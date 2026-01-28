import proj4 from "https://cdn.jsdelivr.net/npm/proj4@2.9.0/+esm";
import geomagnetism from "https://cdn.jsdelivr.net/npm/geomagnetism@0.2.0/+esm";
import { PDFDocument } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";

const L = window.L;

const WMS_BASE_URL = "https://wms.geonorge.no/skwms1/wms.topo";
const WMS_GRID_URL = "https://wms.geonorge.no/skwms1/wms.rutenett";
const WMS_ROUTE_URL = "https://wms.geonorge.no/skwms1/wms.friluftsruter2";
const WMS_HEIGHT_URL = "https://wms.geonorge.no/skwms1/wms.hoyde-dtm";
const WMS_WEAK_ICE_URL =
  "https://kart.nve.no/enterprise/services/SvekketIs1/MapServer/WMSServer";
const WMS_ROUTE_LAYERS = {
  ski: "Skiloype",
  hike: "Fotrute",
};
const WMS_WEAK_ICE_LAYERS = [
  "SvekketIs",
  "SvekketIsElv",
  "SvekketIsIkkeVurdert",
  "OppsprukketIsLangsLand",
];

// Kartverket cache (WMTS/XYZ-style REST endpoints)
// Capabilities are documented here: https://cache.kartverket.no/
const WMTS_CAPABILITIES_URL =
  "https://cache.kartverket.no/v1/wmts/1.0.0/WMTSCapabilities.xml";
const WMTS_BASE_URL = "https://cache.kartverket.no/v1/wmts/1.0.0";
const MAP_TILE_MATRIX_SET = "webmercator";

// "toporaster" is Kartverket's topo raster/turkart layer.
// Other layers: topo, topograatone, sjokartraster.
const DEFAULT_LAYER = "toporaster";
const GRID_LAYER = "1km_rutelinje";
const MAP_TILE_URL = `${WMTS_BASE_URL}/${DEFAULT_LAYER}/default/${MAP_TILE_MATRIX_SET}/{z}/{y}/{x}.png`;
const MAP_ATTRIBUTION = "&copy; Kartverket";

// For PDF export, WMTS requires stitching many tiles. If a page would require
// too many tiles at the highest zoom, we automatically step down.
const WMTS_MAX_TILES_PER_PAGE = 120;
const WMTS_TILE_SIZE = 256;
const USE_WMTS_FOR_BASEMAP = true;
const ROUTE_OVERLAY_OPACITY = 1;
const DEFAULT_HEIGHT_OVERLAY_OPACITY = 0.2;
const HEIGHT_OVERLAY_MIN_ZOOM = 10;
const HEIGHT_OVERLAY_MASK_COLORS = [
  { r: 0x92, g: 0xd0, b: 0x60 },
  { r: 0xd9, g: 0xf0, b: 0x8b },
];
const HEIGHT_OVERLAY_MASK_TOLERANCE = 18;
const HEIGHT_TILE_CACHE_LIMIT = 200;
const DEFAULT_DPI = 300;
const DEFAULT_JPEG_QUALITY = 0.9;
const HEIGHT_OVERLAY_SCALE_BY_MAP_SCALE = {
  25000: 0.55,
  50000: 0.45,
  100000: 0.35,
};
const DEFAULT_OVERLAP = 0.05;
const DEFAULT_MARGIN = 0.15;
const DEFAULT_TRACK_OPACITY = 0.8;
const TRACK_STROKE_PX = 4;
const PAGE_RENDER_CONCURRENCY = 4;
const LARGE_FILE_THRESHOLD = 1024 * 1024;
const PAGE_STYLE = {
  color: "#1e1b16",
  weight: 2,
  fill: true,
  fillOpacity: 0.3,
};
const PAGE_STYLE_SELECTED = {
  color: "#d36b2d",
  weight: 3,
  fill: true,
  fillOpacity: 0.38,
};
const PAGE_FILL_COLOR = "#f1b27c";
const PAPER_SIZES_MM = {
  A5: [148.0, 210.0],
  A4: [210.0, 297.0],
  A3: [297.0, 420.0],
};
const ALLOWED_SCALES = new Set([25000, 50000, 100000]);

const renderStatusEl = document.getElementById("renderStatus");
const statusTextEl = document.getElementById("renderStatusText");
const spinnerEl = document.getElementById("spinner");
const progressEl = document.getElementById("progress");
const fileMetaEl = document.getElementById("fileMeta");
const dropzoneEl = document.getElementById("dropzone");
const downloadLink = document.getElementById("downloadLink");
const renderBtn = document.getElementById("renderBtn");
const renderProgressEl = document.getElementById("renderProgress");
const mapEl = document.getElementById("map");
const selectionBarEl = document.getElementById("selectionBar");
const selectionSelectEl = document.getElementById("selectionSelect");
const orientationToggleEl = document.getElementById("orientationToggle");
const removePageBtn = document.getElementById("removePageBtn");
const addPageBtn = document.getElementById("addPageBtn");
const colorPickerEl = document.getElementById("colorPicker");
const sidebarEl = document.getElementById("sidebar");
const sidebarToggleEl = document.getElementById("sidebarToggle");
const confirmModalEl = document.getElementById("confirmModal");
const confirmTextEl = document.getElementById("confirmText");
const confirmAcceptBtn = document.getElementById("confirmAcceptBtn");
const confirmCancelBtn = document.getElementById("confirmCancelBtn");
const skiRoutesToggleEl = document.getElementById("skiRoutesToggle");
const hikeRoutesToggleEl = document.getElementById("hikeRoutesToggle");
const heightLegendEl = document.getElementById("heightLegend");
const heightLegendImgEl = document.getElementById("heightLegendImg");
const heightLayerToggleEls = Array.from(
  document.querySelectorAll(".height-layer-toggle")
);
const weakIceToggleEl = document.getElementById("weakIceToggle");
const heightOpacityGroupEl = document.getElementById("heightOpacityGroup");
const heightOpacityEl = document.getElementById("heightOpacity");
const heightOpacityValueEl = document.getElementById("heightOpacityValue");
const weakIceOpacityGroupEl = document.getElementById("weakIceOpacityGroup");
const weakIceOpacityEl = document.getElementById("weakIceOpacity");
const weakIceOpacityValueEl = document.getElementById("weakIceOpacityValue");
const heightMaskGroupEl = document.getElementById("heightMaskGroup");
const heightMaskGreenAEl = document.getElementById("heightMaskGreenA");
const heightMaskGreenBEl = document.getElementById("heightMaskGreenB");
const overlapValueEl = document.getElementById("overlapValue");
const marginValueEl = document.getElementById("marginValue");
const trackOpacityEl = document.getElementById("trackOpacity");
const trackOpacityValueEl = document.getElementById("trackOpacityValue");
const trackWidthEl = document.getElementById("trackWidth");
const trackWidthValueEl = document.getElementById("trackWidthValue");
const trackControlsEl = document.getElementById("trackControls");
const pdfJpegToggleEl = document.getElementById("pdfJpegToggle");
const jpegQualityGroupEl = document.getElementById("jpegQualityGroup");
const jpegQualityEl = document.getElementById("jpegQuality");
const jpegQualityValueEl = document.getElementById("jpegQualityValue");

const selections = {
  paper: "A4",
  scale: 50000,
  orientation: "auto",
  trackColor: "#ff3b30",
  trackOpacity: 0.8,
  trackWidth: TRACK_STROKE_PX,
};

let selectedFile = null;
let cachedPoints = null;
let transformerState = null;
let projectionState = null;
let mapInstance = null;
let trackLayer = null;
let pageLayerGroup = null;
let pageLayers = [];
let pageLabelLayers = [];
let pageColors = [];
let skiRoutesLayer = null;
let hikeRoutesLayer = null;
let heightOverlayLayers = new Map();
let weakIceOverlayLayers = new Map();
let heightOverlayBounds = null;
const heightTileBitmapCache = new Map();
const heightTileMaskedCache = new Map();
let selectionMarker = null;
let layoutPages = [];
let selectedPageIndex = null;
let hasManualEdits = false;
let isLayoutReady = false;
let downloadUrl = null;
let dragState = null;
let dragListenersActive = false;
let nextPageId = 1;
let confirmResolver = null;
let gpxWorker = null;
let gpxWorkerRequestId = 0;
const gpxWorkerPending = new Map();

function setStatus(message, isLoading = false) {
  if (!renderStatusEl || !statusTextEl) return;
  const text = String(message || "");
  const show = isLoading || text.startsWith("Fejl");
  statusTextEl.textContent = show ? text : "";
  renderStatusEl.classList.toggle("visible", show);
  if (spinnerEl) {
    spinnerEl.classList.toggle("hidden", !isLoading);
  }
}

function setRenderProgress(completed, total, visible) {
  if (!renderProgressEl) return;
  if (visible) {
    renderProgressEl.max = Math.max(total, 1);
    renderProgressEl.value = Math.min(completed, total);
    renderProgressEl.classList.remove("hidden");
  } else {
    renderProgressEl.classList.add("hidden");
  }
}

function setDownload(blob) {
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
  }
  downloadUrl = URL.createObjectURL(blob);
  if (downloadLink) {
    downloadLink.href = downloadUrl;
    downloadLink.download = "trail_map.pdf";
    downloadLink.classList.remove("disabled");
    return;
  }
  window.open(downloadUrl, "_blank", "noopener");
  setTimeout(() => {
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      downloadUrl = null;
    }
  }, 60000);
}

function clearDownload() {
  if (downloadLink) {
    downloadLink.classList.add("disabled");
    downloadLink.removeAttribute("href");
  }
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
  }
  setRenderProgress(0, 1, false);
}

function resetLayoutState() {
  clearPageOverlays();
  layoutPages = [];
  isLayoutReady = false;
  hasManualEdits = false;
  selectedPageIndex = null;
  pageColors = [];
  heightOverlayBounds = null;
  refreshHeightOverlays();
  updateSelectionBar();
  updateRenderButtonState();
}

function setProgress(activeStep, doneSteps) {
  if (!progressEl) return;
  progressEl.querySelectorAll("li").forEach((item) => {
    const step = Number(item.dataset.step);
    item.classList.toggle("done", doneSteps.includes(step));
    item.classList.toggle("active", step === activeStep);
  });
}

function setSegmentedActive(group, value, attr) {
  group.querySelectorAll("button").forEach((btn) => {
    const isActive = btn.dataset[attr] === value;
    btn.classList.toggle("active", isActive);
  });
}

function setTrackControlsVisible(isVisible) {
  if (!trackControlsEl) return;
  trackControlsEl.classList.toggle("hidden", !isVisible);
}

function setupSegmentedControls() {
  const paperGroup = document.querySelector("[aria-label='Papirstørrelse']");
  const scaleGroup = document.querySelector("[aria-label='Målestok']");
  const orientationGroup = document.querySelector("[aria-label='Orientering']");

  paperGroup.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const nextPaper = button.dataset.paper;
    if (nextPaper === selections.paper) return;
    if (!(await confirmOverrideManualEdits())) {
      setSegmentedActive(paperGroup, selections.paper, "paper");
      return;
    }
    selections.paper = nextPaper;
    setSegmentedActive(paperGroup, selections.paper, "paper");
    if (cachedPoints) {
      generateLayout("Papirstørrelsen er ændret. Layout opdateres...");
    }
  });

  scaleGroup.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const nextScale = Number(button.dataset.scale);
    if (nextScale === selections.scale) return;
    if (!(await confirmOverrideManualEdits())) {
      setSegmentedActive(scaleGroup, String(selections.scale), "scale");
      return;
    }
    selections.scale = nextScale;
    setSegmentedActive(scaleGroup, String(selections.scale), "scale");
    if (cachedPoints) {
      generateLayout("Målestokken er ændret. Layout opdateres...");
    }
  });

  orientationGroup.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const nextOrientation = button.dataset.orientation;
    if (nextOrientation === selections.orientation) return;
    if (!(await confirmOverrideManualEdits())) {
      setSegmentedActive(
        orientationGroup,
        String(selections.orientation),
        "orientation"
      );
      return;
    }
    selections.orientation = nextOrientation;
    setSegmentedActive(
      orientationGroup,
      String(selections.orientation),
      "orientation"
    );
    if (cachedPoints) {
      generateLayout("Orienteringen er ændret. Layout opdateres...");
    }
  });
}

function setupColorPicker() {
  if (!colorPickerEl) return;
  colorPickerEl.querySelectorAll(".color-swatch").forEach((btn) => {
    const swatch = btn;
    const color = swatch.dataset.color;
    if (color) {
      swatch.style.background = color;
    }
    if (color === selections.trackColor) {
      swatch.classList.add("active");
    }
    swatch.addEventListener("click", () => {
      if (!color) return;
      selections.trackColor = color;
      colorPickerEl.querySelectorAll(".color-swatch").forEach((el) => {
        el.classList.toggle("active", el === swatch);
      });
      if (trackLayer) {
        trackLayer.setStyle({ color: selections.trackColor });
      }
    });
  });
}

function setupTrackOpacity() {
  if (!trackOpacityEl) return;
  selections.trackOpacity = Number(trackOpacityEl.value);
  updateTrackOpacityLabel();
  trackOpacityEl.addEventListener("input", () => {
    const value = Number(trackOpacityEl.value);
    if (!Number.isFinite(value)) return;
    selections.trackOpacity = value;
    updateTrackOpacityLabel();
    if (trackLayer) {
      trackLayer.setStyle({ opacity: effectiveTrackOpacity() });
    }
  });
}

