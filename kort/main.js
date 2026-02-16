import proj4 from "https://cdn.jsdelivr.net/npm/proj4@2.9.0/+esm";
import geomagnetism from "https://cdn.jsdelivr.net/npm/geomagnetism@0.2.0/+esm";
import { PDFDocument } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";
import { PROVIDERS, getLeafletTileUrl, getWmsConfig, getMaxZoom, getMinMaxZoom, getCombinedAttribution } from "./providers/config.js";
import { createCompositeTileLayer } from "./layers/composite-tile-layer.js";
import { getTileProviders, getPrimaryProvider, preloadBorders } from "./providers/borders.js";

const L = window.L;

// Default provider for WMS overlays and fallback when no border polygon matches
const CURRENT_PROVIDER = "no";

// Get WMS configuration from provider
const noWmsConfig = PROVIDERS.no.wms;
const WMS_ROUTE_URL = noWmsConfig.routes.url;
const WMS_HEIGHT_URL = noWmsConfig.height.url;
const WMS_WEAK_ICE_URL = noWmsConfig.weakIce.url;
const WMS_ROUTE_LAYERS = noWmsConfig.routes.layers;
const WMS_WEAK_ICE_LAYERS = noWmsConfig.weakIce.layers;

// WMTS configuration from provider
const noWmtsConfig = PROVIDERS.no.wmts;
const WMTS_CAPABILITIES_URL = noWmtsConfig.capabilitiesUrl;
const WMTS_BASE_URL = noWmtsConfig.baseUrl;
const MAP_TILE_MATRIX_SET = noWmtsConfig.matrixSet;
const DEFAULT_LAYER = noWmtsConfig.defaultLayer;
const MAP_TILE_URL = getLeafletTileUrl(CURRENT_PROVIDER);
const MAP_ATTRIBUTION = PROVIDERS.no.attribution;

// For PDF export, WMTS requires stitching many tiles. If a page would require
// too many tiles at the highest zoom, we automatically step down.
const WMTS_MAX_TILES_PER_PAGE = 120;
// Border pages use WebMercator for all providers (for proper clip alignment).
// At high latitudes, WebMercator needs ~4x more tiles than UTM for equivalent
// map detail because tiles cover less ground. Allow a higher budget so Norway
// can reach zoom 15 (scaleDenom ~17k) instead of being capped at zoom 14
// (scaleDenom ~34k, which renders 1.8x less map detail).
const WMTS_MAX_TILES_BORDER_PAGE = 500;
const WMTS_TILE_SIZE = 256;
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
const MAX_GPX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
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
const mapHintEl = document.getElementById("mapHint");
const mapHintScrim = mapHintEl?.querySelector(".map-hint-scrim") ?? null;
const mapHintScrimPath = document.getElementById("mapHintScrimPath");
const mapHintOutline = mapHintEl?.querySelector(".map-hint-outline") ?? null;
const mapHintOutlinePrimary = document.getElementById("mapHintOutlinePrimary");
const mapHintOutlineSecondary = document.getElementById("mapHintOutlineSecondary");
const mapHintTipPrimaryEl = document.getElementById("mapHintTipPrimary");
const mapHintTipSecondaryEl = document.getElementById("mapHintTipSecondary");
const mapToastEl = document.getElementById("mapToast");
const mapToastTextEl = document.getElementById("mapToastText");
const mapToastCloseEl = document.getElementById("mapToastClose");
const selectionBarEl = document.getElementById("selectionBar");
const selectionSelectEl = document.getElementById("selectionSelect");
const orientationToggleEl = document.getElementById("orientationToggle");
const removePageBtn = document.getElementById("removePageBtn");
const lockToggleBtn = document.getElementById("lockToggleBtn");
const lockAllBtn = document.getElementById("lockAllBtn");
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
const overlayTabsEl = document.querySelectorAll(".overlay-tab");
const overlayContentsEl = document.querySelectorAll(".overlay-content");
const scaleWarningEl = document.getElementById("scaleWarning");
const MAP_HINT_SESSION_KEY = "gpx_map_hint_dismissed";
const MAP_TOAST_AUTO_KEY = "gpx_map_toast_auto_shown";
const MAP_TOAST_MANUAL_KEY = "gpx_map_toast_manual_shown";

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
let globalLockAll = false;
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

function isMapHintDismissed() {
  try {
    return sessionStorage.getItem(MAP_HINT_SESSION_KEY) === "1";
  } catch (error) {
    return false;
  }
}

function dismissMapHint() {
  if (!mapHintEl) return;
  mapHintEl.classList.add("hidden");
  document.body.classList.remove("map-hint-active");
  if (dropzoneEl) {
    dropzoneEl.style.background = "";
  }
  try {
    sessionStorage.setItem(MAP_HINT_SESSION_KEY, "1");
  } catch (error) {
    // Ignore storage failures (private mode, etc.)
  }
}

let mapToastTimeout = null;

function hideMapToast() {
  if (!mapToastEl) return;
  mapToastEl.classList.remove("visible");
  if (mapToastTimeout) {
    window.clearTimeout(mapToastTimeout);
    mapToastTimeout = null;
  }
}

function showMapToast(message) {
  if (!mapToastEl || !mapToastTextEl) return;
  mapToastTextEl.textContent = message;
  mapToastEl.classList.add("visible");
  if (mapToastTimeout) {
    window.clearTimeout(mapToastTimeout);
  }
  mapToastTimeout = window.setTimeout(() => {
    hideMapToast();
  }, 15200);
}

function shouldShowToast(key) {
  try {
    return sessionStorage.getItem(key) !== "1";
  } catch (error) {
    return true;
  }
}

function markToastShown(key) {
  try {
    sessionStorage.setItem(key, "1");
  } catch (error) {
    // Ignore storage failures (private mode, etc.)
  }
}

function showAutoLayoutToast(pageCount) {
  if (!pageCount || !shouldShowToast(MAP_TOAST_AUTO_KEY)) return;
  showMapToast(`Vi har lavet ${pageCount} sider til din rute. Træk i dem for at justere.`);
  markToastShown(MAP_TOAST_AUTO_KEY);
}

function showManualLayoutToast() {
  if (!shouldShowToast(MAP_TOAST_MANUAL_KEY)) return;
  if (mapHintEl && !mapHintEl.classList.contains("hidden")) return;
  showMapToast("Træk i siden for at justere. Klik for at slette eller ændre orientering.");
  markToastShown(MAP_TOAST_MANUAL_KEY);
}

function positionHintTooltip(tooltipEl, targetRect, gap, viewportW, viewportH) {
  if (!tooltipEl) return;
  const tipRect = tooltipEl.getBoundingClientRect();
  const width = tipRect.width || 240;
  const height = tipRect.height || 60;
  let x = targetRect.left + targetRect.width / 2 - width / 2;
  let y = targetRect.top - height - gap;
  if (y < 12) {
    y = targetRect.bottom + gap;
  }
  const maxX = viewportW - width - 12;
  const maxY = viewportH - height - 12;
  x = Math.min(Math.max(12, x), maxX);
  y = Math.min(Math.max(12, y), maxY);
  tooltipEl.style.setProperty("--hint-tip-x", `${x}px`);
  tooltipEl.style.setProperty("--hint-tip-y", `${y}px`);
}

