// ui-controller.js -- DOM event handlers, sidebar controls, modals, page manipulation, workflow orchestration
// Dependencies: state.js, constants.js, projection.js, layout.js, gpx-parser.js, pdf-renderer.js,
//               overlays.js, map-manager.js, utils.js, providers/config.js
// All DOM element lookups happen inside functions, NOT at module level (avoid load-order issues).

import {
  DEFAULT_LAYER,
  DEFAULT_DPI, DEFAULT_JPEG_QUALITY,
  DEFAULT_OVERLAP, DEFAULT_MARGIN,
  LARGE_FILE_THRESHOLD, MAX_GPX_FILE_SIZE,
  ALLOWED_SCALES,
  MAP_HINT_SESSION_KEY, MAP_TOAST_AUTO_KEY, MAP_TOAST_MANUAL_KEY,
} from "./constants.js";
import { state } from "./state.js";
import {
  bboxFromCenter,
  formatDistance,
  formatScaleLabel,
} from "./utils.js";
import {
  proj4,
  buildProjection,
  pageGroundSpan,
  transformerForPoints,
} from "./projection.js";
import {
  parseGPX, computeTrackLengthMeters,
  parseLargeGpxWithWorker,
} from "./gpx-parser.js";
import { computeLayoutPages } from "./layout.js";
import {
  renderGPXToPdf,
} from "./pdf-renderer.js";
import {
  updateRouteOverlays, updateHeightOverlays, updateWeakIceOverlays,
  updateDkFriluftsdataOverlays,
  refreshHeightOverlays, effectiveHeightOpacity, effectiveWeakIceOpacity,
  getSelectedHeightLayers, getSelectedWeakIceLayers,
  getSelectedDkFriluftsdataRouteTypes, getSelectedDkFriluftsdataFacilityTypes,
} from "./overlays.js";
import {
  initMap,
  updateTrackLayer, clearTrackLayer,
  highlightTrackSegment, clearTrackHighlight,
  bboxToLatLngBounds,
  clearPageOverlays, ensurePageIds, renderPageOverlays, fitMapToLayout,
  updatePageStyles, selectPage, updateSelectionBar, updatePageLayerBounds,
  getContainerPointFromEvent, startDrag, handleDocumentMove, stopDrag,
  setSatellitePreviewEnabled, getSatellitePreviewYear,
} from "./map-manager.js";
import { getPointProviders } from "./providers/borders.js";
import {
  initDrawing, toggleDrawMode, clearDrawnRoute,
  undo as drawUndo, redo as drawRedo,
  reverseAppendDirection, deleteSelectedPoint, hidePointActionBar,
  routeToGpxXml, triggerGpxDownload, getDrawnRoute, hasDrawnRoute, DRAWN_TRACK_ID,
} from "./draw-manager.js";

const L = window.L;

const SHELL_BREAKPOINTS = Object.freeze({
  desktopMin: 961,
  tabletMin: 721,
});

const SHELL_RELAYOUT_FALLBACK_MS = 420;

// Module-scoped references populated in initUI()
let renderStatusEl, statusTextEl, spinnerEl, progressEl, fileMetaEl, dropzoneEl;
let downloadLink, renderBtn, renderBtnLabelEl, renderBtnSummaryEl, renderProgressEl;
let mapToastEl, mapToastTextEl, mapToastCloseEl;
let selectionBarEl, selectionSelectEl, orientationToggleEl;
let removePageBtn, lockToggleBtn, lockAllBtn, addPageBtn, togglePagePreviewsBtn;
let toggleSatellitePreviewBtn;
let colorPickerEl, sidebarEl, sidebarToggleEl, sidebarBackdropEl, sidebarReopenBtnEl, mapPanelEl, layoutEl;
let confirmModalEl, confirmTextEl, confirmAcceptBtn, confirmCancelBtn;
let skiRoutesToggleEl, hikeRoutesToggleEl, dkRekreativeRoutesToggleEl, dkRekreativeFacilitiesToggleEl, heightLayerToggleEls;
let weakIceToggleEl, heightOpacityGroupEl, heightOpacityEl, heightOpacityValueEl;
let weakIceOpacityGroupEl, weakIceOpacityEl, weakIceOpacityValueEl;
let dkRouteTypeSelectEl;
let dkFacilityTypeSelectEl;
let heightMaskGroupEl, heightMaskGreenAEl, heightMaskGreenBEl;
let overlapValueEl, marginValueEl;
let trackOpacityEl, trackOpacityValueEl, trackWidthEl, trackWidthValueEl, trackControlsEl;
let pdfJpegToggleEl, jpegQualityGroupEl, jpegQualityEl, jpegQualityValueEl;
let overlayTabsEl, overlayContentsEl;
let greyscaleToggleEl;
let pdfRulerToggleEl;
let controlsForm, fileInput;
let drawToggleBtn, drawReverseBtn, drawClearBtn;
let drawPointActionBar, drawDeletePointBtn;
let drawExportSection, exportDrawnBtn, exportMergedBtn;
let mapZoomControlsEl, zoomInBtn, zoomOutBtn;
let sideinddelingSectionEl, formatTrackSectionEl, trackStyleSectionEl;
let phaseEntryEl, phaseCustomizeEl, phaseExportEl;

// Module-local store for original uploaded points (before merging with drawn route)
let _uploadedPoints = null;
let _hoveredUploadedTrackId = null;
let _hoverTrackTimer = null;
let _draggedUploadedTrackId = null;
let _dropTargetTrackId = null;
let _dropInsertBefore = true;
let _suppressRowFocusClick = false;
let _overlayAutoFocusRequestId = 0;
let shellSyncFrame = null;
let shellSyncWaitForTransition = false;
let shellRelayoutFrame = null;
let shellRelayoutTimeout = null;
let shellRelayoutCleanup = null;
let shellViewportListenersBound = false;

// Alias state properties for shorter access
const selections = state.selections;

// --- Status display ---

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

// --- Map hint ---

function isMapHintDismissed() {
  try {
    return sessionStorage.getItem(MAP_HINT_SESSION_KEY) === "1";
  } catch (error) {
    return false;
  }
}

function dismissMapHint() {
  [dropzoneEl, addPageBtn, drawToggleBtn, sidebarReopenBtnEl].forEach((element) => {
    element?.classList.remove("map-hint-target");
  });
  document.body.classList.remove("map-hint-active");
  try {
    sessionStorage.setItem(MAP_HINT_SESSION_KEY, "1");
  } catch (error) {
    // Ignore storage failures (private mode, etc.)
  }
}

// --- Toast ---

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
  if (!isMapHintDismissed()) return;
  showMapToast("Træk siden for at flytte den. Klik for at slette eller ændre orientering.");
  markToastShown(MAP_TOAST_MANUAL_KEY);
}

function updatePagePreviewsToggleUI() {
  const visible = state.pagePreviewsVisible !== false;

  if (mapPanelEl) {
    mapPanelEl.classList.toggle("page-previews-hidden", !visible);
  }
  if (!togglePagePreviewsBtn) return;

  togglePagePreviewsBtn.classList.toggle("is-hidden", !visible);
  togglePagePreviewsBtn.setAttribute("aria-pressed", String(visible));
  const actionLabel = visible ? "Skjul sider" : "Vis sider";
  togglePagePreviewsBtn.setAttribute("aria-label", actionLabel);
  togglePagePreviewsBtn.title = `${actionLabel} (V)`;
}

function setPagePreviewVisibility(visible) {
  state.pagePreviewsVisible = Boolean(visible);
  updatePagePreviewsToggleUI();
  updateSelectionBar();
}

function updateSatellitePreviewToggleUI() {
  const enabled = state.satellitePreviewEnabled === true;
  const year = getSatellitePreviewYear();
  const yearSuffix = year ? ` (${year})` : "";

  if (toggleSatellitePreviewBtn) {
    toggleSatellitePreviewBtn.classList.toggle("is-active", enabled);
    toggleSatellitePreviewBtn.classList.toggle("is-loading", false);
    toggleSatellitePreviewBtn.setAttribute("aria-pressed", String(enabled));
    const actionLabel = enabled ? "Skjul satellitlag" : "Vis satellitlag";
    toggleSatellitePreviewBtn.setAttribute("aria-label", `${actionLabel}${yearSuffix}`);
    toggleSatellitePreviewBtn.title = `${actionLabel}${yearSuffix} (S)`;
  }
}

async function toggleSatellitePreview() {
  if (!toggleSatellitePreviewBtn) return;
  const nextEnabled = !state.satellitePreviewEnabled;
  toggleSatellitePreviewBtn.classList.add("is-loading");
  toggleSatellitePreviewBtn.disabled = true;
  try {
    const enabled = await setSatellitePreviewEnabled(nextEnabled);
    state.satellitePreviewEnabled = enabled;
    if (nextEnabled && !enabled) {
      showMapToast("Satellitlag kunne ikke aktiveres.");
    }
  } catch (error) {
    state.satellitePreviewEnabled = false;
    console.warn("Failed to toggle satellite preview layer:", error);
    showMapToast("Satellitlag kunne ikke hentes.");
  } finally {
    toggleSatellitePreviewBtn.disabled = false;
    toggleSatellitePreviewBtn.classList.remove("is-loading");
    updateSatellitePreviewToggleUI();
  }
}

function updateMapHintHighlight() {
  const active = !isMapHintDismissed();
  document.body.classList.toggle("map-hint-active", active);
  const shouldHighlightReopen = active && !state.shell.drawerOpen;
  [dropzoneEl, addPageBtn, drawToggleBtn].forEach((element) => {
    element?.classList.toggle("map-hint-target", active);
  });
  sidebarReopenBtnEl?.classList.toggle("map-hint-target", shouldHighlightReopen);
}

// --- Download management ---

function getPdfFilename() {
  if (!state.selectedFile?.name) return "min_rute.pdf";
  const totalTracks = getOrderedTrackEntries().length;
  const base = state.selectedFile.name.replace(/\.gpx$/i, "");
  const safeBase = base || "min_rute";
  if (totalTracks > 1) {
    return `${safeBase}_plus_${totalTracks - 1}.pdf`;
  }
  return `${safeBase}.pdf`;
}

function setDownload(blob) {
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
  }
  const filename = getPdfFilename();
  state.downloadUrl = URL.createObjectURL(blob);
  if (downloadLink) {
    downloadLink.href = state.downloadUrl;
    downloadLink.download = filename;
    downloadLink.classList.remove("disabled");
  }
  window.open(state.downloadUrl, "_blank", "noopener");
  const tempLink = document.createElement("a");
  tempLink.href = state.downloadUrl;
  tempLink.download = filename;
  tempLink.rel = "noopener";
  tempLink.click();
  setTimeout(() => {
    if (state.downloadUrl) {
      URL.revokeObjectURL(state.downloadUrl);
      state.downloadUrl = null;
    }
  }, 60000);
}

function clearDownload() {
  if (downloadLink) {
    downloadLink.classList.add("disabled");
    downloadLink.removeAttribute("href");
  }
  if (state.downloadUrl) {
    URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }
  setRenderProgress(0, 1, false);
}

// --- Layout state ---