function setupTrackWidth() {
  if (!trackWidthEl) return;
  selections.trackWidth = Number(trackWidthEl.value);
  updateTrackWidthLabel();
  trackWidthEl.addEventListener("input", () => {
    const value = Number(trackWidthEl.value);
    if (!Number.isFinite(value)) return;
    selections.trackWidth = value;
    updateTrackWidthLabel();
    if (trackLayer) {
      trackLayer.setStyle({ weight: selections.trackWidth });
    }
  });
}

function setupSidebarToggle() {
  if (!sidebarToggleEl || !sidebarEl) return;
  sidebarEl.classList.add("open");
  sidebarToggleEl.addEventListener("click", () => {
    sidebarEl.classList.toggle("open");
    if (mapInstance) {
      setTimeout(() => {
        mapInstance.invalidateSize();
      }, 320);
    }
  });
}

function setupConfirmModal() {
  if (!confirmModalEl || !confirmAcceptBtn || !confirmCancelBtn) return;
  confirmAcceptBtn.addEventListener("click", () => {
    handleConfirmChoice(true);
  });
  confirmCancelBtn.addEventListener("click", () => {
    handleConfirmChoice(false);
  });
  confirmModalEl.addEventListener("click", (event) => {
    if (event.target === confirmModalEl) {
      handleConfirmChoice(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && confirmModalEl.classList.contains("open")) {
      handleConfirmChoice(false);
    }
  });
}

function updateRenderButtonState() {
  const ready = Boolean(layoutPages.length);
  renderBtn.disabled = !ready;
  renderBtn.classList.toggle("ready", ready);
}

function markLayoutCustomized(message) {
  hasManualEdits = true;
  clearDownload();
  updateRenderButtonState();
  if (message) {
    setStatus(message);
  }
}

function setConfirmModalOpen(isOpen) {
  if (!confirmModalEl) return;
  confirmModalEl.classList.toggle("open", isOpen);
  confirmModalEl.setAttribute("aria-hidden", String(!isOpen));
}

function handleConfirmChoice(accepted) {
  if (!confirmResolver) return;
  const resolve = confirmResolver;
  confirmResolver = null;
  setConfirmModalOpen(false);
  resolve(accepted);
}

function showConfirmModal(message) {
  if (!confirmModalEl || !confirmTextEl || !confirmAcceptBtn || !confirmCancelBtn) {
    return Promise.resolve(window.confirm(message));
  }
  if (confirmResolver) {
    return Promise.resolve(false);
  }

  confirmTextEl.textContent = message;
  setConfirmModalOpen(true);
  confirmAcceptBtn.focus();

  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

async function confirmOverrideManualEdits() {
  if (!hasManualEdits) return true;
  const ok = await showConfirmModal(
    "Du har ændret layoutet manuelt. Hvis du ændrer indstillingerne, overskrives dine ændringer. Vil du fortsætte?"
  );
  if (ok) {
    hasManualEdits = false;
  }
  return ok;
}

function parseGPX(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const points = Array.from(doc.querySelectorAll("trkpt")).map((pt) => {
    const lon = Number(pt.getAttribute("lon"));
    const lat = Number(pt.getAttribute("lat"));
    return [lon, lat];
  });

  if (!points.length) {
    throw new Error("Ingen sporpunkt fundet i GPX-filen.");
  }
  return points;
}

function buildProjection(pointsLonLat) {
  const { transformer, epsg } = transformerForPoints(pointsLonLat);
  const { xs, ys } = projectPoints(pointsLonLat, transformer);
  return { pointsLonLat, transformer, epsg, xs, ys };
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "n/a";
  if (meters < 1000) {
    return `${meters.toFixed(0)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

function computeTrackLengthMeters(pointsLonLat) {
  const projection = projectionState;
  const xs = projection?.xs;
  const ys = projection?.ys;
  if (xs && ys && xs.length === ys.length) {
    return trackLengthFromProjected(xs, ys);
  }
  const { transformer } = transformerForPoints(pointsLonLat);
  const projected = projectPoints(pointsLonLat, transformer);
  return trackLengthFromProjected(projected.xs, projected.ys);
}

function trackLengthFromProjected(xs, ys) {
  let total = 0;
  for (let i = 1; i < xs.length; i += 1) {
    const dx = xs[i] - xs[i - 1];
    const dy = ys[i] - ys[i - 1];
    total += Math.hypot(dx, dy);
  }
  return total;
}

function utmZoneFromLon(lon) {
  return Math.floor((lon + 180) / 6) + 1;
}

function inferLocalEtrs89Utm(pointsLonLat) {
  const lons = pointsLonLat.map((p) => p[0]);
  const meanLon = lons.reduce((a, b) => a + b, 0) / lons.length;
  const zone = utmZoneFromLon(meanLon);
  return 25800 + zone;
}

function transformerForPoints(pointsLonLat) {
  const epsg = inferLocalEtrs89Utm(pointsLonLat);
  const zone = epsg - 25800;
  const utmDef = `+proj=utm +zone=${zone} +ellps=GRS80 +units=m +no_defs`;
  const transformer = proj4("EPSG:4326", utmDef);
  return { transformer, epsg, utmDef };
}

function ensureGpxWorker() {
  if (gpxWorker) return gpxWorker;
  if (!window.Worker) return null;
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });
  worker.addEventListener("message", (event) => {
    const data = event.data || {};
    const { id, ok, payload, error } = data;
    const pending = gpxWorkerPending.get(id);
    if (!pending) return;
    gpxWorkerPending.delete(id);
    if (!ok) {
      pending.reject(new Error(error || "Worker-fejl ved GPX-parsing."));
      return;
    }
    try {
      const { pointsLonLat, xs, ys, epsg, utmDef } = payload;
      const transformer = proj4("EPSG:4326", utmDef);
      pending.resolve({ pointsLonLat, xs, ys, epsg, transformer });
    } catch (err) {
      pending.reject(err);
    }
  });
  worker.addEventListener("error", () => {
    const error = new Error("Web worker fejlede.");
    gpxWorkerPending.forEach(({ reject }) => reject(error));
    gpxWorkerPending.clear();
  });
  gpxWorker = worker;
  return worker;
}

async function parseLargeGpxWithWorker(file) {
  const worker = ensureGpxWorker();
  if (!worker) {
    throw new Error("Web worker understøttes ikke i denne browser.");
  }
  const xmlText = await file.text();
  const id = (gpxWorkerRequestId += 1);
  const promise = new Promise((resolve, reject) => {
    gpxWorkerPending.set(id, { resolve, reject });
  });
  worker.postMessage({ id, xmlText });
  return promise;
}

function projectPoints(pointsLonLat, transformer) {
  const xs = [];
  const ys = [];
  for (const [lon, lat] of pointsLonLat) {
    const [x, y] = transformer.forward([lon, lat]);
    xs.push(x);
    ys.push(y);
  }
  return { xs, ys };
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  if (value.length !== 6) return null;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return { r, g, b };
}

function rgbToHex({ r, g, b }) {
  const toHex = (v) => v.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function interpolateColor(startHex, endHex, t) {
  const start = hexToRgb(startHex);
  const end = hexToRgb(endHex);
  if (!start || !end) return startHex;
  const lerp = (a, b) => Math.round(a + (b - a) * t);
  return rgbToHex({
    r: lerp(start.r, end.r),
    g: lerp(start.g, end.g),
    b: lerp(start.b, end.b),
  });
}

function computePageColors(count) {
  return Array.from({ length: count }, () => PAGE_FILL_COLOR);
}

function effectiveTrackOpacity() {
  return selections.trackOpacity;
}

function updateTrackOpacityLabel() {
  if (!trackOpacityValueEl || !trackOpacityEl) return;
  const value = Number(trackOpacityEl.value);
  const percent = Math.round(value * 100);
  trackOpacityValueEl.textContent = `${percent}%`;
}

function updateTrackWidthLabel() {
  if (!trackWidthValueEl || !trackWidthEl) return;
  const value = Number(trackWidthEl.value);
  if (!Number.isFinite(value)) return;
  trackWidthValueEl.textContent = `${value} px`;
}

function updateHeightOpacityLabel() {
  if (!heightOpacityValueEl || !heightOpacityEl) return;
  const value = Number(heightOpacityEl.value);
  const percent = Math.round(value * 100);
  heightOpacityValueEl.textContent = `${percent}%`;
}

function getActiveHeightMaskColors() {
  return [...HEIGHT_OVERLAY_MASK_COLORS];
}

function getHeightMaskKey() {
  return "11";
}

function pruneCache(cache, limit) {
  while (cache.size > limit) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

function matchesMaskedHeightColorFromList(r, g, b, colors) {
  return colors.some((color) => (
    Math.abs(r - color.r) <= HEIGHT_OVERLAY_MASK_TOLERANCE &&
    Math.abs(g - color.g) <= HEIGHT_OVERLAY_MASK_TOLERANCE &&
    Math.abs(b - color.b) <= HEIGHT_OVERLAY_MASK_TOLERANCE
  ));
}

function applyHeightMaskToContext(ctx, width, height, colors) {
  if (!colors.length) return;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    if (matchesMaskedHeightColorFromList(data[i], data[i + 1], data[i + 2], colors)) {
      data[i + 3] = 0;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

function updateJpegQualityLabel() {
  if (!jpegQualityValueEl || !jpegQualityEl) return;
  const value = Number(jpegQualityEl.value);
  if (!Number.isFinite(value)) return;
  const percent = Math.round(value * 100);
  jpegQualityValueEl.textContent = `${percent}%`;
}

function updateJpegQualityVisibility() {
  if (!jpegQualityGroupEl || !pdfJpegToggleEl) return;
  jpegQualityGroupEl.classList.toggle("hidden", !pdfJpegToggleEl.checked);
}

function updateOverlapLabel() {
  if (!overlapValueEl) return;
  const value = Number(document.getElementById("overlap")?.value);
  if (!Number.isFinite(value)) return;
  overlapValueEl.textContent = `${Math.round(value)}%`;
}

function updateMarginLabel() {
  if (!marginValueEl) return;
  const value = Number(document.getElementById("margin")?.value);
  if (!Number.isFinite(value)) return;
  marginValueEl.textContent = `${Math.round(value)}%`;
}

function ensureRouteOverlayPane() {
  if (!mapInstance) return;
  const existing = mapInstance.getPane("routeOverlayPane");
  if (existing) return;
  const pane = mapInstance.createPane("routeOverlayPane");
  pane.style.zIndex = "350";
  pane.style.pointerEvents = "none";
}

function ensureHeightOverlayPane() {
  if (!mapInstance) return;
  const existing = mapInstance.getPane("heightOverlayPane");
  if (existing) return;
  const pane = mapInstance.createPane("heightOverlayPane");
  pane.style.zIndex = "320";
  pane.style.pointerEvents = "none";
}

function ensureWeakIceOverlayPane() {
  if (!mapInstance) return;
  const existing = mapInstance.getPane("weakIceOverlayPane");
  if (existing) return;
  const pane = mapInstance.createPane("weakIceOverlayPane");
  pane.style.zIndex = "330";
  pane.style.pointerEvents = "none";
}

function createRouteLayer(layerName) {
  return L.tileLayer.wms(WMS_ROUTE_URL, {
    layers: layerName,
    format: "image/png",
    transparent: true,
    opacity: ROUTE_OVERLAY_OPACITY,
    pane: "routeOverlayPane",
  });
}

function createWeakIceLayer(layerName) {
  return L.tileLayer.wms(WMS_WEAK_ICE_URL, {
    layers: layerName,
    format: "image/png",
    transparent: true,
    opacity: effectiveWeakIceOpacity(),
    pane: "weakIceOverlayPane",
    minZoom: HEIGHT_OVERLAY_MIN_ZOOM,
  });
}

function createHeightLayer(layerName) {
  const bounds = heightOverlayBounds ?? null;
  const HeightLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement("canvas");
      const size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;
      const ctx = tile.getContext("2d", { willReadFrequently: true });

      if (!mapInstance || !ctx) {
        done(null, tile);
        return tile;
      }

      const nwPoint = coords.scaleBy(size);
      const sePoint = nwPoint.add(size);
      const nw = mapInstance.unproject(nwPoint, coords.z);
      const se = mapInstance.unproject(sePoint, coords.z);
      const tileBounds = L.latLngBounds(nw, se);
      if (bounds && !bounds.intersects(tileBounds)) {
        done(null, tile);
        return tile;
      }

      const crs = mapInstance.options.crs;
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
      const cachedMasked = heightTileMaskedCache.get(maskedCacheKey);
      if (cachedMasked) {
        ctx.drawImage(cachedMasked, 0, 0, size.x, size.y);
        done(null, tile);
        return tile;
      }

      const cachedBitmap = heightTileBitmapCache.get(requestUrl);
      const drawAndMask = (bitmap) => {
        ctx.drawImage(bitmap, 0, 0, size.x, size.y);
        applyHeightMaskToContext(ctx, size.x, size.y, activeMaskColors);
        const maskedCanvas = document.createElement("canvas");
        maskedCanvas.width = size.x;
        maskedCanvas.height = size.y;
        const maskedCtx = maskedCanvas.getContext("2d");
        if (maskedCtx) {
          maskedCtx.drawImage(tile, 0, 0);
          heightTileMaskedCache.set(maskedCacheKey, maskedCanvas);
          pruneCache(heightTileMaskedCache, HEIGHT_TILE_CACHE_LIMIT);
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
          heightTileBitmapCache.set(requestUrl, bitmap);
          pruneCache(heightTileBitmapCache, HEIGHT_TILE_CACHE_LIMIT);
          drawAndMask(bitmap);
        })
        .catch((error) => {
          done(error, tile);
        });

      return tile;
    },
  });

  return new HeightLayer({
    pane: "heightOverlayPane",
    opacity: effectiveHeightOpacity(),
    minZoom: HEIGHT_OVERLAY_MIN_ZOOM,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 0,
  });
}

function updateRouteOverlays() {
  if (!mapInstance || !L) return;
  ensureRouteOverlayPane();
  const showSki = Boolean(skiRoutesToggleEl?.checked);
  const showHike = Boolean(hikeRoutesToggleEl?.checked);

  if (showSki && !skiRoutesLayer) {
    skiRoutesLayer = createRouteLayer(WMS_ROUTE_LAYERS.ski);
    skiRoutesLayer.addTo(mapInstance);
  } else if (!showSki && skiRoutesLayer) {
    mapInstance.removeLayer(skiRoutesLayer);
    skiRoutesLayer = null;
  }

  if (showHike && !hikeRoutesLayer) {
    hikeRoutesLayer = createRouteLayer(WMS_ROUTE_LAYERS.hike);
    hikeRoutesLayer.addTo(mapInstance);
  } else if (!showHike && hikeRoutesLayer) {
    mapInstance.removeLayer(hikeRoutesLayer);
    hikeRoutesLayer = null;
  }

  if (trackLayer) {
    trackLayer.setStyle({ opacity: effectiveTrackOpacity() });
  }
}

function effectiveHeightOpacity() {
  if (!heightOpacityEl) return DEFAULT_HEIGHT_OVERLAY_OPACITY;
  const value = Number(heightOpacityEl.value);
  return Number.isFinite(value) ? value : DEFAULT_HEIGHT_OVERLAY_OPACITY;
}

function effectiveWeakIceOpacity() {
  if (!weakIceOpacityEl) return 1;
  const value = Number(weakIceOpacityEl.value);
  return Number.isFinite(value) ? value : 1;
}

function updateHeightOpacityVisibility() {
  if (!heightOpacityGroupEl) return;
  const anyOn = heightLayerToggleEls.some((toggle) => toggle.checked);
  heightOpacityGroupEl.classList.toggle("hidden", !anyOn);
}

function updateWeakIceOpacityVisibility() {
  if (!weakIceOpacityGroupEl || !weakIceToggleEl) return;
  weakIceOpacityGroupEl.classList.toggle("hidden", !weakIceToggleEl.checked);
}

function updateHeightMaskVisibility() {
  if (!heightMaskGroupEl) return;
  const anyOn = heightLayerToggleEls.some((toggle) => toggle.checked);
  heightMaskGroupEl.classList.toggle("hidden", !anyOn);
}

function updateHeightLegendVisibility() {
  if (!heightLegendEl || !heightLegendImgEl) return;
  const anyOn = heightLayerToggleEls.some((toggle) => toggle.checked);
  heightLegendEl.classList.toggle("hidden", !anyOn);
}

function ensureHeightLegendSrc() {
  if (!heightLegendImgEl || heightLegendImgEl.src) return;
  const params = new URLSearchParams({
    request: "GetLegendGraphic",
    version: "1.3.0",
    format: "image/png",
    layer: "DTM:helning_grader",
  });
  heightLegendImgEl.src = `${WMS_HEIGHT_URL}?${params.toString()}`;
}

function updateHeightOverlays() {
  if (!mapInstance || !L) return;
  ensureHeightOverlayPane();
  updateHeightLegendVisibility();
  ensureHeightLegendSrc();
  heightLayerToggleEls.forEach((toggle) => {
    const layerName = toggle.dataset.heightLayer;
    if (!layerName) return;
    const shouldShow = Boolean(toggle.checked);
    const existing = heightOverlayLayers.get(layerName);
    if (shouldShow && !existing) {
      const layer = createHeightLayer(layerName);
      heightOverlayLayers.set(layerName, layer);
      layer.addTo(mapInstance);
    } else if (!shouldShow && existing) {
      mapInstance.removeLayer(existing);
      heightOverlayLayers.delete(layerName);
    }
  });
}

function refreshHeightOverlays() {
  if (!mapInstance) return;
  heightOverlayLayers.forEach((layer) => {
    mapInstance.removeLayer(layer);
  });
  heightOverlayLayers = new Map();
  updateHeightOverlays();
}

function getSelectedHeightLayers() {
  return heightLayerToggleEls
    .filter((toggle) => toggle.checked)
    .map((toggle) => toggle.dataset.heightLayer)
    .filter(Boolean);
}

function updateWeakIceOverlays() {
  if (!mapInstance || !L) return;
  ensureWeakIceOverlayPane();
  const shouldShow = Boolean(weakIceToggleEl?.checked);
  WMS_WEAK_ICE_LAYERS.forEach((layerName) => {
    const existing = weakIceOverlayLayers.get(layerName);
    if (shouldShow && !existing) {
      const layer = createWeakIceLayer(layerName);
      weakIceOverlayLayers.set(layerName, layer);
      layer.addTo(mapInstance);
    } else if (!shouldShow && existing) {
      mapInstance.removeLayer(existing);
      weakIceOverlayLayers.delete(layerName);
    }
  });
}

function getSelectedWeakIceLayers() {
  if (!weakIceToggleEl?.checked) return [];
  return [...WMS_WEAK_ICE_LAYERS];
}

function initMap() {
  if (mapInstance || !mapEl) return;
  if (!L) {
    setStatus("Kortbiblioteket kunne ikke indlæses.");
    return;
  }
  mapInstance = L.map(mapEl, {
    zoomControl: true,
    zoomSnap: 0.5,
    renderer: L.svg(),
  });
  if (selectionBarEl) {
    L.DomEvent.disableClickPropagation(selectionBarEl);
    L.DomEvent.disableScrollPropagation(selectionBarEl);
  }
  L.tileLayer(MAP_TILE_URL, {
    maxZoom: 18,
    attribution: MAP_ATTRIBUTION,
  }).addTo(mapInstance);
  mapInstance.setView([64.5, 11.0], 5);

  pageLayerGroup = L.layerGroup().addTo(mapInstance);
  updateRouteOverlays();
  updateHeightOverlays();
  updateWeakIceOverlays();

  mapInstance.on("click", (event) => {
    const target = event.originalEvent?.target;
    if (target && target.closest && target.closest(".page-rect")) {
      return;
    }
    selectPage(null);
  });
  mapInstance.on("zoomend moveend", () => {
    updateSelectionBar();
  });
}

function updateTrackLayer(pointsLonLat) {
  initMap();
  if (!mapInstance || !L) return;
  if (trackLayer) {
    mapInstance.removeLayer(trackLayer);
  }
  const latLngs = pointsLonLat.map(([lon, lat]) => [lat, lon]);
  trackLayer = L.polyline(latLngs, {
    color: selections.trackColor,
    weight: selections.trackWidth,
    opacity: effectiveTrackOpacity(),
  }).addTo(mapInstance);
  const bounds = L.latLngBounds(latLngs);
  mapInstance.fitBounds(bounds.pad(0.1));
}

function clearTrackLayer() {
  if (mapInstance && trackLayer) {
    mapInstance.removeLayer(trackLayer);
    trackLayer = null;
  }
}

function bboxToLatLngBounds(bbox, transformer) {
  if (!L) return null;
  const [minx, miny, maxx, maxy] = bbox;
  const [minLon, minLat] = transformer.inverse([minx, miny]);
  const [maxLon, maxLat] = transformer.inverse([maxx, maxy]);
  return L.latLngBounds([minLat, minLon], [maxLat, maxLon]);
}

function clearPageOverlays() {
  if (!pageLayerGroup) return;
  pageLayers.forEach((layer) => pageLayerGroup.removeLayer(layer));
  pageLayers = [];
  pageLabelLayers.forEach((layer) => pageLayerGroup.removeLayer(layer));
  pageLabelLayers = [];
}

function ensurePageIds(pages) {
  pages.forEach((page) => {
    if (!page.id) {
      page.id = nextPageId;
      nextPageId += 1;
    }
  });
}

function createPageLabel(page, index) {
  const el = document.createElement("div");
  el.className = "page-label";
  el.textContent = String(index + 1);

  const bounds = bboxToLatLngBounds(page.bbox, transformerState.transformer);
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

function renderPageOverlays() {
  if (!mapInstance || !transformerState || !layoutPages.length || !L) return;
  clearPageOverlays();
  ensurePageIds(layoutPages);
  pageColors = computePageColors(layoutPages.length);

  layoutPages.forEach((page, index) => {
    const bounds = bboxToLatLngBounds(page.bbox, transformerState.transformer);
    if (!bounds) return;
    const fillColor = pageColors[index] ?? PAGE_FILL_COLOR;
    const rect = L.rectangle(bounds, {
      ...PAGE_STYLE,
      fillColor,
      interactive: true,
      className: "page-rect",
    });
    rect.on("mousedown", (event) => {
      L.DomEvent.stop(event);
      startDrag(event, index);
      selectPage(index, getContainerPointFromEvent(event));
    });
    rect.on("touchstart", (event) => {
      L.DomEvent.stop(event);
      startDrag(event, index);
      selectPage(index, getContainerPointFromEvent(event));
    });
    rect.on("click", (event) => {
      L.DomEvent.stop(event);
      selectPage(index, getContainerPointFromEvent(event));
    });
    rect.addTo(pageLayerGroup);
    pageLayers.push(rect);

    const labelMarker = createPageLabel(page, index);
    if (labelMarker) {
      labelMarker.addTo(pageLayerGroup);
      pageLabelLayers.push(labelMarker);
    }
  });

  updatePageStyles();
  fitMapToLayout();
}

function fitMapToLayout() {
  if (!mapInstance || !layoutPages.length || !transformerState || !L) return;
  const combined = L.latLngBounds();
  layoutPages.forEach((page) => {
    const bounds = bboxToLatLngBounds(page.bbox, transformerState.transformer);
    combined.extend(bounds);
  });
  if (combined.isValid()) {
    mapInstance.fitBounds(combined.pad(0.08));
  }
}

function updatePageStyles() {
  pageLayers.forEach((layer, index) => {
    const baseStyle =
      index === selectedPageIndex ? PAGE_STYLE_SELECTED : PAGE_STYLE;
    const fillColor = pageColors[index] ?? PAGE_FILL_COLOR;
    layer.setStyle({ ...baseStyle, fillColor });
    if (index === selectedPageIndex) {
      layer.bringToFront();
    }
  });
  pageLabelLayers.forEach((layer, index) => {
    if (index === selectedPageIndex) {
      layer.bringToFront();
    }
  });
}

function selectPage(index, anchorPoint) {
  if (index === null || index === undefined) {
    selectedPageIndex = null;
  } else {
    selectedPageIndex = index;
  }
  updatePageStyles();
  requestAnimationFrame(() => {
    updateSelectionBar(anchorPoint);
  });
}

function updateSelectionBar(anchorPoint) {
  if (!selectionBarEl || !mapInstance || !selectionSelectEl || !orientationToggleEl) return;
  if (!transformerState) {
    if (selectionMarker) {
      mapInstance.removeLayer(selectionMarker);
      selectionMarker = null;
    }
    selectionBarEl.classList.add("hidden");
    return;
  }
  if (selectedPageIndex === null || !layoutPages[selectedPageIndex]) {
    if (selectionMarker) {
      mapInstance.removeLayer(selectionMarker);
      selectionMarker = null;
    }
    selectionBarEl.classList.add("hidden");
    return;
  }
  const page = layoutPages[selectedPageIndex];
  const [minx, miny, maxx, maxy] = page.bbox;
  const centerX = (minx + maxx) / 2;
  const [lon, lat] = transformerState.transformer.inverse([centerX, maxy]);
  const latlng = L.latLng(lat, lon);

  selectionSelectEl.innerHTML = "";
  for (let i = 1; i <= layoutPages.length; i += 1) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Side ${i}`;
    if (i === selectedPageIndex + 1) opt.selected = true;
    selectionSelectEl.appendChild(opt);
  }
  const nextOrientation = page.orientation === "portrait" ? "Landskab" : "Portræt";
  orientationToggleEl.textContent = `Skift til ${nextOrientation}`;
  if (removePageBtn) {
    removePageBtn.classList.toggle("hidden", selectedPageIndex === null);
  }

  if (!selectionMarker) {
    selectionMarker = L.marker(latlng, {
      interactive: true,
      icon: L.divIcon({
        className: "",
        html: "",
        iconSize: null,
      }),
    }).addTo(mapInstance);
  } else {
    selectionMarker.setLatLng(latlng);
  }

  const markerEl = selectionMarker.getElement();
  if (markerEl && selectionBarEl.parentElement !== markerEl) {
    selectionBarEl.classList.remove("hidden");
    markerEl.appendChild(selectionBarEl);
  }
}

function updatePageLayerBounds(index) {
  if (!pageLayers[index] || !transformerState) return;
  const bounds = bboxToLatLngBounds(layoutPages[index].bbox, transformerState.transformer);
  pageLayers[index].setBounds(bounds);
  if (pageLabelLayers[index] && bounds) {
    pageLabelLayers[index].setLatLng(bounds.getNorthEast());
  }
}

function getContainerPointFromEvent(event) {
  if (!mapInstance) return null;
  if (event?.containerPoint) return event.containerPoint;
  const original = event?.originalEvent ?? event;
  const touch = original?.touches?.[0] || original?.changedTouches?.[0];
  if (touch) {
    return mapInstance.mouseEventToContainerPoint(touch);
  }
  if (!original) return null;
  return mapInstance.mouseEventToContainerPoint(original);
}

function startDrag(event, index) {
  if (!transformerState) return;
  const point = getContainerPointFromEvent(event);
  if (!point) return;
  const latlng = mapInstance.containerPointToLatLng(point);
  const [startX, startY] = transformerState.transformer.forward([
    latlng.lng,
    latlng.lat,
  ]);
  dragState = {
    index,
    startUtm: [startX, startY],
    startBBox: layoutPages[index].bbox.slice(),
    didMove: false,
  };
  if (mapInstance) {
    mapInstance.dragging.disable();
  }
  bindDragListeners();
}

function handleDocumentMove(event) {
  if (!dragState || !transformerState || !mapInstance) return;
  const point = getContainerPointFromEvent(event);
  if (!point) return;
  const latlng = mapInstance.containerPointToLatLng(point);
  const [currentX, currentY] = transformerState.transformer.forward([
    latlng.lng,
    latlng.lat,
  ]);
  const dx = currentX - dragState.startUtm[0];
  const dy = currentY - dragState.startUtm[1];
  if (dx !== 0 || dy !== 0) {
    dragState.didMove = true;
  }
  const nextBBox = [
    dragState.startBBox[0] + dx,
    dragState.startBBox[1] + dy,
    dragState.startBBox[2] + dx,
    dragState.startBBox[3] + dy,
  ];
  layoutPages[dragState.index].bbox = nextBBox;
  updatePageLayerBounds(dragState.index);
  updateSelectionBar(point);
}

function bindDragListeners() {
  if (dragListenersActive) return;
  dragListenersActive = true;
  document.addEventListener("mousemove", handleDocumentMove);
  document.addEventListener("mouseup", stopDrag);
  document.addEventListener("touchmove", handleDocumentMove, { passive: false });
  document.addEventListener("touchend", stopDrag);
}

function unbindDragListeners() {
  if (!dragListenersActive) return;
  dragListenersActive = false;
  document.removeEventListener("mousemove", handleDocumentMove);
  document.removeEventListener("mouseup", stopDrag);
  document.removeEventListener("touchmove", handleDocumentMove);
  document.removeEventListener("touchend", stopDrag);
}

function stopDrag(event) {
  if (!dragState) return;
  if (event?.preventDefault) {
    event.preventDefault();
  }
  if (dragState.didMove) {
    markLayoutCustomized("Layout er ændret manuelt.");
  }
  dragState = null;
  unbindDragListeners();
  if (mapInstance) {
    mapInstance.dragging.enable();
  }
}

function toggleSelectedOrientation() {
  if (selectedPageIndex === null || !layoutPages[selectedPageIndex]) return;
  const page = layoutPages[selectedPageIndex];
  const nextOrientation = page.orientation === "portrait" ? "landscape" : "portrait";
  const metrics = pageGroundSpan(
    selections.scale,
    DEFAULT_DPI,
    selections.paper,
    nextOrientation
  );
  const [minx, miny, maxx, maxy] = page.bbox;
  const cx = (minx + maxx) / 2;
  const cy = (miny + maxy) / 2;
  const nextBBox = bboxFromCenter(cx, cy, metrics.wM, metrics.hM);
  layoutPages[selectedPageIndex] = {
    ...page,
    bbox: nextBBox,
    orientation: nextOrientation,
    wPx: metrics.wPx,
    hPx: metrics.hPx,
    wM: metrics.wM,
    hM: metrics.hM,
  };
  updatePageLayerBounds(selectedPageIndex);
  updateSelectionBar();
  markLayoutCustomized("Layout er ændret manuelt.");
}

function ensureProjectionForManualPages() {
  if (transformerState && projectionState) return true;
  if (!mapInstance) return false;
  const center = mapInstance.getCenter();
  const { transformer, epsg } = transformerForPoints([[center.lng, center.lat]]);
  transformerState = { transformer, epsg };
  projectionState = {
    pointsLonLat: [],
    transformer,
    epsg,
    xs: [],
    ys: [],
  };
  return true;
}

function removePage(index) {
  if (index === null || index === undefined) return;
  if (!layoutPages[index]) return;
  layoutPages.splice(index, 1);
  markLayoutCustomized("Layout er ændret manuelt.");
  if (!layoutPages.length) {
    resetLayoutState();
    setStatus("Alle sider fjernet.");
    return;
  }
  selectedPageIndex = Math.min(index, layoutPages.length - 1);
  renderPageOverlays();
  updateSelectionBar();
}

function movePageById(pageId, nextIndex) {
  const currentIndex = layoutPages.findIndex((page) => page.id === pageId);
  if (currentIndex < 0) return;
  const clamped = Math.max(0, Math.min(nextIndex, layoutPages.length - 1));
  if (currentIndex === clamped) return;
  const [page] = layoutPages.splice(currentIndex, 1);
  layoutPages.splice(clamped, 0, page);
  selectedPageIndex = clamped;
  renderPageOverlays();
  updateSelectionBar();
  markLayoutCustomized("Layout er ændret manuelt.");
}

function addPageAtCenter() {
  if (!mapInstance || !ensureProjectionForManualPages()) {
    setStatus("Kortet er ikke klar endnu.");
    return;
  }
  const center = mapInstance.getCenter();
  const [centerX, centerY] = transformerState.transformer.forward([
    center.lng,
    center.lat,
  ]);
  const orientation = "portrait";
  const metrics = pageGroundSpan(
    selections.scale,
    DEFAULT_DPI,
    selections.paper,
    orientation
  );
  const bbox = bboxFromCenter(centerX, centerY, metrics.wM, metrics.hM);
  const newPage = {
    id: nextPageId,
    bbox,
    orientation,
    wPx: metrics.wPx,
    hPx: metrics.hPx,
    wM: metrics.wM,
    hM: metrics.hM,
  };
  nextPageId += 1;
  if (!layoutPages.length) {
    layoutPages = [newPage];
    selectedPageIndex = 0;
  } else {
    const insertIndex = Math.floor(layoutPages.length / 2);
    layoutPages.splice(insertIndex, 0, newPage);
    selectedPageIndex = insertIndex;
  }
  isLayoutReady = true;
  renderPageOverlays();
  updateRenderButtonState();
  updateSelectionBar();
  markLayoutCustomized("Ny side tilføjet.");
}

function minMax(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

function bboxFromPoints(xs, ys) {
  const { min: minx, max: maxx } = minMax(xs);
  const { min: miny, max: maxy } = minMax(ys);
  return [minx, miny, maxx, maxy];
}

function clampOverlap(overlap) {
  return Math.max(0.0, Math.min(overlap, 0.9));
}

function clampMargin(margin) {
  return Math.max(0.0, Math.min(margin, 0.45));
}

function clampPdfQuality(quality) {
  return Math.max(0.1, Math.min(quality, 1));
}

function cumulativeDistances(xs, ys) {
  const distances = Array.from({ length: xs.length }, () => 0);
  for (let i = 1; i < xs.length; i += 1) {
    const dx = xs[i] - xs[i - 1];
    const dy = ys[i] - ys[i - 1];
    distances[i] = distances[i - 1] + Math.hypot(dx, dy);
  }
  return distances;
}

function windowEndIndex(distances, startIndex, windowMeters, minPoints) {
  const target = distances[startIndex] + windowMeters;
  let endIndex = startIndex;
  while (endIndex < distances.length - 1 && distances[endIndex] < target) {
    endIndex += 1;
  }
  if (endIndex === startIndex) {
    endIndex = Math.min(startIndex + minPoints, distances.length - 1);
  }
  return endIndex;
}

function meanPoints(xs, ys, startIndex, endIndex) {
  const count = endIndex - startIndex + 1;
  let sumX = 0;
  let sumY = 0;
  for (let i = startIndex; i <= endIndex; i += 1) {
    sumX += xs[i];
    sumY += ys[i];
  }
  return { x: sumX / count, y: sumY / count };
}

function bboxFromCenter(cx, cy, wM, hM) {
  return [cx - wM / 2, cy - hM / 2, cx + wM / 2, cy + hM / 2];
}

function pointInBBox(x, y, bbox) {
  return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
}

function shrinkBBox(bbox, marginX, marginY) {
  return [
    bbox[0] + marginX,
    bbox[1] + marginY,
    bbox[2] - marginX,
    bbox[3] - marginY,
  ];
}

function lastIndexInside(bbox, xs, ys, startIndex) {
  let last = startIndex;
  for (let i = startIndex; i < xs.length; i += 1) {
    if (!pointInBBox(xs[i], ys[i], bbox)) break;
    last = i;
  }
  return last;
}

function candidateCenterIndices(startIndex, endIndex) {
  const maxCandidates = 10;
  const span = endIndex - startIndex;
  const step = Math.max(1, Math.floor(span / maxCandidates));
  const indices = [];
  for (let i = startIndex; i <= endIndex; i += step) {
    indices.push(i);
  }
  if (indices[indices.length - 1] !== endIndex) {
    indices.push(endIndex);
  }
  return indices;
}

function unitVector(dx, dy) {
  const mag = Math.hypot(dx, dy);
  if (!mag) return { x: 1, y: 0 };
  return { x: dx / mag, y: dy / mag };
}

function densifyTrack(xs, ys, maxStepMeters) {
  if (xs.length < 2) return { xs: xs.slice(), ys: ys.slice() };
  const denseX = [];
  const denseY = [];
  for (let i = 0; i < xs.length - 1; i += 1) {
    const x1 = xs[i];
    const y1 = ys[i];
    const x2 = xs[i + 1];
    const y2 = ys[i + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / maxStepMeters));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      denseX.push(x1 + dx * t);
      denseY.push(y1 + dy * t);
    }
  }
  denseX.push(xs[xs.length - 1]);
  denseY.push(ys[ys.length - 1]);
  return { xs: denseX, ys: denseY };
}

function computeAdaptivePages(xs, ys, options) {
  if (options.disableDp) {
    return computeAdaptivePagesGreedy(xs, ys, options);
  }
  const densifyStep = 80;
  const densified = densifyTrack(xs, ys, densifyStep);
  const denseXs = densified.xs;
  const denseYs = densified.ys;
  const overlap = clampOverlap(options.overlap);
  const margin = clampMargin(options.margin ?? DEFAULT_MARGIN);
  const innerFraction = Math.max(overlap, margin);
  const distances = cumulativeDistances(denseXs, denseYs);
  const maxIndex = denseXs.length - 1;
  const metricsByOrientation = {
    portrait: pageGroundSpan(options.scale, options.dpi, options.paper, "portrait"),
    landscape: pageGroundSpan(options.scale, options.dpi, options.paper, "landscape"),
  };
  const windowFactor = 0.9;
  const minWindowPoints = 8;
  const slideRangeFactor = 0.2;
  const slideSteps = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1];

  const buildCandidates = (startIdx, orientation) => {
    const metrics = metricsByOrientation[orientation];
    const windowMeters = Math.max(metrics.wM, metrics.hM) * windowFactor;
    const centerEnd = windowEndIndex(
      distances,
      startIdx,
      windowMeters,
      minWindowPoints
    );
    const centerIndices = candidateCenterIndices(startIdx, centerEnd);
    const dir = unitVector(
      denseXs[centerEnd] - denseXs[startIdx],
      denseYs[centerEnd] - denseYs[startIdx]
    );
    const slideRange = Math.max(metrics.wM, metrics.hM) * slideRangeFactor;
    const marginX = (metrics.wM * innerFraction) / 2;
    const marginY = (metrics.hM * innerFraction) / 2;
    const candidates = [];

    centerIndices.forEach((centerIdx) => {
      const baseCenter = meanPoints(denseXs, denseYs, startIdx, centerIdx);
      slideSteps.forEach((step) => {
        const center = {
          x: baseCenter.x + dir.x * slideRange * step,
          y: baseCenter.y + dir.y * slideRange * step,
        };
        const bbox = bboxFromCenter(center.x, center.y, metrics.wM, metrics.hM);
        const inner = shrinkBBox(bbox, marginX, marginY);
        if (!pointInBBox(denseXs[startIdx], denseYs[startIdx], inner)) return;
        const endIndex = lastIndexInside(inner, denseXs, denseYs, startIdx);
        const coveredDist = distances[endIndex] - distances[startIdx];
        const segmentCenter = meanPoints(denseXs, denseYs, startIdx, endIndex);
        const offsetX = (segmentCenter.x - center.x) / (metrics.wM / 2);
        const offsetY = (segmentCenter.y - center.y) / (metrics.hM / 2);
        const centerPenalty = Math.hypot(offsetX, offsetY);
        candidates.push({
          orientation,
          bbox,
          wPx: metrics.wPx,
          hPx: metrics.hPx,
          wM: metrics.wM,
          hM: metrics.hM,
          endIndex,
          coveredDist,
          centerPenalty,
          startIndex: startIdx,
          isTerminal: endIndex >= maxIndex,
        });
      });
    });

    if (!candidates.length) {
      const fallbackCenter = { x: xs[startIdx], y: ys[startIdx] };
      const bbox = bboxFromCenter(
        fallbackCenter.x,
        fallbackCenter.y,
        metrics.wM,
        metrics.hM
      );
      const inner = shrinkBBox(bbox, marginX, marginY);
      const endIndex = lastIndexInside(inner, denseXs, denseYs, startIdx);
      candidates.push({
        orientation,
        bbox,
        wPx: metrics.wPx,
        hPx: metrics.hPx,
        wM: metrics.wM,
        hM: metrics.hM,
        endIndex,
        coveredDist: distances[endIndex] - distances[startIdx],
        centerPenalty: 0,
        startIndex: startIdx,
        isTerminal: endIndex >= maxIndex,
      });
    }

    return candidates;
  };

  const pickBest = (candidates) => {
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (
        candidate.totalPages < best.totalPages ||
        (candidate.totalPages === best.totalPages &&
          (candidate.totalCoveredDist > best.totalCoveredDist ||
            (candidate.totalCoveredDist === best.totalCoveredDist &&
              candidate.totalCenterPenalty < best.totalCenterPenalty)))
      ) {
        best = candidate;
      }
    }
    return best;
  };

  const memo = new Map();

  const bestFrom = (startIdx) => {
    if (startIdx > maxIndex) {
      return { totalPages: 0, totalCoveredDist: 0, totalCenterPenalty: 0, seq: [] };
    }
    if (memo.has(startIdx)) return memo.get(startIdx);
    const candidates = [
      ...buildCandidates(startIdx, "portrait"),
      ...buildCandidates(startIdx, "landscape"),
    ];

    const scored = candidates.map((candidate) => {
      let remainder = { totalPages: 0, totalCoveredDist: 0, totalCenterPenalty: 0, seq: [] };
      if (!candidate.isTerminal) {
        const nextIndex = Math.min(
          Math.max(candidate.endIndex, startIdx + 1),
          maxIndex
        );
        remainder = bestFrom(nextIndex);
      }
      return {
        ...candidate,
        totalPages: 1 + remainder.totalPages,
        totalCoveredDist: candidate.coveredDist + remainder.totalCoveredDist,
        totalCenterPenalty: candidate.centerPenalty + remainder.totalCenterPenalty,
        seq: [candidate, ...remainder.seq],
      };
    });

    const best = pickBest(scored);
    memo.set(startIdx, best);
    return best;
  };

  const bestPath = bestFrom(0);
  const pages = bestPath.seq.map((entry) => ({
    bbox: entry.bbox,
    orientation: entry.orientation,
    wPx: entry.wPx,
    hPx: entry.hPx,
    wM: entry.wM,
    hM: entry.hM,
  }));

  for (let i = 0; i < denseXs.length; i += 1) {
    const x = denseXs[i];
    const y = denseYs[i];
    let covered = false;
    for (let p = 0; p < pages.length; p += 1) {
      if (pointInBBox(x, y, pages[p].bbox)) {
        covered = true;
        break;
      }
    }
    if (!covered) {
      return computeAdaptivePages(xs, ys, { ...options, disableDp: true });
    }
  }

  return pages;
}