function updateMapHintHighlight() {
  if (!mapHintEl || !addPageBtn || !dropzoneEl) return;
  if (mapHintEl.classList.contains("hidden")) {
    document.body.classList.remove("map-hint-active");
    if (dropzoneEl) {
      dropzoneEl.style.background = "";
    }
    return;
  }
  document.body.classList.add("map-hint-active");
  if (dropzoneEl) {
    dropzoneEl.style.background = "transparent";
  }
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  if (mapHintScrim) {
    mapHintScrim.setAttribute("width", `${viewportW}`);
    mapHintScrim.setAttribute("height", `${viewportH}`);
    mapHintScrim.setAttribute("viewBox", `0 0 ${viewportW} ${viewportH}`);
  }
  if (mapHintOutline) {
    mapHintOutline.setAttribute("width", `${viewportW}`);
    mapHintOutline.setAttribute("height", `${viewportH}`);
    mapHintOutline.setAttribute("viewBox", `0 0 ${viewportW} ${viewportH}`);
  }
  const btnRect = addPageBtn.getBoundingClientRect();
  const buttonPadding = 8;
  const buttonRadius = Number.parseFloat(
    window.getComputedStyle(addPageBtn).borderRadius
  ) || 12;
  const buttonHighlightRadius = buttonRadius + buttonPadding;
  const btnX = btnRect.left - buttonPadding;
  const btnY = btnRect.top - buttonPadding;
  const btnW = btnRect.width + buttonPadding * 2;
  const btnH = btnRect.height + buttonPadding * 2;
  mapHintEl.style.setProperty("--hint-x", `${btnX}px`);
  mapHintEl.style.setProperty("--hint-y", `${btnY}px`);
  mapHintEl.style.setProperty("--hint-w", `${btnW}px`);
  mapHintEl.style.setProperty("--hint-h", `${btnH}px`);
  mapHintEl.style.setProperty("--hint-radius", `${buttonHighlightRadius}px`);
  const buttonCutout = roundedRectPath(
    btnX,
    btnY,
    btnW,
    btnH,
    buttonHighlightRadius
  );
  if (mapHintOutlinePrimary) {
    mapHintOutlinePrimary.setAttribute("x", `${btnX}`);
    mapHintOutlinePrimary.setAttribute("y", `${btnY}`);
    mapHintOutlinePrimary.setAttribute("width", `${btnW}`);
    mapHintOutlinePrimary.setAttribute("height", `${btnH}`);
    mapHintOutlinePrimary.setAttribute("rx", `${buttonHighlightRadius}`);
    mapHintOutlinePrimary.setAttribute("ry", `${buttonHighlightRadius}`);
  }

  const dropTarget = dropzoneEl.querySelector(".dropzone-inner") || dropzoneEl;
  const dropRect = dropTarget.getBoundingClientRect();
  const dropPadding = 0;
  const dropRadius = Number.parseFloat(
    window.getComputedStyle(dropTarget).borderRadius
  ) || 16;
  const dropHighlightRadius = dropRadius;
  const dropX = dropRect.left - dropPadding;
  const dropY = dropRect.top - dropPadding;
  const dropW = dropRect.width + dropPadding * 2;
  const dropH = dropRect.height + dropPadding * 2;
  mapHintEl.style.setProperty("--hint2-x", `${dropX}px`);
  mapHintEl.style.setProperty("--hint2-y", `${dropY}px`);
  mapHintEl.style.setProperty("--hint2-w", `${dropW}px`);
  mapHintEl.style.setProperty("--hint2-h", `${dropH}px`);
  mapHintEl.style.setProperty("--hint2-radius", `${dropHighlightRadius}px`);
  const dropCutout = roundedRectPath(
    dropX,
    dropY,
    dropW,
    dropH,
    dropHighlightRadius
  );
  if (mapHintOutlineSecondary) {
    mapHintOutlineSecondary.setAttribute("x", `${dropX}`);
    mapHintOutlineSecondary.setAttribute("y", `${dropY}`);
    mapHintOutlineSecondary.setAttribute("width", `${dropW}`);
    mapHintOutlineSecondary.setAttribute("height", `${dropH}`);
    mapHintOutlineSecondary.setAttribute("rx", `${dropHighlightRadius}`);
    mapHintOutlineSecondary.setAttribute("ry", `${dropHighlightRadius}`);
  }

  positionHintTooltip(mapHintTipPrimaryEl, dropRect, 12, viewportW, viewportH);
  positionHintTooltip(mapHintTipSecondaryEl, btnRect, 12, viewportW, viewportH);

  if (mapHintScrimPath) {
    const base = `M0 0H${viewportW}V${viewportH}H0Z`;
    mapHintScrimPath.setAttribute("d", `${base}${dropCutout}${buttonCutout}`);
  }
}

function roundedRectPath(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  return [
    `M${x + radius} ${y}`,
    `H${x + w - radius}`,
    `A${radius} ${radius} 0 0 1 ${x + w} ${y + radius}`,
    `V${y + h - radius}`,
    `A${radius} ${radius} 0 0 1 ${x + w - radius} ${y + h}`,
    `H${x + radius}`,
    `A${radius} ${radius} 0 0 1 ${x} ${y + h - radius}`,
    `V${y + radius}`,
    `A${radius} ${radius} 0 0 1 ${x + radius} ${y}`,
    "Z",
  ].join("");
}

function getPdfFilename() {
  if (!selectedFile?.name) return "min_rute.pdf";
  const base = selectedFile.name.replace(/\.gpx$/i, "");
  const safeBase = base || "min_rute";
  return `${safeBase}.pdf`;
}