function resetLayoutState() {
  clearPageOverlays();
  state.layoutPages = [];
  state.isLayoutReady = false;
  state.hasManualEdits = false;
  state.selectedPageIndex = null;
  state.globalLockAll = false;
  state.hasInsertedManualPage = false;
  state.pageColors = [];
  state.heightOverlayBounds = null;
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

function getRenderButtonLabel() {
  if (renderBtnLabelEl) {
    const label = renderBtnLabelEl.textContent?.trim();
    if (label) return label;
  }
  if (renderBtn) {
    const label = renderBtn.textContent?.trim();
    if (label) return label;
  }
  return "Lav PDF";
}

function getRenderButtonSummaryText() {
  const pageCount = state.layoutPages.length;
  if (!pageCount) return "";
  const pageLabel = pageCount === 1 ? "side" : "sider";
  const formattedScale = formatScaleLabel(selections.scale).replace(/\./g, " ");
  return `${pageCount} ${pageLabel} | ${selections.paper} | 1:${formattedScale}`;
}

function updateRenderButtonSummary() {
  if (!renderBtn) return;
  const summary = getRenderButtonSummaryText();
  if (renderBtnSummaryEl) {
    renderBtnSummaryEl.textContent = summary;
    renderBtnSummaryEl.classList.toggle("hidden", !summary);
  }
  const actionLabel = getRenderButtonLabel();
  renderBtn.setAttribute("aria-label", summary ? `${actionLabel}. ${summary}` : actionLabel);
}

function setRenderButtonLabel(label) {
  if (!renderBtn) return;
  if (renderBtnLabelEl) {
    renderBtnLabelEl.textContent = label;
  } else {
    renderBtn.textContent = label;
  }
  updateRenderButtonSummary();
}

function updateRenderButtonState() {
  const ready = Boolean(state.isLayoutReady);
  if (renderBtn) {
    renderBtn.disabled = !ready;
    renderBtn.classList.toggle("ready", ready);
  }
  updateRenderButtonSummary();
  updateWorkflowPhases();
}

function setCollapsibleSectionState(sectionEl, { lockedOpen = false, disabled = false } = {}) {
  if (!sectionEl) return;
  const wasLocked = sectionEl.dataset.lockedOpen === "1";
  sectionEl.dataset.lockedOpen = lockedOpen ? "1" : "0";
  sectionEl.dataset.disabled = disabled ? "1" : "0";
  sectionEl.classList.toggle("locked-open", lockedOpen);
  sectionEl.classList.toggle("is-disabled", disabled);

  if (lockedOpen) {
    sectionEl.open = true;
    return;
  }

  if (disabled) {
    sectionEl.open = false;
    return;
  }

  if (wasLocked && !lockedOpen) {
    sectionEl.open = false;
  }
}

function enforceCollapsibleSectionState(sectionEl) {
  if (!sectionEl) return;
  if (sectionEl.dataset.lockedOpen === "1" && !sectionEl.open) {
    sectionEl.open = true;
    return;
  }
  if (sectionEl.dataset.disabled === "1" && sectionEl.open) {
    sectionEl.open = false;
  }
}

function updateSideinddelingVisibility() {
  const hasTrack = getOrderedTrackEntries().length > 0;
  setCollapsibleSectionState(sideinddelingSectionEl, { disabled: !hasTrack });
}

function updateWorkflowPhases(hasTracks = getOrderedTrackEntries().length > 0) {
  const hasPages = state.layoutPages.length > 0;
  const hasConfiguredLayout = hasTracks || hasPages;

  if (phaseCustomizeEl) {
    phaseCustomizeEl.classList.remove("hidden");
  }

  setCollapsibleSectionState(sideinddelingSectionEl, {
    disabled: !hasTracks,
  });

  const activePhase = !hasConfiguredLayout ? "1" : (state.isLayoutReady ? "3" : "2");
  const activeNum = parseInt(activePhase, 10);
  [phaseEntryEl, phaseCustomizeEl, phaseExportEl].forEach((phaseEl) => {
    if (!phaseEl) return;
    const phaseNum = parseInt(phaseEl.dataset.phase, 10);
    const isActive = (phaseNum >= 2 && phaseNum <= activeNum) || phaseNum === activeNum;
    phaseEl.classList.toggle("is-active", isActive);
    if (isActive) {
      phaseEl.setAttribute("aria-current", "step");
    } else {
      phaseEl.removeAttribute("aria-current");
    }
  });
}

function markLayoutCustomized(message) {
  state.hasManualEdits = true;
  clearDownload();
  updateRenderButtonState();
  if (message) {
    setStatus(message);
  }
}

// --- Segmented controls ---

function setSegmentedActive(group, value, attr) {
  group.querySelectorAll("button").forEach((btn) => {
    const isActive = btn.dataset[attr] === value;
    btn.classList.toggle("active", isActive);
  });
}

function setTrackControlsVisible(isVisible) {
  if (trackStyleSectionEl) {
    trackStyleSectionEl.classList.toggle("is-disabled", !isVisible);
  }
  if (trackControlsEl) {
    trackControlsEl.disabled = !isVisible;
    trackControlsEl.setAttribute("aria-disabled", String(!isVisible));
  }
}

function syncTrackControlsVisibility() {
  const hasTracks = getOrderedTrackEntries().length > 0;
  state.hasTrackData = hasTracks;
  setTrackControlsVisible(hasTracks);
  updateSideinddelingVisibility();
  updateWorkflowPhases(hasTracks);
}

function applyDrawnTrackStyle() {
  if (state.drawPolyline) {
    state.drawPolyline.setStyle({
      color: selections.trackColor,
      weight: selections.trackWidth,
      opacity: selections.trackOpacity,
    });
  }
  if (state.drawRubberBand) {
    state.drawRubberBand.setStyle({
      color: selections.trackColor,
      weight: selections.trackWidth,
      opacity: selections.trackOpacity * 0.5,
    });
  }
  (state.drawMarkers ?? []).forEach((marker) => {
    marker.setStyle({ fillColor: selections.trackColor });
  });
}

function applyGlobalTrackStyle() {
  if (state.trackLayer) {
    state.trackLayer.setStyle({
      color: selections.trackColor,
      weight: selections.trackWidth,
      opacity: selections.trackOpacity,
    });
  }
  applyDrawnTrackStyle();
  if (_hoveredUploadedTrackId) {
    const hoveredTrack = getTrackById(_hoveredUploadedTrackId);
    if (hoveredTrack) {
      highlightTrackSegment(hoveredTrack.pointsLonLat, { flyTo: false });
    } else {
      clearUploadedTrackHover();
    }
  }
}

function updateMergedExportVisibility() {
  if (!exportMergedBtn) return;
  exportMergedBtn.classList.toggle("hidden", !_uploadedPoints?.length || !getDrawnTrackEntry());
}

// --- Modal ---

function setConfirmModalOpen(isOpen) {
  if (!confirmModalEl) return;
  confirmModalEl.classList.toggle("open", isOpen);
  confirmModalEl.setAttribute("aria-hidden", String(!isOpen));
}

function handleConfirmChoice(accepted) {
  if (!state.confirmResolver) return;
  const resolve = state.confirmResolver;
  state.confirmResolver = null;
  setConfirmModalOpen(false);
  resolve(accepted);
}

function showConfirmModal(message) {
  if (!confirmModalEl || !confirmTextEl || !confirmAcceptBtn || !confirmCancelBtn) {
    return Promise.resolve(window.confirm(message));
  }
  if (state.confirmResolver) {
    return Promise.resolve(false);
  }
  confirmTextEl.textContent = message;
  setConfirmModalOpen(true);
  confirmAcceptBtn.focus();
  return new Promise((resolve) => {
    state.confirmResolver = resolve;
  });
}

async function confirmOverrideManualEdits() {
  if (!state.hasManualEdits) return true;
  const ok = await showConfirmModal(
    "Du har ændret layoutet manuelt. Hvis du ændrer indstillingerne, overskrives dine ændringer. Vil du fortsætte?"
  );
  if (ok) {
    state.hasManualEdits = false;
  }
  return ok;
}

// --- Label updaters ---

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

function updateWeakIceOpacityLabel() {
  if (!weakIceOpacityValueEl || !weakIceOpacityEl) return;
  const value = Number(weakIceOpacityEl.value);
  if (!Number.isFinite(value)) return;
  const percent = Math.round(value * 100);
  weakIceOpacityValueEl.textContent = `${percent}%`;
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

function updateHeightOpacityVisibility() {
  if (!heightOpacityGroupEl) return;
  const anyOn = heightLayerToggleEls.some((toggle) => toggle.checked);
  heightOpacityGroupEl.classList.toggle("hidden", !anyOn);
}

function updateWeakIceOpacityVisibility() {
  if (!weakIceOpacityGroupEl || !weakIceToggleEl) return;
  weakIceOpacityGroupEl.classList.toggle("hidden", !weakIceToggleEl.checked);
}

/* --- Denmark tag-select multi-picker --- */
function initDkTagSelects() {
  document.querySelectorAll(".dk-tag-select").forEach((widget) => {
    const targetId = widget.dataset.target;
    const toggleId = widget.dataset.toggle;
    const selectEl = document.getElementById(targetId);
    const toggleEl = document.getElementById(toggleId);
    const chipsEl = widget.querySelector(".dk-tag-chips");
    const dropdownEl = widget.querySelector(".dk-tag-dropdown");
    const triggerBtn = widget.querySelector(".dk-tag-trigger");
    if (!selectEl || !toggleEl || !chipsEl || !dropdownEl || !triggerBtn) return;

    // Build dropdown options from the hidden <select>
    Array.from(selectEl.options).forEach((opt) => {
      const li = document.createElement("li");
      li.role = "option";
      li.className = "dk-tag-option";
      li.dataset.value = opt.value;
      li.innerHTML =
        '<span class="dk-tag-option-check"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7.5L5.5 10L11 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
        '<span>' + opt.textContent + '</span>';
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleOption(opt.value);
      });
      dropdownEl.appendChild(li);
    });

    function syncFromSelect() {
      const selected = new Set(
        Array.from(selectEl.selectedOptions).map((o) => o.value)
      );
      // Update toggle checkbox
      toggleEl.checked = selected.size > 0;
      // Update chips
      chipsEl.innerHTML = "";
      selected.forEach((val) => {
        const opt = selectEl.querySelector('option[value="' + CSS.escape(val) + '"]');
        if (!opt) return;
        const chip = document.createElement("span");
        chip.className = "dk-tag-chip";
        chip.innerHTML =
          '<span>' + opt.textContent + '</span>' +
          '<button type="button" class="dk-tag-chip-x" aria-label="Fjern ' + opt.textContent + '">' +
          '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
          '</button>';
        chip.querySelector(".dk-tag-chip-x").addEventListener("click", (e) => {
          e.stopPropagation();
          toggleOption(val);
        });
        chipsEl.appendChild(chip);
      });
      // Update dropdown checks
      dropdownEl.querySelectorAll(".dk-tag-option").forEach((li) => {
        li.classList.toggle("selected", selected.has(li.dataset.value));
        li.setAttribute("aria-selected", String(selected.has(li.dataset.value)));
      });
    }

    function toggleOption(value) {
      const opt = selectEl.querySelector('option[value="' + CSS.escape(value) + '"]');
      if (!opt) return;
      opt.selected = !opt.selected;
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      syncFromSelect();
      updateDkFriluftsdataOverlays();
    }

    function openDropdown() {
      widget.classList.add("open");
      triggerBtn.setAttribute("aria-expanded", "true");
    }

    function closeDropdown() {
      widget.classList.remove("open");
      triggerBtn.setAttribute("aria-expanded", "false");
    }

    widget.addEventListener("click", (e) => {
      if (e.target.closest(".dk-tag-chip-x")) return;
      if (widget.classList.contains("open")) {
        closeDropdown();
      } else {
        // Close any other open tag-selects
        document.querySelectorAll(".dk-tag-select.open").forEach((w) => {
          w.classList.remove("open");
          w.querySelector(".dk-tag-trigger")?.setAttribute("aria-expanded", "false");
        });
        openDropdown();
      }
    });

    // Close on outside click
    document.addEventListener("click", (e) => {
      if (!widget.contains(e.target)) closeDropdown();
    });

    // Initial render
    syncFromSelect();
  });
}