function computeAdaptivePagesGreedy(xs, ys, options) {
  const overlap = clampOverlap(options.overlap);
  const margin = clampMargin(options.margin ?? DEFAULT_MARGIN);
  const innerFraction = Math.max(overlap, margin);
  const distances = cumulativeDistances(xs, ys);
  const maxIndex = xs.length - 1;
  const metricsByOrientation = {
    portrait: pageGroundSpan(options.scale, options.dpi, options.paper, "portrait"),
    landscape: pageGroundSpan(options.scale, options.dpi, options.paper, "landscape"),
  };
  const windowFactor = 0.9;
  const minWindowPoints = 8;
  const slideRangeFactor = 0.2;
  const slideSteps = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1];

  const buildCandidates = (startIdx, orientation) => {
    const metrics = metricsByOrientation[orientation];
    const windowMeters = Math.max(metrics.wM, metrics.hM) * windowFactor;
    const centerEnd = windowEndIndex(
      distances,
      startIdx,
      windowMeters,
      minWindowPoints
    );
    const centerIndices = candidateCenterIndices(startIdx, centerEnd);
    const dir = unitVector(xs[centerEnd] - xs[startIdx], ys[centerEnd] - ys[startIdx]);
    const slideRange = Math.max(metrics.wM, metrics.hM) * slideRangeFactor;
    const marginX = (metrics.wM * innerFraction) / 2;
    const marginY = (metrics.hM * innerFraction) / 2;
    const candidates = [];

    centerIndices.forEach((centerIdx) => {
      const baseCenter = meanPoints(xs, ys, startIdx, centerIdx);
      slideSteps.forEach((step) => {
        const center = {
          x: baseCenter.x + dir.x * slideRange * step,
          y: baseCenter.y + dir.y * slideRange * step,
        };
        const bbox = bboxFromCenter(center.x, center.y, metrics.wM, metrics.hM);
        const inner = shrinkBBox(bbox, marginX, marginY);
        if (!pointInBBox(xs[startIdx], ys[startIdx], inner)) return;
        const endIndex = lastIndexInside(inner, xs, ys, startIdx);
        const coveredDist = distances[endIndex] - distances[startIdx];
        const segmentCenter = meanPoints(xs, ys, startIdx, endIndex);
        const offsetX = (segmentCenter.x - center.x) / (metrics.wM / 2);
        const offsetY = (segmentCenter.y - center.y) / (metrics.hM / 2);
        const centerPenalty = Math.hypot(offsetX, offsetY);
        candidates.push({
          orientation,
          bbox,
          wPx: metrics.wPx,
          hPx: metrics.hPx,
          wM: metrics.wM,
          hM: metrics.hM,
          endIndex,
          coveredDist,
          centerPenalty,
        });
      });
    });

    if (!candidates.length) {
      const fallbackCenter = { x: xs[startIdx], y: ys[startIdx] };
      const bbox = bboxFromCenter(
        fallbackCenter.x,
        fallbackCenter.y,
        metrics.wM,
        metrics.hM
      );
      const inner = shrinkBBox(bbox, marginX, marginY);
      const endIndex = lastIndexInside(inner, xs, ys, startIdx);
      candidates.push({
        orientation,
        bbox,
        wPx: metrics.wPx,
        hPx: metrics.hPx,
        wM: metrics.wM,
        hM: metrics.hM,
        endIndex,
        coveredDist: distances[endIndex] - distances[startIdx],
        centerPenalty: 0,
      });
    }

    return candidates;
  };

  const pickBest = (candidates) => {
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (
        candidate.endIndex > best.endIndex ||
        (candidate.endIndex === best.endIndex &&
          (candidate.coveredDist > best.coveredDist ||
            (candidate.coveredDist === best.coveredDist &&
              candidate.centerPenalty < best.centerPenalty)))
      ) {
        best = candidate;
      }
    }
    return best;
  };

  const pages = [];
  let startIndex = 0;
  while (startIndex <= maxIndex) {
    const candidates = [
      ...buildCandidates(startIndex, "portrait"),
      ...buildCandidates(startIndex, "landscape"),
    ];
    const best = pickBest(candidates);
    pages.push({
      bbox: best.bbox,
      orientation: best.orientation,
      wPx: best.wPx,
      hPx: best.hPx,
      wM: best.wM,
      hM: best.hM,
    });
    if (best.endIndex >= maxIndex) break;
    const nextIndex = best.endIndex > startIndex ? best.endIndex : startIndex + 1;
    startIndex = Math.min(nextIndex, maxIndex);
  }

  return pages;
}