function setDownload(blob) {
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
  }
  const filename = getPdfFilename();
  downloadUrl = URL.createObjectURL(blob);
  if (downloadLink) {
    downloadLink.href = downloadUrl;
    downloadLink.download = filename;
    downloadLink.classList.remove("disabled");
  }
  window.open(downloadUrl, "_blank", "noopener");
  const tempLink = document.createElement("a");
  tempLink.href = downloadUrl;
  tempLink.download = filename;
  tempLink.rel = "noopener";
  tempLink.click();
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
  globalLockAll = false;
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
    if (cachedPoints) {
      if (!(await confirmOverrideManualEdits())) {
        setSegmentedActive(paperGroup, selections.paper, "paper");
        return;
      }
    } else if (layoutPages.length) {
      const ok = await showConfirmModal(
        "Papirstørrelsen ændres for alle sider. Siderne vil dække et andet område end før. Vil du fortsætte?"
      );
      if (!ok) {
        setSegmentedActive(paperGroup, selections.paper, "paper");
        return;
      }
    }
    selections.paper = nextPaper;
    setSegmentedActive(paperGroup, selections.paper, "paper");
    if (cachedPoints) {
      generateLayout("Papirstørrelsen er ændret. Layout opdateres...");
    } else if (layoutPages.length) {
      resizeManualPagesInPlace();
    }
  });

  scaleGroup.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const nextScale = Number(button.dataset.scale);
    if (nextScale === selections.scale) return;
    if (cachedPoints) {
      if (!(await confirmOverrideManualEdits())) {
        setSegmentedActive(scaleGroup, String(selections.scale), "scale");
        return;
      }
    } else if (layoutPages.length) {
      const ok = await showConfirmModal(
        "Målestokken ændres for alle sider. Siderne vil dække et andet område end før. Vil du fortsætte?"
      );
      if (!ok) {
        setSegmentedActive(scaleGroup, String(selections.scale), "scale");
        return;
      }
    }
    selections.scale = nextScale;
    setSegmentedActive(scaleGroup, String(selections.scale), "scale");
    updateScaleWarning();
    if (cachedPoints) {
      generateLayout("Målestokken er ændret. Layout opdateres...");
    } else if (layoutPages.length) {
      resizeManualPagesInPlace();
    }
  });

  orientationGroup.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const nextOrientation = button.dataset.orientation;
    if (nextOrientation === selections.orientation) return;
    if (cachedPoints) {
      if (!(await confirmOverrideManualEdits())) {
        setSegmentedActive(
          orientationGroup,
          String(selections.orientation),
          "orientation"
        );
        return;
      }
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
        updateMapHintHighlight();
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
  const ready = Boolean(isLayoutReady);
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
  // If in Norway/Nordic longitude range (4°–31.5°E), snap to Kartverket's
  // available zones (32/33/35) so tiles and grid share the same UTM zone.
  if (meanLon >= 4 && meanLon <= 31.5) {
    return optimalNorwayEpsg(meanLon);
  }
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

function updateHeightOverlays() {
  if (!mapInstance || !L) return;
  ensureHeightOverlayPane();
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
  // Use composite tile layer for multi-country support
  // Falls back to Norway for areas outside border polygons
  createCompositeTileLayer({
    defaultProvider: CURRENT_PROVIDER,
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

  if (mapHintEl) {
    if (isMapHintDismissed()) {
      mapHintEl.classList.add("hidden");
      document.body.classList.remove("map-hint-active");
    } else {
      document.body.classList.add("map-hint-active");
      updateMapHintHighlight();
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
        dismissMapHint();
        hintEvents.forEach((eventName) =>
          mapInstance.off(eventName, handleHintDismiss)
        );
        if (sidebarEl) {
          sidebarEvents.forEach((eventName) =>
            sidebarEl.removeEventListener(eventName, handleHintDismiss)
          );
        }
      };
      hintEvents.forEach((eventName) =>
        mapInstance.on(eventName, handleHintDismiss)
      );
      if (sidebarEl) {
        sidebarEvents.forEach((eventName) =>
          sidebarEl.addEventListener(eventName, handleHintDismiss)
        );
      }
    }
  }
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
      if (layoutPages[index]?.locked) return;
      L.DomEvent.stop(event);
      startDrag(event, index);
      selectPage(index, getContainerPointFromEvent(event));
    });
    rect.on("touchstart", (event) => {
      if (layoutPages[index]?.locked) return;
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
    const isLocked = !!layoutPages[index]?.locked;
    layer.setStyle({ ...baseStyle, fillColor, dashArray: isLocked ? "8 4" : null });
    if (index === selectedPageIndex) {
      layer.bringToFront();
    }
  });
  pageLabelLayers.forEach((layer, index) => {
    if (index === selectedPageIndex && layer.bringToFront) {
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
  if (removePageBtn) {
    removePageBtn.classList.toggle("hidden", selectedPageIndex === null);
  }
  if (lockToggleBtn) {
    lockToggleBtn.classList.toggle("lock-active", !!page.locked);
  }
  if (lockAllBtn) {
    lockAllBtn.classList.toggle("lock-active", globalLockAll);
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

function toggleSelectedLock() {
  if (selectedPageIndex === null || !layoutPages[selectedPageIndex]) return;
  layoutPages[selectedPageIndex].locked = !layoutPages[selectedPageIndex].locked;
  updatePageStyles();
  updateSelectionBar();
}

function toggleLockAll() {
  globalLockAll = !globalLockAll;
  layoutPages.forEach((page) => { page.locked = globalLockAll; });
  updatePageStyles();
  updateSelectionBar();
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
    return false;
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
  if (renderBtn) {
    renderBtn.disabled = false;
    renderBtn.classList.add("ready");
    renderBtn.removeAttribute("disabled");
  }
  renderPageOverlays();
  updateRenderButtonState();
  if (renderBtn) {
    renderBtn.disabled = false;
    renderBtn.classList.add("ready");
    renderBtn.removeAttribute("disabled");
  }
  updateSelectionBar();
  markLayoutCustomized("Ny side tilføjet.");
  return true;
}

function resizeManualPagesInPlace() {
  if (!layoutPages.length) return;
  for (let i = 0; i < layoutPages.length; i++) {
    const page = layoutPages[i];
    const metrics = pageGroundSpan(
      selections.scale,
      DEFAULT_DPI,
      selections.paper,
      page.orientation
    );
    const [minx, miny, maxx, maxy] = page.bbox;
    const cx = (minx + maxx) / 2;
    const cy = (miny + maxy) / 2;
    layoutPages[i] = {
      ...page,
      bbox: bboxFromCenter(cx, cy, metrics.wM, metrics.hM),
      wPx: metrics.wPx,
      hPx: metrics.hPx,
      wM: metrics.wM,
      hM: metrics.hM,
    };
  }
  clearDownload();
  renderPageOverlays();
  updateSelectionBar();
  const nextHeightBounds = computeHeightOverlayBounds();
  if (!boundsEqual(heightOverlayBounds, nextHeightBounds)) {
    heightOverlayBounds = nextHeightBounds;
    refreshHeightOverlays();
  }
}

function addPageToRight(sourceIndex) {
  const source = layoutPages[sourceIndex];
  if (!source) return false;

  const [minx, miny, maxx, maxy] = source.bbox;
  const cx = (minx + maxx) / 2;
  const cy = (miny + maxy) / 2;
  const overlap = DEFAULT_OVERLAP;
  const shiftX = source.wM * (1 - overlap);
  const newCx = cx + shiftX;
  const newBBox = bboxFromCenter(newCx, cy, source.wM, source.hM);

  const newPage = {
    id: nextPageId,
    bbox: newBBox,
    orientation: source.orientation,
    wPx: source.wPx,
    hPx: source.hPx,
    wM: source.wM,
    hM: source.hM,
  };
  nextPageId += 1;

  const insertIndex = sourceIndex + 1;
  layoutPages.splice(insertIndex, 0, newPage);
  selectedPageIndex = insertIndex;

  isLayoutReady = true;
  if (renderBtn) {
    renderBtn.disabled = false;
    renderBtn.classList.add("ready");
    renderBtn.removeAttribute("disabled");
  }
  renderPageOverlays();
  updateRenderButtonState();
  updateSelectionBar();
  markLayoutCustomized("Ny side tilføjet.");
  return true;
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

function segmentIntersectsBBox(x1, y1, x2, y2, bbox) {
  const [minx, miny, maxx, maxy] = bbox;
  if (pointInBBox(x1, y1, bbox) || pointInBBox(x2, y2, bbox)) return true;
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const clips = [[-dx, x1 - minx], [dx, maxx - x1], [-dy, y1 - miny], [dy, maxy - y1]];
  for (const [p, q] of clips) {
    if (Math.abs(p) < 1e-10) { if (q < 0) return false; }
    else { const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; } }
  }
  return t0 <= t1;
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

function tileMatrixSetIdFromEpsg(epsgCode, providerId = CURRENT_PROVIDER) {
  // Get UTM matrix set from provider config
  const provider = PROVIDERS[providerId];
  if (provider?.wmts?.utmMatrixSets?.[epsgCode]) {
    return provider.wmts.utmMatrixSets[epsgCode];
  }
  // Fallback: use provider's default matrix set
  return provider?.wmts?.matrixSet || "webmercator";
}

/**
 * Determine the best UTM EPSG code for Norway based on longitude.
 * Kartverket provides tile matrix sets for zones 32, 33, and 35 only.
 */
function optimalNorwayEpsg(lon) {
  if (lon < 12) return 25832;
  if (lon < 24) return 25833;
  return 25835;
}

/**
 * Reproject a UTM bbox from one zone to another.
 */
function reprojectUtmBbox(bbox, fromEpsg, toEpsg) {
  if (fromEpsg === toEpsg) return bbox;
  const fromZone = fromEpsg - 25800;
  const toZone = toEpsg - 25800;
  const fromDef = `+proj=utm +zone=${fromZone} +ellps=GRS80 +units=m +no_defs`;
  const toDef = `+proj=utm +zone=${toZone} +ellps=GRS80 +units=m +no_defs`;
  const transform = proj4(fromDef, toDef);
  const [minX, minY, maxX, maxY] = bbox;
  const corners = [
    transform.forward([minX, minY]),
    transform.forward([minX, maxY]),
    transform.forward([maxX, minY]),
    transform.forward([maxX, maxY]),
  ];
  return [
    Math.min(...corners.map(c => c[0])),
    Math.min(...corners.map(c => c[1])),
    Math.max(...corners.map(c => c[0])),
    Math.max(...corners.map(c => c[1])),
  ];
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

function chooseBestMatrix(matrices, desiredMPerPx) {
  // Pick the matrix with resolution closest to desiredMPerPx.
  // Callers handle tile count capping separately after this returns.

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

// Session-scoped tile cache for PDF generation.
// Caches Promise<ImageBitmap> so concurrent requests for the same tile
// reuse a single in-flight fetch. Cleared after each PDF render.
let _tileBitmapCache = null;

function enableTileCache() {
  _tileBitmapCache = new Map();
}

function clearTileCache() {
  _tileBitmapCache = null;
}

async function fetchTileBitmap(url) {
  if (_tileBitmapCache) {
    const cached = _tileBitmapCache.get(url);
    if (cached) return cached;
    const promise = _fetchTileBitmapUncached(url);
    _tileBitmapCache.set(url, promise);
    // If the fetch fails, remove from cache so it can be retried
    promise.catch(() => _tileBitmapCache?.delete(url));
    return promise;
  }
  return _fetchTileBitmapUncached(url);
}

async function _fetchTileBitmapUncached(url) {
  const r = await fetch(url, { mode: "cors" });
  if (!r.ok) throw new Error(`WMTS tile fejlede (${r.status}).`);
  const b = await r.blob();
  return createImageBitmap(b);
}

/**
 * Compute a 2D affine transform from 3 point correspondences.
 * Given source points (src0, src1, src2) mapping to destination points (dst0, dst1, dst2),
 * returns {a, b, c, d, e, f} suitable for ctx.setTransform(a, b, c, d, e, f).
 */
function computeAffineTransform(src0, src1, src2, dst0, dst1, dst2) {
  // Solve: [dst] = [a c e; b d f; 0 0 1] * [src]
  // From 3 point pairs we get 6 equations for 6 unknowns.
  const [sx0, sy0] = src0;
  const [sx1, sy1] = src1;
  const [sx2, sy2] = src2;
  const [dx0, dy0] = dst0;
  const [dx1, dy1] = dst1;
  const [dx2, dy2] = dst2;

  const det = sx0 * (sy1 - sy2) - sx1 * (sy0 - sy2) + sx2 * (sy0 - sy1);
  const invDet = 1 / det;

  const a = ((dx0 * (sy1 - sy2) - dx1 * (sy0 - sy2) + dx2 * (sy0 - sy1)) * invDet);
  const c = ((dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) * invDet);  // maps to canvas c param
  const e = ((dx0 * (sx1 * sy2 - sx2 * sy1) + dx1 * (sx2 * sy0 - sx0 * sy2) + dx2 * (sx0 * sy1 - sx1 * sy0)) * invDet);

  const b = ((dy0 * (sy1 - sy2) - dy1 * (sy0 - sy2) + dy2 * (sy0 - sy1)) * invDet);
  const d = ((dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) * invDet);  // maps to canvas d param
  const f = ((dy0 * (sx1 * sy2 - sx2 * sy1) + dy1 * (sx2 * sy0 - sx0 * sy2) + dy2 * (sx0 * sy1 - sx1 * sy0)) * invDet);

  return { a, b, c, d, e, f };
}

/**
 * Convert UTM bbox to WGS84 bbox for border detection.
 * Converts all 4 corners to handle rotation between UTM and WGS84.
 * @param {number[]} bbox - UTM bbox [minx, miny, maxx, maxy]
 * @param {number} epsgCode - EPSG code for the UTM zone
 * @returns {number[]} WGS84 bbox [minLon, minLat, maxLon, maxLat]
 */
function utmBboxToWgs84(bbox, epsgCode) {
  const [minx, miny, maxx, maxy] = bbox;
  const utmDef = `+proj=utm +zone=${epsgCode - 25800} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  const inverseTransform = proj4(utmDef, "EPSG:4326");
  const corners = [
    inverseTransform.forward([minx, miny]),
    inverseTransform.forward([minx, maxy]),
    inverseTransform.forward([maxx, miny]),
    inverseTransform.forward([maxx, maxy]),
  ];
  return [
    Math.min(...corners.map(c => c[0])),
    Math.min(...corners.map(c => c[1])),
    Math.max(...corners.map(c => c[0])),
    Math.max(...corners.map(c => c[1])),
  ];
}

/**
 * Convert UTM bbox corners to WGS84, returning all 4 corners (not just AABB).
 * Used for affine transform computation where the rotation matters.
 */
function utmBboxCornersToWgs84(bbox, epsgCode) {
  const [minx, miny, maxx, maxy] = bbox;
  const utmDef = `+proj=utm +zone=${epsgCode - 25800} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  const inv = proj4(utmDef, "EPSG:4326");
  return {
    tl: inv.forward([minx, maxy]),  // top-left (minX, maxY)
    tr: inv.forward([maxx, maxy]),  // top-right (maxX, maxY)
    bl: inv.forward([minx, miny]),  // bottom-left (minX, minY)
    br: inv.forward([maxx, miny]),  // bottom-right (maxX, minY)
  };
}

/**
 * Get the tile URL for a specific provider.
 * @param {string} providerId - Provider ID
 * @param {string} layerId - Layer ID
 * @param {string} tileMatrixSetId - Tile matrix set ID
 * @param {string} matrixId - Matrix level ID
 * @param {number} row - Tile row
 * @param {number} col - Tile column
 * @returns {string} Tile URL
 * @throws {Error} If provider is unknown
 */
function getProviderTileUrl(providerId, layerId, tileMatrixSetId, matrixId, row, col) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const layer = layerId || provider.wmts.defaultLayer;

  if (provider.wmts.requiresProxy) {
    // Use proxy URL
    return provider.wmts.proxyUrl
      .replace("{layer}", layer)
      .replace("{z}", matrixId)
      .replace("{y}", row)
      .replace("{x}", col);
  }

  // Direct URL for Norway
  return `${provider.wmts.baseUrl}/${layer}/default/${tileMatrixSetId}/${matrixId}/${row}/${col}.png`;
}

/**
 * Fetch composite WMTS stitched image from multiple providers
 * Detects which countries the bbox spans and composites appropriately
 */
async function fetchCompositeWmtsStitchedImage(bbox, widthPx, heightPx, epsgCode, layerId) {
  // Convert UTM bbox to WGS84 for border detection
  const wgs84Bbox = utmBboxToWgs84(bbox, epsgCode);

  // Detect which providers this bbox intersects
  let providers;
  try {
    providers = await getTileProviders(wgs84Bbox);
  } catch (err) {
    console.error("Border detection failed, using default provider:", err);
    providers = [CURRENT_PROVIDER];
  }
  console.debug("[PDF] Detected providers:", { wgs84Bbox, providers });

  // If no provider detected, fall back to default (Norway)
  if (providers.length === 0) {
    console.warn("[PDF] No provider detected for bbox, using default 'no'");
    providers = [CURRENT_PROVIDER];
  }

  // Route all cases through the composite path (which handles white background)
  // Single-provider optimization happens inside compositeProviderImages
  // Use the minimum max zoom across all providers
  const minMaxZoom = getMinMaxZoom(providers);

  // Fetch from each provider and composite.
  // On border pages (multiple providers), use WebMercator for ALL providers so every
  // canvas shares the same projection. This ensures the Mercator-Y clip polygon aligns
  // perfectly with every canvas. Single-provider pages keep the UTM path for Norway
  // (best resolution) and the WebMercator path for SE/FI (via fetchWmtsStitchedImageForProvider).
  const isMultiProvider = providers.length > 1;
  const canvases = await Promise.all(
    providers.map(async (providerId) => {
      try {
        if (isMultiProvider) {
          return await fetchWebMercatorStitchedImageForProvider(
            providerId,
            bbox,
            widthPx,
            heightPx,
            epsgCode,
            layerId,
            getMaxZoom(providerId),
            WMTS_MAX_TILES_BORDER_PAGE
          );
        }
        return await fetchWmtsStitchedImageForProvider(
          providerId,
          bbox,
          widthPx,
          heightPx,
          epsgCode,
          layerId,
          minMaxZoom
        );
      } catch (err) {
        console.warn(`Failed to fetch from provider ${providerId}:`, err);
        // Only swallow error if there are other providers to fall back to
        if (providers.length > 1) {
          return null;
        }
        throw err; // Re-throw for single-provider - show error to user
      }
    })
  );

  // Safety check: if ALL providers failed, throw rather than rendering white
  if (canvases.every(c => c === null)) {
    throw new Error("Ingen kortfliser kunne hentes fra nogen udbyder.");
  }

  // Composite the canvases with border clipping
  return compositeProviderImages(canvases, providers, bbox, epsgCode, widthPx, heightPx);
}

/**
 * Fetch stitched image for a specific provider
 */
async function fetchWmtsStitchedImageForProvider(providerId, bbox, widthPx, heightPx, epsgCode, layerId, maxZoomLimit) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  // For non-Norway providers, we need to handle the case where they might not have
  // the same UTM tile matrix sets. Fall back to webmercator approach.
  if (providerId !== "no") {
    return fetchWebMercatorStitchedImageForProvider(providerId, bbox, widthPx, heightPx, epsgCode, layerId, maxZoomLimit);
  }

  // Norway: determine optimal UTM zone for this page based on center longitude.
  // The bbox may be in a different zone than optimal for this page location.
  let tileBbox = bbox;
  let tileEpsg = epsgCode;
  const wgs84Center = utmBboxToWgs84(bbox, epsgCode);
  const centerLon = (wgs84Center[0] + wgs84Center[2]) / 2;
  const optimalEpsg = optimalNorwayEpsg(centerLon);

  if (optimalEpsg !== epsgCode && PROVIDERS.no.wmts.utmMatrixSets[optimalEpsg]) {
    tileBbox = reprojectUtmBbox(bbox, epsgCode, optimalEpsg);
    tileEpsg = optimalEpsg;
  }

  const tileMatrixSetId = tileMatrixSetIdFromEpsg(tileEpsg, providerId);

  // Norway uses UTM-based tile matrix sets
  const { matrices } = await getWmtsTileMatrixSet(tileMatrixSetId);

  const desiredResX = (tileBbox[2] - tileBbox[0]) / widthPx;
  const desiredResY = (tileBbox[3] - tileBbox[1]) / heightPx;
  const desiredMPerPx = Math.max(desiredResX, desiredResY);

  const { startIndex } = chooseBestMatrix(matrices, desiredMPerPx);

  let matrixIndex = startIndex;
  let range = tileRangeForBBox(tileBbox, matrices[matrixIndex]);
  let tileCount = (range.maxCol - range.minCol + 1) * (range.maxRow - range.minRow + 1);

  while (tileCount > WMTS_MAX_TILES_PER_PAGE && matrixIndex < matrices.length - 1) {
    matrixIndex += 1;
    range = tileRangeForBBox(tileBbox, matrices[matrixIndex]);
    tileCount = (range.maxCol - range.minCol + 1) * (range.maxRow - range.minRow + 1);
  }

  const matrix = matrices[matrixIndex];
  const cols = range.maxCol - range.minCol + 1;
  const rows = range.maxRow - range.minRow + 1;
  const mosaicW = cols * matrix.tileWidth;
  const mosaicH = rows * matrix.tileHeight;

  const mosaic = document.createElement("canvas");
  mosaic.width = mosaicW;
  mosaic.height = mosaicH;
  const mctx = getContext2d(mosaic);

  const tasks = [];
  for (let row = range.minRow; row <= range.maxRow; row += 1) {
    for (let col = range.minCol; col <= range.maxCol; col += 1) {
      const x = col - range.minCol;
      const y = row - range.minRow;
      const url = getProviderTileUrl(providerId, layerId, tileMatrixSetId, matrix.id, row, col);
      tasks.push({ url, x, y });
    }
  }

  const concurrency = 8;
  let cursor = 0;
  let failedCount = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < tasks.length) {
      const i = cursor;
      cursor += 1;
      const t = tasks[i];
      try {
        const bmp = await fetchTileBitmap(t.url);
        mctx.drawImage(bmp, t.x * matrix.tileWidth, t.y * matrix.tileHeight, matrix.tileWidth, matrix.tileHeight);
      } catch (err) {
        failedCount += 1;
        console.warn(`[PDF Norway] Failed to fetch tile ${failedCount}/${tasks.length}: ${t.url}`, err.message || err);
        mctx.fillStyle = "#e0e0e0";
        mctx.fillRect(t.x * matrix.tileWidth, t.y * matrix.tileHeight, matrix.tileWidth, matrix.tileHeight);
      }
    }
  });

  await Promise.all(workers);
  if (failedCount > 0) {
    console.error(`[PDF Norway] ${failedCount}/${tasks.length} tiles failed for matrix ${matrix.id}`);
  }
  if (failedCount > tasks.length * 0.2) {
    throw new Error(`Too many tile failures for Norway: ${failedCount}/${tasks.length} tiles failed. Check network connection.`);
  }
  console.debug(`[PDF Norway] Completed fetching ${tasks.length} tiles for matrix ${matrix.id}`);

  // Convert tile-zone UTM coordinates to mosaic pixel coordinates
  const originX = matrix.topLeftCorner[0];
  const originY = matrix.topLeftCorner[1];
  const mosaicOriginX = originX + range.minCol * range.tileSpanX;
  const mosaicOriginY = originY - range.minRow * range.tileSpanY;
  const utmToMosaicPx = ([ux, uy]) => [
    (ux - mosaicOriginX) / range.res,
    (mosaicOriginY - uy) / range.res,
  ];

  const out = document.createElement("canvas");
  out.width = widthPx;
  out.height = heightPx;
  const octx = getContext2d(out);
  // Pre-fill with white so transparent/failed areas don't render black in PDF
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, widthPx, heightPx);

  if (tileEpsg !== epsgCode) {
    // Zone mismatch: the tile mosaic is in a different UTM zone than the page.
    // Use affine transform to account for the rotation between zones.
    const fromZone = epsgCode - 25800;
    const toZone = tileEpsg - 25800;
    const fromDef = `+proj=utm +zone=${fromZone} +ellps=GRS80 +units=m +no_defs`;
    const toDef = `+proj=utm +zone=${toZone} +ellps=GRS80 +units=m +no_defs`;
    const pageToTile = proj4(fromDef, toDef);

    // Map page bbox corners to tile-zone UTM, then to mosaic pixels
    const [minx, miny, maxx, maxy] = bbox;  // page-zone UTM
    const mTL = utmToMosaicPx(pageToTile.forward([minx, maxy]));
    const mTR = utmToMosaicPx(pageToTile.forward([maxx, maxy]));
    const mBL = utmToMosaicPx(pageToTile.forward([minx, miny]));

    const xf = computeAffineTransform(
      mTL, mTR, mBL,
      [0, 0], [widthPx, 0], [0, heightPx]
    );

    console.debug(`[PDF Norway] Zone mismatch affine (${epsgCode}→${tileEpsg}):`, xf);
    octx.setTransform(xf.a, xf.b, xf.c, xf.d, xf.e, xf.f);
    octx.drawImage(mosaic, 0, 0);
    octx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    // Same zone: simple rectangular crop (no rotation needed)
    const cropX = utmToMosaicPx([tileBbox[0], 0])[0];
    const cropY = utmToMosaicPx([0, tileBbox[3]])[1];
    const cropW = (tileBbox[2] - tileBbox[0]) / range.res;
    const cropH = (tileBbox[3] - tileBbox[1]) / range.res;

    console.debug(`[PDF Norway] Crop params:`, { cropX, cropY, cropW, cropH, widthPx, heightPx, mosaicW: mosaic.width, mosaicH: mosaic.height });
    octx.drawImage(mosaic, cropX, cropY, cropW, cropH, 0, 0, widthPx, heightPx);
  }

  // Free mosaic pixel buffer
  mosaic.width = 0;
  mosaic.height = 0;

  return out;
}

/**
 * Fetch stitched image using WebMercator tiles for providers that don't have UTM
 * This converts UTM bbox to WebMercator, fetches tiles, and reprojects
 */
async function fetchWebMercatorStitchedImageForProvider(providerId, bbox, widthPx, heightPx, epsgCode, layerId, maxZoomLimit, maxTiles) {
  const provider = PROVIDERS[providerId];
  // Always use provider's own default layer - Norway's "toporaster" doesn't exist on Sweden/Finland
  const layer = provider.wmts.defaultLayer;

  // Convert UTM bbox to WGS84
  const wgs84Bbox = utmBboxToWgs84(bbox, epsgCode);
  const [minLon, minLat, maxLon, maxLat] = wgs84Bbox;

  // Calculate appropriate zoom level
  const desiredResX = (bbox[2] - bbox[0]) / widthPx;
  const desiredResY = (bbox[3] - bbox[1]) / heightPx;
  const desiredMPerPx = Math.max(desiredResX, desiredResY);

  // On border pages (maxTiles provided), skip latitude correction to get higher zoom.
  // Map servers render tile content at the equatorial scale denominator, so at high
  // latitudes the lat-corrected zoom (e.g. 14, scaleDenom ~34k) has less map detail
  // than zoom 15 (scaleDenom ~17k) which matches UTM Level 12. The higher tile
  // budget on border pages (WMTS_MAX_TILES_BORDER_PAGE) absorbs the extra tiles.
  // On single-provider pages, keep lat correction for optimal ground resolution.
  const avgLat = (minLat + maxLat) / 2;
  const latFactor = maxTiles ? 1 : Math.cos(avgLat * Math.PI / 180);
  let zoom = Math.round(Math.log2(156543.03 * latFactor / desiredMPerPx));
  // Check for undefined instead of falsy (0 is a valid zoom level but falsy in JS)
  zoom = Math.max(0, Math.min(zoom, maxZoomLimit !== undefined ? maxZoomLimit : provider.wmts.maxZoom));

  // Convert WGS84 to tile coordinates
  const n = Math.pow(2, zoom);
  const minTileX = Math.floor((minLon + 180) / 360 * n);
  const maxTileX = Math.floor((maxLon + 180) / 360 * n);
  const minTileY = Math.floor((1 - Math.log(Math.tan(maxLat * Math.PI / 180) + 1 / Math.cos(maxLat * Math.PI / 180)) / Math.PI) / 2 * n);
  const maxTileY = Math.floor((1 - Math.log(Math.tan(minLat * Math.PI / 180) + 1 / Math.cos(minLat * Math.PI / 180)) / Math.PI) / 2 * n);

  // Limit tile count
  const tileLimit = maxTiles || WMTS_MAX_TILES_PER_PAGE;
  const tileCount = (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1);
  if (tileCount > tileLimit) {
    if (zoom <= 0) {
      console.warn(`[PDF] ${providerId}: Cannot reduce zoom further, using zoom 0`);
      // Continue with current zoom level instead of recursing infinitely
    } else {
      // Reduce zoom
      return fetchWebMercatorStitchedImageForProvider(providerId, bbox, widthPx, heightPx, epsgCode, layerId, zoom - 1, maxTiles);
    }
  }

  const tileSize = 256;
  const cols = maxTileX - minTileX + 1;
  const rows = maxTileY - minTileY + 1;
  const mosaicW = cols * tileSize;
  const mosaicH = rows * tileSize;

  const mosaic = document.createElement("canvas");
  mosaic.width = mosaicW;
  mosaic.height = mosaicH;
  const mctx = getContext2d(mosaic);

  // Fetch tiles
  const tasks = [];
  for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
      const x = tileX - minTileX;
      const y = tileY - minTileY;
      const url = getLeafletTileUrl(providerId, layer)
        .replace("{z}", zoom)
        .replace("{x}", tileX)
        .replace("{y}", tileY);
      tasks.push({ url, x, y });
    }
  }

  console.debug(`[PDF] Fetching ${providerId} tiles:`, { zoom, tileCount: tasks.length, sampleUrl: tasks[0]?.url });

  const concurrency = 8;
  let cursor = 0;
  let failedCount = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < tasks.length) {
      const i = cursor;
      cursor += 1;
      const t = tasks[i];
      try {
        const bmp = await fetchTileBitmap(t.url);
        mctx.drawImage(bmp, t.x * tileSize, t.y * tileSize, tileSize, tileSize);
      } catch (err) {
        failedCount += 1;
        console.warn(`[PDF ${providerId}] Failed to fetch tile ${failedCount}/${tasks.length}: ${t.url}`, err.message || err);
        mctx.fillStyle = "#e0e0e0";
        mctx.fillRect(t.x * tileSize, t.y * tileSize, tileSize, tileSize);
      }
    }
  });

  await Promise.all(workers);
  if (failedCount > 0) {
    console.error(`[PDF ${providerId}] ${failedCount}/${tasks.length} tiles failed`);
  }
  if (failedCount > tasks.length * 0.2) {
    throw new Error(`Too many tile failures for ${providerId}: ${failedCount}/${tasks.length} tiles failed. Check network connection and proxy credentials.`);
  }

  // Calculate the WGS84 bounds of the mosaic
  const mosaicMinLon = minTileX / n * 360 - 180;
  const mosaicMaxLon = (maxTileX + 1) / n * 360 - 180;
  const mosaicMaxLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * minTileY / n))) * 180 / Math.PI;
  const mosaicMinLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (maxTileY + 1) / n))) * 180 / Math.PI;

  // Convert WGS84 lon/lat to mosaic pixel coordinates.
  // X is linear in longitude; Y uses Mercator math: y = ln(tan(π/4 + lat/2))
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const mosaicMercTop = mercY(mosaicMaxLat);
  const mosaicMercBot = mercY(mosaicMinLat);
  const mosaicMercH = mosaicMercTop - mosaicMercBot;

  const wgs84ToMosaicPx = ([lon, lat]) => [
    (lon - mosaicMinLon) / (mosaicMaxLon - mosaicMinLon) * mosaicW,
    (mosaicMercTop - mercY(lat)) / mosaicMercH * mosaicH,
  ];

  // Get all 4 UTM bbox corners in WGS84 (preserving the rotation)
  const corners = utmBboxCornersToWgs84(bbox, epsgCode);

  // Map each corner to mosaic pixel position
  const mTL = wgs84ToMosaicPx(corners.tl);
  const mTR = wgs84ToMosaicPx(corners.tr);
  const mBL = wgs84ToMosaicPx(corners.bl);

  // Compute affine: mosaic pixels → output canvas pixels
  // TL → (0,0), TR → (widthPx,0), BL → (0,heightPx)
  const xf = computeAffineTransform(
    mTL, mTR, mBL,
    [0, 0], [widthPx, 0], [0, heightPx]
  );

  const out = document.createElement("canvas");
  out.width = widthPx;
  out.height = heightPx;
  const octx = getContext2d(out);
  // Pre-fill with white so transparent/failed areas don't render black in PDF
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, widthPx, heightPx);
  // Apply affine transform and draw the full mosaic; the transform
  // maps the relevant region to the output canvas automatically.
  octx.setTransform(xf.a, xf.b, xf.c, xf.d, xf.e, xf.f);
  octx.drawImage(mosaic, 0, 0);
  octx.setTransform(1, 0, 0, 1, 0, 0);

  // Free mosaic pixel buffer
  mosaic.width = 0;
  mosaic.height = 0;

  return out;
}