function updateHeightMaskVisibility() {
  if (!heightMaskGroupEl) return;
  const anyOn = heightLayerToggleEls.some((toggle) => toggle.checked);
  heightMaskGroupEl.classList.toggle("hidden", !anyOn);
}

// --- Page manipulation ---

function toggleSelectedOrientation() {
  if (state.selectedPageIndex === null || !state.layoutPages[state.selectedPageIndex]) return;
  const page = state.layoutPages[state.selectedPageIndex];
  const nextOrientation = page.orientation === "portrait" ? "landscape" : "portrait";
  const metrics = pageGroundSpan(selections.scale, DEFAULT_DPI, selections.paper, nextOrientation);
  const [minx, miny, maxx, maxy] = page.bbox;
  const cx = (minx + maxx) / 2;
  const cy = (miny + maxy) / 2;
  const nextBBox = bboxFromCenter(cx, cy, metrics.wM, metrics.hM);
  state.layoutPages[state.selectedPageIndex] = {
    ...page, bbox: nextBBox, orientation: nextOrientation,
    wPx: metrics.wPx, hPx: metrics.hPx, wM: metrics.wM, hM: metrics.hM,
  };
  updatePageLayerBounds(state.selectedPageIndex);
  updateSelectionBar();
  markLayoutCustomized("Layout er ændret manuelt.");
}

function ensureProjectionForManualPages() {
  if (state.transformerState && state.projectionState) return true;
  if (!state.mapInstance) return false;
  const center = state.mapInstance.getCenter();
  const { transformer, epsg } = transformerForPoints([[center.lng, center.lat]]);
  state.transformerState = { transformer, epsg };
  state.projectionState = { pointsLonLat: [], transformer, epsg, xs: [], ys: [] };
  return true;
}

function toggleSelectedLock() {
  if (state.selectedPageIndex === null || !state.layoutPages[state.selectedPageIndex]) return;
  state.layoutPages[state.selectedPageIndex].locked = !state.layoutPages[state.selectedPageIndex].locked;
  updatePageStyles();
  updateSelectionBar();
}

function toggleLockAll() {
  state.globalLockAll = !state.globalLockAll;
  state.layoutPages.forEach((page) => { page.locked = state.globalLockAll; });
  updatePageStyles();
  updateSelectionBar();
}

function removePage(index) {
  if (index === null || index === undefined) return;
  if (!state.layoutPages[index]) return;
  state.layoutPages.splice(index, 1);
  markLayoutCustomized("Layout er ændret manuelt.");
  if (!state.layoutPages.length) {
    resetLayoutState();
    setStatus("Alle sider fjernet.");
    return;
  }
  state.selectedPageIndex = Math.min(index, state.layoutPages.length - 1);
  callRenderPageOverlays();
  updateSelectionBar();
}

function movePageById(pageId, nextIndex) {
  const currentIndex = state.layoutPages.findIndex((page) => page.id === pageId);
  if (currentIndex < 0) return;
  const clamped = Math.max(0, Math.min(nextIndex, state.layoutPages.length - 1));
  if (currentIndex === clamped) return;
  const [page] = state.layoutPages.splice(currentIndex, 1);
  state.layoutPages.splice(clamped, 0, page);
  state.selectedPageIndex = clamped;
  callRenderPageOverlays();
  updateSelectionBar();
  markLayoutCustomized("Layout er ændret manuelt.");
}

function addPageAtCenter() {
  if (!state.mapInstance || !ensureProjectionForManualPages()) {
    setStatus("Kortet er ikke klar endnu.");
    return false;
  }
  const center = state.mapInstance.getCenter();
  const [centerX, centerY] = state.transformerState.transformer.forward([center.lng, center.lat]);
  const orientation = "portrait";
  const metrics = pageGroundSpan(selections.scale, DEFAULT_DPI, selections.paper, orientation);
  const bbox = bboxFromCenter(centerX, centerY, metrics.wM, metrics.hM);
  const newPage = {
    id: state.nextPageId, bbox, orientation,
    wPx: metrics.wPx, hPx: metrics.hPx, wM: metrics.wM, hM: metrics.hM,
  };
  state.nextPageId += 1;
  state.hasInsertedManualPage = true;
  if (!state.layoutPages.length) {
    state.layoutPages = [newPage];
    state.selectedPageIndex = 0;
  } else {
    const insertIndex = Math.floor(state.layoutPages.length / 2);
    state.layoutPages.splice(insertIndex, 0, newPage);
    state.selectedPageIndex = insertIndex;
  }
  state.isLayoutReady = true;
  if (renderBtn) {
    renderBtn.disabled = false;
    renderBtn.classList.add("ready");
    renderBtn.removeAttribute("disabled");
  }
  callRenderPageOverlays();
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
  if (!state.layoutPages.length) return;
  for (let i = 0; i < state.layoutPages.length; i++) {
    const page = state.layoutPages[i];
    const metrics = pageGroundSpan(selections.scale, DEFAULT_DPI, selections.paper, page.orientation);
    const [minx, miny, maxx, maxy] = page.bbox;
    const cx = (minx + maxx) / 2;
    const cy = (miny + maxy) / 2;
    state.layoutPages[i] = {
      ...page, bbox: bboxFromCenter(cx, cy, metrics.wM, metrics.hM),
      wPx: metrics.wPx, hPx: metrics.hPx, wM: metrics.wM, hM: metrics.hM,
    };
  }
  clearDownload();
  callRenderPageOverlays();
  updateSelectionBar();
  const nextHeightBounds = computeHeightOverlayBounds();
  if (!boundsEqual(state.heightOverlayBounds, nextHeightBounds)) {
    state.heightOverlayBounds = nextHeightBounds;
    refreshHeightOverlays();
  }
  updateRenderButtonState();
}

function addPageToRight(sourceIndex) {
  const source = state.layoutPages[sourceIndex];
  if (!source) return false;
  const [minx, miny, maxx, maxy] = source.bbox;
  const cx = (minx + maxx) / 2;
  const cy = (miny + maxy) / 2;
  const overlap = DEFAULT_OVERLAP;
  const shiftX = source.wM * (1 - overlap);
  const newCx = cx + shiftX;
  const newBBox = bboxFromCenter(newCx, cy, source.wM, source.hM);
  const newPage = {
    id: state.nextPageId, bbox: newBBox, orientation: source.orientation,
    wPx: source.wPx, hPx: source.hPx, wM: source.wM, hM: source.hM,
  };
  state.nextPageId += 1;
  state.hasInsertedManualPage = true;
  const insertIndex = sourceIndex + 1;
  state.layoutPages.splice(insertIndex, 0, newPage);
  state.selectedPageIndex = insertIndex;
  state.isLayoutReady = true;
  if (renderBtn) {
    renderBtn.disabled = false;
    renderBtn.classList.add("ready");
    renderBtn.removeAttribute("disabled");
  }
  callRenderPageOverlays();
  updateRenderButtonState();
  updateSelectionBar();
  markLayoutCustomized("Ny side tilføjet.");
  return true;
}

function addPageFromSelectionOrCenter() {
  if (state.selectedPageIndex !== null && state.layoutPages[state.selectedPageIndex]) {
    return addPageToRight(state.selectedPageIndex);
  }
  return addPageAtCenter();
}

// --- Drag event wiring ---

function handleDragMove(event) {
  handleDocumentMove(event, updateSelectionBar);
}

function handleDragEnd(event) {
  stopDrag(event, () => markLayoutCustomized("Layout er ændret manuelt."));
}

function handlePageInteraction(event, index) {
  startDrag(event, index, handleDragMove, handleDragEnd);
  selectPage(index, getContainerPointFromEvent(event), updateSelectionBar);
}

function pageOverlayCallbacks() {
  return {
    onPageMousedown: (event, index) => handlePageInteraction(event, index),
    onPageTouchstart: (event, index) => handlePageInteraction(event, index),
    onPageClick: (event, index) => {
      if (index === state.selectedPageIndex) return;
      selectPage(index, getContainerPointFromEvent(event), updateSelectionBar);
    },
  };
}

function callRenderPageOverlays() {
  renderPageOverlays(pageOverlayCallbacks());
}

function mapCallbacks() {
  return {
    onMapClick: () => selectPage(null, null, updateSelectionBar),
    onMapMove: () => {
      updateSelectionBar();
      updateDkFriluftsdataOverlays();
      void syncOverlayCountryToMapCenter();
    },
    onHintDismiss: () => dismissMapHint(),
    isHintDismissed: () => isMapHintDismissed(),
    updateHintHighlight: () => updateMapHintHighlight(),
  };
}

// --- Overlay tabs ---

function setActiveOverlayCountry(country) {
  if (!country) return;
  overlayTabsEl.forEach((tab) => {
    const isActive = tab.dataset.country === country;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });
  overlayContentsEl.forEach((content) => {
    content.classList.toggle("active", content.dataset.country === country);
  });
}

async function syncOverlayCountryToMapCenter() {
  if (!state.mapInstance) return;
  const center = state.mapInstance.getCenter();
  if (!center) return;

  const requestId = ++_overlayAutoFocusRequestId;
  try {
    const providers = await getPointProviders(center.lng, center.lat);
    if (requestId !== _overlayAutoFocusRequestId) return;

    let nextCountry = null;
    if (providers.includes("dk")) {
      nextCountry = "dk";
    } else if (providers.includes("no")) {
      nextCountry = "no";
    }
    if (nextCountry) {
      setActiveOverlayCountry(nextCountry);
    }
  } catch (error) {
    console.debug("Overlay country sync skipped:", error);
  }
}

// --- Form value extraction ---

function getOverlapValue() {
  const overlapInput = Number(document.getElementById("overlap").value);
  return Number.isFinite(overlapInput) ? overlapInput / 100 : DEFAULT_OVERLAP;
}

function getMarginValue() {
  const marginInput = Number(document.getElementById("margin").value);
  return Number.isFinite(marginInput) ? marginInput / 100 : DEFAULT_MARGIN;
}

function getDpiValue() {
  const dpiInput = Number(document.getElementById("dpi").value);
  return Number.isFinite(dpiInput) ? dpiInput : DEFAULT_DPI;
}

// --- Workflow: generate layout ---

