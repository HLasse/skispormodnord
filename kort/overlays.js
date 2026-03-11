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
import { PROVIDERS } from "./providers/config.js";
import { createHeightTileLayer } from "./layers/height-tile-layer.js";
import {
  DK_FACILITY_ICON_SIZE_PX,
  getDkFacilityIconPath,
} from "./dk-facility-icons.js";

const L = window.L;
const dkFriluftsdataConfig = PROVIDERS.dk?.wms?.friluftsdataRekreativeRuter ?? null;
const DK_FRILUFTSDATA_ROUTE_WFS_MAX_FEATURES = 1200;
const DK_FRILUFTSDATA_FACILITY_WFS_MAX_FEATURES = 5000;
const DK_FRILUFTSDATA_BOUNDS_KEY_DECIMALS = 3;
const DK_FRILUFTSDATA_FEATURE_CACHE_TTL_MS = 5 * 60 * 1000;
const DK_FRILUFTSDATA_ROUTE_FEATURE_CACHE_MAX_ENTRIES = 4;
const DK_FRILUFTSDATA_ROUTE_LAYER_CACHE_MAX_ENTRIES = 24;
const DK_FRILUFTSDATA_FACILITY_FEATURE_CACHE_MAX_ENTRIES = 6;
const DK_FRILUFTSDATA_FACILITY_LAYER_CACHE_MAX_ENTRIES = 36;
const DK_ROUTE_TYPE_COLORS = {
  Vandrerute: "#d1462f",
  Cykelrute: "#2b69c9",
  Loberute: "#7b3ea8",
  "Løberute": "#7b3ea8",
  Mountainbikerute: "#b36b00",
  Skirute: "#2f93c5",
  Riderute: "#6b4f2f",
  Sejlrute: "#1594a6",
  "Adgangsvej": "#4a4a4a",
  "Rekreativ sti": "#347a43",
  Motionsrute: "#9b3f6e",
  "Gratis fiskeri": "#1f7aa8",
  Bilrute: "#5b5b5b",
  "Andet": "#805f3f",
  "Trec-bane": "#3f7f73",
};
const DK_FACILITY_POINT_COLOR_PALETTE = [
  "#1f7aa8",
  "#d1462f",
  "#2b69c9",
  "#7b3ea8",
  "#2f8f46",
  "#8a5a23",
  "#a63f68",
  "#0b7f7a",
];
let dkFriluftsdataRouteAbortController = null;
let dkFriluftsdataRouteRequestToken = 0;
const dkFriluftsdataRouteFeatureCache = new Map();
const dkFriluftsdataRouteLayerCache = new Map();
let dkFriluftsdataFacilityAbortController = null;
let dkFriluftsdataFacilityRequestToken = 0;
const dkFriluftsdataFacilityFeatureCache = new Map();
const dkFriluftsdataFacilityLayerCache = new Map();
const dkFriluftsdataFacilityMarkerIconCache = new Map();

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

export function getSelectedDkFriluftsdataRouteTypes() {
  const selectEl = document.getElementById("dkRouteTypeSelect");
  if (selectEl instanceof HTMLSelectElement) {
    return Array.from(selectEl.selectedOptions)
      .map((option) => option.value)
      .filter(Boolean);
  }
  // Backward-compatible fallback if the old checkbox UI is still in DOM.
  const toggles = Array.from(document.querySelectorAll(".dk-route-type-toggle"));
  return toggles
    .filter((toggle) => toggle.checked)
    .map((toggle) => toggle.dataset.routeType)
    .filter(Boolean);
}

export function getSelectedDkFriluftsdataFacilityTypes() {
  const selectEl = document.getElementById("dkFacilityTypeSelect");
  if (selectEl instanceof HTMLSelectElement) {
    return Array.from(selectEl.selectedOptions)
      .map((option) => option.value)
      .filter(Boolean);
  }
  const toggles = Array.from(document.querySelectorAll(".dk-facility-type-toggle"));
  return toggles
    .filter((toggle) => toggle.checked)
    .map((toggle) => toggle.dataset.facilityType)
    .filter(Boolean);
}

function clearDkFriluftsdataRouteVectorLayer() {
  if (!state.mapInstance || !state.dkFriluftsdataRouteVectorLayer) return;
  state.mapInstance.removeLayer(state.dkFriluftsdataRouteVectorLayer);
  state.dkFriluftsdataRouteVectorLayer = null;
}

