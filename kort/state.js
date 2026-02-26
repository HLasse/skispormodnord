// state.js -- Centralized mutable state container
// Zero dependencies -- imports NOTHING from other app modules.

const state = {
  // User selections (persisted across interactions)
  selections: {
    paper: "A4",
    scale: 50000,
    orientation: "auto",
    trackColor: "#ff3b30",
    trackOpacity: 0.8,
    trackWidth: 4,
    greyscale: false,
  },

  // File state
  selectedFile: null,
  uploadedTracks: [],
  trackOrder: [],        // Ordered ids for uploaded tracks + DRAWN_TRACK_ID when present
  cachedPoints: null,
  hasTrackData: false,

  // Projection state
  transformerState: null,
  projectionState: null,

  // Map state
  mapInstance: null,
  trackLayer: null,
  trackHoverLayer: null,
  pageLayerGroup: null,
  pageLayers: [],
  pageLabelLayers: [],
  pageColors: [],
  selectionMarker: null,

  // Overlay state
  skiRoutesLayer: null,
  hikeRoutesLayer: null,
  heightOverlayLayers: new Map(),
  weakIceOverlayLayers: new Map(),
  heightOverlayBounds: null,

  // Layout state
  layoutPages: [],
  selectedPageIndex: null,
  hasManualEdits: false,
  isLayoutReady: false,
  nextPageId: 1,
  globalLockAll: false,
  hasInsertedManualPage: false,

  // UI state
  downloadUrl: null,
  dragState: null,
  dragListenersActive: false,
  confirmResolver: null,
  pagePreviewsVisible: true,

  // Worker state
  gpxWorker: null,
  gpxWorkerRequestId: 0,
  gpxWorkerPending: new Map(),

  // Caches
  heightTileBitmapCache: new Map(),
  heightTileMaskedCache: new Map(),

  // Drawing state
  drawnRoute: [],           // Array of [lon, lat] pairs
  drawModeActive: false,
  drawLayerGroup: null,
  drawPolyline: null,
  drawMarkers: [],          // Array of L.circleMarker instances
  drawRubberBand: null,     // L.polyline from last point to cursor
  drawUndoStack: [],        // Array of undo command objects
  drawRedoStack: [],        // Array of redo command objects
  drawAppendToEnd: true,    // true = append new points to end; false = prepend to start
  drawSelectedPoint: null,  // Index of currently selected waypoint (for action bar)
  drawFreehandActive: false,
  drawFreehandBuffer: [],   // Buffer for freehand points before simplification
};

export default state;
export { state };
