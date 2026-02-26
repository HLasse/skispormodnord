// pdf-renderer.js -- PDF generation pipeline
// Dependencies: pdf-lib (CDN), geomagnetism (CDN), tile-fetcher.js, layout.js,
//               projection.js, constants.js, utils.js, errors.js

import { PDFDocument } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";
import geomagnetism from "https://cdn.jsdelivr.net/npm/geomagnetism@0.2.0/+esm";

import {
  WMS_ROUTE_URL, WMS_HEIGHT_URL, WMS_WEAK_ICE_URL,
  WMS_ROUTE_LAYERS, WMS_WEAK_ICE_LAYERS,
  ROUTE_OVERLAY_OPACITY, DEFAULT_HEIGHT_OVERLAY_OPACITY,
  HEIGHT_OVERLAY_MASK_COLORS, HEIGHT_OVERLAY_SCALE_BY_MAP_SCALE,
  DEFAULT_TRACK_OPACITY, TRACK_STROKE_PX, DEFAULT_JPEG_QUALITY,
  PAGE_RENDER_CONCURRENCY, PAGE_RENDER_BATCH_SIZE,
  GREYSCALE_CONTRAST_FACTOR, GREYSCALE_GRID_STYLE, GREYSCALE_GRID_LABEL_STYLE,
  GREYSCALE_TRACK_HALO_EXTRA, GREYSCALE_LABEL_BG_OPACITY,
} from "./constants.js";
import {
  pointInBBox, segmentIntersectsBBox,
  clampPdfQuality,
  formatScaleLabel, formatDeclination,
  canvasToBlob, getContext2d, runWithConcurrency,
} from "./utils.js";
import {
  proj4,
  optimalNorwayEpsg, buildProjection,
  reprojectUtmBbox, utmBboxToWgs84,
  computeGridConvergenceDeg, paperDimensionsMm,
} from "./projection.js";
import { parseGPX } from "./gpx-parser.js";
import { computeLayoutPages } from "./layout.js";
import {
  fetchCompositeWmtsStitchedImage, fetchWmsImage,
  enableTileCache, clearTileCache,
} from "./tile-fetcher.js";

// --- Height mask ---

export function getActiveHeightMaskColors() {
  return [...HEIGHT_OVERLAY_MASK_COLORS];
}

export function getHeightMaskKey() {
  return "11";
}

export function matchesMaskedHeightColorFromList(r, g, b, colors) {
  return colors.some((color) => (
    Math.abs(r - color.r) <= 18 &&
    Math.abs(g - color.g) <= 18 &&
    Math.abs(b - color.b) <= 18
  ));
}

export function applyHeightMaskToContext(ctx, width, height, colors) {
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

// --- Overlay scaling ---

export function heightOverlayScaleForMapScale(scale) {
  if (HEIGHT_OVERLAY_SCALE_BY_MAP_SCALE[scale]) {
    return HEIGHT_OVERLAY_SCALE_BY_MAP_SCALE[scale];
  }
  return 0.45;
}

// --- Greyscale conversion ---

/**
 * Convert canvas pixels to greyscale in-place using BT.601 luminance weights.
 * Uses getImageData/putImageData for Safari compatibility (ctx.filter not supported).
 */
export function applyGreyscale(ctx, width, height) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const grey = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = grey;
    data[i + 1] = grey;
    data[i + 2] = grey;
    // Alpha unchanged
  }
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Apply contrast adjustment to canvas pixels in-place.
 * Linear contrast: output = factor * input + 128 * (1 - factor).
 * factor > 1 increases contrast, factor < 1 decreases.
 */
export function applyContrast(ctx, width, height, factor) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const intercept = 128 * (1 - factor);
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = Math.max(0, Math.min(255, factor * data[i] + intercept));
    data[i + 1] = Math.max(0, Math.min(255, factor * data[i + 1] + intercept));
    data[i + 2] = Math.max(0, Math.min(255, factor * data[i + 2] + intercept));
  }
  ctx.putImageData(imageData, 0, 0);
}

// --- Grid drawing ---