function clearDkFriluftsdataFacilityVectorLayer() {
  if (!state.mapInstance || !state.dkFriluftsdataFacilityVectorLayer) return;
  state.mapInstance.removeLayer(state.dkFriluftsdataFacilityVectorLayer);
  state.dkFriluftsdataFacilityVectorLayer = null;
}

function abortDkFriluftsdataRouteFetch() {
  if (dkFriluftsdataRouteAbortController) {
    dkFriluftsdataRouteAbortController.abort();
    dkFriluftsdataRouteAbortController = null;
  }
}

function abortDkFriluftsdataFacilityFetch() {
  if (dkFriluftsdataFacilityAbortController) {
    dkFriluftsdataFacilityAbortController.abort();
    dkFriluftsdataFacilityAbortController = null;
  }
}

function formatBoundsKeyCoord(value) {
  return Number(value).toFixed(DK_FRILUFTSDATA_BOUNDS_KEY_DECIMALS);
}

function selectedValuesKey(values) {
  return [...new Set(values)].sort().join("|");
}

function touchCacheEntry(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
}

function pruneFeatureCache(cache, maxEntries) {
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function pruneLayerCache(cache, maxEntries, activeLayer) {
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.get(oldestKey);
    if (oldest?.layer && oldest.layer !== activeLayer) {
      try {
        oldest.layer.remove();
      } catch (_) {
        // Ignore stale layer removal errors.
      }
    }
    cache.delete(oldestKey);
  }
}

function getCachedFeatures(cache, boundsKey) {
  const entry = cache.get(boundsKey);
  if (!entry) return null;
  if ((Date.now() - entry.cachedAt) > DK_FRILUFTSDATA_FEATURE_CACHE_TTL_MS) {
    cache.delete(boundsKey);
    return null;
  }
  touchCacheEntry(cache, boundsKey, entry);
  return entry.features;
}

function setCachedFeatures(cache, boundsKey, features, maxEntries) {
  touchCacheEntry(cache, boundsKey, {
    cachedAt: Date.now(),
    features,
  });
  pruneFeatureCache(cache, maxEntries);
}

function getCachedLayer(cache, layerKey) {
  const entry = cache.get(layerKey);
  if (!entry) return null;
  touchCacheEntry(cache, layerKey, entry);
  return entry.layer;
}

function setCachedLayer(cache, layerKey, layer, maxEntries, activeLayer) {
  touchCacheEntry(cache, layerKey, {
    cachedAt: Date.now(),
    layer,
  });
  pruneLayerCache(cache, maxEntries, activeLayer);
}

function activateDkFriluftsdataRouteVectorLayer(layer) {
  if (!state.mapInstance || !layer) return;
  if (state.dkFriluftsdataRouteVectorLayer && state.dkFriluftsdataRouteVectorLayer !== layer) {
    state.mapInstance.removeLayer(state.dkFriluftsdataRouteVectorLayer);
  }
  state.dkFriluftsdataRouteVectorLayer = layer;
  if (!state.mapInstance.hasLayer(layer)) {
    layer.addTo(state.mapInstance);
  }
}

function activateDkFriluftsdataFacilityVectorLayer(layer) {
  if (!state.mapInstance || !layer) return;
  if (state.dkFriluftsdataFacilityVectorLayer && state.dkFriluftsdataFacilityVectorLayer !== layer) {
    state.mapInstance.removeLayer(state.dkFriluftsdataFacilityVectorLayer);
  }
  state.dkFriluftsdataFacilityVectorLayer = layer;
  if (!state.mapInstance.hasLayer(layer)) {
    layer.addTo(state.mapInstance);
  }
}

function buildDkFriluftsdataWfsRequest({ typeName, maxFeatures, propertyName }) {
  if (!state.mapInstance || !dkFriluftsdataConfig) return null;
  const bounds = state.mapInstance.getBounds();
  const south = bounds.getSouth();
  const west = bounds.getWest();
  const north = bounds.getNorth();
  const east = bounds.getEast();
  const bbox = [
    south,
    west,
    north,
    east,
    "EPSG:4326",
  ].join(",");
  const boundsKey = [
    formatBoundsKeyCoord(south),
    formatBoundsKeyCoord(west),
    formatBoundsKeyCoord(north),
    formatBoundsKeyCoord(east),
  ].join(",");
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: typeName,
    outputFormat: "application/json",
    srsName: "EPSG:4326",
    count: String(maxFeatures),
    bbox,
    propertyName,
  });
  return {
    boundsKey,
    url: `${dkFriluftsdataConfig.url}?${params.toString()}`,
  };
}

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseWfsFeatureCollection(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const firstObject = extractFirstJsonObject(text);
    if (!firstObject) {
      throw error;
    }
    return JSON.parse(firstObject);
  }
}