export function generateLayout(statusMessage, options = {}) {
  if (!state.cachedPoints) {
    setStatus("Tilføj eller tegn et spor først.");
    return;
  }
  const previousSelectedPageIndex = state.selectedPageIndex;
  clearDownload();
  setStatus(statusMessage || "Beregner layout...", true);
  const overlapValue = getOverlapValue();
  const marginValue = getMarginValue();
  const dpiValue = getDpiValue();
  const layoutOptions = {
    scale: selections.scale,
    dpi: dpiValue,
    paper: selections.paper,
    orientation: selections.orientation,
    overlap: overlapValue,
    margin: marginValue,
  };

  const segments = getOrderedTrackSegments();
  let allPages;
  let statusLine;

  if (segments.length <= 1) {
    // Single track (or no tracks): use existing behavior with shared projection
    const layout = computeLayoutPages(state.cachedPoints, {
      ...layoutOptions,
      projection: state.projectionState,
    });
    allPages = layout.pages;
    statusLine = layout.statusLine;
  } else {
    // Multiple tracks: run layout independently per segment
    allPages = [];
    for (const segment of segments) {
      if (!segment.length) continue;
      const segLayout = computeLayoutPages(segment, {
        ...layoutOptions,
        projection: null,
      });
      allPages.push(...segLayout.pages);
    }
    statusLine = `Sider: ${allPages.length} | ${selections.paper} | 1:${selections.scale} | ${segments.length} spor`;
  }

  state.layoutPages = allPages;
  ensurePageIds(state.layoutPages);
  state.isLayoutReady = true;
  state.hasManualEdits = false;
  if (options.preserveSelection) {
    const hasValidSelection = Number.isInteger(previousSelectedPageIndex)
      && previousSelectedPageIndex >= 0
      && previousSelectedPageIndex < state.layoutPages.length;
    state.selectedPageIndex = hasValidSelection ? previousSelectedPageIndex : null;
  } else {
    const shouldSelectFirstPage = options.selectFirstPage !== false;
    state.selectedPageIndex = shouldSelectFirstPage && state.layoutPages.length ? 0 : null;
  }
  setProgress(3, [1, 2]);
  setStatus(statusLine || "Layout klar.");
  updateRenderButtonState();
  callRenderPageOverlays();
  if (options.fitToLayout !== false) {
    fitMapToLayout();
  }
  updateSelectionBar();
  const nextHeightBounds = computeHeightOverlayBounds();
  if (!boundsEqual(state.heightOverlayBounds, nextHeightBounds)) {
    state.heightOverlayBounds = nextHeightBounds;
    refreshHeightOverlays();
  }
}

function computeHeightOverlayBounds() {
  if (!state.layoutPages.length || !state.projectionState?.transformer || !L) return null;
  let bounds = null;
  state.layoutPages.forEach((page) => {
    const pageBounds = bboxToLatLngBounds(page.bbox, state.projectionState.transformer);
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

// --- Workflow: file handling ---

function getDrawnTrackEntry() {
  if (!hasDrawnRoute()) return null;
  const points = getDrawnRoute();
  return {
    id: DRAWN_TRACK_ID,
    source: "drawn",
    file: { name: "Tegnet rute" },
    pointsLonLat: points,
    lengthMeters: computeTrackLengthMeters(points, null),
  };
}

function syncTrackOrder(availableIds) {
  const existingOrder = Array.isArray(state.trackOrder) ? state.trackOrder : [];
  const keptIds = existingOrder.filter((id) => availableIds.includes(id));
  const appendedIds = availableIds.filter((id) => !keptIds.includes(id));
  state.trackOrder = [...keptIds, ...appendedIds];
  return state.trackOrder;
}

function getOrderedTrackEntries() {
  const uploadedEntries = (state.uploadedTracks ?? []).map((track) => ({
    ...track,
    source: "uploaded",
  }));
  const drawnEntry = getDrawnTrackEntry();
  const availableEntries = drawnEntry ? [...uploadedEntries, drawnEntry] : uploadedEntries;
  const entryIds = availableEntries.map((entry) => entry.id);
  const orderedIds = syncTrackOrder(entryIds);
  const entryById = new Map(availableEntries.map((entry) => [entry.id, entry]));
  return orderedIds.map((id) => entryById.get(id)).filter(Boolean);
}

function getTrackById(trackId) {
  return getOrderedTrackEntries().find((track) => track.id === trackId) ?? null;
}

function setHoveredTrackRow(trackId) {
  if (!fileMetaEl) return;
  fileMetaEl.querySelectorAll(".file-meta-row").forEach((row) => {
    row.classList.toggle("is-hovered", Boolean(trackId) && row.dataset.trackId === trackId);
  });
}

function clearUploadedTrackHover() {
  _hoveredUploadedTrackId = null;
  if (_hoverTrackTimer) {
    window.clearTimeout(_hoverTrackTimer);
    _hoverTrackTimer = null;
  }
  setHoveredTrackRow(null);
  clearTrackHighlight();
}

function setTrackDropMarker(targetTrackId, insertBefore) {
  if (!fileMetaEl) return;
  fileMetaEl.querySelectorAll(".file-meta-row").forEach((row) => {
    const isTarget = targetTrackId && row.dataset.trackId === targetTrackId;
    row.classList.toggle("drop-before", isTarget && insertBefore);
    row.classList.toggle("drop-after", isTarget && !insertBefore);
  });
}

function clearTrackReorderVisualState() {
  if (!fileMetaEl) return;
  fileMetaEl.querySelectorAll(".file-meta-row").forEach((row) => {
    row.classList.remove("is-dragging", "drop-before", "drop-after");
  });
}

function resetTrackReorderState() {
  _draggedUploadedTrackId = null;
  _dropTargetTrackId = null;
  _dropInsertBefore = true;
  clearTrackReorderVisualState();
}

function hoverUploadedTrack(trackId) {
  if (_draggedUploadedTrackId) return;
  if (!trackId) {
    clearUploadedTrackHover();
    return;
  }
  if (_hoveredUploadedTrackId === trackId) return;
  const track = getTrackById(trackId);
  if (!track) {
    clearUploadedTrackHover();
    return;
  }

  _hoveredUploadedTrackId = trackId;
  setHoveredTrackRow(trackId);
  if (_hoverTrackTimer) {
    window.clearTimeout(_hoverTrackTimer);
  }
  _hoverTrackTimer = window.setTimeout(() => {
    if (_hoveredUploadedTrackId !== trackId) return;
    highlightTrackSegment(track.pointsLonLat, { flyTo: false });
  }, 120);
}

function focusUploadedTrack(trackId) {
  if (!trackId) return;
  const track = getTrackById(trackId);
  if (!track) return;
  _hoveredUploadedTrackId = trackId;
  if (_hoverTrackTimer) {
    window.clearTimeout(_hoverTrackTimer);
    _hoverTrackTimer = null;
  }
  setHoveredTrackRow(trackId);
  highlightTrackSegment(track.pointsLonLat, { flyTo: true });
}

function createTrackId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `track_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSelectedFiles(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter(Boolean);
  if (typeof FileList !== "undefined" && input instanceof FileList) {
    return Array.from(input).filter(Boolean);
  }
  return [input].filter(Boolean);
}

function getUploadedTrackSegments() {
  return getOrderedTrackEntries()
    .filter((track) => track.source === "uploaded")
    .map((track) => track.pointsLonLat)
    .filter((points) => Array.isArray(points) && points.length);
}

function getOrderedTrackSegments() {
  return getOrderedTrackEntries()
    .map((track) => track.pointsLonLat)
    .filter((points) => Array.isArray(points) && points.length);
}

function buildTrackBreakIndices(segments) {
  const breaks = [];
  let offset = 0;
  segments.forEach((segment) => {
    if (!segment.length) return;
    breaks.push(offset);
    offset += segment.length;
  });
  return breaks.length ? breaks : [0];
}

function reorderTrackEntries(draggedTrackId, targetTrackId, insertBefore) {
  const order = Array.isArray(state.trackOrder) ? state.trackOrder : [];
  const fromIndex = order.indexOf(draggedTrackId);
  const targetIndex = order.indexOf(targetTrackId);
  if (fromIndex < 0 || targetIndex < 0) return false;

  let toIndex = insertBefore ? targetIndex : targetIndex + 1;
  if (fromIndex < toIndex) {
    toIndex -= 1;
  }
  if (toIndex === fromIndex) return false;

  const nextOrder = [...order];
  const [movedTrackId] = nextOrder.splice(fromIndex, 1);
  nextOrder.splice(toIndex, 0, movedTrackId);
  state.trackOrder = nextOrder;
  return true;
}

function applyTrackOrderChange() {
  setRenderButtonLabel("Lav PDF");
  clearDownload();
  resetLayoutState();
  updateFileMeta();
  applyTrackState();
  syncTrackControlsVisibility();
  setProgress(2, [1]);
  setStatus("Rækkefølge opdateret. Layout beregnes...");
  generateLayout();
  showAutoLayoutToast(state.layoutPages.length);
}

function applyTrackState(options = {}) {
  const orderedEntries = getOrderedTrackEntries();
  const orderedSegments = getOrderedTrackSegments();
  const uploadedSegments = getUploadedTrackSegments();
  if (!orderedSegments.length) {
    clearUploadedTrackHover();
    state.selectedFile = null;
    state.cachedPoints = null;
    _uploadedPoints = null;
    state.transformerState = null;
    state.projectionState = null;
    clearTrackLayer();
    updateMergedExportVisibility();
    syncTrackControlsVisibility();
    return { segments: [], trackBreakIndices: [0] };
  }

  const mergedPoints = orderedSegments.flat();
  const projection = buildProjection(mergedPoints);
  state.selectedFile = orderedEntries.find((entry) => entry.source === "uploaded")?.file ?? null;
  state.cachedPoints = mergedPoints;
  _uploadedPoints = uploadedSegments.flat();
  state.projectionState = projection;
  state.transformerState = { transformer: projection.transformer, epsg: projection.epsg };
  if (uploadedSegments.length) {
    updateTrackLayer(uploadedSegments, { fitBounds: options.fitBounds !== false });
  } else {
    clearTrackLayer();
  }
  if (_hoveredUploadedTrackId) {
    const hoveredTrack = getTrackById(_hoveredUploadedTrackId);
    if (hoveredTrack) {
      highlightTrackSegment(hoveredTrack.pointsLonLat, { flyTo: false });
      setHoveredTrackRow(_hoveredUploadedTrackId);
    } else {
      clearUploadedTrackHover();
    }
  }
  updateMergedExportVisibility();
  syncTrackControlsVisibility();

  return {
    segments: orderedSegments,
    trackBreakIndices: buildTrackBreakIndices(orderedSegments),
  };
}

function updateFileMeta() {
  const tracks = getOrderedTrackEntries();
  fileMetaEl.textContent = "";
  if (!tracks.length) {
    fileMetaEl.classList.add("hidden");
    return;
  }

  const table = document.createElement("table");
  table.className = "file-meta-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["", "Fil", "Længde", ""].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  const tbody = document.createElement("tbody");
  tracks.forEach((track) => {
    const row = document.createElement("tr");
    row.className = "file-meta-row";
    row.dataset.trackId = track.id;
    row.draggable = false;

    const reorderCell = document.createElement("td");
    reorderCell.className = "file-meta-reorder";
    const reorderHandle = document.createElement("button");
    reorderHandle.type = "button";
    reorderHandle.className = "file-meta-handle";
    reorderHandle.dataset.trackId = track.id;
    reorderHandle.draggable = tracks.length > 1;
    reorderHandle.setAttribute("aria-label", `Træk for at flytte ${track.file.name}`);
    reorderHandle.title = "Træk for at ændre rækkefølge";
    const reorderIcon = document.createElement("span");
    reorderIcon.className = "file-meta-handle-icon";
    reorderIcon.setAttribute("aria-hidden", "true");
    reorderHandle.appendChild(reorderIcon);
    reorderCell.appendChild(reorderHandle);

    const fileCell = document.createElement("td");
    fileCell.className = "file-meta-name";
    fileCell.title = track.file.name;
    const fileNameText = document.createElement("span");
    fileNameText.className = "file-meta-name-text";
    fileNameText.textContent = track.file.name;
    fileCell.appendChild(fileNameText);

    const lengthCell = document.createElement("td");
    lengthCell.textContent = formatDistance(track.lengthMeters);

    const removeCell = document.createElement("td");
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "file-meta-remove";
    removeBtn.textContent = "×";
    removeBtn.dataset.trackId = track.id;
    removeBtn.setAttribute("aria-label", `Fjern ${track.file.name}`);
    removeCell.appendChild(removeBtn);

    row.appendChild(reorderCell);
    row.appendChild(fileCell);
    row.appendChild(lengthCell);
    row.appendChild(removeCell);
    tbody.appendChild(row);
  });

  table.appendChild(thead);
  table.appendChild(tbody);
  fileMetaEl.appendChild(table);
  const hint = document.createElement("p");
  hint.className = "file-meta-hint";
  hint.textContent = "Klik på en række for at fokusere sporet på kortet. Træk håndtaget for at ændre rækkefølgen.";
  fileMetaEl.appendChild(hint);
  fileMetaEl.classList.remove("hidden");
  if (_hoveredUploadedTrackId && !getTrackById(_hoveredUploadedTrackId)) {
    clearUploadedTrackHover();
  } else {
    setHoveredTrackRow(_hoveredUploadedTrackId);
  }
}

function removeTrackFromState(trackId) {
  if (trackId === DRAWN_TRACK_ID) {
    if (!state.drawnRoute.length) return false;
    clearDrawnRoute();
    return true;
  }
  const prevTracks = state.uploadedTracks ?? [];
  const nextTracks = prevTracks.filter((track) => track.id !== trackId);
  if (nextTracks.length === prevTracks.length) return false;
  state.uploadedTracks = nextTracks;
  return true;
}

function removeTrackEntry(trackId) {
  clearUploadedTrackHover();
  const didRemove = removeTrackFromState(trackId);
  if (!didRemove) return;

  setRenderButtonLabel("Lav PDF");
  clearDownload();
  resetLayoutState();
  updateFileMeta();

  applyTrackState();
  if (!getOrderedTrackEntries().length) {
    setProgress(1, []);
    return;
  }

  setProgress(2, [1]);
  setStatus("Spor fjernet. Layout beregnes...");
  generateLayout();
  showAutoLayoutToast(state.layoutPages.length);
}

async function parseTrackFile(file) {
  if (file.size > MAX_GPX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    throw new Error(`Filen ${file.name} er for stor (${sizeMB} MB). Maksimum er ${MAX_GPX_FILE_SIZE / (1024 * 1024)} MB.`);
  }

  let points;
  if (file.size > LARGE_FILE_THRESHOLD) {
    try {
      const projection = await parseLargeGpxWithWorker(file, state, proj4);
      points = projection.pointsLonLat;
    } catch (workerError) {
      console.warn("Worker-based GPX parsing failed, falling back to main thread:", workerError);
      const text = await file.text();
      points = parseGPX(text);
    }
  } else {
    const text = await file.text();
    points = parseGPX(text);
  }

  return {
    id: createTrackId(),
    file,
    pointsLonLat: points,
    lengthMeters: computeTrackLengthMeters(points, null),
  };
}

export async function handleFileSelection(fileOrFiles) {
  const files = normalizeSelectedFiles(fileOrFiles);
  if (!files.length) return;

  setRenderButtonLabel("Lav PDF");
  setStatus(files.length > 1 ? `Læser ${files.length} GPX-filer...` : "Læser GPX...", true);

  try {
    const parsedTracks = [];
    for (const file of files) {
      const parsed = await parseTrackFile(file);
      parsedTracks.push(parsed);
    }

    state.uploadedTracks = [...(state.uploadedTracks ?? []), ...parsedTracks];
    clearDownload();
    resetLayoutState();
    updateFileMeta();
    applyTrackState();
    setProgress(2, [1]);
    setStatus("GPX indlæst. Layout beregnes...");
    updateRenderButtonState();
    generateLayout();
    showAutoLayoutToast(state.layoutPages.length);
    const nextFocus = document.querySelector("[data-paper=\"A4\"]");
    if (nextFocus) nextFocus.focus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Fejl: ${message}`);
    if (!(state.uploadedTracks ?? []).length && !getDrawnTrackEntry()) {
      fileMetaEl.classList.add("hidden");
      state.transformerState = null;
      state.projectionState = null;
      clearTrackLayer();
      resetLayoutState();
    }
  }
}