function groundResolutionMPerPx(scale, dpi) {
  return (scale * 0.0254) / dpi;
}

function paperDimensionsMm(paper, orientation) {
  if (!(paper in PAPER_SIZES_MM)) {
    throw new Error(`Ikke understøttet papirstørrelse: ${paper}`);
  }
  let [wMm, hMm] = PAPER_SIZES_MM[paper];
  if (orientation === "landscape") {
    [wMm, hMm] = [hMm, wMm];
  }
  return [wMm, hMm];
}

function paperPixels(paper, dpi, orientation) {
  const [wMm, hMm] = paperDimensionsMm(paper, orientation);
  const wPx = Math.round((wMm / 25.4) * dpi);
  const hPx = Math.round((hMm / 25.4) * dpi);
  return [wPx, hPx];
}

function pageGroundSpan(scale, dpi, paper, orientation) {
  const [wPx, hPx] = paperPixels(paper, dpi, orientation);
  const res = groundResolutionMPerPx(scale, dpi);
  const wM = wPx * res;
  const hM = hPx * res;
  return { wPx, hPx, wM, hM };
}

function computePageGrid(bbox, pageWM, pageHM, overlap) {
  const clampedOverlap = Math.max(0.0, Math.min(overlap, 0.9));
  const [minx, miny, maxx, maxy] = bbox;
  const dx = maxx - minx;
  const dy = maxy - miny;

  const stepX = pageWM * (1.0 - clampedOverlap);
  const stepY = pageHM * (1.0 - clampedOverlap);
  const cols = Math.max(1, Math.ceil(stepX ? dx / stepX : 1));
  const rows = Math.max(1, Math.ceil(stepY ? dy / stepY : 1));

  const totalW = pageWM + (cols - 1) * stepX;
  const totalH = pageHM + (rows - 1) * stepY;

  const cx = (minx + maxx) / 2.0;
  const cy = (miny + maxy) / 2.0;
  const west = cx - totalW / 2.0;
  const north = cy + totalH / 2.0;

  const bboxes = [];
  for (let row = 0; row < rows; row += 1) {
    const maxyRow = north - row * stepY;
    const minyRow = maxyRow - pageHM;
    for (let col = 0; col < cols; col += 1) {
      const minxCol = west + col * stepX;
      const maxxCol = minxCol + pageWM;
      bboxes.push([minxCol, minyRow, maxxCol, maxyRow]);
    }
  }

  return { bboxes, rows, cols };
}