function styleDkFriluftsdataRouteFeature(feature) {
  const routeType = feature?.properties?.rute_ty;
  const color = DK_ROUTE_TYPE_COLORS[routeType] || "#d36b2d";
  return {
    color,
    weight: 3,
    opacity: 0.9,
    lineCap: "round",
    lineJoin: "round",
  };
}

function colorForDkFacilityType(facilityType) {
  const key = String(facilityType || "");
  if (!key) return DK_FACILITY_POINT_COLOR_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % DK_FACILITY_POINT_COLOR_PALETTE.length;
  return DK_FACILITY_POINT_COLOR_PALETTE[index];
}

function styleDkFriluftsdataFacilityPoint(feature) {
  const fillColor = colorForDkFacilityType(feature?.properties?.facil_ty);
  return {
    pane: "routeOverlayPane",
    interactive: false,
    radius: 4,
    weight: 1,
    color: "#ffffff",
    opacity: 0.95,
    fillColor,
    fillOpacity: 0.9,
  };
}

function createDkFriluftsdataFacilityMarker(feature, latlng) {
  const iconPath = getDkFacilityIconPath(feature?.properties?.facil_ty);
  if (!iconPath) {
    return L.circleMarker(latlng, styleDkFriluftsdataFacilityPoint(feature));
  }
  let icon = dkFriluftsdataFacilityMarkerIconCache.get(iconPath);
  if (!icon) {
    const halfSize = DK_FACILITY_ICON_SIZE_PX / 2;
    icon = L.icon({
      iconUrl: iconPath,
      iconSize: [DK_FACILITY_ICON_SIZE_PX, DK_FACILITY_ICON_SIZE_PX],
      iconAnchor: [halfSize, halfSize],
      className: "dk-facility-icon-marker",
    });
    dkFriluftsdataFacilityMarkerIconCache.set(iconPath, icon);
  }
  return L.marker(latlng, {
    pane: "routeOverlayPane",
    interactive: false,
    keyboard: false,
    icon,
  });
}

async function renderFilteredDkFriluftsdataRoutes(routeTypes) {
  if (!state.mapInstance || !L || !dkFriluftsdataConfig) return;
  const request = buildDkFriluftsdataWfsRequest({
    typeName: "fkg:fkg.t_5802_fac_li",
    maxFeatures: DK_FRILUFTSDATA_ROUTE_WFS_MAX_FEATURES,
    propertyName: "geometri,rute_ty",
  });
  if (!request) return;
  const selectedRouteTypes = [...new Set(routeTypes)];
  const layerKey = `${request.boundsKey}::${selectedValuesKey(selectedRouteTypes)}`;

  const cachedLayer = getCachedLayer(dkFriluftsdataRouteLayerCache, layerKey);
  if (cachedLayer) {
    abortDkFriluftsdataRouteFetch();
    activateDkFriluftsdataRouteVectorLayer(cachedLayer);
    return;
  }

  let sourceFeatures = getCachedFeatures(dkFriluftsdataRouteFeatureCache, request.boundsKey);

  try {
    if (!sourceFeatures) {
      abortDkFriluftsdataRouteFetch();
      dkFriluftsdataRouteAbortController = new AbortController();
      const requestToken = ++dkFriluftsdataRouteRequestToken;

      const response = await fetch(request.url, {
        mode: "cors",
        signal: dkFriluftsdataRouteAbortController.signal,
      });
      if (!response.ok) {
        throw new Error(`WFS request failed (${response.status}).`);
      }
      const payloadText = await response.text();
      const payload = parseWfsFeatureCollection(payloadText);
      if (requestToken !== dkFriluftsdataRouteRequestToken) return;
      sourceFeatures = payload.features || [];
      setCachedFeatures(
        dkFriluftsdataRouteFeatureCache,
        request.boundsKey,
        sourceFeatures,
        DK_FRILUFTSDATA_ROUTE_FEATURE_CACHE_MAX_ENTRIES
      );
    }

    const selected = new Set(selectedRouteTypes);
    const features = (sourceFeatures || []).filter((feature) => {
      const routeType = feature?.properties?.rute_ty;
      return selected.has(routeType);
    });

    clearDkFriluftsdataRouteVectorLayer();
    if (!features.length) return;

    const layer = L.geoJSON(
      { type: "FeatureCollection", features },
      {
        pane: "routeOverlayPane",
        interactive: false,
        style: styleDkFriluftsdataRouteFeature,
      }
    );
    setCachedLayer(
      dkFriluftsdataRouteLayerCache,
      layerKey,
      layer,
      DK_FRILUFTSDATA_ROUTE_LAYER_CACHE_MAX_ENTRIES,
      state.dkFriluftsdataRouteVectorLayer
    );
    activateDkFriluftsdataRouteVectorLayer(layer);
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.warn("Failed to render filtered DK route overlay:", error);
  }
}

