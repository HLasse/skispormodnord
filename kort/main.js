import proj4 from "https://cdn.jsdelivr.net/npm/proj4@2.9.0/+esm";
import geomagnetism from "https://cdn.jsdelivr.net/npm/geomagnetism@0.2.0/+esm";
import { PDFDocument } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";

const WMS_BASE_URL = "https://wms.geonorge.no/skwms1/wms.topo";
const WMS_GRID_URL = "https://wms.geonorge.no/skwms1/wms.rutenett";

// Kartverket cache (WMTS/XYZ-style REST endpoints)
// Capabilities are documented here: https://cache.kartverket.no/
const WMTS_CAPABILITIES_URL =
  "https://cache.kartverket.no/v1/wmts/1.0.0/WMTSCapabilities.xml";
const WMTS_BASE_URL = "https://cache.kartverket.no/v1/wmts/1.0.0";

// "toporaster" is Kartverket's topo raster/turkart layer.
// Other layers: topo, topograatone, sjokartraster.
const DEFAULT_LAYER = "toporaster";
const GRID_LAYER = "1km_rutelinje";

// For PDF export, WMTS requires stitching many tiles. If a page would require
// too many tiles at the highest zoom, we automatically step down.
const WMTS_MAX_TILES_PER_PAGE = 120;
const WMTS_TILE_SIZE = 256;
const USE_WMTS_FOR_BASEMAP = true;
const DEFAULT_DPI = 300;
const DEFAULT_OVERLAP = 0.05;
const TRACK_STROKE_PX = 4;
const PAGE_RENDER_CONCURRENCY = 2;
const PAPER_SIZES_MM = {
  A5: [148.0, 210.0],
  A4: [210.0, 297.0],
  A3: [297.0, 420.0],
};
const ALLOWED_SCALES = new Set([25000, 50000, 100000]);

const statusTextEl = document.getElementById("statusText");
const spinnerEl = document.getElementById("spinner");
const progressEl = document.getElementById("progress");
const fileMetaEl = document.getElementById("fileMeta");
const dropzoneEl = document.getElementById("dropzone");
const previewGrid = document.getElementById("previewGrid");
const downloadLink = document.getElementById("downloadLink");
const renderBtn = document.getElementById("renderBtn");
const previewSection = document.getElementById("preview");
const renderProgressEl = document.getElementById("renderProgress");
const viewerEl = document.getElementById("viewer");
const viewerImageEl = document.getElementById("viewerImage");
const viewerCaptionEl = document.getElementById("viewerCaption");
const viewerCloseEl = document.getElementById("viewerClose");
const viewerPrevEl = document.getElementById("viewerPrev");
const viewerNextEl = document.getElementById("viewerNext");
const viewerStageEl = document.getElementById("viewerStage");
const viewerZoomOutEl = document.getElementById("viewerZoomOut");
const viewerZoomResetEl = document.getElementById("viewerZoomReset");
const viewerZoomInEl = document.getElementById("viewerZoomIn");

const selections = {
  paper: "A4",
  scale: 50000,
  orientation: "portrait",
};

let selectedFile = null;
let cachedPoints = null;
let hasGenerated = false;
let viewerUrls = [];
let previewUrls = [];
let downloadUrl = null;
let viewerIndex = 0;
let viewerZoom = 1;
let viewerBaseSize = { width: 0, height: 0 };

function setStatus(message, isLoading = false) {
  statusTextEl.textContent = message;
  spinnerEl.classList.toggle("hidden", !isLoading);
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
  downloadLink.href = downloadUrl;
  downloadLink.download = "trail_map.pdf";
  downloadLink.classList.remove("disabled");
}

function clearPreview() {
  previewGrid.innerHTML = "";
  downloadLink.classList.add("disabled");
  downloadLink.removeAttribute("href");
  viewerUrls.forEach((url) => URL.revokeObjectURL(url));
  viewerUrls = [];
  previewUrls.forEach((url) => URL.revokeObjectURL(url));
  previewUrls = [];
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
  }
  viewerIndex = 0;
  viewerZoom = 1;
  setRenderProgress(0, 1, false);
}

