// draw-manager.js -- Core drawing engine: click-to-place, freehand, rubber band, distance, page locking,
//   drag, midpoint insert, delete, undo/redo, snap-to-track, reverse, clear
// Dependencies: state.js, projection.js, gpx-parser.js, utils.js, map-manager.js
// DOES NOT import from ui-controller.js (callbacks only)

import { state } from "./state.js";
import { transformerForPoints, projectPoints } from "./projection.js";
import { trackLengthFromProjected } from "./gpx-parser.js";
import { formatDistance } from "./utils.js";
import { setPageOverlaysInteractive } from "./map-manager.js";

const L = window.L;

export const DRAWN_TRACK_ID = "__drawn_track__";

// Module-scoped callback store
let callbacks = {
  onDistanceChanged: null,
  onDrawModeChanged: null,
  onRouteChanged: null,
  onPointSelected: null,
  onPointDeselected: null,
};

// Module-scoped handler references for cleanup
let _mapClickHandler = null;
let _mouseMoveHandler = null;
let _mouseDownHandler = null;
let _mouseUpHandler = null;
let _keyUpHandler = null;

// Freehand projection cache (avoid re-projecting on every mousemove)
let _freehandTransformer = null;

// Drag state (transient, not in state.js)
let _dragMarkerIndex = null;
let _dragStartPos = null;
let _isDragging = false;

// Snap state (transient)
let _snapTarget = null; // { lat, lng } or null

// Suppress map click after marker interaction (drag or click on marker)
let _suppressMapClick = false;

// --- Undo/Redo command pattern ---

const UNDO_STACK_LIMIT = 100;

/**
 * Push an undo action onto the undo stack, clear redo stack.
 */
function pushUndo(action) {
  state.drawUndoStack.push(action);
  if (state.drawUndoStack.length > UNDO_STACK_LIMIT) {
    state.drawUndoStack.shift();
  }
  state.drawRedoStack = [];
}

/**
 * Reverse (undo) a single action.
 */
function reverseAction(action) {
  switch (action.type) {
    case "addPoint":
      state.drawnRoute.splice(action.index, 1);
      break;
    case "movePoint":
      state.drawnRoute[action.index] = action.from;
      break;
    case "deletePoint":
      state.drawnRoute.splice(action.index, 0, action.point);
      break;
    case "insertMidpoint":
      state.drawnRoute.splice(action.index, 1);
      break;
    case "freehand":
      state.drawnRoute.splice(action.startIndex, action.points.length);
      break;
    case "clearAll":
      state.drawnRoute = [...action.points];
      break;
  }
}

/**
 * Reapply (redo) a single action.
 */
function reapplyAction(action) {
  switch (action.type) {
    case "addPoint":
      state.drawnRoute.splice(action.index, 0, action.point);
      break;
    case "movePoint":
      state.drawnRoute[action.index] = action.to;
      break;
    case "deletePoint":
      state.drawnRoute.splice(action.index, 1);
      break;
    case "insertMidpoint":
      state.drawnRoute.splice(action.index, 0, action.point);
      break;
    case "freehand":
      state.drawnRoute.splice(action.startIndex, 0, ...action.points);
      break;
    case "clearAll":
      state.drawnRoute = [];
      break;
  }
}

/**
 * Undo the last drawing action.
 */
export function undo() {
  if (!state.drawUndoStack.length) return;
  const action = state.drawUndoStack.pop();
  state.drawRedoStack.push(action);
  reverseAction(action);
  rebuildDrawLayers();
  debouncedSave();
  if (callbacks.onRouteChanged) callbacks.onRouteChanged();
}

/**
 * Redo the last undone drawing action.
 */
export function redo() {
  if (!state.drawRedoStack.length) return;
  const action = state.drawRedoStack.pop();
  state.drawUndoStack.push(action);
  reapplyAction(action);
  rebuildDrawLayers();
  debouncedSave();
  if (callbacks.onRouteChanged) callbacks.onRouteChanged();
}

function debouncedSave() {
  // Drawn route is intentionally ephemeral and should reset on refresh.
  return;
}