export function drawUtmGrid(ctx, bbox, wPx, hPx, spacing = 1000, styleOverrides = null) {
  const [minX, minY, maxX, maxY] = bbox;
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;

  const toPixelX = (x) => ((x - minX) / bboxW) * wPx;
  const toPixelY = (y) => ((maxY - y) / bboxH) * hPx;

  // Draw cyan grid lines.
  // Use lineWidth 2 and opacity 0.75 so the lines remain detectable (max
  // channel >=150) even over dark Scandinavian forest backgrounds.
  ctx.save();
  ctx.strokeStyle = styleOverrides?.strokeStyle ?? "rgba(0, 210, 210, 0.75)";
  ctx.lineWidth = styleOverrides?.lineWidth ?? 2;

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
  ctx.fillStyle = styleOverrides?.labelFillStyle ?? "#333";
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

  // Easting labels rotated 90 deg CCW along vertical grid lines, centered on middle horizontal line
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

// --- Track drawing ---

export function drawTrackOnCanvas(ctx, xs, ys, bbox, width, height, color, opacity, trackWidth, trackBreakIndices = [0]) {
  const [minx, miny, maxx, maxy] = bbox;
  const breakSet = new Set((trackBreakIndices ?? []).filter((idx) => idx > 0 && idx < xs.length));
  const toPixel = (x, y) => {
    const px = ((x - minx) / (maxx - minx)) * width;
    const py = height - ((y - miny) / (maxy - miny)) * height;
    return [px, py];
  };

  const drawMask = new Uint8Array(xs.length);
  for (let i = 0; i < xs.length; i += 1) {
    if (pointInBBox(xs[i], ys[i], bbox)) {
      drawMask[i] = 1;
      if (i > 0 && !breakSet.has(i)) drawMask[i - 1] = 1;
      if (i + 1 < xs.length && !breakSet.has(i + 1)) drawMask[i + 1] = 1;
    }
  }
  // Mark segments that cross the bbox even when neither endpoint is inside
  for (let i = 0; i < xs.length - 1; i += 1) {
    if (breakSet.has(i + 1)) continue;
    if (drawMask[i] && drawMask[i + 1]) continue;
    if (segmentIntersectsBBox(xs[i], ys[i], xs[i + 1], ys[i + 1], bbox)) {
      drawMask[i] = 1;
      drawMask[i + 1] = 1;
    }
  }

  ctx.beginPath();
  let started = false;
  for (let i = 0; i < xs.length; i += 1) {
    if (breakSet.has(i)) {
      started = false;
    }
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

// --- Labels ---

export function drawPageLabel(ctx, pageNumber, scale, epsgCode, greyscale = false) {
  const utmZone = epsgCode - 25800;
  const label = `${pageNumber} | 1:${formatScaleLabel(scale)} | UTM ${utmZone}`;
  const pad = 12;
  ctx.font = "27px IBM Plex Mono, monospace";
  const metrics = ctx.measureText(label);
  const textW = metrics.width;
  const textH = 32;
  ctx.fillStyle = greyscale
    ? `rgba(255, 255, 255, ${GREYSCALE_LABEL_BG_OPACITY})`
    : "rgba(255, 255, 255, 0.6)";
  ctx.fillRect(pad, pad, textW + pad * 2, textH + pad);
  ctx.fillStyle = greyscale ? "#000" : "#111";
  ctx.fillText(label, pad + 9, pad + textH);
}

export function drawDeclinationLabel(ctx, declinationTrue, convergence, width, height, greyscale = false) {
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
  ctx.fillStyle = greyscale
    ? `rgba(255, 255, 255, ${GREYSCALE_LABEL_BG_OPACITY})`
    : "rgba(255, 255, 255, 0.6)";
  ctx.fillRect(pad, boxY, textW + pad * 2, boxH);
  ctx.fillStyle = greyscale ? "#000" : "#111";
  lines.forEach((line, idx) => {
    ctx.fillText(line, pad + 9, boxY + lineHeight * (idx + 1));
  });
}

// --- Progress ---

export function createRenderProgressUpdater(total, setStatusFn, setRenderProgressFn) {
  let lastUpdate = 0;
  let pending = null;

  const update = (completed) => {
    pending = completed;
    const now = performance.now();
    if (now - lastUpdate < 100) return;
    lastUpdate = now;
    setStatusFn(`Renderer side ${pending} / ${total}...`, true);
    setRenderProgressFn(pending, total, true);
    pending = null;
  };

  const flush = () => {
    if (pending === null) return;
    setStatusFn(`Renderer side ${pending} / ${total}...`, true);
    setRenderProgressFn(pending, total, true);
    pending = null;
  };

  return { update, flush };
}

// --- Main PDF pipeline ---

/**
 * Render GPX track data to a multi-page topographic PDF.
 *
 * @param {File|null} file - GPX file (used as fallback if options.pointsLonLat missing)
 * @param {Object} options - Rendering options
 * @param {Object} [options.callbacks] - UI callback functions
 * @param {Function} [options.callbacks.setStatus] - (message, isLoading) => void
 * @param {Function} [options.callbacks.setRenderProgress] - (completed, total, visible) => void
 * @returns {Promise<Blob>} PDF blob
 */
export async function renderGPXToPdf(file, options) {
  const setStatusFn = options.callbacks?.setStatus ?? (() => {});
  const setRenderProgressFn = options.callbacks?.setRenderProgress ?? (() => {});

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
    setStatusFn(statusLine);
  }
  setRenderProgressFn(0, pages.length, false);

  // Enable tile cache to avoid redundant fetches for overlapping pages
  enableTileCache();

  const pdfDoc = await PDFDocument.create();
  let completed = 0;
  const progress = createRenderProgressUpdater(pages.length, setStatusFn, setRenderProgressFn);

  try {
  setStatusFn(`Renderer side 0 / ${pages.length}...`, true);
  setRenderProgressFn(0, pages.length, true);

  // --- Batched render+embed pipeline ---
  // Process pages in batches of PAGE_RENDER_BATCH_SIZE (12). Each batch
  // renders concurrently (up to PAGE_RENDER_CONCURRENCY workers), embeds
  // into the PDF immediately, then disposes blobs before the next batch.
  // This bounds peak blob memory to batchSize * blobSize instead of
  // totalPages * blobSize.
  for (let batchStart = 0; batchStart < pages.length; batchStart += PAGE_RENDER_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + PAGE_RENDER_BATCH_SIZE, pages.length);
    const batchPages = pages.slice(batchStart, batchEnd);
    const batchResults = new Array(batchPages.length);

    // Render batch concurrently
    const tasks = batchPages.map((pageInfo, localIdx) => async () => {
      const globalIdx = batchStart + localIdx;
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
      // Draw grid BEFORE overlays only in color mode
      if (!options.greyscale) {
        drawUtmGrid(ctx, localBBox, wPx, hPx);
      }
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
      // Greyscale: convert all composited layers to monochrome, then draw grid on top
      if (options.greyscale) {
        applyGreyscale(ctx, wPx, hPx);
        applyContrast(ctx, wPx, hPx, GREYSCALE_CONTRAST_FACTOR);
        drawUtmGrid(ctx, localBBox, wPx, hPx, 1000, {
          ...GREYSCALE_GRID_STYLE,
          labelFillStyle: GREYSCALE_GRID_LABEL_STYLE.fillStyle,
        });
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
      if (options.greyscale) {
        // White halo for contrast against all map backgrounds
        drawTrackOnCanvas(
          ctx, drawXs, drawYs, localBBox, wPx, hPx,
          "#ffffff", 1.0,
          (options.trackWidth ?? TRACK_STROKE_PX) + GREYSCALE_TRACK_HALO_EXTRA,
          options.trackBreakIndices
        );
        // Dark track on top
        drawTrackOnCanvas(
          ctx, drawXs, drawYs, localBBox, wPx, hPx,
          "#1a1a1a", 1.0,
          options.trackWidth ?? TRACK_STROKE_PX,
          options.trackBreakIndices
        );
      } else {
        drawTrackOnCanvas(
          ctx,
          drawXs,
          drawYs,
          localBBox,
          wPx,
          hPx,
          options.trackColor ?? "#ff0000",
          options.trackOpacity,
          options.trackWidth,
          options.trackBreakIndices
        );
      }
      drawPageLabel(ctx, globalIdx + 1, options.scale, localEpsg, options.greyscale);
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
        drawDeclinationLabel(ctx, info.decl, convergence, wPx, hPx, options.greyscale);
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

      batchResults[localIdx] = { imageBlob, imageFormat };
      completed += 1;
      progress.update(completed);
    });

    await runWithConcurrency(tasks, PAGE_RENDER_CONCURRENCY);
    progress.flush();

    // Embed batch immediately into PDF (in page order), then dispose blobs
    setStatusFn("Samler PDF...", true);
    for (let i = 0; i < batchResults.length; i++) {
      const { imageBlob, imageFormat } = batchResults[i];
      const imageBytes = await imageBlob.arrayBuffer();
      const { orientation } = pages[batchStart + i];
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

      // Release page blob so GC can reclaim memory incrementally
      batchResults[i] = null;
    }

    // Yield to event loop so progress UI paints between batches
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // Release tile cache before final PDF save -- tiles are no longer needed
  // once all pages are rendered and embedded, and this reduces peak memory
  // during serialization.
  clearTileCache();

  const pdfBytes = await pdfDoc.save();
  return new Blob([pdfBytes], { type: "application/pdf" });

  } finally {
    // Safety net: ensure tile cache is always released, even on errors.
    // No-op if already cleared above (cache is already null).
    clearTileCache();
  }
}
