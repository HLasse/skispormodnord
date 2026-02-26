// constants.js -- All configuration constants extracted from main.js
// Zero dependencies -- no imports from other app modules.

import { PROVIDERS } from "./providers/config.js";

// Default provider for WMS overlays and fallback when no border polygon matches
export const CURRENT_PROVIDER = "no";

// WMS configuration from provider
const noWmsConfig = PROVIDERS.no.wms;
export const WMS_ROUTE_URL = noWmsConfig.routes.url;
export const WMS_HEIGHT_URL = noWmsConfig.height.url;
export const WMS_WEAK_ICE_URL = noWmsConfig.weakIce.url;
export const WMS_ROUTE_LAYERS = noWmsConfig.routes.layers;
export const WMS_WEAK_ICE_LAYERS = noWmsConfig.weakIce.layers;

// WMTS configuration from provider
const noWmtsConfig = PROVIDERS.no.wmts;
export const WMTS_CAPABILITIES_URL = noWmtsConfig.capabilitiesUrl;
export const WMTS_BASE_URL = noWmtsConfig.baseUrl;
export const MAP_TILE_MATRIX_SET = noWmtsConfig.matrixSet;
export const DEFAULT_LAYER = noWmtsConfig.defaultLayer;

// Tile limits
export const WMTS_MAX_TILES_PER_PAGE = 120;
export const WMTS_MAX_TILES_BORDER_PAGE = 500;
export const WMTS_TILE_SIZE = 256;
export const TILE_BITMAP_CACHE_MAX_ENTRIES = 720; // 120 tiles/page * 4 concurrency * 1.5 overlap

// Overlay constants
export const ROUTE_OVERLAY_OPACITY = 1;
export const DEFAULT_HEIGHT_OVERLAY_OPACITY = 0.2;
export const HEIGHT_OVERLAY_MIN_ZOOM = 10;
export const HEIGHT_OVERLAY_MASK_COLORS = [
  { r: 0x92, g: 0xd0, b: 0x60 },
  { r: 0xd9, g: 0xf0, b: 0x8b },
];
export const HEIGHT_OVERLAY_MASK_TOLERANCE = 18;
export const HEIGHT_TILE_CACHE_LIMIT = 200;
export const HEIGHT_OVERLAY_SCALE_BY_MAP_SCALE = {
  25000: 0.55,
  50000: 0.45,
  100000: 0.35,
};

// PDF/rendering defaults
export const DEFAULT_DPI = 300;
export const DEFAULT_JPEG_QUALITY = 0.9;
export const DEFAULT_OVERLAP = 0.05;
export const DEFAULT_MARGIN = 0.15;
export const DEFAULT_TRACK_OPACITY = 0.8;
export const TRACK_STROKE_PX = 4;
export const PAGE_RENDER_CONCURRENCY = 4;
export const PAGE_RENDER_BATCH_SIZE = 3 * PAGE_RENDER_CONCURRENCY; // 12 -- bounds peak blob memory for long renders

// GPX file limits
export const LARGE_FILE_THRESHOLD = 1024 * 1024;
export const MAX_GPX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// Page styles
export const PAGE_STYLE = {
  color: "#1e1b16",
  weight: 2,
  fill: true,
  fillOpacity: 0.3,
};
export const PAGE_STYLE_SELECTED = {
  color: "#d36b2d",
  weight: 3,
  fill: true,
  fillOpacity: 0.38,
};
export const PAGE_FILL_COLOR = "#f1b27c";

// Paper sizes
export const PAPER_SIZES_MM = {
  A5: [148.0, 210.0],
  A4: [210.0, 297.0],
  A3: [297.0, 420.0],
};
export const ALLOWED_SCALES = new Set([25000, 50000, 100000]);

// Session storage keys
export const MAP_HINT_SESSION_KEY = "gpx_map_hint_dismissed";
export const MAP_TOAST_AUTO_KEY = "gpx_map_toast_auto_shown";
export const MAP_TOAST_MANUAL_KEY = "gpx_map_toast_manual_shown";

// Greyscale PDF rendering
export const GREYSCALE_CONTRAST_FACTOR = 1.15;
export const GREYSCALE_GRID_STYLE = { strokeStyle: "rgba(140, 140, 140, 0.5)", lineWidth: 1 };
export const GREYSCALE_GRID_LABEL_STYLE = { fillStyle: "#555" };
export const GREYSCALE_TRACK_HALO_EXTRA = 3;
export const GREYSCALE_LABEL_BG_OPACITY = 0.8;