// --- Setup functions ---

function setupSegmentedControls() {
  const paperGroup = document.querySelector("[aria-label='Papirstørrelse']");
  const scaleGroup = document.querySelector("[aria-label='Målestok']");
  selections.orientation = "auto";

  paperGroup.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const nextPaper = button.dataset.paper;
    if (nextPaper === selections.paper) return;
    if (state.cachedPoints) {
      if (!(await confirmOverrideManualEdits())) {
        setSegmentedActive(paperGroup, selections.paper, "paper");
        return;
      }
    } else if (state.layoutPages.length) {
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
    if (state.cachedPoints) {
      generateLayout("Papirstørrelsen er ændret. Layout opdateres...", {
        preserveSelection: true,
      });
    } else if (state.layoutPages.length) {
      resizeManualPagesInPlace();
    }
  });

  scaleGroup.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const nextScale = Number(button.dataset.scale);
    if (nextScale === selections.scale) return;
    if (state.cachedPoints) {
      if (!(await confirmOverrideManualEdits())) {
        setSegmentedActive(scaleGroup, String(selections.scale), "scale");
        return;
      }
    } else if (state.layoutPages.length) {
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
    if (state.cachedPoints) {
      generateLayout("Målestokken er ændret. Layout opdateres...", {
        preserveSelection: true,
      });
    } else if (state.layoutPages.length) {
      resizeManualPagesInPlace();
    }
  });

}