function pageTrackIndex(pageBBox, xs, ys) {
  const [minx, miny, maxx, maxy] = pageBBox;
  let best = Infinity;
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i];
    const y = ys[i];
    if (minx <= x && x <= maxx && miny <= y && y <= maxy) {
      if (i < best) best = i;
    }
  }
  return best;
}

function recenterPageBBox(pageBBox, xs, ys, pageWM, pageHM) {
  const [minx, miny, maxx, maxy] = pageBBox;
  let minInX = Infinity;
  let maxInX = -Infinity;
  let minInY = Infinity;
  let maxInY = -Infinity;
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i];
    const y = ys[i];
    if (minx <= x && x <= maxx && miny <= y && y <= maxy) {
      if (x < minInX) minInX = x;
      if (x > maxInX) maxInX = x;
      if (y < minInY) minInY = y;
      if (y > maxInY) maxInY = y;
    }
  }
  if (!Number.isFinite(minInX) || !Number.isFinite(minInY)) {
    return pageBBox;
  }

  const cx = (minInX + maxInX) / 2.0;
  const cy = (minInY + maxInY) / 2.0;

  const newMinx = cx - pageWM / 2.0;
  const newMaxx = cx + pageWM / 2.0;
  const newMiny = cy - pageHM / 2.0;
  const newMaxy = cy + pageHM / 2.0;
  return [newMinx, newMiny, newMaxx, newMaxy];
}

function alignBBoxesToGrid(originalBBoxes, desiredBBoxes, rows, cols, pageWM, pageHM) {
  if (!desiredBBoxes.length || !originalBBoxes.length) return [];

  const rowOffsets = Array.from({ length: rows }, () => 0);
  const colOffsets = Array.from({ length: cols }, () => 0);

  for (let row = 0; row < rows; row += 1) {
    const offsets = [];
    for (let col = 0; col < cols; col += 1) {
      const idx = row * cols + col;
      offsets.push(desiredBBoxes[idx][0] - originalBBoxes[idx][0]);
    }
    rowOffsets[row] = offsets.reduce((a, b) => a + b, 0) / offsets.length;
  }

  for (let col = 0; col < cols; col += 1) {
    const offsets = [];
    for (let row = 0; row < rows; row += 1) {
      const idx = row * cols + col;
      offsets.push(desiredBBoxes[idx][3] - originalBBoxes[idx][3]);
    }
    colOffsets[col] = offsets.reduce((a, b) => a + b, 0) / offsets.length;
  }

  const adjusted = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const idx = row * cols + col;
      const baseMinx = originalBBoxes[idx][0];
      const baseMaxy = originalBBoxes[idx][3];
      const minx = baseMinx + rowOffsets[row];
      const maxy = baseMaxy + colOffsets[col];
      adjusted.push([minx, maxy - pageHM, minx + pageWM, maxy]);
    }
  }

  return adjusted;
}

async function fetchWmsImage({ baseUrl, layer, styles, format, transparent }, bbox, widthPx, heightPx, epsgCode) {
  const [minx, miny, maxx, maxy] = bbox;
  const params = new URLSearchParams({
    service: "WMS",
    request: "GetMap",
    version: "1.3.0",
    layers: layer,
    styles,
    width: String(widthPx),
    height: String(heightPx),
    format,
    crs: `EPSG:${epsgCode}`,
    bbox: `${minx},${miny},${maxx},${maxy}`,
  });

  if (transparent) {
    params.set("transparent", "true");
  }

  const url = `${baseUrl}?${params.toString()}`;
  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) {
    throw new Error(`WMS-forespørgsel fejlede (${response.status}).`);
  }

  const blob = await response.blob();
  return createImageBitmap(blob);
}

const wmtsConfigCache = new Map();

function tileMatrixSetIdFromEpsg(epsgCode) {
  // Kartverket cache supports: webmercator, utm32n, utm33n, utm35n
  if (epsgCode === 25832) return "utm32n";
  if (epsgCode === 25833) return "utm33n";
  if (epsgCode === 25835) return "utm35n";
  // Fallback: use webmercator if someone ends up outside those zones.
  return "webmercator";
}

function textContentOrNull(el, selector) {
  const node = el.querySelector(selector);
  return node ? node.textContent : null;
}

