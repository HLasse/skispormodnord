/**
 * Provider module exports
 */

export {
  PROVIDERS,
  getProvider,
  getProviderIds,
  getTileUrl,
  getLeafletTileUrl,
  getMaxZoom,
  getMinMaxZoom,
  getWmsConfig,
  hasWmsLayer,
  getUtmMatrixSet,
  getCombinedAttribution,
} from "./config.js";

export {
  getTileProviders,
  getPointProviders,
  getPrimaryProvider,
  getCountryPolygon,
  tileToBbox,
  coordsToTilePixel,
  applyPolygonClip,
  areBordersLoaded,
  preloadBorders,
} from "./borders.js";

// Re-export default
export { default } from "./config.js";
