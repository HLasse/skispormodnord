// map-manager.js -- Leaflet map lifecycle, track layer, page overlays, page dragging
// Dependencies: state.js, constants.js, projection.js, overlays.js, layers/composite-tile-layer.js
// DOES NOT import from ui-controller.js (no circular deps)

import { state } from "./state.js";
import {
  CURRENT_PROVIDER,
  PAGE_STYLE, PAGE_STYLE_SELECTED, PAGE_FILL_COLOR,
} from "./constants.js";
import { createCompositeTileLayer } from "./layers/composite-tile-layer.js";
import { computePageColors } from "./layout.js";
import {
  updateRouteOverlays, updateHeightOverlays, updateWeakIceOverlays,
} from "./overlays.js";

const L = window.L;
const TRACK_HOVER_FALLBACK_COLOR = "#ff7a45";

function pointsToLatLngs(pointsLonLat) {
  return (pointsLonLat ?? []).map(([lon, lat]) => [lat, lon]);
}

// --- Map initialization ---

/**
 * Initialize the Leaflet map instance.
 * @param {Object} callbacks - Callback functions to avoid importing from ui-controller
 * @param {Function} callbacks.onMapClick - Called when map background is clicked (deselect page)
 * @param {Function} callbacks.onMapMove - Called on zoomend/moveend (update selection bar)
 * @param {Function} callbacks.onHintDismiss - Called to dismiss the map hint
 * @param {Function} callbacks.isHintDismissed - Returns whether hint was already dismissed
 * @param {Function} callbacks.updateHintHighlight - Updates the hint highlight positions
 */
export function initMap(callbacks) {
  const mapEl = document.getElementById("map");
  const selectionBarEl = document.getElementById("selectionBar");
  const mapHintEl = document.getElementById("mapHint");
  const sidebarEl = document.getElementById("sidebar");

  if (state.mapInstance || !mapEl) return;
  if (!L) {
    return;
  }
  state.mapInstance = L.map(mapEl, {
    zoomControl: true,
    zoomSnap: 0.5,
    renderer: L.svg(),
  });
  if (selectionBarEl) {
    L.DomEvent.disableClickPropagation(selectionBarEl);
    L.DomEvent.disableScrollPropagation(selectionBarEl);
  }
  // Use composite tile layer for multi-country support
  // Falls back to Norway for areas outside border polygons
  createCompositeTileLayer({
    defaultProvider: CURRENT_PROVIDER,
  }).addTo(state.mapInstance);
  state.mapInstance.setView([64.5, 11.0], 5);

  state.pageLayerGroup = L.layerGroup().addTo(state.mapInstance);
  updateRouteOverlays();
  updateHeightOverlays();
  updateWeakIceOverlays();

  state.mapInstance.on("click", (event) => {
    if (state.drawModeActive) return; // Drawing handles its own clicks
    const target = event.originalEvent?.target;
    if (target && target.closest && target.closest(".page-rect")) {
      return;
    }
    if (callbacks.onMapClick) callbacks.onMapClick();
  });
  state.mapInstance.on("zoomend moveend", () => {
    if (callbacks.onMapMove) callbacks.onMapMove();
  });

  if (mapHintEl) {
    if (callbacks.isHintDismissed && callbacks.isHintDismissed()) {
      mapHintEl.classList.add("hidden");
      document.body.classList.remove("map-hint-active");
    } else {
      document.body.classList.add("map-hint-active");
      if (callbacks.updateHintHighlight) callbacks.updateHintHighlight();
      const hintEvents = [
        "mousedown",
        "touchstart",
        "zoomstart",
        "movestart",
        "dragstart",
        "click",
      ];
      const sidebarEvents = ["mousedown", "touchstart", "click", "scroll"];
      const handleHintDismiss = () => {
        if (mapHintEl.classList.contains("hidden")) return;
        if (callbacks.onHintDismiss) callbacks.onHintDismiss();
        hintEvents.forEach((eventName) =>
          state.mapInstance.off(eventName, handleHintDismiss)
        );
        if (sidebarEl) {
          sidebarEvents.forEach((eventName) =>
            sidebarEl.removeEventListener(eventName, handleHintDismiss)
          );
        }
      };
      hintEvents.forEach((eventName) =>
        state.mapInstance.on(eventName, handleHintDismiss)
      );
      if (sidebarEl) {
        sidebarEvents.forEach((eventName) =>
          sidebarEl.addEventListener(eventName, handleHintDismiss)
        );
      }
    }
  }
}

