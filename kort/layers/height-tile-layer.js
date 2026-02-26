/**
 * HeightTileLayer - A Leaflet GridLayer that renders WMS height/slope data
 * with optional color masking for removing green vegetation tones.
 *
 * Tiles are fetched as WMS GetMap requests, cached as ImageBitmaps,
 * then masked and cached again as canvas elements.
 */

import { state } from "../state.js";
import { WMS_HEIGHT_URL, HEIGHT_TILE_CACHE_LIMIT } from "../constants.js";
import { pruneCache } from "../utils.js";
import {
  getActiveHeightMaskColors, getHeightMaskKey,
  applyHeightMaskToContext,
} from "../pdf-renderer.js";

const L = window.L;

/**
 * Create a Leaflet GridLayer that renders WMS height data with masking.
 * @param {string} layerName - WMS layer name (e.g., "DTM:helning_grader")
 * @param {Object} options - Layer options (opacity, pane, minZoom, etc.)
 * @param {L.LatLngBounds|null} bounds - Optional bounds to restrict tile loading
 * @returns {L.GridLayer} A Leaflet grid layer instance
 */
export function createHeightTileLayer(layerName, options, bounds) {
  const HeightLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement("canvas");
      const size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;
      const ctx = tile.getContext("2d", { willReadFrequently: true });

      if (!state.mapInstance || !ctx) {
        done(null, tile);
        return tile;
      }

      const nwPoint = coords.scaleBy(size);
      const sePoint = nwPoint.add(size);
      const nw = state.mapInstance.unproject(nwPoint, coords.z);
      const se = state.mapInstance.unproject(sePoint, coords.z);
      const tileBounds = L.latLngBounds(nw, se);
      if (bounds && !bounds.intersects(tileBounds)) {
        done(null, tile);
        return tile;
      }

      const crs = state.mapInstance.options.crs;
      const projectedNw = crs.project(nw);
      const projectedSe = crs.project(se);
      const bbox = [
        projectedNw.x,
        projectedSe.y,
        projectedSe.x,
        projectedNw.y,
      ];

      const params = new URLSearchParams({
        service: "WMS",
        request: "GetMap",
        version: "1.3.0",
        layers: layerName,
        styles: "",
        width: String(size.x),
        height: String(size.y),
        format: "image/png",
        transparent: "true",
        crs: "EPSG:3857",
        bbox: bbox.join(","),
      });

      const requestUrl = `${WMS_HEIGHT_URL}?${params.toString()}`;
      const activeMaskColors = getActiveHeightMaskColors();
      const maskKey = getHeightMaskKey();
      const maskedCacheKey = `${requestUrl}|${maskKey}`;
      const cachedMasked = state.heightTileMaskedCache.get(maskedCacheKey);
      if (cachedMasked) {
        ctx.drawImage(cachedMasked, 0, 0, size.x, size.y);
        done(null, tile);
        return tile;
      }

      const cachedBitmap = state.heightTileBitmapCache.get(requestUrl);
      const drawAndMask = (bitmap) => {
        ctx.drawImage(bitmap, 0, 0, size.x, size.y);
        applyHeightMaskToContext(ctx, size.x, size.y, activeMaskColors);
        const maskedCanvas = document.createElement("canvas");
        maskedCanvas.width = size.x;
        maskedCanvas.height = size.y;
        const maskedCtx = maskedCanvas.getContext("2d");
        if (maskedCtx) {
          maskedCtx.drawImage(tile, 0, 0);
          state.heightTileMaskedCache.set(maskedCacheKey, maskedCanvas);
          pruneCache(state.heightTileMaskedCache, HEIGHT_TILE_CACHE_LIMIT);
        }
        done(null, tile);
      };

      if (cachedBitmap) {
        drawAndMask(cachedBitmap);
        return tile;
      }

      fetch(requestUrl, { mode: "cors" })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`WMS-forespørgsel fejlede (${response.status}).`);
          }
          return response.blob();
        })
        .then((blob) => createImageBitmap(blob))
        .then((bitmap) => {
          state.heightTileBitmapCache.set(requestUrl, bitmap);
          pruneCache(state.heightTileBitmapCache, HEIGHT_TILE_CACHE_LIMIT);
          drawAndMask(bitmap);
        })
        .catch((error) => {
          done(error, tile);
        });

      return tile;
    },
  });

  return new HeightLayer(options);
}
