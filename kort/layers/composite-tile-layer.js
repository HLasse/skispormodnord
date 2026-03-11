/**
 * CompositeTileLayer - A Leaflet GridLayer that composites tiles from multiple providers.
 *
 * For tiles entirely within one country, it fetches from that provider only (fast path).
 * For tiles crossing country borders, it fetches from all relevant providers and
 * composites them with accurate border clipping.
 */

import {
  PROVIDERS,
  getLeafletTileUrl,
  getMaxZoom,
  getMinMaxZoom,
  getCombinedAttribution,
  getProviderIds,
} from "../providers/config.js";

import {
  getTileProviders,
  tileToBbox,
  getCountryPolygon,
  applyPolygonClip,
  preloadBorders,
} from "../providers/borders.js";
import { computeAffineTransform, proj4 } from "../projection.js";
import { getDkWmtsMatrices } from "../providers/dk-matrix.js";

const L = window.L;
const ALL_PROVIDER_IDS = getProviderIds();
const DK_MATRICES = getDkWmtsMatrices();
const DK_UTM_DEF = "+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs";
const WGS84_TO_DK_UTM = proj4("EPSG:4326", DK_UTM_DEF);
const DK_DTK25_SWITCH_ZOOM = PROVIDERS.dk?.wms?.dtk25SwitchZoom ?? 11;
const DK_DTK25_PROXY_URL = PROVIDERS.dk?.wms?.dtk25?.proxyUrl || "/.netlify/functions/wmts-proxy?provider=dk&kind=wms";
const DK_DTK25_LAYER = PROVIDERS.dk?.wms?.dtk25?.layer || "dtk25";
const DK_DTK25_CRS = PROVIDERS.dk?.wms?.dtk25?.crs || "EPSG:25832";
const DK_DTK25_FORMAT = PROVIDERS.dk?.wms?.dtk25?.format || "image/jpeg";
const DK_UTM_COVERAGE_BBOX = (() => {
  const bounds = PROVIDERS.dk?.bounds;
  if (!bounds) return null;
  const corners = [
    [bounds.minLon, bounds.minLat],
    [bounds.minLon, bounds.maxLat],
    [bounds.maxLon, bounds.minLat],
    [bounds.maxLon, bounds.maxLat],
  ].map((corner) => WGS84_TO_DK_UTM.forward(corner));
  return [
    Math.min(...corners.map((p) => p[0])),
    Math.min(...corners.map((p) => p[1])),
    Math.max(...corners.map((p) => p[0])),
    Math.max(...corners.map((p) => p[1])),
  ];
})();

function providerSupportsLeafletXyz(providerId) {
  return PROVIDERS[providerId]?.wmts?.supportsWebMercator !== false;
}
const WEB_MERCATOR_PROVIDER_IDS = ALL_PROVIDER_IDS.filter(providerSupportsLeafletXyz);

function chooseClosestDkMatrix(desiredMPerPx) {
  let chosenIndex = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < DK_MATRICES.length; i += 1) {
    const matrix = DK_MATRICES[i];
    const diff = Math.abs(Math.log(matrix.resolution / desiredMPerPx));
    if (diff < bestDiff) {
      bestDiff = diff;
      chosenIndex = i;
    }
  }
  return chosenIndex;
}

function tileRangeForMatrix(bbox, matrix) {
  const [minx, miny, maxx, maxy] = bbox;
  const res = matrix.resolution;
  const originX = matrix.topLeftCorner[0];
  const originY = matrix.topLeftCorner[1];
  const tileSpanX = matrix.tileWidth * res;
  const tileSpanY = matrix.tileHeight * res;
  return {
    minCol: Math.floor((minx - originX) / tileSpanX),
    maxCol: Math.floor((maxx - originX) / tileSpanX),
    minRow: Math.floor((originY - maxy) / tileSpanY),
    maxRow: Math.floor((originY - miny) / tileSpanY),
    res,
    tileSpanX,
    tileSpanY,
  };
}