/**
 * Composite multiple provider canvases with border clipping
 */
async function compositeProviderImages(canvases, providers, bbox, epsgCode, widthPx, heightPx) {
  const out = document.createElement("canvas");
  out.width = widthPx;
  out.height = heightPx;
  const ctx = getContext2d(out);

  // Pre-fill with white background so transparent/failed areas don't render black in PDF
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, widthPx, heightPx);

  // Single provider - just draw directly without polygon clipping
  // This avoids issues with complex MultiPolygon borders (Sweden/Finland)
  if (providers.length === 1 && canvases[0]) {
    ctx.drawImage(canvases[0], 0, 0);
    return createImageBitmap(out);
  }

  // Multiple providers - canvases are affine-transformed from WebMercator to UTM
  // pixel space. Clip polygons must be projected to the same UTM CRS to align
  // correctly with the canvas pixels.
  // Strategy: draw first provider unclipped as background (fills gaps between
  // simplified polygons), then draw all providers clipped to their country
  // polygons for clean borders.
  const { getCountryPolygon } = await import("./providers/borders.js");

  // Draw first available provider as full background (gap-filling)
  for (let i = 0; i < canvases.length; i++) {
    if (canvases[i]) {
      ctx.drawImage(canvases[i], 0, 0);
      break;
    }
  }

  // Draw all providers clipped to their country polygons using UTM projection
  for (let i = 0; i < providers.length; i++) {
    const providerId = providers[i];
    const canvas = canvases[i];
    if (!canvas) continue;

    try {
      const polygon = await getCountryPolygon(providerId);
      if (polygon) {
        ctx.save();
        applyClipForUtmBbox(ctx, polygon, bbox, epsgCode, widthPx, heightPx);
        ctx.drawImage(canvas, 0, 0);
        ctx.restore();
      } else {
        ctx.drawImage(canvas, 0, 0);
      }
    } catch (err) {
      console.error(`[PDF] Clipping failed for provider ${providerId}, drawing without clip:`, err);
      ctx.drawImage(canvas, 0, 0);
    }
  }

  return createImageBitmap(out);
}