function setProgress(activeStep, doneSteps) {
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

function setupSegmentedControls() {
  const paperGroup = document.querySelector("[aria-label='Papirstørrelse']");
  const scaleGroup = document.querySelector("[aria-label='Målestok']");
  const orientationGroup = document.querySelector("[aria-label='Orientering']");

  paperGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    selections.paper = button.dataset.paper;
    setSegmentedActive(paperGroup, selections.paper, "paper");
  });

  scaleGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    selections.scale = Number(button.dataset.scale);
    setSegmentedActive(scaleGroup, String(selections.scale), "scale");
  });

  orientationGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    selections.orientation = button.dataset.orientation;
    setSegmentedActive(
      orientationGroup,
      String(selections.orientation),
      "orientation"
    );
  });
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

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "n/a";
  if (meters < 1000) {
    return `${meters.toFixed(0)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

function computeTrackLengthMeters(pointsLonLat) {
  const { transformer } = transformerForPoints(pointsLonLat);
  const { xs, ys } = projectPoints(pointsLonLat, transformer);
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
  return { transformer, epsg };
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

function computeAdaptivePages(xs, ys, options) {
  const overlap = clampOverlap(options.overlap);
  const distances = cumulativeDistances(xs, ys);
  const maxIndex = xs.length - 1;
  const metricsByOrientation = {
    portrait: pageGroundSpan(options.scale, options.dpi, options.paper, "portrait"),
    landscape: pageGroundSpan(options.scale, options.dpi, options.paper, "landscape"),
  };
  const windowFactor = 0.6;
  const minWindowPoints = 8;

  const pages = [];
  let startIndex = 0;
  while (startIndex <= maxIndex) {
    const candidates = ["portrait", "landscape"].map((orientation) => {
      const metrics = metricsByOrientation[orientation];
      const windowMeters = Math.max(metrics.wM, metrics.hM) * windowFactor;
      const centerEnd = windowEndIndex(
        distances,
        startIndex,
        windowMeters,
        minWindowPoints
      );
      const center = meanPoints(xs, ys, startIndex, centerEnd);
      let bbox = bboxFromCenter(center.x, center.y, metrics.wM, metrics.hM);
      if (!pointInBBox(xs[startIndex], ys[startIndex], bbox)) {
        bbox = bboxFromCenter(xs[startIndex], ys[startIndex], metrics.wM, metrics.hM);
      }
      const marginX = (metrics.wM * overlap) / 2;
      const marginY = (metrics.hM * overlap) / 2;
      const inner = shrinkBBox(bbox, marginX, marginY);
      const endIndex = lastIndexInside(inner, xs, ys, startIndex);
      const coveredDist = distances[endIndex] - distances[startIndex];
      return {
        orientation,
        bbox,
        wPx: metrics.wPx,
        hPx: metrics.hPx,
        wM: metrics.wM,
        hM: metrics.hM,
        endIndex,
        coveredDist,
      };
    });

    let best = candidates[0];
    if (
      candidates[1].endIndex > best.endIndex ||
      (candidates[1].endIndex === best.endIndex &&
        candidates[1].coveredDist > best.coveredDist)
    ) {
      best = candidates[1];
    }

    pages.push({
      bbox: best.bbox,
      orientation: best.orientation,
      wPx: best.wPx,
      hPx: best.hPx,
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

function drawTrackOnCanvas(ctx, xs, ys, bbox, width, height) {
  const [minx, miny, maxx, maxy] = bbox;
  const toPixel = (x, y) => {
    const px = ((x - minx) / (maxx - minx)) * width;
    const py = height - ((y - miny) / (maxy - miny)) * height;
    return [px, py];
  };

  ctx.strokeStyle = "#ff0000";
  ctx.lineWidth = TRACK_STROKE_PX;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();

  xs.forEach((x, idx) => {
    const y = ys[idx];
    const [px, py] = toPixel(x, y);
    if (idx === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  });

  ctx.stroke();
}

function formatScaleLabel(scale) {
  return String(scale).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function drawPageLabel(ctx, scale, epsgCode) {
  const utmZone = epsgCode - 25800;
  const label = `1:${formatScaleLabel(scale)} | UTM ${utmZone}`;
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

function createPreviewCard(index) {
  const previewCard = document.createElement("div");
  previewCard.className = "preview-card loading";

  const img = document.createElement("img");
  img.alt = "";
  img.src =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

  const label = document.createElement("p");
  label.textContent = `Side ${index + 1}`;

  previewCard.appendChild(img);
  previewCard.appendChild(label);
  previewCard.addEventListener("click", () => {
    if (!viewerUrls[index]) return;
    openViewer(index);
  });
  previewGrid.appendChild(previewCard);
  return { card: previewCard, img, label };
}

function resizeCanvasForPreview(canvas, maxWidth = 480) {
  const ratio = canvas.width / canvas.height;
  const targetWidth = Math.min(maxWidth, canvas.width);
  const targetHeight = Math.round(targetWidth / ratio);

  const previewCanvas = document.createElement("canvas");
  previewCanvas.width = targetWidth;
  previewCanvas.height = targetHeight;

  const ctx = previewCanvas.getContext("2d");
  ctx.drawImage(canvas, 0, 0, targetWidth, targetHeight);
  return previewCanvas;
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

async function renderGPXToPdf(file, options) {
  const pointsLonLat =
    options.pointsLonLat ?? parseGPX(await file.text());

  const { transformer, epsg } = transformerForPoints(pointsLonLat);
  const { xs, ys } = projectPoints(pointsLonLat, transformer);
  const bbox = bboxFromPoints(xs, ys);
  const modelDate = new Date();
  const declinationModel = options.showDeclination
    ? geomagnetism.model()
    : null;

  const overlap = clampOverlap(options.overlap);
  let pages = [];
  let statusLine = "";

  if (options.orientation === "auto") {
    pages = computeAdaptivePages(xs, ys, { ...options, overlap });
    statusLine = `Sider: ${pages.length} | ${options.paper} | 1:${options.scale} | overlap ${(overlap * 100).toFixed(1)}% | auto`;
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
    }));

    statusLine = `Sider: ${rows} rækker x ${cols} kolonner | ${options.paper} | 1:${options.scale} | overlap ${(overlap * 100).toFixed(1)}%`;
  }

  setStatus(statusLine);
  setRenderProgress(0, pages.length, false);

  const pdfDoc = await PDFDocument.create();
  const results = Array.from({ length: pages.length });
  let completed = 0;
  const progress = createRenderProgressUpdater(pages.length);
  viewerUrls = Array.from({ length: pages.length });
  const previewCards = pages.map((_, idx) => createPreviewCard(idx));

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

    const [baseImg, gridImg] = await Promise.all([baseImgPromise, gridImgPromise]);

    const canvas = document.createElement("canvas");
    canvas.width = wPx;
    canvas.height = hPx;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(baseImg, 0, 0, wPx, hPx);
    ctx.drawImage(gridImg, 0, 0, wPx, hPx);
    drawTrackOnCanvas(ctx, xs, ys, pageBBox, wPx, hPx);
    drawPageLabel(ctx, options.scale, epsg);
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

    const pngBlob = await canvasToBlob(canvas, "image/png");
    if (!pngBlob) {
      throw new Error("Kunne ikke oprette sidebillede.");
    }

    const previewCanvas = resizeCanvasForPreview(canvas);
    const previewBlob = await canvasToBlob(previewCanvas, "image/jpeg", 0.7);

    results[idx] = { pngBlob, previewBlob };
    const viewerUrl = URL.createObjectURL(pngBlob);
    viewerUrls[idx] = viewerUrl;

    if (previewBlob) {
      const previewUrl = URL.createObjectURL(previewBlob);
      previewUrls.push(previewUrl);
      previewCards[idx].img.src = previewUrl;
      previewCards[idx].img.alt = `Forhåndsvisning side ${idx + 1}`;
    }
    previewCards[idx].card.classList.remove("loading");
    completed += 1;
    progress.update(completed);
  });

  setStatus(`Renderer side 0 / ${pages.length}...`, true);
  setRenderProgress(0, pages.length, true);
  await runWithConcurrency(tasks, PAGE_RENDER_CONCURRENCY);
  progress.flush();
  setStatus("Samler PDF...", true);

  for (let idx = 0; idx < results.length; idx += 1) {
    const { pngBlob } = results[idx];
    const pngBytes = await pngBlob.arrayBuffer();
    const { orientation } = pages[idx];
    const [paperWmm, paperHmm] = paperDimensionsMm(options.paper, orientation);
    const pageWidthPt = (paperWmm / 25.4) * 72;
    const pageHeightPt = (paperHmm / 25.4) * 72;
    const embedded = await pdfDoc.embedPng(pngBytes);
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

const controlsForm = document.getElementById("controls");
const fileInput = document.getElementById("gpxFile");

function updateFileMeta(file, pointsLonLat) {
  const lengthMeters = computeTrackLengthMeters(pointsLonLat);
  fileMetaEl.innerHTML = `
    <div><strong>Fil:</strong> ${file.name}</div>
    <div><strong>Sporlængde:</strong> ${formatDistance(lengthMeters)}</div>
  `;
  fileMetaEl.classList.remove("hidden");
}

async function handleFileSelection(file) {
  if (!file) return;
  selectedFile = file;
  cachedPoints = null;
  hasGenerated = false;
  renderBtn.textContent = "Generér kort-PDF";
  previewSection.classList.add("hidden");
  setStatus("Læser GPX...");
  try {
    const text = await file.text();
    const points = parseGPX(text);
    cachedPoints = points;
    updateFileMeta(file, points);
    setProgress(2, [1]);
    setStatus("GPX indlæst. Vælg layout.");
    renderBtn.disabled = false;
    renderBtn.classList.add("ready");
    const nextFocus = document.querySelector("[data-paper=\"A4\"]");
    if (nextFocus) nextFocus.focus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Fejl: ${message}`);
    fileMetaEl.classList.add("hidden");
    renderBtn.disabled = true;
    renderBtn.classList.remove("ready");
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