function getDkTileGeometry(tileBbox) {
  const [minLon, minLat, maxLon, maxLat] = tileBbox;
  const cornersWgs84 = [
    [minLon, maxLat], // tl
    [maxLon, maxLat], // tr
    [minLon, minLat], // bl
    [maxLon, minLat], // br
  ];
  const cornersUtm = cornersWgs84.map((corner) => WGS84_TO_DK_UTM.forward(corner));
  const srcBbox = [
    Math.min(...cornersUtm.map((p) => p[0])),
    Math.min(...cornersUtm.map((p) => p[1])),
    Math.max(...cornersUtm.map((p) => p[0])),
    Math.max(...cornersUtm.map((p) => p[1])),
  ];
  return { cornersUtm, srcBbox, cornersWgs84 };
}

function sourcePxForBbox(srcBbox, srcWidth, srcHeight, pointUtm) {
  const [minx, miny, maxx, maxy] = srcBbox;
  const [ux, uy] = pointUtm;
  const x = (ux - minx) / (maxx - minx) * srcWidth;
  const y = (maxy - uy) / (maxy - miny) * srcHeight;
  return [x, y];
}

function intersectBboxes(a, b) {
  if (!a || !b) return null;
  const minx = Math.max(a[0], b[0]);
  const miny = Math.max(a[1], b[1]);
  const maxx = Math.min(a[2], b[2]);
  const maxy = Math.min(a[3], b[3]);
  if (!(minx < maxx && miny < maxy)) return null;
  return [minx, miny, maxx, maxy];
}

/**
 * Create a composite tile layer that automatically selects providers based on location
 * @param {object} options - Leaflet layer options plus:
 *   - defaultProvider: string - Fallback provider ID (default: 'no')
 *   - layer: string - Optional layer override for all providers
 * @returns {L.GridLayer}
 */
