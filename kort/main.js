import proj4 from "https://cdn.jsdelivr.net/npm/proj4@2.9.0/+esm";
import { PDFDocument } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";

const WMS_BASE_URL = "https://wms.geonorge.no/skwms1/wms.topo";
const WMS_GRID_URL = "https://wms.geonorge.no/skwms1/wms.rutenett";
const DEFAULT_LAYER = "topo";
const GRID_LAYER = "1km_rutelinje";
const DEFAULT_DPI = 300;
const DEFAULT_OVERLAP = 0.05;
const TRACK_STROKE_PX = 4;
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

const selections = {
  paper: "A4",
  scale: 50000,
};

let selectedFile = null;
let cachedPoints = null;
let hasGenerated = false;

function setStatus(message, isLoading = false) {
  statusTextEl.textContent = message;
  spinnerEl.classList.toggle("hidden", !isLoading);
}

function setDownload(blob) {
  const url = URL.createObjectURL(blob);
  downloadLink.href = url;
  downloadLink.download = "trail_map.pdf";
  downloadLink.classList.remove("disabled");
}

function clearPreview() {
  previewGrid.innerHTML = "";
  downloadLink.classList.add("disabled");
  downloadLink.removeAttribute("href");
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
  const paperGroup = document.querySelector("[aria-label='Paper size']");
  const scaleGroup = document.querySelector("[aria-label='Scale']");

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
    throw new Error("No track points found in GPX file.");
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

function bboxFromPoints(xs, ys) {
  const minx = Math.min(...xs);
  const maxx = Math.max(...xs);
  const miny = Math.min(...ys);
  const maxy = Math.max(...ys);
  return [minx, miny, maxx, maxy];
}

function groundResolutionMPerPx(scale, dpi) {
  return (scale * 0.0254) / dpi;
}

function paperPixels(paper, dpi) {
  if (!(paper in PAPER_SIZES_MM)) {
    throw new Error(`Unsupported paper size: ${paper}`);
  }
  const [wMm, hMm] = PAPER_SIZES_MM[paper];
  const wPx = Math.round((wMm / 25.4) * dpi);
  const hPx = Math.round((hMm / 25.4) * dpi);
  return [wPx, hPx];
}

function pageGroundSpan(scale, dpi, paper) {
  const [wPx, hPx] = paperPixels(paper, dpi);
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
  const ptsIn = [];
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i];
    const y = ys[i];
    if (minx <= x && x <= maxx && miny <= y && y <= maxy) {
      ptsIn.push([x, y]);
    }
  }
  if (!ptsIn.length) {
    return pageBBox;
  }

  const xsIn = ptsIn.map((p) => p[0]);
  const ysIn = ptsIn.map((p) => p[1]);
  const cx = (Math.min(...xsIn) + Math.max(...xsIn)) / 2.0;
  const cy = (Math.min(...ysIn) + Math.max(...ysIn)) / 2.0;

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
    throw new Error(`WMS request failed (${response.status}).`);
  }

  const blob = await response.blob();
  return createImageBitmap(blob);
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