// --- Track layer ---

export function updateTrackLayer(pointsLonLatOrSegments, options = {}) {
  if (!state.mapInstance || !L) return;
  if (state.trackLayer) {
    state.mapInstance.removeLayer(state.trackLayer);
  }
  clearTrackHighlight();

  const segments = Array.isArray(pointsLonLatOrSegments?.[0]?.[0])
    ? pointsLonLatOrSegments
    : [pointsLonLatOrSegments];
  const latLngSegments = segments
    .filter((segment) => Array.isArray(segment) && segment.length)
    .map((segment) => pointsToLatLngs(segment));
  if (!latLngSegments.length) {
    state.trackLayer = null;
    return;
  }

  const polylineData = latLngSegments.length === 1 ? latLngSegments[0] : latLngSegments;
  state.trackLayer = L.polyline(polylineData, {
    color: state.selections.trackColor,
    weight: state.selections.trackWidth,
    opacity: state.selections.trackOpacity,
  }).addTo(state.mapInstance);

  if (options.fitBounds !== false) {
    const bounds = L.latLngBounds(latLngSegments.flat());
    state.mapInstance.fitBounds(bounds.pad(0.1));
  }
}

export function highlightTrackSegment(pointsLonLat, options = {}) {
  if (!state.mapInstance || !L) return;
  clearTrackHighlight();
  const latLngs = pointsToLatLngs(pointsLonLat);
  if (!latLngs.length) return;

  const haloLayer = L.polyline(latLngs, {
    color: "#fff3ea",
    weight: state.selections.trackWidth + 10,
    opacity: 0.85,
    interactive: false,
    lineJoin: "round",
    lineCap: "round",
  });
  const focusLayer = L.polyline(latLngs, {
    color: state.selections.trackColor || TRACK_HOVER_FALLBACK_COLOR,
    weight: state.selections.trackWidth + 4,
    opacity: 0.98,
    interactive: false,
    lineJoin: "round",
    lineCap: "round",
  });

  state.trackHoverLayer = L.layerGroup([haloLayer, focusLayer]).addTo(state.mapInstance);

  if (options.flyTo !== false) {
    const bounds = L.latLngBounds(latLngs);
    if (bounds.isValid()) {
      state.mapInstance.flyToBounds(bounds.pad(0.22), {
        duration: 0.45,
        easeLinearity: 0.2,
      });
    }
  }
}

export function clearTrackHighlight() {
  if (state.mapInstance && state.trackHoverLayer) {
    state.mapInstance.removeLayer(state.trackHoverLayer);
    state.trackHoverLayer = null;
  }
}

export function clearTrackLayer() {
  clearTrackHighlight();
  if (state.mapInstance && state.trackLayer) {
    state.mapInstance.removeLayer(state.trackLayer);
    state.trackLayer = null;
  }
}

// --- Coordinate conversion ---

export function bboxToLatLngBounds(bbox, transformer) {
  if (!L) return null;
  const [minx, miny, maxx, maxy] = bbox;
  const [minLon, minLat] = transformer.inverse([minx, miny]);
  const [maxLon, maxLat] = transformer.inverse([maxx, maxy]);
  return L.latLngBounds([minLat, minLon], [maxLat, maxLon]);
}

// --- Page overlays ---

export function clearPageOverlays() {
  if (!state.pageLayerGroup) return;
  state.pageLayers.forEach((layer) => state.pageLayerGroup.removeLayer(layer));
  state.pageLayers = [];
  state.pageLabelLayers.forEach((layer) => state.pageLayerGroup.removeLayer(layer));
  state.pageLabelLayers = [];
}

export function ensurePageIds(pages) {
  pages.forEach((page) => {
    if (!page.id) {
      page.id = state.nextPageId;
      state.nextPageId += 1;
    }
  });
}