function setupColorPicker() {
  if (!colorPickerEl) return;
  colorPickerEl.querySelectorAll(".color-swatch").forEach((btn) => {
    const swatch = btn;
    const color = swatch.dataset.color;
    if (color) swatch.style.background = color;
    if (color === selections.trackColor) swatch.classList.add("active");
    swatch.addEventListener("click", () => {
      if (!color) return;
      selections.trackColor = color;
      colorPickerEl.querySelectorAll(".color-swatch").forEach((el) => {
        el.classList.toggle("active", el === swatch);
      });
      applyGlobalTrackStyle();
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
    applyGlobalTrackStyle();
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
    applyGlobalTrackStyle();
  });
}

function getShellViewportMetrics() {
  const visualViewport = window.visualViewport;
  const width = Math.round(visualViewport?.width || window.innerWidth || document.documentElement.clientWidth || 0);
  const height = Math.round(visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 0);
  const offsetTop = Math.round(visualViewport?.offsetTop || 0);
  const offsetLeft = Math.round(visualViewport?.offsetLeft || 0);

  return {
    width,
    height,
    offsetTop,
    offsetLeft,
  };
}

function getShellViewportWidth() {
  return getShellViewportMetrics().width;
}

function getShellBand(width = getShellViewportWidth()) {
  if (width >= SHELL_BREAKPOINTS.desktopMin) return "desktop";
  if (width >= SHELL_BREAKPOINTS.tabletMin) return "tablet";
  return "phone";
}

function getShellDefaultOpen(band) {
  return band !== "phone";
}

function isOverlayShellBand(band) {
  return band !== "desktop";
}

function clearShellRelayoutWaiters() {
  if (shellRelayoutCleanup) {
    shellRelayoutCleanup();
    shellRelayoutCleanup = null;
  }
  if (shellRelayoutTimeout) {
    window.clearTimeout(shellRelayoutTimeout);
    shellRelayoutTimeout = null;
  }
  if (shellRelayoutFrame) {
    window.cancelAnimationFrame(shellRelayoutFrame);
    shellRelayoutFrame = null;
  }
}

function runShellRelayout() {
  clearShellRelayoutWaiters();
  shellRelayoutFrame = window.requestAnimationFrame(() => {
    shellRelayoutFrame = window.requestAnimationFrame(() => {
      shellRelayoutFrame = null;
      if (state.mapInstance) {
        state.mapInstance.invalidateSize({ pan: false, animate: false });
      }
      updateSelectionBar();
      updateMapHintHighlight();
    });
  });
}

function scheduleShellRelayout(options = {}) {
  const { waitForTransition = false } = options;
  clearShellRelayoutWaiters();

  if (!waitForTransition || !sidebarEl) {
    runShellRelayout();
    return;
  }

  const listeners = [];
  const cleanup = () => {
    listeners.forEach(({ element, handler }) => element.removeEventListener("transitionend", handler));
  };
  shellRelayoutCleanup = cleanup;

  const finish = () => {
    cleanup();
    shellRelayoutCleanup = null;
    if (shellRelayoutTimeout) {
      window.clearTimeout(shellRelayoutTimeout);
      shellRelayoutTimeout = null;
    }
    runShellRelayout();
  };

  const onTransitionEnd = (event) => {
    if (event.target !== sidebarEl && event.target !== sidebarBackdropEl) return;
    if (event.propertyName && !["transform", "opacity", "visibility"].includes(event.propertyName)) return;
    finish();
  };

  [sidebarEl, sidebarBackdropEl].filter(Boolean).forEach((element) => {
    listeners.push({ element, handler: onTransitionEnd });
    element.addEventListener("transitionend", onTransitionEnd);
  });

  shellRelayoutTimeout = window.setTimeout(finish, SHELL_RELAYOUT_FALLBACK_MS);
}

function syncShellAria() {
  const expanded = String(state.shell.drawerOpen);
  [sidebarToggleEl, sidebarReopenBtnEl].forEach((element) => {
    if (!element) return;
    element.setAttribute("aria-controls", "sidebar");
    element.setAttribute("aria-expanded", expanded);
  });
  if (sidebarBackdropEl) {
    const hidden = !state.shell.overlay || !state.shell.drawerOpen;
    sidebarBackdropEl.setAttribute("aria-hidden", String(hidden));
    if ("inert" in sidebarBackdropEl) {
      sidebarBackdropEl.inert = hidden;
    }
  }
}

function syncShellDatasets() {
  const values = {
    shellBand: state.shell.band,
    drawerMode: state.shell.overlay ? "overlay" : "pinned",
    drawerOpen: state.shell.drawerOpen ? "true" : "false",
    shellOverlay: state.shell.overlay ? "true" : "false",
  };
  [document.documentElement, document.body, layoutEl, mapPanelEl, sidebarEl].filter(Boolean).forEach((element) => {
    element.dataset.shellBand = values.shellBand;
    element.dataset.drawerMode = values.drawerMode;
    element.dataset.drawerOpen = values.drawerOpen;
    element.dataset.shellOverlay = values.shellOverlay;
  });
  document.body.classList.toggle("drawer-open", state.shell.drawerOpen);
  document.body.classList.toggle("drawer-overlay", state.shell.overlay);
}

function syncViewportCssVars() {
  const { width, height, offsetTop, offsetLeft } = getShellViewportMetrics();
  state.shell.viewportWidth = width;
  state.shell.viewportHeight = height;
  state.shell.viewportOffsetTop = offsetTop;
  state.shell.viewportOffsetLeft = offsetLeft;
  document.documentElement.style.setProperty("--app-viewport-width", `${width}px`);
  document.documentElement.style.setProperty("--app-viewport-height", `${height}px`);
  document.documentElement.style.setProperty("--app-viewport-offset-top", `${offsetTop}px`);
  document.documentElement.style.setProperty("--app-viewport-offset-left", `${offsetLeft}px`);
  document.documentElement.style.setProperty("--app-viewport-offset-bottom", `${offsetTop + height}px`);
  document.documentElement.style.setProperty("--app-viewport-offset-right", `${offsetLeft + width}px`);
}

function applyShellState(options = {}) {
  const { waitForTransition = false } = options;
  const overlay = state.shell.overlay;
  const drawerOpen = Boolean(state.shell.drawerOpen);

  state.shell.drawerOpen = drawerOpen;
  if (sidebarEl) {
    sidebarEl.classList.toggle("open", drawerOpen);
    sidebarEl.classList.toggle("is-overlay", overlay);
  }
  if (sidebarToggleEl) {
    const hideSidebarToggle = !drawerOpen;
    sidebarToggleEl.classList.toggle("hidden", hideSidebarToggle);
    sidebarToggleEl.setAttribute("aria-hidden", String(hideSidebarToggle));
    if (hideSidebarToggle) {
      sidebarToggleEl.setAttribute("tabindex", "-1");
    } else {
      sidebarToggleEl.removeAttribute("tabindex");
    }
  }
  if (mapPanelEl) {
    mapPanelEl.classList.toggle("sidebar-overlay-open", overlay && drawerOpen);
  }
  if (sidebarBackdropEl) {
    sidebarBackdropEl.classList.toggle("open", overlay && drawerOpen);
  }
  if (sidebarReopenBtnEl) {
    sidebarReopenBtnEl.classList.toggle("hidden", drawerOpen);
  }

  syncShellDatasets();
  syncShellAria();
  scheduleShellRelayout({ waitForTransition });
}

function setShellDrawerOpen(nextOpen, options = {}) {
  const { waitForTransition = true } = options;
  const overlay = isOverlayShellBand(state.shell.band);
  state.shell.overlay = overlay;
  state.shell.drawerOpen = Boolean(nextOpen);
  applyShellState({ waitForTransition });
}

function syncResponsiveShell(options = {}) {
  const { waitForTransition = false } = options;
  syncViewportCssVars();

  const previousBand = state.shell.band;
  const nextBand = getShellBand(state.shell.viewportWidth);
  const bandChanged = previousBand !== nextBand;

  state.shell.band = nextBand;
  state.shell.overlay = isOverlayShellBand(nextBand);
  if (bandChanged) {
    state.shell.drawerOpen = getShellDefaultOpen(nextBand);
  }

  applyShellState({ waitForTransition: waitForTransition && bandChanged });
}

function queueResponsiveShellSync(options = {}) {
  const { waitForTransition = false } = options;
  shellSyncWaitForTransition = shellSyncWaitForTransition || waitForTransition;
  if (shellSyncFrame) return;
  shellSyncFrame = window.requestAnimationFrame(() => {
    shellSyncFrame = null;
    const shouldWaitForTransition = shellSyncWaitForTransition;
    shellSyncWaitForTransition = false;
    syncResponsiveShell({ waitForTransition: shouldWaitForTransition });
  });
}

function handleShellDismiss() {
  if (!state.shell.overlay || !state.shell.drawerOpen) return;
  setShellDrawerOpen(false, { waitForTransition: true });
}

function setupSidebarToggle() {
  if (!sidebarEl) return;

  const onToggleClick = (event) => {
    event.preventDefault();
    setShellDrawerOpen(!state.shell.drawerOpen, { waitForTransition: true });
  };

  sidebarToggleEl?.addEventListener("click", onToggleClick);
  sidebarReopenBtnEl?.addEventListener("click", onToggleClick);
  sidebarBackdropEl?.addEventListener("click", () => handleShellDismiss());

  if (!shellViewportListenersBound && window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => queueResponsiveShellSync());
    window.visualViewport.addEventListener("scroll", () => queueResponsiveShellSync());
    shellViewportListenersBound = true;
  }

  queueResponsiveShellSync();
}

function setupConfirmModal() {
  if (!confirmModalEl || !confirmAcceptBtn || !confirmCancelBtn) return;
  confirmAcceptBtn.addEventListener("click", () => handleConfirmChoice(true));
  confirmCancelBtn.addEventListener("click", () => handleConfirmChoice(false));
  confirmModalEl.addEventListener("click", (event) => {
    if (event.target === confirmModalEl) handleConfirmChoice(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && confirmModalEl.classList.contains("open")) {
      handleConfirmChoice(false);
    }
  });
}

function setupDrawToolbar() {
  if (!drawToggleBtn) return;

  // Initialize drawing manager
  initDrawing({
    onDrawModeChanged(isActive) {
      const mapPanel = document.querySelector(".map-panel");
      if (drawToggleBtn) drawToggleBtn.classList.toggle("active", isActive);
      if (drawReverseBtn) drawReverseBtn.classList.toggle("hidden", !isActive || !state.drawnRoute.length);
      if (drawClearBtn) drawClearBtn.classList.toggle("hidden", !isActive || !state.drawnRoute.length);
      if (mapPanel) mapPanel.classList.toggle("draw-mode-active", isActive);
      if (isActive) {
        selectPage(null, null, updateSelectionBar);
      }
      // Hide point action bar when draw mode is toggled off
      if (!isActive && drawPointActionBar) drawPointActionBar.classList.add("hidden");
      // Trigger layout algorithm on draw mode exit (per locked decision)
      if (!isActive) {
        // Fresh state on draw mode exit -- deselect any page (per locked decision)
        selectPage(null, null, updateSelectionBar);
        applyTrackState({ fitBounds: false });
        if (state.cachedPoints?.length) {
          generateLayout("Layout beregnes for tegnet rute...", {
            fitToLayout: false,
            selectFirstPage: false,
          });
        }
      }
    },
    onRouteChanged() {
      // Show/hide reverse and clear buttons based on route length
      const hasPoints = state.drawnRoute.length > 0;
      if (drawReverseBtn) drawReverseBtn.classList.toggle("hidden", !state.drawModeActive || !hasPoints);
      if (drawClearBtn) drawClearBtn.classList.toggle("hidden", !state.drawModeActive || !hasPoints);
      // Update export section visibility and content
      if (drawExportSection) drawExportSection.classList.toggle("hidden", !hasPoints);
      updateFileMeta();
      applyTrackState({ fitBounds: false });
      updateMergedExportVisibility();
    },
    onPointSelected(index, containerPoint) {
      if (!drawPointActionBar) return;
      drawPointActionBar.classList.remove("hidden");
      drawPointActionBar.style.left = containerPoint.x + "px";
      drawPointActionBar.style.top = containerPoint.y + "px";
    },
    onPointDeselected() {
      if (drawPointActionBar) drawPointActionBar.classList.add("hidden");
    },
  });

  // Pencil toggle
  drawToggleBtn.addEventListener("click", () => {
    if (!isMapHintDismissed()) dismissMapHint();
    toggleDrawMode();
  });

  // Reverse direction
  if (drawReverseBtn) {
    drawReverseBtn.addEventListener("click", () => {
      reverseAppendDirection();
      drawReverseBtn.classList.toggle("reverse-active");
    });
  }

  // Clear route with confirmation
  if (drawClearBtn) {
    drawClearBtn.addEventListener("click", async () => {
      const ok = await showConfirmModal("Vil du slette hele den tegnede rute?");
      if (ok) clearDrawnRoute();
    });
  }

  // Point action bar delete button
  if (drawDeletePointBtn) {
    drawDeletePointBtn.addEventListener("click", () => {
      deleteSelectedPoint();
    });
  }

  // Export drawn route as GPX
  if (exportDrawnBtn) {
    exportDrawnBtn.addEventListener("click", () => {
      const points = getDrawnRoute();
      if (!points.length) return;
      const xml = routeToGpxXml(points, "Tegnet rute");
      triggerGpxDownload(xml, "tegnet_rute.gpx");
    });
  }

  // Export merged route (uploaded + drawn) as GPX
  if (exportMergedBtn) {
    exportMergedBtn.addEventListener("click", () => {
      const merged = getOrderedTrackSegments().flat();
      if (!merged.length) return;
      const xml = routeToGpxXml(merged, "Samlet rute");
      triggerGpxDownload(xml, "samlet_rute.gpx");
    });
  }

  // Disable click propagation to map for toolbar buttons
  const toolbarEl = document.getElementById("drawToolbar");
  if (toolbarEl) {
    L.DomEvent.disableClickPropagation(toolbarEl);
  }
  if (drawPointActionBar) {
    L.DomEvent.disableClickPropagation(drawPointActionBar);
  }
}

function setupMapZoomControls() {
  if (!mapZoomControlsEl || !zoomInBtn || !zoomOutBtn || !state.mapInstance) return;

  const updateZoomButtons = () => {
    const zoom = state.mapInstance.getZoom();
    const minZoom = state.mapInstance.getMinZoom();
    const maxZoom = state.mapInstance.getMaxZoom();
    zoomOutBtn.disabled = Number.isFinite(minZoom) && zoom <= minZoom;
    zoomInBtn.disabled = Number.isFinite(maxZoom) && zoom >= maxZoom;
  };

  L.DomEvent.disableClickPropagation(mapZoomControlsEl);

  zoomInBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    state.mapInstance.zoomIn();
  });

  zoomOutBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    state.mapInstance.zoomOut();
  });

  state.mapInstance.on("zoomend", updateZoomButtons);
  state.mapInstance.on("load", updateZoomButtons);
  updateZoomButtons();
}

