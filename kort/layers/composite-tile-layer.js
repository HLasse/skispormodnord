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
} from "../providers/config.js";

import {
  getTileProviders,
  tileToBbox,
  getCountryPolygon,
  applyPolygonClip,
  preloadBorders,
} from "../providers/borders.js";

const L = window.L;

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
      maxZoom: getMinMaxZoom(["no", "se", "fi"]),
      attribution: getCombinedAttribution(["no", "se", "fi"]),
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
          await this._renderSingleProviderTile(tile, coords, defaultProvider);
        } else if (providers.length === 1) {
          // Single provider - fast path
          await this._renderSingleProviderTile(tile, coords, providers[0]);
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

    _renderSingleProviderTile: async function (tile, coords, providerId) {
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
          const url = this._getTileUrl(coords, providerId);
          const img = await this._fetchTileImage(url);
          return { providerId, img, success: true };
        } catch (err) {
          console.warn(`Failed to fetch tile for ${providerId}:`, err);
          return { providerId, img: null, success: false };
        }
      });

      const results = await Promise.all(fetchPromises);

      // Phase 1: Draw ALL tiles unclipped as background (fills any gaps)
      // This ensures no grey areas where one provider lacks coverage
      for (const result of results) {
        if (result.success && result.img) {
          ctx.drawImage(result.img, 0, 0, tileSize, tileSize);
        }
      }

      // Phase 2: Draw tiles with proper country polygon clipping
      // This establishes correct borders - each country's tile is clipped to its polygon
      for (const { providerId, img, success } of results) {
        if (!success || !img) continue;

        try {
          const polygon = await getCountryPolygon(providerId);
          if (!polygon) {
            // No polygon - already drawn in phase 1
            continue;
          }

          ctx.save();
          applyPolygonClip(ctx, polygon, tileBbox, tileSize);
          ctx.drawImage(img, 0, 0, tileSize, tileSize);
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
      maxZoom: getMinMaxZoom(["no", "se", "fi"]),
      attribution: getCombinedAttribution(["no", "se", "fi"]),
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
        const providerId = providers[0] || defaultProvider;

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