function parseCorner(str) {
  // "x y" (space-separated)
  if (!str) return null;
  const parts = str.trim().split(/\s+/).map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0], parts[1]];
}

async function getWmtsTileMatrixSet(tileMatrixSetId) {
  if (wmtsConfigCache.has(tileMatrixSetId)) return wmtsConfigCache.get(tileMatrixSetId);

  const res = await fetch(WMTS_CAPABILITIES_URL, { mode: "cors" });
  if (!res.ok) {
    throw new Error(`WMTS GetCapabilities fejlede (${res.status}).`);
  }
  const xmlText = await res.text();
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");

  // Find TileMatrixSet by identifier
  const sets = Array.from(doc.querySelectorAll("TileMatrixSet"));
  const setEl = sets.find((s) => textContentOrNull(s, "Identifier") === tileMatrixSetId);
  if (!setEl) {
    throw new Error(`WMTS TileMatrixSet ikke fundet: ${tileMatrixSetId}`);
  }

  const matrices = Array.from(setEl.querySelectorAll("TileMatrix")).map((m) => {
    const id = textContentOrNull(m, "Identifier");
    const scaleDen = Number(textContentOrNull(m, "ScaleDenominator"));
    const topLeft = parseCorner(textContentOrNull(m, "TopLeftCorner"));
    const tileW = Number(textContentOrNull(m, "TileWidth"));
    const tileH = Number(textContentOrNull(m, "TileHeight"));
    const matrixW = Number(textContentOrNull(m, "MatrixWidth"));
    const matrixH = Number(textContentOrNull(m, "MatrixHeight"));
    if (!id || !Number.isFinite(scaleDen) || !topLeft) return null;
    return {
      id,
      scaleDenominator: scaleDen,
      topLeftCorner: topLeft, // [x, y]
      tileWidth: Number.isFinite(tileW) ? tileW : WMTS_TILE_SIZE,
      tileHeight: Number.isFinite(tileH) ? tileH : WMTS_TILE_SIZE,
      matrixWidth: matrixW,
      matrixHeight: matrixH,
    };
  }).filter(Boolean);

  if (!matrices.length) {
    throw new Error(`Ingen TileMatrix fundet for ${tileMatrixSetId}.`);
  }

  // Sort by increasing scaleDenominator (more zoomed in = smaller scaleDen)
  matrices.sort((a, b) => a.scaleDenominator - b.scaleDenominator);

  const config = { tileMatrixSetId, matrices };
  wmtsConfigCache.set(tileMatrixSetId, config);
  return config;
}

function metersPerPixelFromScaleDenominator(scaleDenominator) {
  // OGC WMTS uses "pixel size" = 0.00028m for scale denominator.
  // resolution (m/px) = scaleDenominator * 0.00028
  return scaleDenominator * 0.00028;
}

function chooseBestMatrix(matrices, desiredMPerPx, maxTiles) {
  // Start with the most zoomed-in matrix (smallest m/px) that still makes sense.
  // If it would require too many tiles for the requested bbox/output, step down.
  // We pick the highest detail with m/px <= desiredMPerPx if possible; otherwise the closest.

  // First pick by resolution
  let chosen = matrices[0];
  let bestDiff = Infinity;
  for (const m of matrices) {
    const res = metersPerPixelFromScaleDenominator(m.scaleDenominator);
    const diff = Math.abs(Math.log(res / desiredMPerPx));
    if (diff < bestDiff) {
      bestDiff = diff;
      chosen = m;
    }
  }

  // We'll return an index so we can step to less detailed (larger m/px)
  const startIndex = matrices.indexOf(chosen);
  return { startIndex };
}

function tileRangeForBBox(bbox, matrix) {
  const [minx, miny, maxx, maxy] = bbox;
  const res = metersPerPixelFromScaleDenominator(matrix.scaleDenominator);

  const originX = matrix.topLeftCorner[0];
  const originY = matrix.topLeftCorner[1];

  // In WMTS, TileRow increases downward from top-left origin.
  const tileSpanX = matrix.tileWidth * res;
  const tileSpanY = matrix.tileHeight * res;

  const minCol = Math.floor((minx - originX) / tileSpanX);
  const maxCol = Math.floor((maxx - originX) / tileSpanX);

  const minRow = Math.floor((originY - maxy) / tileSpanY);
  const maxRow = Math.floor((originY - miny) / tileSpanY);

  return {
    minCol,
    maxCol,
    minRow,
    maxRow,
    tileSpanX,
    tileSpanY,
    res,
  };
}

async function fetchTileBitmap(url) {
  const r = await fetch(url, { mode: "cors" });
  if (!r.ok) throw new Error(`WMTS tile fejlede (${r.status}).`);
  const b = await r.blob();
  return createImageBitmap(b);
}

async function fetchWmtsStitchedImage(bbox, widthPx, heightPx, epsgCode, layerId) {
  const tileMatrixSetId = tileMatrixSetIdFromEpsg(epsgCode);
  const { matrices } = await getWmtsTileMatrixSet(tileMatrixSetId);

  // Desired output resolution from bbox + output pixels
  const desiredResX = (bbox[2] - bbox[0]) / widthPx;
  const desiredResY = (bbox[3] - bbox[1]) / heightPx;
  const desiredMPerPx = Math.max(desiredResX, desiredResY);

  const { startIndex } = chooseBestMatrix(matrices, desiredMPerPx, WMTS_MAX_TILES_PER_PAGE);

  // Step down (less detailed) until tile count is acceptable
  let matrixIndex = startIndex;
  let range = tileRangeForBBox(bbox, matrices[matrixIndex]);
  let tileCount = (range.maxCol - range.minCol + 1) * (range.maxRow - range.minRow + 1);

  while (tileCount > WMTS_MAX_TILES_PER_PAGE && matrixIndex < matrices.length - 1) {
    matrixIndex += 1; // less detail -> fewer tiles
    range = tileRangeForBBox(bbox, matrices[matrixIndex]);
    tileCount = (range.maxCol - range.minCol + 1) * (range.maxRow - range.minRow + 1);
  }

  const matrix = matrices[matrixIndex];

  // Create a temporary canvas large enough for the full tile mosaic
  const cols = range.maxCol - range.minCol + 1;
  const rows = range.maxRow - range.minRow + 1;

  const mosaicW = cols * matrix.tileWidth;
  const mosaicH = rows * matrix.tileHeight;

  const mosaic = document.createElement("canvas");
  mosaic.width = mosaicW;
  mosaic.height = mosaicH;
  const mctx = mosaic.getContext("2d");

  // Fetch tiles with simple concurrency limiting
  const tasks = [];
  for (let row = range.minRow; row <= range.maxRow; row += 1) {
    for (let col = range.minCol; col <= range.maxCol; col += 1) {
      const x = col - range.minCol;
      const y = row - range.minRow;
      const url = `${WMTS_BASE_URL}/${layerId}/default/${tileMatrixSetId}/${matrix.id}/${row}/${col}.png`;
      tasks.push({ url, x, y });
    }
  }

  const concurrency = 8;
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < tasks.length) {
      const i = cursor;
      cursor += 1;
      const t = tasks[i];
      const bmp = await fetchTileBitmap(t.url);
      mctx.drawImage(
        bmp,
        t.x * matrix.tileWidth,
        t.y * matrix.tileHeight,
        matrix.tileWidth,
        matrix.tileHeight
      );
    }
  });

  await Promise.all(workers);

  // Crop the mosaic to exactly bbox and scale to requested output size.
  const originX = matrix.topLeftCorner[0];
  const originY = matrix.topLeftCorner[1];

  const cropXMap = bbox[0] - (originX + range.minCol * range.tileSpanX);
  const cropYMap = (originY - range.minRow * range.tileSpanY) - bbox[3];

  const cropX = cropXMap / range.res;
  const cropY = cropYMap / range.res;
  const cropW = (bbox[2] - bbox[0]) / range.res;
  const cropH = (bbox[3] - bbox[1]) / range.res;

  const out = document.createElement("canvas");
  out.width = widthPx;
  out.height = heightPx;
  const octx = out.getContext("2d");
  octx.drawImage(mosaic, cropX, cropY, cropW, cropH, 0, 0, widthPx, heightPx);

  return createImageBitmap(out);
}

function drawTrackOnCanvas(ctx, xs, ys, bbox, width, height, color, opacity, trackWidth) {
  const [minx, miny, maxx, maxy] = bbox;
  const toPixel = (x, y) => {
    const px = ((x - minx) / (maxx - minx)) * width;
    const py = height - ((y - miny) / (maxy - miny)) * height;
    return [px, py];
  };

  const drawMask = new Uint8Array(xs.length);
  for (let i = 0; i < xs.length; i += 1) {
    if (pointInBBox(xs[i], ys[i], bbox)) {
      drawMask[i] = 1;
      if (i > 0) drawMask[i - 1] = 1;
      if (i + 1 < xs.length) drawMask[i + 1] = 1;
    }
  }

  ctx.beginPath();
  let started = false;
  for (let i = 0; i < xs.length; i += 1) {
    if (!drawMask[i]) {
      started = false;
      continue;
    }
    const [px, py] = toPixel(xs[i], ys[i]);
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }
  }

  ctx.save();
  ctx.globalAlpha = Number.isFinite(opacity) ? opacity : DEFAULT_TRACK_OPACITY;
  ctx.strokeStyle = color;
  ctx.lineWidth = Number.isFinite(trackWidth) ? trackWidth : TRACK_STROKE_PX;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
}