function addPreview(canvas, index) {
  const previewCard = document.createElement("div");
  previewCard.className = "preview-card";

  const img = document.createElement("img");
  img.src = canvas.toDataURL("image/jpeg", 0.7);

  const label = document.createElement("p");
  label.textContent = `Page ${index + 1}`;

  previewCard.appendChild(img);
  previewCard.appendChild(label);
  previewGrid.appendChild(previewCard);
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

async function renderGPXToPdf(file, options) {
  const pointsLonLat =
    options.pointsLonLat ?? parseGPX(await file.text());

  const { transformer, epsg } = transformerForPoints(pointsLonLat);
  const { xs, ys } = projectPoints(pointsLonLat, transformer);
  const bbox = bboxFromPoints(xs, ys);

  const { wPx, hPx, wM, hM } = pageGroundSpan(
    options.scale,
    options.dpi,
    options.paper
  );

  const { bboxes, rows, cols } = computePageGrid(
    bbox,
    wM,
    hM,
    options.overlap
  );

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
  indexed.sort((a, b) => a[1] - b[1]);

  const sortedBBoxes = indexed.map((entry) => entry[0]);

  setStatus(
    `Pages: ${rows} rows x ${cols} cols | ${options.paper} | 1:${options.scale} | overlap ${(options.overlap * 100).toFixed(1)}%`
  );

  const pdfDoc = await PDFDocument.create();
  const [paperWmm, paperHmm] = PAPER_SIZES_MM[options.paper];
  const pageWidthPt = (paperWmm / 25.4) * 72;
  const pageHeightPt = (paperHmm / 25.4) * 72;

  for (let idx = 0; idx < sortedBBoxes.length; idx += 1) {
    setStatus(`Rendering page ${idx + 1} / ${sortedBBoxes.length}...`, true);
    const pageBBox = sortedBBoxes[idx];

    const baseImg = await fetchWmsImage(
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

    const gridImg = await fetchWmsImage(
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

    const canvas = document.createElement("canvas");
    canvas.width = wPx;
    canvas.height = hPx;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(baseImg, 0, 0, wPx, hPx);
    ctx.drawImage(gridImg, 0, 0, wPx, hPx);
    drawTrackOnCanvas(ctx, xs, ys, pageBBox, wPx, hPx);

    const previewCanvas = resizeCanvasForPreview(canvas);
    addPreview(previewCanvas, idx);

    const pngBlob = await new Promise((resolve) =>
      canvas.toBlob((blob) => resolve(blob), "image/png")
    );

    if (!pngBlob) {
      throw new Error("Failed to create page image.");
    }

    const pngBytes = await pngBlob.arrayBuffer();
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
    <div><strong>File:</strong> ${file.name}</div>
    <div><strong>Track length:</strong> ${formatDistance(lengthMeters)}</div>
  `;
  fileMetaEl.classList.remove("hidden");
}

async function handleFileSelection(file) {
  if (!file) return;
  selectedFile = file;
  cachedPoints = null;
  hasGenerated = false;
  renderBtn.textContent = "Generate map PDF";
  setStatus("Reading GPX...");
  try {
    const text = await file.text();
    const points = parseGPX(text);
    cachedPoints = points;
    updateFileMeta(file, points);
    setProgress(2, [1]);
    setStatus("GPX loaded. Choose layout.");
    renderBtn.disabled = false;
    const nextFocus = document.querySelector("[data-paper=\"A4\"]");
    if (nextFocus) nextFocus.focus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Error: ${message}`);
    fileMetaEl.classList.add("hidden");
    renderBtn.disabled = true;
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

controlsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearPreview();

  if (!selectedFile) {
    setStatus("Please select a GPX file.");
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
  renderBtn.disabled = true;
  const previewSection = document.getElementById("preview");
  if (previewSection) {
    previewSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  setProgress(3, [1, 2]);
  setStatus("Preparing PDF...", true);

  try {
    const pdfBlob = await renderGPXToPdf(selectedFile, {
      scale: selections.scale,
      dpi: DEFAULT_DPI,
      paper: selections.paper,
      overlap: overlapValue,
      layer: DEFAULT_LAYER,
      pointsLonLat: cachedPoints,
    });

    setDownload(pdfBlob);
    setProgress(3, [1, 2, 3]);
    setStatus("PDF ready.");
    hasGenerated = true;
    renderBtn.textContent = "Re-generate map PDF";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const friendly = message.includes("Failed to fetch")
      ? "Map tiles could not be fetched (possible CORS issue). Try again or use another network."
      : message;
    setStatus(`Error: ${friendly}`);
    setProgress(2, [1]);
  } finally {
    renderBtn.disabled = false;
    spinnerEl.classList.add("hidden");
  }
});

setProgress(1, []);