async function renderFilteredDkFriluftsdataFacilities(facilityTypes) {
  if (!state.mapInstance || !L || !dkFriluftsdataConfig) return;
  const request = buildDkFriluftsdataWfsRequest({
    typeName: "fkg:fkg.t_5800_fac_pkt",
    maxFeatures: DK_FRILUFTSDATA_FACILITY_WFS_MAX_FEATURES,
    propertyName: "geometri,facil_ty",
  });
  if (!request) return;
  const selectedFacilityTypes = [...new Set(facilityTypes)];
  const layerKey = `${request.boundsKey}::${selectedValuesKey(selectedFacilityTypes)}`;

  const cachedLayer = getCachedLayer(dkFriluftsdataFacilityLayerCache, layerKey);
  if (cachedLayer) {
    abortDkFriluftsdataFacilityFetch();
    activateDkFriluftsdataFacilityVectorLayer(cachedLayer);
    return;
  }

  let sourceFeatures = getCachedFeatures(dkFriluftsdataFacilityFeatureCache, request.boundsKey);

  try {
    if (!sourceFeatures) {
      abortDkFriluftsdataFacilityFetch();
      dkFriluftsdataFacilityAbortController = new AbortController();
      const requestToken = ++dkFriluftsdataFacilityRequestToken;

      const response = await fetch(request.url, {
        mode: "cors",
        signal: dkFriluftsdataFacilityAbortController.signal,
      });
      if (!response.ok) {
        throw new Error(`WFS request failed (${response.status}).`);
      }
      const payloadText = await response.text();
      const payload = parseWfsFeatureCollection(payloadText);
      if (requestToken !== dkFriluftsdataFacilityRequestToken) return;
      sourceFeatures = payload.features || [];
      setCachedFeatures(
        dkFriluftsdataFacilityFeatureCache,
        request.boundsKey,
        sourceFeatures,
        DK_FRILUFTSDATA_FACILITY_FEATURE_CACHE_MAX_ENTRIES
      );
    }

    const selected = new Set(selectedFacilityTypes);
    const features = (sourceFeatures || []).filter((feature) => {
      const facilityType = feature?.properties?.facil_ty;
      return selected.has(facilityType);
    });

    clearDkFriluftsdataFacilityVectorLayer();
    if (!features.length) return;

    const layer = L.geoJSON(
      { type: "FeatureCollection", features },
      {
        pane: "routeOverlayPane",
        interactive: false,
        pointToLayer: (feature, latlng) => createDkFriluftsdataFacilityMarker(feature, latlng),
      }
    );
    setCachedLayer(
      dkFriluftsdataFacilityLayerCache,
      layerKey,
      layer,
      DK_FRILUFTSDATA_FACILITY_LAYER_CACHE_MAX_ENTRIES,
      state.dkFriluftsdataFacilityVectorLayer
    );
    activateDkFriluftsdataFacilityVectorLayer(layer);
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.warn("Failed to render filtered DK facility overlay:", error);
  }
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

export function updateDkFriluftsdataOverlays() {
  if (!state.mapInstance || !L || !dkFriluftsdataConfig) return;
  ensureRouteOverlayPane();
  const isRouteEnabled = Boolean(document.getElementById("dkRekreativeRoutesToggle")?.checked);
  const isFacilityEnabled = Boolean(document.getElementById("dkRekreativeFacilitiesToggle")?.checked);
  const selectedRouteTypes = getSelectedDkFriluftsdataRouteTypes();
  const selectedFacilityTypes = getSelectedDkFriluftsdataFacilityTypes();

  if (!isRouteEnabled || !selectedRouteTypes.length) {
    abortDkFriluftsdataRouteFetch();
    clearDkFriluftsdataRouteVectorLayer();
  } else {
    void renderFilteredDkFriluftsdataRoutes(selectedRouteTypes);
  }

  if (!isFacilityEnabled || !selectedFacilityTypes.length) {
    abortDkFriluftsdataFacilityFetch();
    clearDkFriluftsdataFacilityVectorLayer();
  } else {
    void renderFilteredDkFriluftsdataFacilities(selectedFacilityTypes);
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