function openViewer(index) {
  const url = viewerUrls[index];
  if (!url) return;
  viewerIndex = index;
  viewerImageEl.onload = () => {
    fitViewerImage();
  };
  viewerImageEl.src = url;
  viewerEl.classList.remove("hidden");
}

function closeViewer() {
  viewerEl.classList.add("hidden");
  viewerImageEl.src = "";
}

function showViewerPage(nextIndex) {
  if (!viewerUrls.length) return;
  const total = viewerUrls.length;
  const next = (nextIndex + total) % total;
  const url = viewerUrls[next];
  if (!url) return;
  viewerIndex = next;
  viewerImageEl.onload = () => {
    fitViewerImage();
  };
  viewerImageEl.src = url;
}

function applyViewerZoom() {
  const width = viewerBaseSize.width * viewerZoom;
  const height = viewerBaseSize.height * viewerZoom;
  viewerImageEl.style.width = `${width}px`;
  viewerImageEl.style.height = `${height}px`;
  viewerCaptionEl.textContent = `Side ${viewerIndex + 1} af ${viewerUrls.length} · ${Math.round(viewerZoom * 100)}%`;
}

function fitViewerImage() {
  const maxW = Math.min(window.innerWidth * 0.9, 980);
  const maxH = window.innerHeight * 0.8;
  const ratio = Math.min(
    maxW / viewerImageEl.naturalWidth,
    maxH / viewerImageEl.naturalHeight,
    1
  );
  viewerBaseSize = {
    width: viewerImageEl.naturalWidth * ratio,
    height: viewerImageEl.naturalHeight * ratio,
  };
  viewerZoom = 1;
  applyViewerZoom();
}