function createPageLabel(page, index) {
  const el = document.createElement("div");
  el.className = "page-label";
  el.textContent = String(index + 1);

  const bounds = bboxToLatLngBounds(page.bbox, state.transformerState.transformer);
  if (!bounds) return null;
  const position = bounds.getNorthWest();

  const marker = L.marker(position, {
    interactive: true,
    icon: L.divIcon({
      className: "",
      html: el,
      iconSize: null,
    }),
  });
  return marker;
}

/**
 * Render page overlays on the map.
 * @param {Object} callbacks - Callback functions to avoid circular imports
 * @param {Function} callbacks.onPageMousedown - Called on page mousedown: (event, index) => void
 * @param {Function} callbacks.onPageTouchstart - Called on page touchstart: (event, index) => void
 * @param {Function} callbacks.onPageClick - Called on page click: (event, index) => void
 */
export function renderPageOverlays(callbacks) {
  if (!state.mapInstance || !state.transformerState || !state.layoutPages.length || !L) return;
  clearPageOverlays();
  ensurePageIds(state.layoutPages);
  state.pageColors = computePageColors(state.layoutPages.length);

  state.layoutPages.forEach((page, index) => {
    const bounds = bboxToLatLngBounds(page.bbox, state.transformerState.transformer);
    if (!bounds) return;
    const fillColor = state.pageColors[index] ?? PAGE_FILL_COLOR;
    const rect = L.rectangle(bounds, {
      ...PAGE_STYLE,
      fillColor,
      interactive: true,
      className: "page-rect",
    });
    rect.on("mousedown", (event) => {
      if (state.layoutPages[index]?.locked) return;
      L.DomEvent.stop(event);
      if (callbacks?.onPageMousedown) callbacks.onPageMousedown(event, index);
    });
    rect.on("touchstart", (event) => {
      if (state.layoutPages[index]?.locked) return;
      L.DomEvent.stop(event);
      if (callbacks?.onPageTouchstart) callbacks.onPageTouchstart(event, index);
    });
    rect.on("click", (event) => {
      L.DomEvent.stop(event);
      if (callbacks?.onPageClick) callbacks.onPageClick(event, index);
    });
    rect.addTo(state.pageLayerGroup);
    state.pageLayers.push(rect);

    const labelMarker = createPageLabel(page, index);
    if (labelMarker) {
      labelMarker.addTo(state.pageLayerGroup);
      state.pageLabelLayers.push(labelMarker);
    }
  });

  updatePageStyles();
}

export function fitMapToLayout() {
  if (!state.mapInstance || !state.layoutPages.length || !state.transformerState || !L) return;
  const combined = L.latLngBounds();
  state.layoutPages.forEach((page) => {
    const bounds = bboxToLatLngBounds(page.bbox, state.transformerState.transformer);
    combined.extend(bounds);
  });
  if (combined.isValid()) {
    state.mapInstance.fitBounds(combined.pad(0.08));
  }
}

// --- Page styling ---

export function updatePageStyles() {
  state.pageLayers.forEach((layer, index) => {
    const baseStyle =
      index === state.selectedPageIndex ? PAGE_STYLE_SELECTED : PAGE_STYLE;
    const fillColor = state.pageColors[index] ?? PAGE_FILL_COLOR;
    const isLocked = !!state.layoutPages[index]?.locked;
    layer.setStyle({ ...baseStyle, fillColor, dashArray: isLocked ? "8 4" : null });
    if (index === state.selectedPageIndex) {
      layer.bringToFront();
    }
  });
  state.pageLabelLayers.forEach((layer, index) => {
    if (index === state.selectedPageIndex && layer.bringToFront) {
      layer.bringToFront();
    }
  });
}

// --- Page selection ---

/**
 * Select a page by index.
 * @param {number|null} index - Page index to select, or null to deselect
 * @param {Object} anchorPoint - Optional container point for positioning selection bar
 * @param {Function} updateSelectionBarFn - Callback to update the selection bar UI
 */
export function selectPage(index, anchorPoint, updateSelectionBarFn) {
  if (index === null || index === undefined) {
    state.selectedPageIndex = null;
  } else {
    state.selectedPageIndex = index;
  }
  updatePageStyles();
  requestAnimationFrame(() => {
    if (updateSelectionBarFn) updateSelectionBarFn(anchorPoint);
  });
}

// --- Selection bar ---