function formatScaleLabel(scale) {
  return String(scale).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function drawPageLabel(ctx, pageNumber, scale, epsgCode) {
  const utmZone = epsgCode - 25800;
  const label = `${pageNumber} | 1:${formatScaleLabel(scale)} | UTM ${utmZone}`;
  const pad = 12;
  ctx.font = "18px IBM Plex Mono, monospace";
  const metrics = ctx.measureText(label);
  const textW = metrics.width;
  const textH = 21;
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.fillRect(pad, pad, textW + pad * 2, textH + pad);
  ctx.fillStyle = "#111";
  ctx.fillText(label, pad + 9, pad + textH);
}

function formatDeclination(deg) {
  if (!Number.isFinite(deg)) return "ukendt";
  const absVal = Math.abs(deg).toFixed(1);
  const hemi = deg >= 0 ? "Ø" : "V";
  return `${absVal}° ${hemi}`;
}

function formatConvergence(deg) {
  if (!Number.isFinite(deg)) return "ukendt";
  const absVal = Math.abs(deg).toFixed(1);
  const hemi = deg >= 0 ? "Ø" : "V";
  return `${absVal}° ${hemi}`;
}

function computeGridConvergenceDeg(lonDeg, latDeg) {
  const zone = utmZoneFromLon(lonDeg);
  const lon0 = zone * 6 - 183;
  const deltaLon = (lonDeg - lon0) * (Math.PI / 180);
  const lat = latDeg * (Math.PI / 180);
  const gamma = Math.atan(Math.tan(deltaLon) * Math.sin(lat));
  return (gamma * 180) / Math.PI;
}


function drawDeclinationLabel(ctx, declinationTrue, convergence, width, height) {
  // Magnetic declination from geomagnetism is relative to TRUE north.
  // If we want magnetic declination relative to GRID north (G-M angle), we must
  // subtract grid convergence (GRID - TRUE): (MAG - GRID) = (MAG - TRUE) - (GRID - TRUE).
  const declinationGrid =
    Number.isFinite(declinationTrue) && Number.isFinite(convergence)
      ? declinationTrue - convergence
      : NaN;

  const lines = [
    `Mag. dekl. (gitter): ${formatDeclination(declinationGrid)}`,
    `Mag. dekl. (sand nord): ${formatDeclination(declinationTrue)}`,
  ];
  const pad = 12;
  ctx.font = "18px IBM Plex Mono, monospace";
  const lineHeight = 21;
  const textW = Math.max(...lines.map((line) => ctx.measureText(line).width));
  const boxH = lineHeight * lines.length + pad;
  const boxY = height - pad - boxH;
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.fillRect(pad, boxY, textW + pad * 2, boxH);
  ctx.fillStyle = "#111";
  lines.forEach((line, idx) => {
    ctx.fillText(line, pad + 9, boxY + lineHeight * (idx + 1));
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function createRenderProgressUpdater(total) {
  let lastUpdate = 0;
  let pending = null;

  const update = (completed) => {
    pending = completed;
    const now = performance.now();
    if (now - lastUpdate < 100) return;
    lastUpdate = now;
    setStatus(`Renderer side ${pending} / ${total}...`, true);
    setRenderProgress(pending, total, true);
    pending = null;
  };

  const flush = () => {
    if (pending === null) return;
    setStatus(`Renderer side ${pending} / ${total}...`, true);
    setRenderProgress(pending, total, true);
    pending = null;
  };

  return { update, flush };
}

async function runWithConcurrency(taskFns, limit) {
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < taskFns.length) {
      const i = cursor;
      cursor += 1;
      await taskFns[i]();
    }
  });
  await Promise.all(workers);
}

function computeLayoutPages(pointsLonLat, options) {
  const projection = options.projection ?? null;
  let transformer;
  let epsg;
  let xs;
  let ys;
  if (projection?.transformer && projection?.epsg && projection?.xs && projection?.ys) {
    ({ transformer, epsg, xs, ys } = projection);
  } else {
    const fresh = buildProjection(pointsLonLat);
    ({ transformer, epsg, xs, ys } = fresh);
  }
  const bbox = bboxFromPoints(xs, ys);
  const overlap = clampOverlap(options.overlap);
  let pages = [];
  let statusLine = "";

  if (options.orientation === "auto") {
    const margin = clampMargin(options.margin ?? DEFAULT_MARGIN);
    pages = computeAdaptivePages(xs, ys, { ...options, overlap, margin });
    statusLine = `Sider: ${pages.length} | ${options.paper} | 1:${options.scale} | overlap ${(overlap * 100).toFixed(1)}% | margin ${(margin * 100).toFixed(0)}% | auto`;
  } else {
    const { wPx, hPx, wM, hM } = pageGroundSpan(
      options.scale,
      options.dpi,
      options.paper,
      options.orientation
    );

    const { bboxes, rows, cols } = computePageGrid(bbox, wM, hM, overlap);

    const originalBBoxes = bboxes.slice();
    const desiredBBoxes = bboxes.map((bb) => recenterPageBBox(bb, xs, ys, wM, hM));
    const alignedBBoxes = alignBBoxesToGrid(
      originalBBoxes,
      desiredBBoxes,
      rows,
      cols,
      wM,
      hM
    );

    const indexed = alignedBBoxes.map((bb) => [bb, pageTrackIndex(bb, xs, ys)]);
    const filteredIndexed = indexed.some((entry) => Number.isFinite(entry[1]))
      ? indexed.filter((entry) => Number.isFinite(entry[1]))
      : indexed;
    filteredIndexed.sort((a, b) => a[1] - b[1]);

    const sortedBBoxes = filteredIndexed.map((entry) => entry[0]);
    pages = sortedBBoxes.map((bboxEntry) => ({
      bbox: bboxEntry,
      orientation: options.orientation,
      wPx,
      hPx,
      wM,
      hM,
    }));

    statusLine = `Sider: ${rows} rækker x ${cols} kolonner | ${options.paper} | 1:${options.scale} | overlap ${(overlap * 100).toFixed(1)}%`;
  }

  return { pages, xs, ys, epsg, transformer, statusLine };
}

function heightOverlayScaleForMapScale(scale) {
  if (HEIGHT_OVERLAY_SCALE_BY_MAP_SCALE[scale]) {
    return HEIGHT_OVERLAY_SCALE_BY_MAP_SCALE[scale];
  }
  return 0.45;
}

async function renderGPXToPdf(file, options) {
  const pointsLonLat =
    options.pointsLonLat ??
    (file ? parseGPX(await file.text()) : []);
  const projection = options.projection ?? null;
  let transformer;
  let epsg;
  let xs = [];
  let ys = [];
  if (projection?.transformer && projection?.epsg && projection?.xs && projection?.ys) {
    ({ transformer, epsg, xs, ys } = projection);
  } else if (projection?.transformer && projection?.epsg) {
    transformer = projection.transformer;
    epsg = projection.epsg;
    xs = projection.xs ?? [];
    ys = projection.ys ?? [];
  } else {
    if (!pointsLonLat.length) {
      throw new Error("Ingen GPX-fil valgt.");
    }
    const fresh = buildProjection(pointsLonLat);
    ({ transformer, epsg, xs, ys } = fresh);
  }
  const modelDate = new Date();
  const declinationModel = options.showDeclination
    ? geomagnetism.model()
    : null;

  let pages = options.pages;
  let statusLine = "";
  if (!pages || !pages.length) {
    const layout = computeLayoutPages(pointsLonLat, options);
    pages = layout.pages;
    statusLine = layout.statusLine;
  }

  if (statusLine) {
    setStatus(statusLine);
  }
  setRenderProgress(0, pages.length, false);

  const pdfDoc = await PDFDocument.create();
  const results = Array.from({ length: pages.length });
  let completed = 0;
  const progress = createRenderProgressUpdater(pages.length);

  const tasks = pages.map((pageInfo, idx) => async () => {
    const { bbox: pageBBox, wPx, hPx } = pageInfo;
    const baseImgPromise = USE_WMTS_FOR_BASEMAP
      ? fetchWmtsStitchedImage(pageBBox, wPx, hPx, epsg, options.layer)
      : fetchWmsImage(
          {
            baseUrl: WMS_BASE_URL,
            layer: options.layer,
            styles: "",
            format: "image/png",
            transparent: false,
          },
          pageBBox,
          wPx,
          hPx,
          epsg
        );

    const gridImgPromise = fetchWmsImage(
      {
        baseUrl: WMS_GRID_URL,
        layer: GRID_LAYER,
        styles: "",
        format: "image/png",
        transparent: true,
      },
      pageBBox,
      wPx,
      hPx,
      epsg
    );

  const overlayPromises = [];
  const heightLayers = options.heightLayers ?? [];
    const weakIceLayers = options.weakIceLayers ?? [];
    const weakIceOpacity = Number.isFinite(options.weakIceOpacity)
      ? options.weakIceOpacity
      : 1;
  const heightOpacity = Number.isFinite(options.heightOpacity)
    ? options.heightOpacity
    : DEFAULT_HEIGHT_OVERLAY_OPACITY;
    const heightScale = Number.isFinite(options.heightOverlayScaleFactor)
      ? options.heightOverlayScaleFactor
      : heightOverlayScaleForMapScale(options.scale);
    const heightWidthPx = Math.max(1, Math.round(wPx * heightScale));
    const heightHeightPx = Math.max(1, Math.round(hPx * heightScale));
  const heightOverlayPromises = heightLayers.map((layerName) =>
    fetchWmsImage(
      {
        baseUrl: WMS_HEIGHT_URL,
        layer: layerName,
          styles: "",
          format: "image/png",
          transparent: true,
        },
        pageBBox,
        heightWidthPx,
        heightHeightPx,
        epsg
      )
    );
  const weakIceOverlayPromises = weakIceLayers.map((layerName) =>
    fetchWmsImage(
      {
        baseUrl: WMS_WEAK_ICE_URL,
        layer: layerName,
        styles: "",
        format: "image/png",
        transparent: true,
      },
      pageBBox,
      wPx,
      hPx,
      epsg
    )
  );
  if (options.showSkiRoutes) {
    overlayPromises.push(
      fetchWmsImage(
        {
            baseUrl: WMS_ROUTE_URL,
            layer: WMS_ROUTE_LAYERS.ski,
            styles: "",
            format: "image/png",
            transparent: true,
          },
          pageBBox,
          wPx,
          hPx,
          epsg
        )
      );
    }
    if (options.showHikeRoutes) {
      overlayPromises.push(
        fetchWmsImage(
          {
            baseUrl: WMS_ROUTE_URL,
            layer: WMS_ROUTE_LAYERS.hike,
            styles: "",
            format: "image/png",
            transparent: true,
          },
          pageBBox,
          wPx,
          hPx,
          epsg
        )
      );
    }

  const [baseImg, gridImg, ...overlayImgs] = await Promise.all([
    baseImgPromise,
    gridImgPromise,
    ...heightOverlayPromises,
    ...weakIceOverlayPromises,
    ...overlayPromises,
  ]);
  const heightOverlayImgs = overlayImgs.slice(0, heightOverlayPromises.length);
  const weakIceOverlayImgs = overlayImgs.slice(
    heightOverlayPromises.length,
    heightOverlayPromises.length + weakIceOverlayPromises.length
  );
  const routeOverlayImgs = overlayImgs.slice(
    heightOverlayPromises.length + weakIceOverlayPromises.length
  );
  const activeMaskColors = getActiveHeightMaskColors();
  const maskedHeightOverlays = heightOverlayImgs.map((img) => {
    const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const maskCtx = canvas.getContext("2d", { willReadFrequently: true });
      if (!maskCtx) return img;
      maskCtx.drawImage(img, 0, 0);
      applyHeightMaskToContext(maskCtx, canvas.width, canvas.height, activeMaskColors);
      return canvas;
    });

    const canvas = document.createElement("canvas");
    canvas.width = wPx;
    canvas.height = hPx;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(baseImg, 0, 0, wPx, hPx);
    ctx.drawImage(gridImg, 0, 0, wPx, hPx);
  if (maskedHeightOverlays.length) {
    ctx.save();
    ctx.globalAlpha = heightOpacity;
    maskedHeightOverlays.forEach((img) => {
      ctx.drawImage(img, 0, 0, wPx, hPx);
    });
    ctx.restore();
  }
    if (weakIceOverlayImgs.length) {
      ctx.save();
      ctx.globalAlpha = weakIceOpacity;
      weakIceOverlayImgs.forEach((img) => {
        ctx.drawImage(img, 0, 0, wPx, hPx);
      });
      ctx.restore();
    }
  if (routeOverlayImgs.length) {
    ctx.save();
    ctx.globalAlpha = ROUTE_OVERLAY_OPACITY;
      routeOverlayImgs.forEach((img) => {
        ctx.drawImage(img, 0, 0, wPx, hPx);
      });
      ctx.restore();
    }
    drawTrackOnCanvas(
      ctx,
      xs,
      ys,
      pageBBox,
      wPx,
      hPx,
      options.trackColor ?? "#ff0000",
      options.trackOpacity,
      options.trackWidth
    );
    drawPageLabel(ctx, idx + 1, options.scale, epsg);
    if (declinationModel) {
      const centerX = (pageBBox[0] + pageBBox[2]) / 2;
      const centerY = (pageBBox[1] + pageBBox[3]) / 2;
      const [lon, lat] = transformer.inverse([centerX, centerY]);
      let info;
      try {
        info = declinationModel.point([lat, lon, 0], modelDate);
      } catch (error) {
        info = declinationModel.point([lat, lon, 0]);
      }
      const convergence = computeGridConvergenceDeg(lon, lat);
      drawDeclinationLabel(ctx, info.decl, convergence, wPx, hPx);
    }

    const imageFormat = options.pageImageFormat ?? "image/png";
    const useJpeg = imageFormat === "image/jpeg";
    const quality = useJpeg
      ? clampPdfQuality(
          Number.isFinite(options.pageImageQuality)
            ? options.pageImageQuality
            : DEFAULT_JPEG_QUALITY
        )
      : undefined;
    const imageBlob = await canvasToBlob(canvas, imageFormat, quality);
    if (!imageBlob) {
      throw new Error("Kunne ikke oprette sidebillede.");
    }

    results[idx] = { imageBlob, imageFormat };
    completed += 1;
    progress.update(completed);
  });

  setStatus(`Renderer side 0 / ${pages.length}...`, true);
  setRenderProgress(0, pages.length, true);
  await runWithConcurrency(tasks, PAGE_RENDER_CONCURRENCY);
  progress.flush();
  setStatus("Samler PDF...", true);

  for (let idx = 0; idx < results.length; idx += 1) {
    const { imageBlob, imageFormat } = results[idx];
    const imageBytes = await imageBlob.arrayBuffer();
    const { orientation } = pages[idx];
    const [paperWmm, paperHmm] = paperDimensionsMm(options.paper, orientation);
    const pageWidthPt = (paperWmm / 25.4) * 72;
    const pageHeightPt = (paperHmm / 25.4) * 72;
    const embedded =
      imageFormat === "image/jpeg"
        ? await pdfDoc.embedJpg(imageBytes)
        : await pdfDoc.embedPng(imageBytes);
    const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);

    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: pageWidthPt,
      height: pageHeightPt,
    });
  }

  const pdfBytes = await pdfDoc.save();
  return new Blob([pdfBytes], { type: "application/pdf" });
}

setupSegmentedControls();
setupColorPicker();
setupTrackOpacity();
setupTrackWidth();
setupSidebarToggle();
setupConfirmModal();
initMap();

const controlsForm = document.getElementById("controls");
const fileInput = document.getElementById("gpxFile");

function updateFileMeta(file, pointsLonLat) {
  const lengthMeters = computeTrackLengthMeters(pointsLonLat);
  fileMetaEl.textContent = "";
  const nameRow = document.createElement("div");
  const nameLabel = document.createElement("strong");
  nameLabel.textContent = "Fil:";
  const nameValue = document.createElement("span");
  nameValue.textContent = ` ${file.name}`;
  nameRow.appendChild(nameLabel);
  nameRow.appendChild(nameValue);

  const lengthRow = document.createElement("div");
  const lengthLabel = document.createElement("strong");
  lengthLabel.textContent = "Sporlængde:";
  const lengthValue = document.createElement("span");
  lengthValue.textContent = ` ${formatDistance(lengthMeters)}`;
  lengthRow.appendChild(lengthLabel);
  lengthRow.appendChild(lengthValue);

  fileMetaEl.appendChild(nameRow);
  fileMetaEl.appendChild(lengthRow);
  fileMetaEl.classList.remove("hidden");
  if (trackControlsEl) {
    trackControlsEl.classList.remove("hidden");
  }
}

function getOverlapValue() {
  const overlapInput = Number(document.getElementById("overlap").value);
  return Number.isFinite(overlapInput)
    ? overlapInput / 100
    : DEFAULT_OVERLAP;
}

function getMarginValue() {
  const marginInput = Number(document.getElementById("margin").value);
  return Number.isFinite(marginInput)
    ? marginInput / 100
    : DEFAULT_MARGIN;
}

function getDpiValue() {
  const dpiInput = Number(document.getElementById("dpi").value);
  return Number.isFinite(dpiInput) ? dpiInput : DEFAULT_DPI;
}

