// overlays.js -- WMS overlay management (route, height, weak ice layers)
// Dependencies: state.js, constants.js, layers/height-tile-layer.js
// DOES NOT import from map-manager.js or ui-controller.js (no circular deps)

import { state } from "./state.js";
import {
  WMS_ROUTE_URL, WMS_HEIGHT_URL, WMS_WEAK_ICE_URL,
  WMS_ROUTE_LAYERS, WMS_WEAK_ICE_LAYERS,
  ROUTE_OVERLAY_OPACITY, DEFAULT_HEIGHT_OVERLAY_OPACITY,
  HEIGHT_OVERLAY_MIN_ZOOM,
} from "./constants.js";
import { createHeightTileLayer } from "./layers/height-tile-layer.js";

const L = window.L;

// --- Pane management ---

export function ensureRouteOverlayPane() {
  if (!state.mapInstance) return;
  const existing = state.mapInstance.getPane("routeOverlayPane");
  if (existing) return;
  const pane = state.mapInstance.createPane("routeOverlayPane");
  pane.style.zIndex = "350";
  pane.style.pointerEvents = "none";
}

export function ensureHeightOverlayPane() {
  if (!state.mapInstance) return;
  const existing = state.mapInstance.getPane("heightOverlayPane");
  if (existing) return;
  const pane = state.mapInstance.createPane("heightOverlayPane");
  pane.style.zIndex = "320";
  pane.style.pointerEvents = "none";
}

export function ensureWeakIceOverlayPane() {
  if (!state.mapInstance) return;
  const existing = state.mapInstance.getPane("weakIceOverlayPane");
  if (existing) return;
  const pane = state.mapInstance.createPane("weakIceOverlayPane");
  pane.style.zIndex = "330";
  pane.style.pointerEvents = "none";
}

// --- Layer factories ---

export function createRouteLayer(layerName) {
  return L.tileLayer.wms(WMS_ROUTE_URL, {
    layers: layerName,
    format: "image/png",
    transparent: true,
    opacity: ROUTE_OVERLAY_OPACITY,
    pane: "routeOverlayPane",
  });
}

export function createWeakIceLayer(layerName) {
  return L.tileLayer.wms(WMS_WEAK_ICE_URL, {
    layers: layerName,
    format: "image/png",
    transparent: true,
    opacity: effectiveWeakIceOpacity(),
    pane: "weakIceOverlayPane",
    minZoom: HEIGHT_OVERLAY_MIN_ZOOM,
  });
}

export function createHeightLayer(layerName) {
  const bounds = state.heightOverlayBounds ?? null;
  return createHeightTileLayer(layerName, {
    pane: "heightOverlayPane",
    opacity: effectiveHeightOpacity(),
    minZoom: HEIGHT_OVERLAY_MIN_ZOOM,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 0,
  }, bounds);
}

// --- Opacity helpers ---

export function effectiveHeightOpacity() {
  const el = document.getElementById("heightOpacity");
  if (!el) return DEFAULT_HEIGHT_OVERLAY_OPACITY;
  const value = Number(el.value);
  return Number.isFinite(value) ? value : DEFAULT_HEIGHT_OVERLAY_OPACITY;
}

export function effectiveWeakIceOpacity() {
  const el = document.getElementById("weakIceOpacity");
  if (!el) return 1;
  const value = Number(el.value);
  return Number.isFinite(value) ? value : 1;
}

// --- Selection queries ---

export function getSelectedHeightLayers() {
  const toggles = Array.from(document.querySelectorAll(".height-layer-toggle"));
  return toggles
    .filter((toggle) => toggle.checked)
    .map((toggle) => toggle.dataset.heightLayer)
    .filter(Boolean);
}

export function getSelectedWeakIceLayers() {
  const weakIceToggleEl = document.getElementById("weakIceToggle");
  if (!weakIceToggleEl?.checked) return [];
  return [...WMS_WEAK_ICE_LAYERS];
}

// --- Overlay toggle functions ---

export function updateRouteOverlays() {
  if (!state.mapInstance || !L) return;
  ensureRouteOverlayPane();
  const skiRoutesToggleEl = document.getElementById("skiRoutesToggle");
  const hikeRoutesToggleEl = document.getElementById("hikeRoutesToggle");
  const showSki = Boolean(skiRoutesToggleEl?.checked);
  const showHike = Boolean(hikeRoutesToggleEl?.checked);

  if (showSki && !state.skiRoutesLayer) {
    state.skiRoutesLayer = createRouteLayer(WMS_ROUTE_LAYERS.ski);
    state.skiRoutesLayer.addTo(state.mapInstance);
  } else if (!showSki && state.skiRoutesLayer) {
    state.mapInstance.removeLayer(state.skiRoutesLayer);
    state.skiRoutesLayer = null;
  }

  if (showHike && !state.hikeRoutesLayer) {
    state.hikeRoutesLayer = createRouteLayer(WMS_ROUTE_LAYERS.hike);
    state.hikeRoutesLayer.addTo(state.mapInstance);
  } else if (!showHike && state.hikeRoutesLayer) {
    state.mapInstance.removeLayer(state.hikeRoutesLayer);
    state.hikeRoutesLayer = null;
  }

  if (state.trackLayer) {
    state.trackLayer.setStyle({ opacity: state.selections.trackOpacity });
  }
}

export function updateHeightOverlays() {
  if (!state.mapInstance || !L) return;
  ensureHeightOverlayPane();
  const heightLayerToggleEls = Array.from(
    document.querySelectorAll(".height-layer-toggle")
  );
  heightLayerToggleEls.forEach((toggle) => {
    const layerName = toggle.dataset.heightLayer;
    if (!layerName) return;
    const shouldShow = Boolean(toggle.checked);
    const existing = state.heightOverlayLayers.get(layerName);
    if (shouldShow && !existing) {
      const layer = createHeightLayer(layerName);
      state.heightOverlayLayers.set(layerName, layer);
      layer.addTo(state.mapInstance);
    } else if (!shouldShow && existing) {
      state.mapInstance.removeLayer(existing);
      state.heightOverlayLayers.delete(layerName);
    }
  });
}

export function refreshHeightOverlays() {
  if (!state.mapInstance) return;
  state.heightOverlayLayers.forEach((layer) => {
    state.mapInstance.removeLayer(layer);
  });
  state.heightOverlayLayers = new Map();
  updateHeightOverlays();
}

export function updateWeakIceOverlays() {
  if (!state.mapInstance || !L) return;
  ensureWeakIceOverlayPane();
  const weakIceToggleEl = document.getElementById("weakIceToggle");
  const shouldShow = Boolean(weakIceToggleEl?.checked);
  WMS_WEAK_ICE_LAYERS.forEach((layerName) => {
    const existing = state.weakIceOverlayLayers.get(layerName);
    if (shouldShow && !existing) {
      const layer = createWeakIceLayer(layerName);
      state.weakIceOverlayLayers.set(layerName, layer);
      layer.addTo(state.mapInstance);
    } else if (!shouldShow && existing) {
      state.mapInstance.removeLayer(existing);
      state.weakIceOverlayLayers.delete(layerName);
    }
  });
}