export function createCompositeTileLayer(options = {}) {
  const defaultProvider = options.defaultProvider || "no";
  const layer = options.layer || null;

  // Preload border polygons
  preloadBorders().catch(err => {
    console.warn("Failed to preload border polygons:", err);
  });

  const CompositeTileLayer = L.GridLayer.extend({
    options: {
      tileSize: 256,
      maxZoom: getMinMaxZoom(WEB_MERCATOR_PROVIDER_IDS),
      attribution: getCombinedAttribution(ALL_PROVIDER_IDS),
      crossOrigin: true,
      ...options,
    },

    createTile: function (coords, done) {
      const tile = document.createElement("canvas");
      const tileSize = this.getTileSize();
      tile.width = tileSize.x;
      tile.height = tileSize.y;

      // Get tile bounding box in WGS84
      const tileBbox = tileToBbox(coords.z, coords.x, coords.y);

      // Async tile creation
      this._createTileAsync(tile, coords, tileBbox, done);

      return tile;
    },

    _createTileAsync: async function (tile, coords, tileBbox, done) {
      try {
        // Determine which providers this tile intersects
        const providers = await getTileProviders(tileBbox);

        if (providers.length === 0) {
          // Outside all borders - use default provider
          await this._renderSingleProviderTile(tile, coords, tileBbox, defaultProvider);
        } else if (providers.length === 1) {
          // Single provider - fast path
          await this._renderSingleProviderTile(tile, coords, tileBbox, providers[0]);
        } else {
          // Multiple providers - composite with clipping
          await this._renderCompositeTile(tile, coords, tileBbox, providers);
        }

        done(null, tile);
      } catch (err) {
        console.warn("Tile error:", err);
        // Fill with error indicator
        const ctx = tile.getContext("2d");
        ctx.fillStyle = "#ffeeee";
        ctx.fillRect(0, 0, tile.width, tile.height);
        done(err, tile);
      }
    },

    _getTileUrl: function (coords, providerId) {
      if (!providerSupportsLeafletXyz(providerId)) {
        throw new Error(`Provider ${providerId} requires custom reprojection fetch`);
      }
      const tileUrl = getLeafletTileUrl(providerId, layer);
      return tileUrl
        .replace("{z}", coords.z)
        .replace("{x}", coords.x)
        .replace("{y}", coords.y);
    },

    _fetchTileImage: function (url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = (err) => reject(new Error(`Failed to load tile: ${url}`));
        img.src = url;
      });
    },

    _renderDkSourceToOutput: function (source, srcBbox, cornersUtm, outWidth, outHeight) {
      const srcWidth = source.naturalWidth || source.width;
      const srcHeight = source.naturalHeight || source.height;
      const mTL = sourcePxForBbox(srcBbox, srcWidth, srcHeight, cornersUtm[0]);
      const mTR = sourcePxForBbox(srcBbox, srcWidth, srcHeight, cornersUtm[1]);
      const mBL = sourcePxForBbox(srcBbox, srcWidth, srcHeight, cornersUtm[2]);
      const xf = computeAffineTransform(
        mTL, mTR, mBL,
        [0, 0], [outWidth, 0], [0, outHeight]
      );

      const out = document.createElement("canvas");
      out.width = outWidth;
      out.height = outHeight;
      const octx = out.getContext("2d");
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, out.width, out.height);
      octx.setTransform(xf.a, xf.b, xf.c, xf.d, xf.e, xf.f);
      octx.drawImage(source, 0, 0);
      octx.setTransform(1, 0, 0, 1, 0, 0);
      return out;
    },

    _fetchDkWmtsReprojectedCanvas: async function (coords, tileBbox, outWidth = 256, outHeight = 256) {
      const { cornersUtm, srcBbox } = getDkTileGeometry(tileBbox);
      const requestBbox = intersectBboxes(srcBbox, DK_UTM_COVERAGE_BBOX);
      if (!requestBbox) {
        const empty = document.createElement("canvas");
        empty.width = outWidth;
        empty.height = outHeight;
        return empty;
      }

      const [minLon, minLat, maxLon, maxLat] = tileBbox;
      const centerLat = (minLat + maxLat) / 2;
      const desiredMPerPx = Math.cos(centerLat * Math.PI / 180) * 156543.03392 / (2 ** coords.z);
      let matrixIndex = chooseClosestDkMatrix(desiredMPerPx);
      let matrix = DK_MATRICES[matrixIndex];
      let range = tileRangeForMatrix(requestBbox, matrix);
      let tileCount = (range.maxCol - range.minCol + 1) * (range.maxRow - range.minRow + 1);
      const maxTiles = 48;
      while (tileCount > maxTiles && matrixIndex < DK_MATRICES.length - 1) {
        matrixIndex += 1;
        matrix = DK_MATRICES[matrixIndex];
        range = tileRangeForMatrix(requestBbox, matrix);
        tileCount = (range.maxCol - range.minCol + 1) * (range.maxRow - range.minRow + 1);
      }

      // DK WMTS matrix indices are non-negative in practice; clamp to avoid noisy
      // proxy calls from tiles well outside DK coverage.
      range.minCol = Math.max(0, range.minCol);
      range.minRow = Math.max(0, range.minRow);
      if (range.maxCol < range.minCol || range.maxRow < range.minRow) {
        const empty = document.createElement("canvas");
        empty.width = outWidth;
        empty.height = outHeight;
        return empty;
      }

      const cols = range.maxCol - range.minCol + 1;
      const rows = range.maxRow - range.minRow + 1;
      const mosaic = document.createElement("canvas");
      mosaic.width = cols * matrix.tileWidth;
      mosaic.height = rows * matrix.tileHeight;
      const mctx = mosaic.getContext("2d");

      const proxyTemplate = PROVIDERS.dk.wmts.proxyUrl.replace("{layer}", PROVIDERS.dk.wmts.defaultLayer);
      const tasks = [];
      for (let row = range.minRow; row <= range.maxRow; row += 1) {
        for (let col = range.minCol; col <= range.maxCol; col += 1) {
          tasks.push({
            row,
            col,
            x: col - range.minCol,
            y: row - range.minRow,
            url: proxyTemplate
              .replace("{z}", matrix.id)
              .replace("{x}", String(col))
              .replace("{y}", String(row)),
          });
        }
      }

      await Promise.all(tasks.map(async (task) => {
        try {
          const img = await this._fetchTileImage(task.url);
          mctx.drawImage(
            img,
            task.x * matrix.tileWidth,
            task.y * matrix.tileHeight,
            matrix.tileWidth,
            matrix.tileHeight
          );
        } catch (_) {
          mctx.fillStyle = "#ececec";
          mctx.fillRect(
            task.x * matrix.tileWidth,
            task.y * matrix.tileHeight,
            matrix.tileWidth,
            matrix.tileHeight
          );
        }
      }));

      const originX = matrix.topLeftCorner[0];
      const originY = matrix.topLeftCorner[1];
      const mosaicOriginX = originX + range.minCol * range.tileSpanX;
      const mosaicOriginY = originY - range.minRow * range.tileSpanY;
      const wmtsSourceBbox = [
        mosaicOriginX,
        mosaicOriginY - mosaic.height * range.res,
        mosaicOriginX + mosaic.width * range.res,
        mosaicOriginY,
      ];
      return this._renderDkSourceToOutput(mosaic, wmtsSourceBbox, cornersUtm, outWidth, outHeight);
    },

    _fetchDkWmsReprojectedCanvas: async function (coords, tileBbox, outWidth = 256, outHeight = 256) {
      const { cornersUtm, srcBbox } = getDkTileGeometry(tileBbox);
      const requestBbox = intersectBboxes(srcBbox, DK_UTM_COVERAGE_BBOX);
      if (!requestBbox) {
        const empty = document.createElement("canvas");
        empty.width = outWidth;
        empty.height = outHeight;
        return empty;
      }
      // Oversample slightly for cleaner reprojection around tile edges.
      const requestSize = Math.max(512, outWidth * 2, outHeight * 2);
      const params = new URLSearchParams({
        layer: DK_DTK25_LAYER,
        crs: DK_DTK25_CRS,
        bbox: requestBbox.join(","),
        width: String(requestSize),
        height: String(requestSize),
        format: DK_DTK25_FORMAT,
      });
      const url = `${DK_DTK25_PROXY_URL}&${params.toString()}`;
      const source = await this._fetchTileImage(url);
      return this._renderDkSourceToOutput(source, requestBbox, cornersUtm, outWidth, outHeight);
    },

    _fetchDkReprojectedCanvas: async function (coords, tileBbox, outWidth = 256, outHeight = 256) {
      if (coords.z >= DK_DTK25_SWITCH_ZOOM) {
        return this._fetchDkWmsReprojectedCanvas(coords, tileBbox, outWidth, outHeight);
      }
      return this._fetchDkWmtsReprojectedCanvas(coords, tileBbox, outWidth, outHeight);
    },

    _renderSingleProviderTile: async function (tile, coords, tileBbox, providerId) {
      if (providerId === "dk") {
        const dkCanvas = await this._fetchDkReprojectedCanvas(coords, tileBbox, tile.width, tile.height);
        const ctx = tile.getContext("2d");
        ctx.drawImage(dkCanvas, 0, 0, tile.width, tile.height);
        return;
      }

      const url = this._getTileUrl(coords, providerId);
      const img = await this._fetchTileImage(url);
      const ctx = tile.getContext("2d");
      ctx.drawImage(img, 0, 0, tile.width, tile.height);
    },

    _renderCompositeTile: async function (tile, coords, tileBbox, providers) {
      const ctx = tile.getContext("2d");
      const tileSize = tile.width;

      // Fetch tiles from all providers in parallel
      const fetchPromises = providers.map(async (providerId) => {
        try {
          if (providerId === "dk") {
            const canvas = await this._fetchDkReprojectedCanvas(coords, tileBbox, tileSize, tileSize);
            return { providerId, surface: canvas, success: true };
          }
          const url = this._getTileUrl(coords, providerId);
          const img = await this._fetchTileImage(url);
          return { providerId, surface: img, success: true };
        } catch (err) {
          console.warn(`Failed to fetch tile for ${providerId}:`, err);
          return { providerId, surface: null, success: false };
        }
      });

      const results = await Promise.all(fetchPromises);

      // Phase 1: Draw ALL tiles unclipped as background (fills any gaps)
      // This ensures no grey areas where one provider lacks coverage
      for (const result of results) {
        if (result.success && result.surface) {
          ctx.drawImage(result.surface, 0, 0, tileSize, tileSize);
        }
      }

      // Phase 2: Draw tiles with proper country polygon clipping
      // This establishes correct borders - each country's tile is clipped to its polygon
      for (const { providerId, surface, success } of results) {
        if (!success || !surface) continue;

        try {
          const polygon = await getCountryPolygon(providerId);
          if (!polygon) {
            // No polygon - already drawn in phase 1
            continue;
          }

          ctx.save();
          applyPolygonClip(ctx, polygon, tileBbox, tileSize);
          ctx.drawImage(surface, 0, 0, tileSize, tileSize);
          ctx.restore();
        } catch (clipErr) {
          // Fallback: already drawn in phase 1, just log
          console.warn(`Clip error for ${providerId}:`, clipErr);
        }
      }
    },
  });

  return new CompositeTileLayer(options);
}