function generateLayout(statusMessage) {
  if (!cachedPoints) {
    setStatus("Vælg en GPX-fil.");
    return;
  }
  clearDownload();
  setStatus(statusMessage || "Beregner layout...", true);
  const overlapValue = getOverlapValue();
  const marginValue = getMarginValue();
  const dpiValue = getDpiValue();
  const layout = computeLayoutPages(cachedPoints, {
    scale: selections.scale,
    dpi: dpiValue,
    paper: selections.paper,
    orientation: selections.orientation,
    overlap: overlapValue,
    margin: marginValue,
    projection: projectionState,
  });
  layoutPages = layout.pages;
  ensurePageIds(layoutPages);
  isLayoutReady = true;
  hasManualEdits = false;
  selectedPageIndex = null;
  setProgress(3, [1, 2]);
  setStatus(layout.statusLine || "Layout klar.");
  updateRenderButtonState();
  renderPageOverlays();
  updateSelectionBar();
  const nextHeightBounds = computeHeightOverlayBounds();
  if (!boundsEqual(heightOverlayBounds, nextHeightBounds)) {
    heightOverlayBounds = nextHeightBounds;
    refreshHeightOverlays();
  }
}

function computeHeightOverlayBounds() {
  if (!layoutPages.length || !projectionState?.transformer || !L) return null;
  let bounds = null;
  layoutPages.forEach((page) => {
    const pageBounds = bboxToLatLngBounds(page.bbox, projectionState.transformer);
    if (!pageBounds) return;
    bounds = bounds ? bounds.extend(pageBounds) : pageBounds;
  });
  return bounds;
}

function boundsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a.equals === "function") return a.equals(b);
  const aSw = a.getSouthWest();
  const aNe = a.getNorthEast();
  const bSw = b.getSouthWest();
  const bNe = b.getNorthEast();
  const tol = 1e-6;
  return (
    Math.abs(aSw.lat - bSw.lat) < tol &&
    Math.abs(aSw.lng - bSw.lng) < tol &&
    Math.abs(aNe.lat - bNe.lat) < tol &&
    Math.abs(aNe.lng - bNe.lng) < tol
  );
}

async function handleFileSelection(file) {
  if (!file) return;
  selectedFile = file;
  cachedPoints = null;
  projectionState = null;
  renderBtn.textContent = "Generér kort-PDF";
  clearDownload();
  resetLayoutState();
  setStatus("Læser GPX...");
  try {
    let points;
    let projection;
    if (file.size > LARGE_FILE_THRESHOLD) {
      try {
        projection = await parseLargeGpxWithWorker(file);
        points = projection.pointsLonLat;
      } catch (workerError) {
        const text = await file.text();
        points = parseGPX(text);
        projection = buildProjection(points);
      }
    } else {
      const text = await file.text();
      points = parseGPX(text);
      projection = buildProjection(points);
    }
    cachedPoints = points;
    projectionState = projection;
    transformerState = {
      transformer: projection.transformer,
      epsg: projection.epsg,
    };
    updateFileMeta(file, points);
    updateTrackLayer(points);
    setTrackControlsVisible(true);
    setProgress(2, [1]);
    setStatus("GPX indlæst. Layout beregnes...");
    updateRenderButtonState();
    generateLayout();
    const nextFocus = document.querySelector("[data-paper=\"A4\"]");
    if (nextFocus) nextFocus.focus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Fejl: ${message}`);
    fileMetaEl.classList.add("hidden");
    if (trackControlsEl) {
      trackControlsEl.classList.add("hidden");
    }
    transformerState = null;
    projectionState = null;
    clearTrackLayer();
    setTrackControlsVisible(false);
    resetLayoutState();
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  handleFileSelection(file);
});

dropzoneEl.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzoneEl.classList.add("active");
});

dropzoneEl.addEventListener("dragleave", () => {
  dropzoneEl.classList.remove("active");
});

dropzoneEl.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzoneEl.classList.remove("active");
  const file = event.dataTransfer.files?.[0];
  if (file) {
    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileInput.files = transfer.files;
    } catch (error) {
      // Some browsers disallow programmatic assignment; we still handle the file directly.
    }
    handleFileSelection(file);
  }
});

orientationToggleEl.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleSelectedOrientation();
});

if (removePageBtn) {
  removePageBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    removePage(selectedPageIndex);
  });
}

if (addPageBtn) {
  addPageBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    addPageAtCenter();
  });
}

if (selectionSelectEl) {
  selectionSelectEl.addEventListener("change", () => {
    if (selectedPageIndex === null) return;
    const nextIndex = Number(selectionSelectEl.value) - 1;
    const page = layoutPages[selectedPageIndex];
    if (!page) return;
    movePageById(page.id, nextIndex);
  });
}

selectionBarEl.addEventListener("click", (event) => {
  event.stopPropagation();
});

const overlapInputEl = document.getElementById("overlap");
overlapInputEl.dataset.prev = overlapInputEl.value;
updateOverlapLabel();
overlapInputEl.addEventListener("input", () => {
  updateOverlapLabel();
});
overlapInputEl.addEventListener("change", async () => {
  if (!(await confirmOverrideManualEdits())) {
    overlapInputEl.value = overlapInputEl.dataset.prev || overlapInputEl.value;
    updateOverlapLabel();
    return;
  }
  const nextValue = Number(overlapInputEl.value);
  if (!Number.isFinite(nextValue)) return;
  overlapInputEl.dataset.prev = overlapInputEl.value;
  updateOverlapLabel();
  if (cachedPoints) {
    generateLayout("Overlap er ændret. Layout opdateres...");
  }
});

const marginInputEl = document.getElementById("margin");
marginInputEl.dataset.prev = marginInputEl.value;
updateMarginLabel();
marginInputEl.addEventListener("input", () => {
  updateMarginLabel();
});
marginInputEl.addEventListener("change", async () => {
  if (!(await confirmOverrideManualEdits())) {
    marginInputEl.value = marginInputEl.dataset.prev || marginInputEl.value;
    updateMarginLabel();
    return;
  }
  const nextValue = Number(marginInputEl.value);
  if (!Number.isFinite(nextValue)) return;
  marginInputEl.dataset.prev = marginInputEl.value;
  updateMarginLabel();
  if (cachedPoints) {
    generateLayout("Sikkerhedsmargin er ændret. Layout opdateres...");
  }
});

const dpiInputEl = document.getElementById("dpi");
dpiInputEl.dataset.prev = dpiInputEl.value;
dpiInputEl.addEventListener("change", async () => {
  if (!(await confirmOverrideManualEdits())) {
    dpiInputEl.value = dpiInputEl.dataset.prev || dpiInputEl.value;
    return;
  }
  const nextValue = Number(dpiInputEl.value);
  if (!Number.isFinite(nextValue)) return;
  dpiInputEl.dataset.prev = dpiInputEl.value;
  if (cachedPoints) {
    generateLayout("Opløsning er ændret. Layout opdateres...");
  }
});

if (skiRoutesToggleEl) {
  skiRoutesToggleEl.addEventListener("change", () => {
    updateRouteOverlays();
  });
}

if (hikeRoutesToggleEl) {
  hikeRoutesToggleEl.addEventListener("change", () => {
    updateRouteOverlays();
  });
}

if (weakIceToggleEl) {
  weakIceToggleEl.addEventListener("change", () => {
    updateWeakIceOpacityVisibility();
    updateWeakIceOverlays();
  });
}

heightLayerToggleEls.forEach((toggle) => {
  toggle.addEventListener("change", () => {
    updateHeightOpacityVisibility();
    updateHeightMaskVisibility();
    updateHeightLegendVisibility();
    updateHeightOverlays();
  });
});

if (heightOpacityEl) {
  updateHeightOpacityLabel();
  heightOpacityEl.addEventListener("input", () => {
    updateHeightOpacityLabel();
    heightOverlayLayers.forEach((layer) => {
      layer.setOpacity(effectiveHeightOpacity());
    });
  });
}

function updateWeakIceOpacityLabel() {
  if (!weakIceOpacityValueEl || !weakIceOpacityEl) return;
  const value = Number(weakIceOpacityEl.value);
  if (!Number.isFinite(value)) return;
  const percent = Math.round(value * 100);
  weakIceOpacityValueEl.textContent = `${percent}%`;
}

if (weakIceOpacityEl) {
  updateWeakIceOpacityLabel();
  weakIceOpacityEl.addEventListener("input", () => {
    updateWeakIceOpacityLabel();
    weakIceOverlayLayers.forEach((layer) => {
      layer.setOpacity(effectiveWeakIceOpacity());
    });
  });
}

if (heightMaskGreenAEl) {
  heightMaskGreenAEl.addEventListener("change", () => {
    refreshHeightOverlays();
  });
}

if (heightMaskGreenBEl) {
  heightMaskGreenBEl.addEventListener("change", () => {
    refreshHeightOverlays();
  });
}

updateWeakIceOpacityVisibility();
updateHeightOpacityVisibility();
updateHeightMaskVisibility();

if (pdfJpegToggleEl) {
  pdfJpegToggleEl.addEventListener("change", () => {
    updateJpegQualityVisibility();
  });
}

if (jpegQualityEl) {
  updateJpegQualityLabel();
  jpegQualityEl.addEventListener("input", () => {
    updateJpegQualityLabel();
  });
}

updateJpegQualityVisibility();

controlsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearDownload();

  if (!selectedFile && !projectionState?.transformer) {
    setStatus("Kortet er ikke klar endnu.");
    return;
  }

  if (!ALLOWED_SCALES.has(selections.scale)) {
    setStatus("Invalid scale selected.");
    return;
  }

  if (!layoutPages.length) {
    setStatus("Layout er ikke klar endnu.");
    return;
  }

  const overlapValue = getOverlapValue();
  const marginValue = getMarginValue();
  const dpiValue = getDpiValue();
  const showDeclination = document.getElementById("declinationToggle").checked;
  const showSkiRoutes = Boolean(skiRoutesToggleEl?.checked);
  const showHikeRoutes = Boolean(hikeRoutesToggleEl?.checked);
  const useJpeg = Boolean(pdfJpegToggleEl?.checked);
  const jpegQualityValue = Number(jpegQualityEl?.value);
  const pageImageFormat = useJpeg ? "image/jpeg" : "image/png";
  const pageImageQuality = Number.isFinite(jpegQualityValue)
    ? jpegQualityValue
    : DEFAULT_JPEG_QUALITY;
  const heightLayers = getSelectedHeightLayers();
  const heightOpacity = effectiveHeightOpacity();
  const weakIceLayers = getSelectedWeakIceLayers();
  const weakIceOpacity = effectiveWeakIceOpacity();
  const trackOpacity = selections.trackOpacity;
  const trackWidth = selections.trackWidth;
  fetch("/.netlify/functions/log_click", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  keepalive: true,
  body: JSON.stringify({
    event: "generate-pdf",
    path: location.pathname,
    scale: selections.scale,
    paper: selections.paper,
    orientation: selections.orientation,
    overlap: overlapValue,
    margin: marginValue,
    dpi: dpiValue,
    showDeclination,
    showSkiRoutes,
    showHikeRoutes,
    heightLayers,
    heightOpacity,
    weakIceLayers,
    weakIceOpacity,
    trackOpacity,
    trackWidth,
    trackColor: selections.trackColor,
    pageImageFormat,
    pageImageQuality,
  }),
}).catch(() => {});
  window.umami?.track("generate-pdf", {
    scale: selections.scale,
    paper: selections.paper,
    orientation: selections.orientation,
    overlap: overlapValue,
    margin: marginValue,
    dpi: dpiValue,
    showDeclination,
    showSkiRoutes,
    showHikeRoutes,
    heightLayers,
    heightOpacity,
    weakIceLayers,
    weakIceOpacity,
    trackOpacity,
    trackWidth,
    trackColor: selections.trackColor,
    pageImageFormat,
    pageImageQuality,
  });
  renderBtn.disabled = true;
  renderBtn.classList.remove("ready");
  setProgress(3, [1, 2]);
  setStatus("Forbereder PDF...", true);

  try {
    const pdfBlob = await renderGPXToPdf(selectedFile, {
      scale: selections.scale,
      dpi: dpiValue,
      paper: selections.paper,
      orientation: selections.orientation,
      overlap: overlapValue,
      margin: marginValue,
      layer: DEFAULT_LAYER,
      showDeclination,
      showSkiRoutes,
      showHikeRoutes,
      heightLayers,
      heightOpacity,
      weakIceLayers,
      weakIceOpacity,
      trackOpacity,
      trackWidth,
      trackColor: selections.trackColor,
      pageImageFormat,
      pageImageQuality,
      pointsLonLat: cachedPoints ?? [],
      projection: projectionState,
      pages: layoutPages,
    });

    setDownload(pdfBlob);
    setProgress(3, [1, 2, 3]);
    setStatus("PDF klar.");
    setRenderProgress(0, 1, false);
    renderBtn.textContent = "Generér kort-PDF igen";
    renderBtn.classList.add("ready");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const friendly = message.includes("Failed to fetch")
      ? "Kortfliser kunne ikke hentes (mulig CORS-fejl). Prøv igen eller brug et andet netværk."
      : message;
    setStatus(`Fejl: ${friendly}`);
    setProgress(3, [1, 2]);
    setRenderProgress(0, 1, false);
  } finally {
    renderBtn.disabled = false;
    if (spinnerEl) {
      spinnerEl.classList.add("hidden");
    }
  }
});

window.addEventListener("resize", () => {
  if (mapInstance) {
    mapInstance.invalidateSize();
  }
  updateSelectionBar();
});

window.addEventListener("keydown", (event) => {
  if (!layoutPages.length) return;
  const target = event.target;
  if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
    return;
  }
  if (event.key === "Backspace" || event.key === "Delete") {
    removePage(selectedPageIndex);
  }
});

setProgress(1, []);
updateRenderButtonState();
setTrackControlsVisible(false);