function setupFormSubmit() {
  controlsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearDownload();

    if (!state.selectedFile && !state.projectionState?.transformer) {
      setStatus("Kortet er ikke klar endnu.");
      return;
    }
    if (!ALLOWED_SCALES.has(selections.scale)) {
      setStatus("Ugyldig målestok. Vælg 1:25 000, 1:50 000 eller 1:100 000.");
      return;
    }
    if (!state.layoutPages.length) {
      setStatus("Layout er ikke klar endnu.");
      return;
    }

    const overlapValue = getOverlapValue();
    const marginValue = getMarginValue();
    const dpiValue = getDpiValue();
    const showDeclination = true;
    const showSkiRoutes = Boolean(skiRoutesToggleEl?.checked);
    const showHikeRoutes = Boolean(hikeRoutesToggleEl?.checked);
    const useJpeg = Boolean(pdfJpegToggleEl?.checked);
    const jpegQualityValue = Number(jpegQualityEl?.value);
    const pageImageFormat = useJpeg ? "image/jpeg" : "image/png";
    const pageImageQuality = Number.isFinite(jpegQualityValue) ? jpegQualityValue : DEFAULT_JPEG_QUALITY;
    const greyscale = Boolean(greyscaleToggleEl?.checked);
    const showScaleRuler = Boolean(pdfRulerToggleEl?.checked);
    const heightLayers = getSelectedHeightLayers();
    const heightOpacity = effectiveHeightOpacity();
    const weakIceLayers = getSelectedWeakIceLayers();
    const weakIceOpacity = effectiveWeakIceOpacity();
    const showDkRekreativeRoutes = Boolean(dkRekreativeRoutesToggleEl?.checked);
    const showDkRekreativeFacilities = Boolean(dkRekreativeFacilitiesToggleEl?.checked);
    const selectedDkRouteTypes = getSelectedDkFriluftsdataRouteTypes();
    const selectedDkFacilityTypes = getSelectedDkFriluftsdataFacilityTypes();
    const dkFriluftsdataRouteTypes = showDkRekreativeRoutes ? selectedDkRouteTypes : [];
    const dkFriluftsdataFacilityTypes = showDkRekreativeFacilities ? selectedDkFacilityTypes : [];
    const trackOpacity = selections.trackOpacity;
    const trackWidth = selections.trackWidth;
    const gpxFileCount = (state.uploadedTracks ?? []).length;
    const hasDrawnTrack = hasDrawnRoute();
    const pageCount = state.layoutPages.length;
    const hasInsertedManualPage = state.hasInsertedManualPage;

    fetch("/.netlify/functions/log_click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        event: "generate-pdf", path: location.pathname,
        scale: selections.scale, paper: selections.paper,
        orientation: selections.orientation, overlap: overlapValue, margin: marginValue,
        dpi: dpiValue, showDeclination, showSkiRoutes, showHikeRoutes,
        heightLayers, heightOpacity, weakIceLayers, weakIceOpacity,
        dkFriluftsdataRouteTypes, dkFriluftsdataFacilityTypes,
        trackOpacity, trackWidth, trackColor: selections.trackColor,
        pageImageFormat, pageImageQuality, greyscale, showScaleRuler,
        gpxFileCount, hasDrawnTrack, pageCount, hasInsertedManualPage,
      }),
    }).catch(() => {});

    window.umami?.track("generate-pdf", {
      scale: selections.scale, paper: selections.paper,
      orientation: selections.orientation, overlap: overlapValue, margin: marginValue,
      dpi: dpiValue, showDeclination, showSkiRoutes, showHikeRoutes,
      heightLayers, heightOpacity, weakIceLayers, weakIceOpacity,
      dkFriluftsdataRouteTypes, dkFriluftsdataFacilityTypes,
      trackOpacity, trackWidth, trackColor: selections.trackColor,
      pageImageFormat, pageImageQuality, greyscale, showScaleRuler,
      gpxFileCount, hasDrawnTrack, pageCount, hasInsertedManualPage,
    });

    renderBtn.disabled = true;
    renderBtn.classList.remove("ready");
    setProgress(3, [1, 2]);
    setStatus("Forbereder PDF...", true);

    try {
      const renderSegments = getOrderedTrackSegments();
      const renderPoints = renderSegments.length ? renderSegments.flat() : (state.cachedPoints ?? []);
      const renderProjection = state.projectionState;
      const trackBreakIndices = renderSegments.length ? buildTrackBreakIndices(renderSegments) : [0];

      const pdfBlob = await renderGPXToPdf(state.selectedFile, {
        scale: selections.scale, dpi: dpiValue, paper: selections.paper,
        orientation: selections.orientation, overlap: overlapValue, margin: marginValue,
        layer: DEFAULT_LAYER, showDeclination, showSkiRoutes, showHikeRoutes, greyscale,
        heightLayers, heightOpacity, weakIceLayers, weakIceOpacity,
        dkFriluftsdataRouteTypes, dkFriluftsdataFacilityTypes,
        trackOpacity, trackWidth, trackColor: selections.trackColor,
        pageImageFormat, pageImageQuality, showScaleRuler,
        pointsLonLat: renderPoints,
        trackBreakIndices,
        projection: renderProjection,
        pages: state.layoutPages,
        callbacks: { setStatus, setRenderProgress },
      });
      setDownload(pdfBlob);
      setProgress(3, [1, 2, 3]);
      setStatus("PDF klar.");
      setRenderProgress(0, 1, false);
      setRenderButtonLabel("Lav PDF igen");
      renderBtn.classList.add("ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const friendly = message.includes("Failed to fetch")
        ? "Kortfliser kunne ikke hentes. Prøv igen, eller prøv et andet netværk."
        : message;
      setStatus(`Fejl: ${friendly}`);
      setProgress(3, [1, 2]);
      setRenderProgress(0, 1, false);
    } finally {
      renderBtn.disabled = false;
      if (spinnerEl) spinnerEl.classList.add("hidden");
    }
  });
}

// --- Main initialization ---

/**
 * Initialize all UI controls, event handlers, and the Leaflet map.
 * Must be called after DOMContentLoaded (all elements exist in DOM).
 */