function rescueSelectionBar(selectionBarEl) {
  selectionBarEl.classList.add("hidden");
  const overlay = document.querySelector(".map-overlay");
  if (overlay && selectionBarEl.parentElement !== overlay) {
    overlay.appendChild(selectionBarEl);
  }
}

export function updateSelectionBar(anchorPoint) {
  const selectionBarEl = document.getElementById("selectionBar");
  const selectionSelectEl = document.getElementById("selectionSelect");
  const orientationToggleEl = document.getElementById("orientationToggle");
  const removePageBtn = document.getElementById("removePageBtn");
  const lockToggleBtn = document.getElementById("lockToggleBtn");
  const lockAllBtn = document.getElementById("lockAllBtn");

  if (!selectionBarEl || !state.mapInstance || !selectionSelectEl || !orientationToggleEl) return;
  if (!state.pagePreviewsVisible) {
    rescueSelectionBar(selectionBarEl);
    if (state.selectionMarker) {
      state.mapInstance.removeLayer(state.selectionMarker);
      state.selectionMarker = null;
    }
    return;
  }
  if (!state.transformerState) {
    rescueSelectionBar(selectionBarEl);
    if (state.selectionMarker) {
      state.mapInstance.removeLayer(state.selectionMarker);
      state.selectionMarker = null;
    }
    return;
  }
  if (state.selectedPageIndex === null || !state.layoutPages[state.selectedPageIndex]) {
    rescueSelectionBar(selectionBarEl);
    if (state.selectionMarker) {
      state.mapInstance.removeLayer(state.selectionMarker);
      state.selectionMarker = null;
    }
    return;
  }
  const page = state.layoutPages[state.selectedPageIndex];
  const [minx, miny, maxx, maxy] = page.bbox;
  const centerX = (minx + maxx) / 2;
  const [lon, lat] = state.transformerState.transformer.inverse([centerX, maxy]);
  const latlng = L.latLng(lat, lon);

  selectionSelectEl.innerHTML = "";
  for (let i = 1; i <= state.layoutPages.length; i += 1) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Side ${i}`;
    if (i === state.selectedPageIndex + 1) opt.selected = true;
    selectionSelectEl.appendChild(opt);
  }
  if (removePageBtn) {
    removePageBtn.classList.toggle("hidden", state.selectedPageIndex === null);
  }
  if (lockToggleBtn) {
    lockToggleBtn.classList.toggle("lock-active", !!page.locked);
  }
  if (lockAllBtn) {
    lockAllBtn.classList.toggle("lock-active", state.globalLockAll);
  }

  if (!state.selectionMarker) {
    state.selectionMarker = L.marker(latlng, {
      interactive: true,
      icon: L.divIcon({
        className: "",
        html: "",
        iconSize: null,
      }),
    }).addTo(state.mapInstance);
  } else {
    state.selectionMarker.setLatLng(latlng);
  }

  const markerEl = state.selectionMarker.getElement();
  if (markerEl) {
    selectionBarEl.classList.remove("hidden");
    if (selectionBarEl.parentElement !== markerEl) {
      markerEl.appendChild(selectionBarEl);
    }
  }
}

// --- Page layer bounds ---

export function updatePageLayerBounds(index) {
  if (!state.pageLayers[index] || !state.transformerState) return;
  const bounds = bboxToLatLngBounds(state.layoutPages[index].bbox, state.transformerState.transformer);
  state.pageLayers[index].setBounds(bounds);
  if (state.pageLabelLayers[index] && bounds) {
    state.pageLabelLayers[index].setLatLng(bounds.getNorthEast());
  }
}

// --- Drag handling ---

export function getContainerPointFromEvent(event) {
  if (!state.mapInstance) return null;
  if (event?.containerPoint) return event.containerPoint;
  const original = event?.originalEvent ?? event;
  const touch = original?.touches?.[0] || original?.changedTouches?.[0];
  if (touch) {
    return state.mapInstance.mouseEventToContainerPoint(touch);
  }
  if (!original) return null;
  return state.mapInstance.mouseEventToContainerPoint(original);
}

/**
 * Start dragging a page.
 * @param {Object} event - Mouse/touch event
 * @param {number} index - Page index
 * @param {Function} onDragMove - Called on drag move with (event) => void
 * @param {Function} onDragEnd - Called on drag end with (event) => void
 */
export function startDrag(event, index, onDragMove, onDragEnd) {
  if (!state.transformerState) return;
  const point = getContainerPointFromEvent(event);
  if (!point) return;
  const latlng = state.mapInstance.containerPointToLatLng(point);
  const [startX, startY] = state.transformerState.transformer.forward([
    latlng.lng,
    latlng.lat,
  ]);
  state.dragState = {
    index,
    startUtm: [startX, startY],
    startBBox: state.layoutPages[index].bbox.slice(),
    didMove: false,
  };
  if (state.mapInstance) {
    state.mapInstance.dragging.disable();
  }
  bindDragListeners(onDragMove, onDragEnd);
}

/**
 * Handle document-level mouse/touch move during drag.
 * @param {Object} event - Mouse/touch event
 * @param {Function} updateSelectionBarFn - Callback to update selection bar position
 */
export function handleDocumentMove(event, updateSelectionBarFn) {
  if (!state.dragState || !state.transformerState || !state.mapInstance) return;
  const point = getContainerPointFromEvent(event);
  if (!point) return;
  const latlng = state.mapInstance.containerPointToLatLng(point);
  const [currentX, currentY] = state.transformerState.transformer.forward([
    latlng.lng,
    latlng.lat,
  ]);
  const dx = currentX - state.dragState.startUtm[0];
  const dy = currentY - state.dragState.startUtm[1];
  if (dx !== 0 || dy !== 0) {
    state.dragState.didMove = true;
  }
  const nextBBox = [
    state.dragState.startBBox[0] + dx,
    state.dragState.startBBox[1] + dy,
    state.dragState.startBBox[2] + dx,
    state.dragState.startBBox[3] + dy,
  ];
  state.layoutPages[state.dragState.index].bbox = nextBBox;
  updatePageLayerBounds(state.dragState.index);
  if (updateSelectionBarFn) updateSelectionBarFn(point);
}

// Store references for cleanup
let _boundDragMove = null;
let _boundDragEnd = null;

function bindDragListeners(onDragMove, onDragEnd) {
  if (state.dragListenersActive) return;
  state.dragListenersActive = true;
  _boundDragMove = onDragMove;
  _boundDragEnd = onDragEnd;
  document.addEventListener("mousemove", _boundDragMove);
  document.addEventListener("mouseup", _boundDragEnd);
  document.addEventListener("touchmove", _boundDragMove, { passive: false });
  document.addEventListener("touchend", _boundDragEnd);
}

export function unbindDragListeners() {
  if (!state.dragListenersActive) return;
  state.dragListenersActive = false;
  if (_boundDragMove) {
    document.removeEventListener("mousemove", _boundDragMove);
    document.removeEventListener("touchmove", _boundDragMove);
    _boundDragMove = null;
  }
  if (_boundDragEnd) {
    document.removeEventListener("mouseup", _boundDragEnd);
    document.removeEventListener("touchend", _boundDragEnd);
    _boundDragEnd = null;
  }
}

/**
 * Stop dragging.
 * @param {Object} event - Mouse/touch event
 * @param {Function} onDragComplete - Called when drag completes with didMove boolean
 */
export function stopDrag(event, onDragComplete) {
  if (!state.dragState) return;
  if (event?.preventDefault) {
    event.preventDefault();
  }
  const didMove = state.dragState.didMove;
  state.dragState = null;
  unbindDragListeners();
  if (state.mapInstance) {
    state.mapInstance.dragging.enable();
  }
  if (didMove && onDragComplete) {
    onDragComplete();
  }
}

// --- Page overlay interactivity ---

/**
 * Enable or disable interactive state on all page rect overlays.
 * Used by draw-manager to lock pages during draw mode.
 */
export function setPageOverlaysInteractive(interactive) {
  // Hide/show the entire page layer group (rects + labels)
  if (state.pageLayerGroup && state.mapInstance) {
    if (interactive) {
      if (!state.mapInstance.hasLayer(state.pageLayerGroup)) {
        state.pageLayerGroup.addTo(state.mapInstance);
      }
    } else {
      state.mapInstance.removeLayer(state.pageLayerGroup);
    }
  }
}