/**
 * Create a simple single-provider tile layer (for testing or explicit provider selection)
 * @param {string} providerId - Provider ID
 * @param {object} options - Leaflet TileLayer options
 * @returns {L.TileLayer}
 */
export function createProviderTileLayer(providerId, options = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  if (!providerSupportsLeafletXyz(providerId)) {
    throw new Error(`Provider ${providerId} does not support direct Leaflet XYZ tiles`);
  }

  const url = getLeafletTileUrl(providerId, options.layer);
  const maxZoom = getMaxZoom(providerId);

  return L.tileLayer(url, {
    maxZoom,
    attribution: provider.attribution,
    crossOrigin: true,
    ...options,
  });
}

/**
 * Simple split layer that chooses provider based on tile center point
 * (lighter weight alternative to full compositing)
 * @param {object} options - Layer options
 * @returns {L.GridLayer}
 */
export function createSplitTileLayer(options = {}) {
  const defaultProvider = options.defaultProvider || "no";
  const layer = options.layer || null;

  // Preload borders
  preloadBorders().catch(console.warn);

  const SplitTileLayer = L.GridLayer.extend({
    options: {
      tileSize: 256,
      maxZoom: getMinMaxZoom(WEB_MERCATOR_PROVIDER_IDS),
      attribution: getCombinedAttribution(ALL_PROVIDER_IDS),
      crossOrigin: true,
      ...options,
    },

    createTile: function (coords, done) {
      const tile = document.createElement("img");
      tile.crossOrigin = "anonymous";

      // Get tile center
      const tileBbox = tileToBbox(coords.z, coords.x, coords.y);
      const centerLon = (tileBbox[0] + tileBbox[2]) / 2;
      const centerLat = (tileBbox[1] + tileBbox[3]) / 2;

      // Async provider detection
      this._selectProviderAndLoad(tile, coords, centerLon, centerLat, done);

      return tile;
    },

    _selectProviderAndLoad: async function (tile, coords, lon, lat, done) {
      try {
        // Get providers for tile center
        const providers = await getTileProviders([lon - 0.001, lat - 0.001, lon + 0.001, lat + 0.001]);
        let providerId = providers[0] || defaultProvider;
        if (!providerSupportsLeafletXyz(providerId)) {
          providerId = defaultProvider;
        }

        const tileUrl = getLeafletTileUrl(providerId, layer);
        const url = tileUrl
          .replace("{z}", coords.z)
          .replace("{x}", coords.x)
          .replace("{y}", coords.y);

        tile.onload = () => done(null, tile);
        tile.onerror = (err) => done(err, tile);
        tile.src = url;
      } catch (err) {
        // Fallback to default provider
        const tileUrl = getLeafletTileUrl(defaultProvider, layer);
        const url = tileUrl
          .replace("{z}", coords.z)
          .replace("{x}", coords.x)
          .replace("{y}", coords.y);

        tile.onload = () => done(null, tile);
        tile.onerror = (err) => done(err, tile);
        tile.src = url;
      }
    },
  });

  return new SplitTileLayer(options);
}

export default {
  createCompositeTileLayer,
  createProviderTileLayer,
  createSplitTileLayer,
};