export function initUI() {
  // Populate DOM references
  renderStatusEl = document.getElementById("renderStatus");
  statusTextEl = document.getElementById("renderStatusText");
  spinnerEl = document.getElementById("spinner");
  progressEl = document.getElementById("progress");
  fileMetaEl = document.getElementById("fileMeta");
  dropzoneEl = document.getElementById("dropzone");
  downloadLink = document.getElementById("downloadLink");
  renderBtn = document.getElementById("renderBtn");
  renderBtnLabelEl = renderBtn?.querySelector(".render-btn-label") ?? null;
  renderBtnSummaryEl = document.getElementById("renderBtnSummary");
  renderProgressEl = document.getElementById("renderProgress");
  mapToastEl = document.getElementById("mapToast");
  mapToastTextEl = document.getElementById("mapToastText");
  mapToastCloseEl = document.getElementById("mapToastClose");
  selectionBarEl = document.getElementById("selectionBar");
  selectionSelectEl = document.getElementById("selectionSelect");
  orientationToggleEl = document.getElementById("orientationToggle");
  removePageBtn = document.getElementById("removePageBtn");
  lockToggleBtn = document.getElementById("lockToggleBtn");
  lockAllBtn = document.getElementById("lockAllBtn");
  addPageBtn = document.getElementById("addPageBtn");
  togglePagePreviewsBtn = document.getElementById("togglePagePreviewsBtn");
  toggleSatellitePreviewBtn = document.getElementById("toggleSatellitePreviewBtn");
  colorPickerEl = document.getElementById("colorPicker");
  sidebarEl = document.getElementById("sidebar");
  sidebarToggleEl = document.getElementById("sidebarToggle");
  sidebarBackdropEl = document.getElementById("sidebarBackdrop") || document.querySelector("[data-sidebar-backdrop]");
  sidebarReopenBtnEl = document.getElementById("sidebarReopenBtn") || document.querySelector("[data-sidebar-reopen]");
  mapPanelEl = document.querySelector(".map-panel");
  layoutEl = document.querySelector(".layout");
  confirmModalEl = document.getElementById("confirmModal");
  confirmTextEl = document.getElementById("confirmText");
  confirmAcceptBtn = document.getElementById("confirmAcceptBtn");
  confirmCancelBtn = document.getElementById("confirmCancelBtn");
  skiRoutesToggleEl = document.getElementById("skiRoutesToggle");
  hikeRoutesToggleEl = document.getElementById("hikeRoutesToggle");
  dkRekreativeRoutesToggleEl = document.getElementById("dkRekreativeRoutesToggle");
  dkRekreativeFacilitiesToggleEl = document.getElementById("dkRekreativeFacilitiesToggle");
  heightLayerToggleEls = Array.from(document.querySelectorAll(".height-layer-toggle"));
  weakIceToggleEl = document.getElementById("weakIceToggle");
  dkRouteTypeSelectEl = document.getElementById("dkRouteTypeSelect");
  dkFacilityTypeSelectEl = document.getElementById("dkFacilityTypeSelect");
  heightOpacityGroupEl = document.getElementById("heightOpacityGroup");
  heightOpacityEl = document.getElementById("heightOpacity");
  heightOpacityValueEl = document.getElementById("heightOpacityValue");
  weakIceOpacityGroupEl = document.getElementById("weakIceOpacityGroup");
  weakIceOpacityEl = document.getElementById("weakIceOpacity");
  weakIceOpacityValueEl = document.getElementById("weakIceOpacityValue");
  heightMaskGroupEl = document.getElementById("heightMaskGroup");
  heightMaskGreenAEl = document.getElementById("heightMaskGreenA");
  heightMaskGreenBEl = document.getElementById("heightMaskGreenB");
  overlapValueEl = document.getElementById("overlapValue");
  marginValueEl = document.getElementById("marginValue");
  trackOpacityEl = document.getElementById("trackOpacity");
  trackOpacityValueEl = document.getElementById("trackOpacityValue");
  trackWidthEl = document.getElementById("trackWidth");
  trackWidthValueEl = document.getElementById("trackWidthValue");
  trackControlsEl = document.getElementById("trackControls");
  pdfJpegToggleEl = document.getElementById("pdfJpegToggle");
  jpegQualityGroupEl = document.getElementById("jpegQualityGroup");
  jpegQualityEl = document.getElementById("jpegQuality");
  jpegQualityValueEl = document.getElementById("jpegQualityValue");
  overlayTabsEl = document.querySelectorAll(".overlay-tab");
  overlayContentsEl = document.querySelectorAll(".overlay-content");
  greyscaleToggleEl = document.getElementById("greyscaleToggle");
  pdfRulerToggleEl = document.getElementById("pdfRulerToggle");
  controlsForm = document.getElementById("controls");
  fileInput = document.getElementById("gpxFile");
  drawToggleBtn = document.getElementById("drawToggleBtn");
  drawReverseBtn = document.getElementById("drawReverseBtn");
  drawClearBtn = document.getElementById("drawClearBtn");
  drawPointActionBar = document.getElementById("drawPointActionBar");
  drawDeletePointBtn = document.getElementById("drawDeletePointBtn");
  drawExportSection = document.getElementById("drawExportSection");
  exportDrawnBtn = document.getElementById("exportDrawnBtn");
  exportMergedBtn = document.getElementById("exportMergedBtn");
  mapZoomControlsEl = document.getElementById("mapZoomControls");
  zoomInBtn = document.getElementById("zoomInBtn");
  zoomOutBtn = document.getElementById("zoomOutBtn");
  formatTrackSectionEl = document.getElementById("formatTrackSection");
  sideinddelingSectionEl = document.getElementById("sideinddelingSection");
  trackStyleSectionEl = document.getElementById("trackStyleSection");
  phaseEntryEl = document.getElementById("phaseEntry");
  phaseCustomizeEl = document.getElementById("phaseCustomize");
  phaseExportEl = document.getElementById("phaseExport");

  [formatTrackSectionEl, sideinddelingSectionEl].forEach((sectionEl) => {
    if (!sectionEl) return;
    sectionEl.addEventListener("toggle", () => enforceCollapsibleSectionState(sectionEl));
  });

  // Setup controls
  setupSegmentedControls();
  setupColorPicker();
  setupTrackOpacity();
  setupTrackWidth();
  setupSidebarToggle();
  setupConfirmModal();
  setupDrawToolbar();
  updatePagePreviewsToggleUI();
  updateSatellitePreviewToggleUI();
  initDkTagSelects();

  // Init map
  initMap(mapCallbacks());
  setupMapZoomControls();
  queueResponsiveShellSync();

  // File input
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files ?? []);
    if (files.length && !isMapHintDismissed()) dismissMapHint();
    handleFileSelection(files);
    fileInput.value = "";
  });

  fileMetaEl.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const removeBtn = target.closest(".file-meta-remove");
    if (removeBtn) {
      removeTrackEntry(removeBtn.dataset.trackId);
      return;
    }
    if (target.closest(".file-meta-handle")) return;
    if (_suppressRowFocusClick) {
      _suppressRowFocusClick = false;
      return;
    }
    const row = target.closest(".file-meta-row");
    if (!row?.dataset.trackId) return;
    focusUploadedTrack(row.dataset.trackId);
  });

  fileMetaEl.addEventListener("mouseover", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest(".file-meta-row");
    if (!row || !row.dataset.trackId) return;
    hoverUploadedTrack(row.dataset.trackId);
  });

  fileMetaEl.addEventListener("mouseout", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const currentRow = target.closest(".file-meta-row");
    if (!currentRow) return;

    const related = event.relatedTarget;
    if (related instanceof Element) {
      const nextRow = related.closest(".file-meta-row");
      if (nextRow?.dataset.trackId) {
        hoverUploadedTrack(nextRow.dataset.trackId);
        return;
      }
    }
    clearUploadedTrackHover();
  });

  fileMetaEl.addEventListener("dragstart", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const handle = target.closest(".file-meta-handle");
    if (!handle) {
      event.preventDefault();
      return;
    }
    const row = handle.closest(".file-meta-row");
    const trackId = row?.dataset.trackId;
    if (!trackId) {
      event.preventDefault();
      return;
    }
    clearUploadedTrackHover();
    resetTrackReorderState();
    _draggedUploadedTrackId = trackId;
    row.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", trackId);
    }
  });

  fileMetaEl.addEventListener("dragover", (event) => {
    if (!_draggedUploadedTrackId) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest(".file-meta-row");
    if (!row?.dataset.trackId || row.dataset.trackId === _draggedUploadedTrackId) return;

    event.preventDefault();
    const rect = row.getBoundingClientRect();
    _dropInsertBefore = event.clientY < rect.top + rect.height / 2;
    _dropTargetTrackId = row.dataset.trackId;
    setTrackDropMarker(_dropTargetTrackId, _dropInsertBefore);
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  });

  fileMetaEl.addEventListener("drop", (event) => {
    if (!_draggedUploadedTrackId) return;
    event.preventDefault();
    const draggedTrackId = _draggedUploadedTrackId;
    const targetTrackId = _dropTargetTrackId;
    const insertBefore = _dropInsertBefore;
    resetTrackReorderState();
    if (!targetTrackId || targetTrackId === draggedTrackId) return;

    const changed = reorderTrackEntries(draggedTrackId, targetTrackId, insertBefore);
    if (!changed) return;
    _suppressRowFocusClick = true;
    window.setTimeout(() => {
      _suppressRowFocusClick = false;
    }, 0);
    applyTrackOrderChange();
  });

  fileMetaEl.addEventListener("dragend", () => {
    resetTrackReorderState();
  });

  // Drag and drop
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
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length) {
      if (!isMapHintDismissed()) dismissMapHint();
      try {
        const transfer = new DataTransfer();
        files.forEach((file) => transfer.items.add(file));
        fileInput.files = transfer.files;
      } catch (error) {
        // Some browsers disallow programmatic assignment
      }
      handleFileSelection(files);
    }
  });

  // Page interaction buttons
  orientationToggleEl.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSelectedOrientation();
  });
  if (removePageBtn) {
    removePageBtn.addEventListener("click", (event) => { event.stopPropagation(); removePage(state.selectedPageIndex); });
  }
  if (lockToggleBtn) {
    lockToggleBtn.addEventListener("click", (event) => { event.stopPropagation(); toggleSelectedLock(); });
  }
  if (lockAllBtn) {
    lockAllBtn.addEventListener("click", (event) => { event.stopPropagation(); toggleLockAll(); });
  }

  const insertPageBtn = document.getElementById("insertPageBtn");
  if (insertPageBtn) {
    insertPageBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      addPageFromSelectionOrCenter();
    });
  }

  if (mapToastCloseEl) {
    mapToastCloseEl.addEventListener("click", (event) => { event.stopPropagation(); hideMapToast(); });
  }

  if (togglePagePreviewsBtn) {
    togglePagePreviewsBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      setPagePreviewVisibility(!state.pagePreviewsVisible);
    });
  }
  if (toggleSatellitePreviewBtn) {
    toggleSatellitePreviewBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await toggleSatellitePreview();
    });
  }

  if (addPageBtn) {
    addPageBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!isMapHintDismissed()) dismissMapHint();
      let pendingToast = false;
      if (state.mapInstance) {
        const targetZoom = 10;
        if (state.mapInstance.getZoom() < targetZoom) {
          pendingToast = true;
          state.mapInstance.once("moveend", () => showManualLayoutToast());
          state.mapInstance.flyTo(state.mapInstance.getCenter(), targetZoom, { animate: true, duration: 0.8 });
        }
      }
      const didAddPage = addPageFromSelectionOrCenter();
      if (renderBtn && state.layoutPages.length) {
        renderBtn.disabled = false;
        renderBtn.classList.add("ready");
        renderBtn.removeAttribute("disabled");
      }
      if (didAddPage && !pendingToast) showManualLayoutToast();
    });
  }

  if (selectionSelectEl) {
    selectionSelectEl.addEventListener("change", () => {
      if (state.selectedPageIndex === null) return;
      const nextIndex = Number(selectionSelectEl.value) - 1;
      const page = state.layoutPages[state.selectedPageIndex];
      if (!page) return;
      movePageById(page.id, nextIndex);
    });
  }

  selectionBarEl.addEventListener("click", (event) => event.stopPropagation());
  selectionBarEl.addEventListener("mousedown", (event) => event.stopPropagation());
  selectionBarEl.addEventListener("touchstart", (event) => event.stopPropagation());

  // Range inputs
  const overlapInputEl = document.getElementById("overlap");
  overlapInputEl.dataset.prev = overlapInputEl.value;
  updateOverlapLabel();
  overlapInputEl.addEventListener("input", () => updateOverlapLabel());
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
    if (state.cachedPoints) {
      generateLayout("Overlap er ændret. Layout opdateres...", {
        preserveSelection: true,
      });
    }
  });

  const marginInputEl = document.getElementById("margin");
  marginInputEl.dataset.prev = marginInputEl.value;
  updateMarginLabel();
  marginInputEl.addEventListener("input", () => updateMarginLabel());
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
    if (state.cachedPoints) {
      generateLayout("Sikkerhedsmargin er ændret. Layout opdateres...", {
        preserveSelection: true,
      });
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
    if (state.cachedPoints) generateLayout("Opløsning er ændret. Layout opdateres...");
  });

  // Overlay toggles
  if (skiRoutesToggleEl) skiRoutesToggleEl.addEventListener("change", () => updateRouteOverlays());
  if (hikeRoutesToggleEl) hikeRoutesToggleEl.addEventListener("change", () => updateRouteOverlays());
  if (weakIceToggleEl) {
    weakIceToggleEl.addEventListener("change", () => { updateWeakIceOpacityVisibility(); updateWeakIceOverlays(); });
  }
  heightLayerToggleEls.forEach((toggle) => {
    toggle.addEventListener("change", () => { updateHeightOpacityVisibility(); updateHeightMaskVisibility(); updateHeightOverlays(); });
  });

  // Overlay tabs
  overlayTabsEl.forEach((tab) => {
    tab.addEventListener("click", () => {
      const country = tab.dataset.country;
      setActiveOverlayCountry(country);
    });
  });

  // Height/weak ice opacity
  if (heightOpacityEl) {
    updateHeightOpacityLabel();
    heightOpacityEl.addEventListener("input", () => {
      updateHeightOpacityLabel();
      state.heightOverlayLayers.forEach((layer) => layer.setOpacity(effectiveHeightOpacity()));
    });
  }
  if (weakIceOpacityEl) {
    updateWeakIceOpacityLabel();
    weakIceOpacityEl.addEventListener("input", () => {
      updateWeakIceOpacityLabel();
      state.weakIceOverlayLayers.forEach((layer) => layer.setOpacity(effectiveWeakIceOpacity()));
    });
  }
  if (heightMaskGreenAEl) heightMaskGreenAEl.addEventListener("change", () => refreshHeightOverlays());
  if (heightMaskGreenBEl) heightMaskGreenBEl.addEventListener("change", () => refreshHeightOverlays());

  updateWeakIceOpacityVisibility();
  updateHeightOpacityVisibility();
  updateHeightMaskVisibility();

  // JPEG quality
  if (pdfJpegToggleEl) pdfJpegToggleEl.addEventListener("change", () => updateJpegQualityVisibility());
  if (jpegQualityEl) {
    updateJpegQualityLabel();
    jpegQualityEl.addEventListener("input", () => updateJpegQualityLabel());
  }
  updateJpegQualityVisibility();

  // Form submit
  setupFormSubmit();

  // Window events
  window.addEventListener("resize", () => {
    queueResponsiveShellSync();
  });

  window.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

    if (event.key === "Escape" && !confirmModalEl?.classList.contains("open") && state.shell.overlay && state.shell.drawerOpen) {
      handleShellDismiss();
      return;
    }

    // Undo/redo for drawing mode
    if ((event.ctrlKey || event.metaKey) && event.key === "z" && !event.shiftKey && state.drawModeActive) {
      event.preventDefault();
      drawUndo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && ((event.key === "z" && event.shiftKey) || event.key === "Z") && state.drawModeActive) {
      event.preventDefault();
      drawRedo();
      return;
    }

    // Hotkeys (no modifiers)
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === "d" || event.key === "D") {
        event.preventDefault();
        toggleDrawMode();
        return;
      }
      if (event.key === "Escape" && state.drawModeActive) {
        // Only if confirm modal is not open (modal Escape handled elsewhere)
        if (!confirmModalEl || !confirmModalEl.classList.contains("open")) {
          event.preventDefault();
          toggleDrawMode();
          return;
        }
      }
      if ((event.key === "n" || event.key === "N") && addPageBtn) {
        event.preventDefault();
        addPageBtn.click();
        return;
      }
      if ((event.key === "v" || event.key === "V") && togglePagePreviewsBtn) {
        event.preventDefault();
        togglePagePreviewsBtn.click();
        return;
      }
      if ((event.key === "s" || event.key === "S") && toggleSatellitePreviewBtn) {
        event.preventDefault();
        toggleSatellitePreviewBtn.click();
        return;
      }
    }

    // Page manipulation shortcuts
    if (!state.layoutPages.length) return;
    if (event.key === "Backspace" || event.key === "Delete") removePage(state.selectedPageIndex);
  });

  // Initial state
  setProgress(1, []);
  updateRenderButtonState();
  syncTrackControlsVisibility();
}