/**
 * Apply polygon clip path by projecting WGS84 polygon coordinates to the
 * page's UTM CRS. The provider canvases are affine-transformed from
 * WebMercator into UTM pixel space, so clipping must use the same UTM
 * projection for correct alignment. The previous Mercator-Y approach caused
 * multi-pixel misalignment at high latitudes due to UTM grid convergence.
 */
function applyClipForUtmBbox(ctx, polygon, bbox, epsgCode, widthPx, heightPx) {
  const [minE, minN, maxE, maxN] = bbox;
  const utmDef = `+proj=utm +zone=${epsgCode - 25800} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  const toUtm = proj4("EPSG:4326", utmDef);

  const geometry = polygon.geometry || polygon;
  let rings;
  if (geometry.type === "Polygon") {
    rings = geometry.coordinates;
  } else if (geometry.type === "MultiPolygon") {
    rings = geometry.coordinates.flatMap(poly => poly);
  } else {
    return;
  }

  ctx.beginPath();
  for (const ring of rings) {
    let started = false;
    for (const [lon, lat] of ring) {
      const [easting, northing] = toUtm.forward([lon, lat]);
      const px = ((easting - minE) / (maxE - minE)) * widthPx;
      const py = ((maxN - northing) / (maxN - minN)) * heightPx;

      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.closePath();
  }
  ctx.clip("evenodd");
}

function drawUtmGrid(ctx, bbox, wPx, hPx, spacing = 1000) {
  const [minX, minY, maxX, maxY] = bbox;
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;

  const toPixelX = (x) => ((x - minX) / bboxW) * wPx;
  const toPixelY = (y) => ((maxY - y) / bboxH) * hPx;

  // Draw cyan grid lines.
  // Use lineWidth 2 and opacity 0.75 so the lines remain detectable (max
  // channel ≥150) even over dark Scandinavian forest backgrounds.
  ctx.save();
  ctx.strokeStyle = "rgba(0, 210, 210, 0.75)";
  ctx.lineWidth = 2;

  const startX = Math.ceil(minX / spacing) * spacing;
  for (let x = startX; x <= maxX; x += spacing) {
    const px = Math.round(toPixelX(x));
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, hPx);
    ctx.stroke();
  }

  const startY = Math.ceil(minY / spacing) * spacing;
  for (let y = startY; y <= maxY; y += spacing) {
    const py = Math.round(toPixelY(y));
    ctx.beginPath();
    ctx.moveTo(0, py);
    ctx.lineTo(wPx, py);
    ctx.stroke();
  }
  ctx.restore();

  // Draw coordinate labels centered on grid lines
  ctx.save();
  ctx.fillStyle = "#333";
  ctx.font = "bold 18px sans-serif";

  // Northing labels right-aligned to the middle vertical grid line
  const verticalLines = [];
  for (let x = startX; x <= maxX; x += spacing) verticalLines.push(toPixelX(x));
  const midVerticalPx = verticalLines[Math.floor(verticalLines.length / 2)] ?? wPx / 2;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let y = startY; y <= maxY; y += spacing) {
    const py = toPixelY(y);
    if (py < 20 || py > hPx - 20) continue;
    ctx.fillText(`${y}m N`, midVerticalPx - 4, py);
  }

  // Easting labels rotated 90° CCW along vertical grid lines, centered on middle horizontal line
  const horizontalLines = [];
  for (let y = startY; y <= maxY; y += spacing) horizontalLines.push(toPixelY(y));
  const midHorizontalPx = horizontalLines[Math.floor(horizontalLines.length / 2)] ?? hPx / 2;
  for (let x = startX; x <= maxX; x += spacing) {
    const px = toPixelX(x);
    if (px < 40 || px > wPx - 40) continue;
    ctx.save();
    ctx.translate(px, midHorizontalPx);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`${x}m E`, 4, 0);
    ctx.restore();
  }

  ctx.restore();
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
  // Mark segments that cross the bbox even when neither endpoint is inside
  for (let i = 0; i < xs.length - 1; i += 1) {
    if (drawMask[i] && drawMask[i + 1]) continue;
    if (segmentIntersectsBBox(xs[i], ys[i], xs[i + 1], ys[i + 1], bbox)) {
      drawMask[i] = 1;
      drawMask[i + 1] = 1;
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
  ctx.font = "27px IBM Plex Mono, monospace";
  const metrics = ctx.measureText(label);
  const textW = metrics.width;
  const textH = 32;
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

function computeGridConvergenceDeg(lonDeg, latDeg, epsgCode) {
  const zone = epsgCode ? (epsgCode - 25800) : utmZoneFromLon(lonDeg);
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
  ctx.font = "27px IBM Plex Mono, monospace";
  const lineHeight = 32;
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

function getContext2d(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error(`Kunne ikke oprette 2D canvas context (${canvas.width}x${canvas.height}px). Prøv en mindre sidestørrelse.`);
  }
  return ctx;
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

  // Enable tile cache to avoid redundant fetches for overlapping pages
  enableTileCache();

  const pdfDoc = await PDFDocument.create();
  const results = Array.from({ length: pages.length });
  let completed = 0;
  const progress = createRenderProgressUpdater(pages.length);

  const tasks = pages.map((pageInfo, idx) => async () => {
    const { bbox: pageBBox, wPx, hPx } = pageInfo;

    // Determine optimal UTM zone for THIS page based on its center longitude.
    // This ensures the page CRS matches the WMS grid service's native zone,
    // keeping grid lines perfectly horizontal/vertical.
    const pageWgs84 = utmBboxToWgs84(pageBBox, epsg);
    const pageCenterLon = (pageWgs84[0] + pageWgs84[2]) / 2;
    const pageEpsg = optimalNorwayEpsg(pageCenterLon);
    let localBBox = pageBBox;
    let localEpsg = epsg;
    if (pageEpsg !== epsg) {
      localBBox = reprojectUtmBbox(pageBBox, epsg, pageEpsg);
      localEpsg = pageEpsg;
    }

    // Use composite fetching for multi-country support
    const baseImgPromise = fetchCompositeWmtsStitchedImage(
      localBBox,
      wPx,
      hPx,
      localEpsg,
      options.layer
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
        localBBox,
        heightWidthPx,
        heightHeightPx,
        localEpsg
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
      localBBox,
      wPx,
      hPx,
      localEpsg
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
          localBBox,
          wPx,
          hPx,
          localEpsg
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
          localBBox,
          wPx,
          hPx,
          localEpsg
        )
      );
    }

  const [baseImg, ...overlayImgs] = await Promise.all([
    baseImgPromise,
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
    const ctx = getContext2d(canvas);
    ctx.drawImage(baseImg, 0, 0, wPx, hPx);
    drawUtmGrid(ctx, localBBox, wPx, hPx);
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
    // Reproject track coords to per-page zone if needed
    let drawXs = xs;
    let drawYs = ys;
    if (localEpsg !== epsg) {
      const fromZone = epsg - 25800;
      const toZone = localEpsg - 25800;
      const fromDef = `+proj=utm +zone=${fromZone} +ellps=GRS80 +units=m +no_defs`;
      const toDef = `+proj=utm +zone=${toZone} +ellps=GRS80 +units=m +no_defs`;
      const reproj = proj4(fromDef, toDef);
      drawXs = new Array(xs.length);
      drawYs = new Array(ys.length);
      for (let i = 0; i < xs.length; i++) {
        const [rx, ry] = reproj.forward([xs[i], ys[i]]);
        drawXs[i] = rx;
        drawYs[i] = ry;
      }
    }
    drawTrackOnCanvas(
      ctx,
      drawXs,
      drawYs,
      localBBox,
      wPx,
      hPx,
      options.trackColor ?? "#ff0000",
      options.trackOpacity,
      options.trackWidth
    );
    drawPageLabel(ctx, idx + 1, options.scale, localEpsg);
    if (declinationModel) {
      const centerX = (localBBox[0] + localBBox[2]) / 2;
      const centerY = (localBBox[1] + localBBox[3]) / 2;
      const localZone = localEpsg - 25800;
      const localUtmDef = `+proj=utm +zone=${localZone} +ellps=GRS80 +units=m +no_defs`;
      const localTransformer = proj4("EPSG:4326", localUtmDef);
      const [lon, lat] = localTransformer.inverse([centerX, centerY]);
      let info;
      try {
        info = declinationModel.point([lat, lon, 0], modelDate);
      } catch (error) {
        console.warn("Declination model date-specific lookup failed, using dateless fallback:", error);
        info = declinationModel.point([lat, lon, 0]);
      }
      const convergence = computeGridConvergenceDeg(lon, lat, localEpsg);
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

    // Free page canvas pixel buffer
    canvas.width = 0;
    canvas.height = 0;

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

  // Clear tile cache now that all pages are rendered
  clearTileCache();

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
updateScaleWarning();

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
  fitMapToLayout();
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
  if (file.size > MAX_GPX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    setStatus(`Fejl: Filen er for stor (${sizeMB} MB). Maksimum er ${MAX_GPX_FILE_SIZE / (1024 * 1024)} MB.`);
    return;
  }
  selectedFile = file;
  cachedPoints = null;
  projectionState = null;
  renderBtn.textContent = "Lav PDF";
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
        console.warn("Worker-based GPX parsing failed, falling back to main thread:", workerError);
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
    showAutoLayoutToast(layoutPages.length);
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

if (lockToggleBtn) {
  lockToggleBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSelectedLock();
  });
}

if (lockAllBtn) {
  lockAllBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleLockAll();
  });
}

const insertPageBtn = document.getElementById("insertPageBtn");
if (insertPageBtn) {
  insertPageBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (selectedPageIndex !== null && layoutPages[selectedPageIndex]) {
      addPageToRight(selectedPageIndex);
    } else {
      addPageAtCenter();
    }
  });
}

if (mapToastCloseEl) {
  mapToastCloseEl.addEventListener("click", (event) => {
    event.stopPropagation();
    hideMapToast();
  });
}

if (addPageBtn) {
  addPageBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (mapHintEl && !mapHintEl.classList.contains("hidden")) {
      dismissMapHint();
    }
    let pendingToast = false;
    if (mapInstance) {
      const targetZoom = 10;
      if (mapInstance.getZoom() < targetZoom) {
        pendingToast = true;
        mapInstance.once("moveend", () => {
          showManualLayoutToast();
        });
        mapInstance.flyTo(mapInstance.getCenter(), targetZoom, {
          animate: true,
          duration: 0.8,
        });
      }
    }
    const didAddPage = addPageAtCenter();
    if (renderBtn && layoutPages.length) {
      renderBtn.disabled = false;
      renderBtn.classList.add("ready");
      renderBtn.removeAttribute("disabled");
    }
    if (didAddPage && !pendingToast) {
      showManualLayoutToast();
    }
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
selectionBarEl.addEventListener("mousedown", (event) => {
  event.stopPropagation();
});
selectionBarEl.addEventListener("touchstart", (event) => {
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
    updateHeightOverlays();
  });
});

// Overlay tab switching
overlayTabsEl.forEach((tab) => {
  tab.addEventListener("click", () => {
    const country = tab.dataset.country;
    // Update tabs
    overlayTabsEl.forEach((t) => {
      t.classList.toggle("active", t.dataset.country === country);
      t.setAttribute("aria-selected", t.dataset.country === country);
    });
    // Update content panels
    overlayContentsEl.forEach((content) => {
      content.classList.toggle("active", content.dataset.country === country);
    });
  });
});

// Scale warning for Swedish maps at 1:25,000
function updateScaleWarning() {
  if (!scaleWarningEl) return;
  // Only show warning when track intersects Swedish territory
  let touchesSweden = false;
  if (cachedPoints && selections.scale === 25000) {
    const seBounds = PROVIDERS.se.bounds;
    touchesSweden = cachedPoints.some(([lon, lat]) =>
      lon >= seBounds.minLon && lon <= seBounds.maxLon &&
      lat >= seBounds.minLat && lat <= seBounds.maxLat
    );
  }
  scaleWarningEl.classList.toggle("hidden", !touchesSweden);
}

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
    renderBtn.textContent = "Lav PDF igen";
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
  updateMapHintHighlight();
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