// --- Ramer-Douglas-Peucker simplification ---

/**
 * Perpendicular distance from point p to line segment (a, b).
 * All inputs are [x, y] in projected UTM space.
 */
function perpendicularDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  const projX = a[0] + t * dx;
  const projY = a[1] + t * dy;
  return Math.hypot(p[0] - projX, p[1] - projY);
}

/**
 * Ramer-Douglas-Peucker line simplification.
 * @param {Array<[number, number]>} points - Projected UTM coordinate pairs
 * @param {number} epsilon - Tolerance in meters
 * @returns {Array<[number, number]>} Simplified points
 */
function simplifyRDP(points, epsilon) {
  if (points.length <= 2) return points.slice();

  let maxDist = 0;
  let maxIndex = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }

  if (maxDist > epsilon) {
    const left = simplifyRDP(points.slice(0, maxIndex + 1), epsilon);
    const right = simplifyRDP(points.slice(maxIndex), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

// --- Distance calculation ---

/**
 * Get or create a transformer suitable for the current route points.
 */
function ensureDrawTransformer() {
  if (state.transformerState?.transformer) {
    return state.transformerState.transformer;
  }
  if (!state.drawnRoute.length) return null;
  const { transformer, epsg } = transformerForPoints(state.drawnRoute);
  state.transformerState = { transformer, epsg };
  state.projectionState = {
    pointsLonLat: state.drawnRoute,
    transformer,
    epsg,
    xs: [],
    ys: [],
  };
  return transformer;
}

function updateDistance() {
  if (!state.drawnRoute.length) {
    if (callbacks.onDistanceChanged) callbacks.onDistanceChanged("0 m");
    return;
  }
  try {
    const transformer = ensureDrawTransformer();
    if (!transformer) {
      if (callbacks.onDistanceChanged) callbacks.onDistanceChanged("0 m");
      return;
    }
    const { xs, ys } = projectPoints(state.drawnRoute, transformer);
    const totalMeters = trackLengthFromProjected(xs, ys);
    const formatted = formatDistance(totalMeters);
    if (callbacks.onDistanceChanged) callbacks.onDistanceChanged(formatted);
  } catch (error) {
    console.warn("draw-manager: distance calculation failed:", error);
    if (callbacks.onDistanceChanged) callbacks.onDistanceChanged("--");
  }
}

// --- Marker management ---

function markerRadius(index, total) {
  // First and last markers are larger to indicate endpoints
  if (index === 0 || index === total - 1) return 8;
  return 6;
}

function addWaypointMarker(latlng, index) {
  const total = state.drawnRoute.length;
  const marker = L.circleMarker(latlng, {
    radius: markerRadius(index, total),
    color: "#ffffff",
    weight: 2,
    fillColor: state.selections.trackColor,
    fillOpacity: 1,
    interactive: true,
    bubblingMouseEvents: false,
  });
  marker.addTo(state.drawLayerGroup);
  state.drawMarkers.splice(index, 0, marker);

  // Attach interaction handlers to the new marker
  attachMarkerHandlers(marker, index);

  // Update radii of all markers (endpoints may have changed)
  updateMarkerRadii();
}

function updateMarkerRadii() {
  const total = state.drawMarkers.length;
  for (let i = 0; i < total; i++) {
    const expected = markerRadius(i, total);
    if (state.drawMarkers[i].getRadius() !== expected) {
      state.drawMarkers[i].setRadius(expected);
    }
  }
}

// --- Marker interaction handlers (drag, click-to-select, Shift+click-to-delete) ---

function attachMarkerHandlers(marker, markerIndex) {
  // Store the index on the marker for retrieval during drag
  marker._drawIndex = markerIndex;

  // Hover enlargement to indicate interactivity
  marker.on("mouseover", () => {
    if (!state.drawModeActive) return;
    marker.setRadius(marker.getRadius() + 3);
    marker.getElement && marker.getElement()?.style && (marker.getElement().style.cursor = "grab");
  });
  marker.on("mouseout", () => {
    if (!state.drawModeActive) return;
    const total = state.drawMarkers.length;
    marker.setRadius(markerRadius(marker._drawIndex, total));
  });

  marker.on("mousedown", (e) => {
    if (!state.drawModeActive) return;
    const origEvent = e.originalEvent;

    // Prevent map pan
    L.DomEvent.stop(e);
    if (state.mapInstance) state.mapInstance.dragging.disable();

    // Start drag tracking
    _dragMarkerIndex = marker._drawIndex;
    _dragStartPos = [state.drawnRoute[_dragMarkerIndex][0], state.drawnRoute[_dragMarkerIndex][1]];
    _isDragging = false;

    const onDocMove = (moveEvent) => {
      _isDragging = true;
      const latlng = state.mapInstance.containerPointToLatLng(
        L.point(moveEvent.clientX, moveEvent.clientY)
      );
      marker.setLatLng(latlng);
      state.drawnRoute[_dragMarkerIndex] = [latlng.lng, latlng.lat];
      updatePolyline();
      // Do NOT update distance during drag (per locked decision)
    };

    const onDocUp = (upEvent) => {
      document.removeEventListener("mousemove", onDocMove);
      document.removeEventListener("mouseup", onDocUp);
      if (state.mapInstance) state.mapInstance.dragging.enable();

      // Suppress the next map click so it doesn't place a new point
      _suppressMapClick = true;
      setTimeout(() => { _suppressMapClick = false; }, 50);

      if (_isDragging && _dragStartPos) {
        const finalPos = [state.drawnRoute[_dragMarkerIndex][0], state.drawnRoute[_dragMarkerIndex][1]];
        pushUndo({ type: "movePoint", index: _dragMarkerIndex, from: _dragStartPos, to: finalPos });
        updateDistance();
        debouncedSave();
        if (callbacks.onRouteChanged) callbacks.onRouteChanged();
      } else {
        // It was a click, not a drag
        if (origEvent.shiftKey) {
          // Shift+click: quick delete
          deletePointAtIndex(_dragMarkerIndex);
        } else {
          // Regular click: show action bar
          selectPoint(_dragMarkerIndex);
        }
      }

      _dragMarkerIndex = null;
      _dragStartPos = null;
      _isDragging = false;
    };

    document.addEventListener("mousemove", onDocMove);
    document.addEventListener("mouseup", onDocUp);
  });
}

function reindexMarkers() {
  for (let i = 0; i < state.drawMarkers.length; i++) {
    state.drawMarkers[i]._drawIndex = i;
  }
}

// --- Point selection and deletion ---

function selectPoint(index) {
  state.drawSelectedPoint = index;
  if (callbacks.onPointSelected && state.mapInstance) {
    const [lon, lat] = state.drawnRoute[index];
    const containerPoint = state.mapInstance.latLngToContainerPoint(L.latLng(lat, lon));
    callbacks.onPointSelected(index, containerPoint);
  }
}

function deselectPoint() {
  state.drawSelectedPoint = null;
  if (callbacks.onPointDeselected) callbacks.onPointDeselected();
}

function deletePointAtIndex(index) {
  if (index < 0 || index >= state.drawnRoute.length) return;
  const point = state.drawnRoute[index];
  state.drawnRoute.splice(index, 1);
  pushUndo({ type: "deletePoint", index, point });
  deselectPoint();
  rebuildDrawLayers();
  debouncedSave();
  if (callbacks.onRouteChanged) callbacks.onRouteChanged();
}

/**
 * Delete the currently selected point (called from action bar button).
 */
export function deleteSelectedPoint() {
  if (state.drawSelectedPoint === null) return;
  deletePointAtIndex(state.drawSelectedPoint);
}

/**
 * Hide the point action bar.
 */
export function hidePointActionBar() {
  deselectPoint();
}

// --- Midpoint insertion (click on polyline) ---

function handlePolylineClick(e) {
  if (!state.drawModeActive) return;
  if (state.drawnRoute.length < 2) return;
  if (_suppressMapClick) return;

  L.DomEvent.stop(e);
  const clickLatLng = e.latlng;
  const clickPoint = state.mapInstance.latLngToContainerPoint(clickLatLng);

  // Find nearest segment
  let minDist = Infinity;
  let insertIndex = 1;

  for (let i = 0; i < state.drawnRoute.length - 1; i++) {
    const [lon1, lat1] = state.drawnRoute[i];
    const [lon2, lat2] = state.drawnRoute[i + 1];
    const p1 = state.mapInstance.latLngToContainerPoint(L.latLng(lat1, lon1));
    const p2 = state.mapInstance.latLngToContainerPoint(L.latLng(lat2, lon2));

    const dist = pointToSegmentDistance(clickPoint, p1, p2);
    if (dist < minDist) {
      minDist = dist;
      insertIndex = i + 1;
    }
  }

  const newPoint = [clickLatLng.lng, clickLatLng.lat];
  state.drawnRoute.splice(insertIndex, 0, newPoint);
  pushUndo({ type: "insertMidpoint", index: insertIndex, point: newPoint });
  rebuildDrawLayers();
  debouncedSave();
  if (callbacks.onRouteChanged) callbacks.onRouteChanged();
}

/**
 * Distance from point p to line segment (a, b) in container pixel space.
 */
function pointToSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

// --- Snap-to-existing-track ---

function updateSnapAndRubberBand(e) {
  if (!state.drawModeActive || !state.drawnRoute.length) {
    if (state.drawRubberBand) state.drawRubberBand.setLatLngs([]);
    _snapTarget = null;
    return;
  }
  if (state.drawFreehandActive) {
    if (state.drawRubberBand) state.drawRubberBand.setLatLngs([]);
    _snapTarget = null;
    return;
  }

  let cursorLatLng = e.latlng;
  _snapTarget = null;

  // Snap to uploaded GPX track if within 15px
  if (state.cachedPoints && state.cachedPoints.length > 0 && state.mapInstance) {
    const cursorContainer = state.mapInstance.latLngToContainerPoint(cursorLatLng);
    let minDist = Infinity;
    let snapCandidate = null;

    for (let i = 0; i < state.cachedPoints.length; i++) {
      const [lon, lat] = state.cachedPoints[i];
      const ptContainer = state.mapInstance.latLngToContainerPoint(L.latLng(lat, lon));
      const dist = Math.hypot(cursorContainer.x - ptContainer.x, cursorContainer.y - ptContainer.y);
      if (dist < minDist) {
        minDist = dist;
        snapCandidate = { lat, lon };
      }
    }

    if (minDist <= 15 && snapCandidate) {
      _snapTarget = snapCandidate;
      cursorLatLng = L.latLng(snapCandidate.lat, snapCandidate.lon);
    }
  }

  // Anchor point: last point if appending, first point if prepending
  const anchorIndex = state.drawAppendToEnd
    ? state.drawnRoute.length - 1
    : 0;
  const [anchorLon, anchorLat] = state.drawnRoute[anchorIndex];
  const anchorLatLng = [anchorLat, anchorLon];

  if (state.drawRubberBand) {
    state.drawRubberBand.setLatLngs([anchorLatLng, [cursorLatLng.lat, cursorLatLng.lng]]);
    state.drawRubberBand.setStyle({
      color: state.selections.trackColor,
      weight: state.selections.trackWidth,
      opacity: state.selections.trackOpacity * 0.5,
      dashArray: _snapTarget ? null : "8 8",
    });
  }
}

// --- Polyline management ---

function updatePolyline() {
  if (!state.drawPolyline) return;
  const latLngs = state.drawnRoute.map(([lon, lat]) => [lat, lon]);
  state.drawPolyline.setLatLngs(latLngs);
  state.drawPolyline.setStyle({
    color: state.selections.trackColor,
    weight: state.selections.trackWidth,
    opacity: state.selections.trackOpacity,
  });
}

// --- Rebuild layers ---

function rebuildDrawLayers() {
  if (!state.drawLayerGroup) return;
  // Remove all existing markers
  state.drawMarkers.forEach((m) => state.drawLayerGroup.removeLayer(m));
  state.drawMarkers = [];

  // Recreate markers from route
  state.drawnRoute.forEach(([lon, lat], index) => {
    const marker = L.circleMarker([lat, lon], {
      radius: markerRadius(index, state.drawnRoute.length),
      color: "#ffffff",
      weight: 2,
      fillColor: state.selections.trackColor,
      fillOpacity: 1,
      interactive: true,
      bubblingMouseEvents: false,
    });
    marker.addTo(state.drawLayerGroup);
    state.drawMarkers.push(marker);
    attachMarkerHandlers(marker, index);
  });

  // Reattach polyline click handler
  if (state.drawPolyline) {
    state.drawPolyline.off("click", handlePolylineClick);
    state.drawPolyline.on("click", handlePolylineClick);
  }

  updatePolyline();
  updateDistance();
}

// --- Freehand drawing ---

function getFreehandTransformer() {
  if (_freehandTransformer) return _freehandTransformer;
  const transformer = ensureDrawTransformer();
  if (transformer) {
    _freehandTransformer = transformer;
    return transformer;
  }
  return null;
}

function handleFreehandMouseDown(e) {
  if (!state.drawModeActive) return;
  if (!e.originalEvent?.shiftKey) return;

  L.DomEvent.stop(e);
  state.drawFreehandActive = true;
  state.drawFreehandBuffer = [];
  _freehandTransformer = null; // Reset for fresh projection

  // Capture the start point
  const latlng = e.latlng;
  state.drawFreehandBuffer.push([latlng.lng, latlng.lat]);
}

function handleFreehandMouseMove(e) {
  if (!state.drawFreehandActive) return;

  const latlng = e.latlng;
  const newPoint = [latlng.lng, latlng.lat];

  // Distance-based throttling: skip points closer than 20m in UTM space
  if (state.drawFreehandBuffer.length > 0) {
    const transformer = getFreehandTransformer();
    if (transformer) {
      const lastPoint = state.drawFreehandBuffer[state.drawFreehandBuffer.length - 1];
      const [lastX, lastY] = transformer.forward(lastPoint);
      const [newX, newY] = transformer.forward(newPoint);
      const dist = Math.hypot(newX - lastX, newY - lastY);
      if (dist < 20) return; // Skip points too close together
    }
  }

  state.drawFreehandBuffer.push(newPoint);

  // Live preview: temporarily add freehand points to polyline
  const previewRoute = state.drawAppendToEnd
    ? [...state.drawnRoute, ...state.drawFreehandBuffer]
    : [...state.drawFreehandBuffer.slice().reverse(), ...state.drawnRoute];
  const latLngs = previewRoute.map(([lon, lat]) => [lat, lon]);
  if (state.drawPolyline) {
    state.drawPolyline.setLatLngs(latLngs);
  }
}

function handleFreehandEnd() {
  if (!state.drawFreehandActive) return;
  state.drawFreehandActive = false;

  if (state.drawFreehandBuffer.length < 2) {
    state.drawFreehandBuffer = [];
    updatePolyline(); // Restore original polyline
    return;
  }

  // Project freehand points to UTM for simplification
  const transformer = getFreehandTransformer();
  let simplifiedLonLat = state.drawFreehandBuffer;

  if (transformer && state.drawFreehandBuffer.length > 2) {
    const projected = state.drawFreehandBuffer.map((p) => transformer.forward(p));
    const simplified = simplifyRDP(projected, 10); // 10m epsilon
    simplifiedLonLat = simplified.map((p) => transformer.inverse(p));
  }

  // Compute startIndex and push undo before mutating route
  const startIndex = state.drawAppendToEnd ? state.drawnRoute.length : 0;
  const pointsCopy = simplifiedLonLat.map((p) => [...p]);

  // Append/prepend simplified points to route
  if (state.drawAppendToEnd) {
    state.drawnRoute.push(...simplifiedLonLat);
  } else {
    state.drawnRoute.unshift(...simplifiedLonLat.reverse());
  }

  pushUndo({ type: "freehand", startIndex, points: pointsCopy });

  state.drawFreehandBuffer = [];
  _freehandTransformer = null;

  // Rebuild visual layers
  rebuildDrawLayers();
  debouncedSave();

  // Notify callbacks
  if (callbacks.onRouteChanged) callbacks.onRouteChanged();
}

function handleKeyUp(e) {
  // End freehand on Shift release
  if (e.key === "Shift" && state.drawFreehandActive) {
    handleFreehandEnd();
  }
}

// --- Map click handler ---

function handleMapClick(e) {
  if (!state.drawModeActive) return;
  if (state.drawFreehandActive) return;
  if (_suppressMapClick) return;

  L.DomEvent.stop(e);

  // Deselect any selected point when clicking on the map
  if (state.drawSelectedPoint !== null) {
    deselectPoint();
  }

  let latlng = e.latlng;

  // Use snapped position if available
  if (_snapTarget) {
    latlng = L.latLng(_snapTarget.lat, _snapTarget.lon);
  }

  const point = [latlng.lng, latlng.lat];

  if (state.drawAppendToEnd) {
    const index = state.drawnRoute.length;
    state.drawnRoute.push(point);
    pushUndo({ type: "addPoint", index, point });
    addWaypointMarker([latlng.lat, latlng.lng], state.drawnRoute.length - 1);
  } else {
    state.drawnRoute.unshift(point);
    pushUndo({ type: "addPoint", index: 0, point });
    // Rebuild all markers since indices shifted
    rebuildDrawLayers();
  }

  updatePolyline();
  updateDistance();
  debouncedSave();

  if (callbacks.onRouteChanged) callbacks.onRouteChanged();
}

// --- Clear route ---

export function clearDrawnRoute() {
  if (state.drawnRoute.length > 0) {
    pushUndo({ type: "clearAll", points: [...state.drawnRoute] });
  }
  state.drawnRoute = [];
  state.drawMarkers.forEach((m) => {
    if (state.drawLayerGroup) state.drawLayerGroup.removeLayer(m);
  });
  state.drawMarkers = [];
  if (state.drawPolyline) state.drawPolyline.setLatLngs([]);
  if (state.drawRubberBand) state.drawRubberBand.setLatLngs([]);
  deselectPoint();
  updateDistance();
  debouncedSave();
  if (callbacks.onRouteChanged) callbacks.onRouteChanged();
}

// --- Reverse direction ---

export function reverseAppendDirection() {
  state.drawnRoute.reverse();
  rebuildDrawLayers();
  debouncedSave();
  if (callbacks.onRouteChanged) callbacks.onRouteChanged();
}

// --- Toggle draw mode ---

export function toggleDrawMode() {
  const wasActive = state.drawModeActive;
  state.drawModeActive = !wasActive;

  if (state.drawModeActive) {
    // Enable draw mode
    const container = state.mapInstance.getContainer();
    container.style.cursor = "crosshair";

    // Add drawing layers to map
    if (!state.drawLayerGroup) {
      state.drawLayerGroup = L.layerGroup().addTo(state.mapInstance);
    } else if (!state.mapInstance.hasLayer(state.drawLayerGroup)) {
      state.drawLayerGroup.addTo(state.mapInstance);
    }

    // Create polyline if not exists
    if (!state.drawPolyline) {
      state.drawPolyline = L.polyline([], {
        color: state.selections.trackColor,
        weight: state.selections.trackWidth,
        opacity: state.selections.trackOpacity,
        interactive: true,
        bubblingMouseEvents: false,
      }).addTo(state.drawLayerGroup);
    }

    // Create rubber band if not exists
    if (!state.drawRubberBand) {
      state.drawRubberBand = L.polyline([], {
        color: state.selections.trackColor,
        weight: state.selections.trackWidth,
        opacity: state.selections.trackOpacity * 0.5,
        dashArray: "8 8",
      }).addTo(state.drawLayerGroup);
    }

    // Rebuild existing route visuals
    if (state.drawnRoute.length) {
      rebuildDrawLayers();
    }

    // Attach polyline click handler for midpoint insertion
    if (state.drawPolyline) {
      state.drawPolyline.on("click", handlePolylineClick);
    }

    // Register map event handlers
    _mapClickHandler = handleMapClick;
    _mouseMoveHandler = updateSnapAndRubberBand;
    _mouseDownHandler = handleFreehandMouseDown;
    _mouseUpHandler = handleFreehandEnd;
    _keyUpHandler = handleKeyUp;

    state.mapInstance.on("click", _mapClickHandler);
    state.mapInstance.on("mousemove", _mouseMoveHandler);
    state.mapInstance.on("mousedown", _mouseDownHandler);
    state.mapInstance.on("mouseup", _mouseUpHandler);
    document.addEventListener("keyup", _keyUpHandler);

    // Lock page overlays
    setPageOverlaysInteractive(false);
  } else {
    // Disable draw mode
    const container = state.mapInstance.getContainer();
    container.style.cursor = "";

    // End any active freehand
    if (state.drawFreehandActive) {
      handleFreehandEnd();
    }

    // Deselect any selected point
    deselectPoint();

    // Remove rubber band visual
    if (state.drawRubberBand) {
      state.drawRubberBand.setLatLngs([]);
    }

    // Remove polyline click handler
    if (state.drawPolyline) {
      state.drawPolyline.off("click", handlePolylineClick);
    }

    // Remove map event handlers
    if (_mapClickHandler) state.mapInstance.off("click", _mapClickHandler);
    if (_mouseMoveHandler) state.mapInstance.off("mousemove", _mouseMoveHandler);
    if (_mouseDownHandler) state.mapInstance.off("mousedown", _mouseDownHandler);
    if (_mouseUpHandler) state.mapInstance.off("mouseup", _mouseUpHandler);
    if (_keyUpHandler) document.removeEventListener("keyup", _keyUpHandler);

    _mapClickHandler = null;
    _mouseMoveHandler = null;
    _mouseDownHandler = null;
    _mouseUpHandler = null;
    _keyUpHandler = null;

    // Unlock page overlays
    setPageOverlaysInteractive(true);
  }

  if (callbacks.onDrawModeChanged) callbacks.onDrawModeChanged(state.drawModeActive);
}

// --- Initialization ---

/**
 * Initialize the drawing system.
 * @param {Object} cbs - Callbacks
 * @param {Function} cbs.onDistanceChanged - Called with formatted distance string
 * @param {Function} cbs.onDrawModeChanged - Called with boolean when draw mode toggles
 * @param {Function} cbs.onRouteChanged - Called when route points change
 * @param {Function} cbs.onPointSelected - Called with (index, containerPoint) when point selected
 * @param {Function} cbs.onPointDeselected - Called when point deselected
 */
// --- GPX export ---

/**
 * Escape XML special characters.
 */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert an array of [lon, lat] points to a valid GPX 1.1 XML string.
 * @param {Array<[number, number]>} pointsLonLat
 * @param {string} name - Track name
 * @returns {string} GPX XML
 */
export function routeToGpxXml(pointsLonLat, name = "Tegnet rute") {
  const trkpts = pointsLonLat.map(([lon, lat]) =>
    `        <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"/>`
  ).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd"
     version="1.1" creator="GPX-kortark">
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

/**
 * Trigger a file download of GPX XML content.
 * @param {string} xml - GPX XML string
 * @param {string} filename - Download filename
 */
export function triggerGpxDownload(xml, filename = "tegnet_rute.gpx") {
  const blob = new Blob([xml], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * Get a defensive copy of the drawn route.
 * @returns {Array<[number, number]>} Copy of drawnRoute
 */
export function getDrawnRoute() {
  return [...state.drawnRoute];
}

export function hasDrawnRoute() {
  return Array.isArray(state.drawnRoute) && state.drawnRoute.length > 0;
}

// --- Initialization ---

export function initDrawing(cbs) {
  callbacks = {
    onDistanceChanged: cbs.onDistanceChanged || null,
    onDrawModeChanged: cbs.onDrawModeChanged || null,
    onRouteChanged: cbs.onRouteChanged || null,
    onPointSelected: cbs.onPointSelected || null,
    onPointDeselected: cbs.onPointDeselected || null,
  };
}