function setViewerZoom(nextZoom) {
  viewerZoom = Math.min(Math.max(nextZoom, 0.5), 3);
  applyViewerZoom();
}

viewerCloseEl.addEventListener("click", closeViewer);
viewerPrevEl.addEventListener("click", () => showViewerPage(viewerIndex - 1));
viewerNextEl.addEventListener("click", () => showViewerPage(viewerIndex + 1));
viewerZoomOutEl.addEventListener("click", () => setViewerZoom(viewerZoom - 0.2));
viewerZoomInEl.addEventListener("click", () => setViewerZoom(viewerZoom + 0.2));
viewerZoomResetEl.addEventListener("click", () => fitViewerImage());

viewerStageEl.addEventListener("wheel", (event) => {
  event.preventDefault();
  const delta = event.deltaY > 0 ? -0.1 : 0.1;
  setViewerZoom(viewerZoom + delta);
});

window.addEventListener("resize", () => {
  if (viewerEl.classList.contains("hidden")) return;
  fitViewerImage();
});

viewerEl.addEventListener("click", (event) => {
  if (event.target === viewerEl) {
    closeViewer();
  }
});

window.addEventListener("keydown", (event) => {
  if (viewerEl.classList.contains("hidden")) return;
  if (event.key === "Escape") closeViewer();
  if (event.key === "ArrowLeft") showViewerPage(viewerIndex - 1);
  if (event.key === "ArrowRight") showViewerPage(viewerIndex + 1);
  if (event.key === "+" || event.key === "=") setViewerZoom(viewerZoom + 0.2);
  if (event.key === "-") setViewerZoom(viewerZoom - 0.2);
});

controlsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearPreview();

  if (!selectedFile) {
    setStatus("Vælg en GPX-fil.");
    return;
  }

  if (!ALLOWED_SCALES.has(selections.scale)) {
    setStatus("Invalid scale selected.");
    return;
  }

  const overlapInput = Number(document.getElementById("overlap").value);
  const overlapValue = Number.isFinite(overlapInput)
    ? overlapInput / 100
    : DEFAULT_OVERLAP;
  const showDeclination = document.getElementById("declinationToggle").checked;
  renderBtn.disabled = true;
  renderBtn.classList.remove("ready");
  previewSection.classList.remove("hidden");
  previewSection.scrollIntoView({ behavior: "smooth", block: "start" });
  setProgress(3, [1, 2]);
  setStatus("Forbereder PDF...", true);

  try {
    const pdfBlob = await renderGPXToPdf(selectedFile, {
      scale: selections.scale,
      dpi: DEFAULT_DPI,
      paper: selections.paper,
      orientation: selections.orientation,
      overlap: overlapValue,
      layer: DEFAULT_LAYER,
      showDeclination,
      pointsLonLat: cachedPoints,
    });

    setDownload(pdfBlob);
    setProgress(3, [1, 2, 3]);
    setStatus("PDF klar.");
    setRenderProgress(0, 1, false);
    hasGenerated = true;
    renderBtn.textContent = "Generér kort-PDF igen";
    renderBtn.classList.add("ready");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const friendly = message.includes("Failed to fetch")
      ? "Kortfliser kunne ikke hentes (mulig CORS-fejl). Prøv igen eller brug et andet netværk."
      : message;
    setStatus(`Fejl: ${friendly}`);
    setProgress(2, [1]);
    setRenderProgress(0, 1, false);
  } finally {
    renderBtn.disabled = false;
    spinnerEl.classList.add("hidden");
  }
});

setProgress(1, []);
