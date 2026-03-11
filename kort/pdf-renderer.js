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
import { PROVIDERS } from "./providers/config.js";
import {
  DK_FACILITY_ICON_SIZE_PX,
  getDkFacilityIconPath,
} from "./dk-facility-icons.js";

const DK_FRILUFTSDATA_WFS_URL = PROVIDERS.dk?.wms?.friluftsdataRekreativeRuter?.url || "";
const DK_FRILUFTSDATA_WFS_PAGE_SIZE = 5000;
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
const dkFacilityIconImageCache = new Map();

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

// --- DK friluftsdata WFS overlays ---

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
    if (!firstObject) throw error;
    return JSON.parse(firstObject);
  }
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

function toPixelFromLonLat(coord, forward, bbox, width, height) {
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const [minx, miny, maxx, maxy] = bbox;
  const [x, y] = forward.forward([coord[0], coord[1]]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const px = ((x - minx) / (maxx - minx)) * width;
  const py = height - ((y - miny) / (maxy - miny)) * height;
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  return [px, py];
}

function drawLineStringFromLonLat(ctx, coordinates, forward, bbox, width, height) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return;
  let started = false;
  ctx.beginPath();
  for (let i = 0; i < coordinates.length; i += 1) {
    const pixel = toPixelFromLonLat(coordinates[i], forward, bbox, width, height);
    if (!pixel) {
      started = false;
      continue;
    }
    const [px, py] = pixel;
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }
  }
  if (started) ctx.stroke();
}

function drawRouteGeometryFromLonLat(ctx, geometry, forward, bbox, width, height) {
  if (!geometry || typeof geometry !== "object") return;
  if (geometry.type === "LineString") {
    drawLineStringFromLonLat(ctx, geometry.coordinates, forward, bbox, width, height);
    return;
  }
  if (geometry.type === "MultiLineString") {
    (geometry.coordinates || []).forEach((line) => {
      drawLineStringFromLonLat(ctx, line, forward, bbox, width, height);
    });
    return;
  }
  if (geometry.type === "GeometryCollection") {
    (geometry.geometries || []).forEach((part) => {
      drawRouteGeometryFromLonLat(ctx, part, forward, bbox, width, height);
    });
  }
}

function drawPointFromLonLat(
  ctx,
  coord,
  forward,
  bbox,
  width,
  height,
  { radius = 4, iconImage = null, iconSize = DK_FACILITY_ICON_SIZE_PX } = {}
) {
  const pixel = toPixelFromLonLat(coord, forward, bbox, width, height);
  if (!pixel) return;
  const [px, py] = pixel;
  if (iconImage) {
    const halfSize = iconSize / 2;
    ctx.drawImage(iconImage, px - halfSize, py - halfSize, iconSize, iconSize);
    return;
  }
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawFacilityGeometryFromLonLat(
  ctx,
  geometry,
  forward,
  bbox,
  width,
  height,
  drawOptions = {}
) {
  if (!geometry || typeof geometry !== "object") return;
  if (geometry.type === "Point") {
    drawPointFromLonLat(ctx, geometry.coordinates, forward, bbox, width, height, drawOptions);
    return;
  }
  if (geometry.type === "MultiPoint") {
    (geometry.coordinates || []).forEach((point) => {
      drawPointFromLonLat(ctx, point, forward, bbox, width, height, drawOptions);
    });
    return;
  }
  if (geometry.type === "GeometryCollection") {
    (geometry.geometries || []).forEach((part) => {
      drawFacilityGeometryFromLonLat(ctx, part, forward, bbox, width, height, drawOptions);
    });
  }
}

function getDkFacilityIconImage(iconPath) {
  if (!iconPath) return Promise.resolve(null);
  const cached = dkFacilityIconImageCache.get(iconPath);
  if (cached) return cached;
  const pending = new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = iconPath;
  });
  dkFacilityIconImageCache.set(iconPath, pending);
  return pending;
}

function drawDkRouteFeaturesOnCanvas(ctx, features, bbox, width, height, epsgCode) {
  if (!features.length) return;
  const utmZone = epsgCode - 25800;
  const utmDef = `+proj=utm +zone=${utmZone} +ellps=GRS80 +units=m +no_defs`;
  const forward = proj4("EPSG:4326", utmDef);

  features.forEach((feature) => {
    const routeType = feature?.properties?.rute_ty;
    const color = DK_ROUTE_TYPE_COLORS[routeType] || "#d36b2d";
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    drawRouteGeometryFromLonLat(ctx, feature?.geometry, forward, bbox, width, height);
    ctx.restore();
  });
}

async function drawDkFacilityFeaturesOnCanvas(ctx, features, bbox, width, height, epsgCode) {
  if (!features.length) return;
  const utmZone = epsgCode - 25800;
  const utmDef = `+proj=utm +zone=${utmZone} +ellps=GRS80 +units=m +no_defs`;
  const forward = proj4("EPSG:4326", utmDef);

  const iconPaths = [...new Set(features
    .map((feature) => getDkFacilityIconPath(feature?.properties?.facil_ty))
    .filter(Boolean))];
  if (iconPaths.length) {
    await Promise.all(iconPaths.map((iconPath) => getDkFacilityIconImage(iconPath)));
  }

  for (const feature of features) {
    const facilityType = feature?.properties?.facil_ty;
    const iconPath = getDkFacilityIconPath(facilityType);
    const iconImage = iconPath ? await getDkFacilityIconImage(iconPath) : null;
    ctx.save();
    if (iconImage) {
      drawFacilityGeometryFromLonLat(
        ctx,
        feature?.geometry,
        forward,
        bbox,
        width,
        height,
        { iconImage, iconSize: DK_FACILITY_ICON_SIZE_PX }
      );
    } else {
      ctx.fillStyle = colorForDkFacilityType(facilityType);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1;
      drawFacilityGeometryFromLonLat(
        ctx,
        feature?.geometry,
        forward,
        bbox,
        width,
        height,
        { radius: 4 }
      );
    }
    ctx.restore();
  }
}

async function fetchFilteredDkWfsFeatures({
  typeName,
  propertyName,
  attributeName,
  selectedValues,
  localBBox,
  localEpsg,
  cache,
}) {
  if (!DK_FRILUFTSDATA_WFS_URL || !selectedValues.length) return [];

  const [minLon, minLat, maxLon, maxLat] = utmBboxToWgs84(localBBox, localEpsg);
  const south = Math.min(minLat, maxLat);
  const west = Math.min(minLon, maxLon);
  const north = Math.max(minLat, maxLat);
  const east = Math.max(minLon, maxLon);
  const bbox = [south, west, north, east, "EPSG:4326"].join(",");
  const valuesKey = [...new Set(selectedValues)].sort().join("|");
  const cacheKey = `${typeName}::${propertyName}::${attributeName}::${bbox}::${valuesKey}`;
  if (cache && cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const selectedSet = new Set(selectedValues);
  const allFeatures = [];
  let startIndex = 0;

  while (true) {
    const params = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: typeName,
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      count: String(DK_FRILUFTSDATA_WFS_PAGE_SIZE),
      startIndex: String(startIndex),
      bbox,
      propertyName,
    });
    const response = await fetch(`${DK_FRILUFTSDATA_WFS_URL}?${params.toString()}`, {
      mode: "cors",
    });
    if (!response.ok) {
      throw new Error(`DK WFS request failed (${response.status}) for ${typeName}.`);
    }
    const payloadText = await response.text();
    const payload = parseWfsFeatureCollection(payloadText);
    const sourceFeatures = payload.features || [];
    const filtered = sourceFeatures.filter((feature) => {
      const value = feature?.properties?.[attributeName];
      return selectedSet.has(value);
    });
    if (filtered.length) {
      allFeatures.push(...filtered);
    }

    if (sourceFeatures.length < DK_FRILUFTSDATA_WFS_PAGE_SIZE) {
      break;
    }
    startIndex += sourceFeatures.length;
  }

  if (cache) {
    cache.set(cacheKey, allFeatures);
  }
  return allFeatures;
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

function mmToPx(mm, dpi) {
  return (mm / 25.4) * dpi;
}

export function drawScaleRuler(ctx, bbox, dpi, width, height, greyscale = false) {
  const segmentMeters = 200;
  const segmentCount = 5;
  const gridSpacing = segmentMeters * segmentCount;
  const declinationBottomInsetPx = 12;
  if (
    !Array.isArray(bbox) ||
    bbox.length < 4 ||
    !Number.isFinite(dpi) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return;
  }
  const [minX, , maxX] = bbox;
  const bboxWidth = maxX - minX;
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(bboxWidth) ||
    bboxWidth <= 0
  ) {
    return;
  }

  const toPixelX = (x) => ((x - minX) / bboxWidth) * width;
  const rightGridX = Math.floor(maxX / gridSpacing) * gridSpacing;
  const leftGridX = rightGridX - gridSpacing;
  if (leftGridX < minX) return;

  const barStartPx = Math.round(toPixelX(leftGridX));
  const barEndPx = Math.round(toPixelX(rightGridX));
  const totalWidthPx = barEndPx - barStartPx;
  if (!Number.isFinite(totalWidthPx) || totalWidthPx <= 0) return;

  const segmentWidthPx = totalWidthPx / segmentCount;
  const fontSizePx = mmToPx(2.6, dpi);
  const barHeightPx = mmToPx(3.2, dpi);
  const tickHeightPx = mmToPx(1.9, dpi);
  const labelGapPx = mmToPx(1.4, dpi);
  const lineWidthPx = Math.max(1, mmToPx(0.3, dpi));
  const labelAngle = -Math.PI / 4;
  const labelAngleSin = Math.sin(Math.abs(labelAngle));
  const labels = ["0", "0.2", "0.4", "0.6", "0.8", "1"];
  const unitLabel = "km";

  ctx.save();
  ctx.font = `${fontSizePx}px IBM Plex Mono, monospace`;
  const labelMetrics = labels.map((label) => {
    const metrics = ctx.measureText(label);
    return {
      label,
      width: metrics.width,
      height: (
        (metrics.actualBoundingBoxAscent ?? fontSizePx * 0.8)
        + (metrics.actualBoundingBoxDescent ?? fontSizePx * 0.2)
      ),
    };
  });
  const maxRotatedLabelBottomPx = Math.max(
    ...labelMetrics.map(({ width: labelWidth, height: labelHeight }) => (
      labelAngleSin * (labelWidth + labelHeight)
    ))
  );
  const targetLabelBottomY = height - declinationBottomInsetPx;
  const labelOriginY = targetLabelBottomY - maxRotatedLabelBottomPx;
  const barY = labelOriginY - labelGapPx - tickHeightPx - barHeightPx;
  if (barY < 0) {
    ctx.restore();
    return;
  }

  const barX = barStartPx;
  const segmentColors = greyscale
    ? ["#ffffff", "#111111"]
    : ["#f6f2e8", "#1e1b16"];

  for (let index = 0; index < segmentCount; index += 1) {
    const x = barX + (index * segmentWidthPx);
    ctx.fillStyle = segmentColors[index % 2];
    ctx.fillRect(x, barY, segmentWidthPx, barHeightPx);
  }

  ctx.strokeStyle = greyscale ? "#111111" : "#2b261f";
  ctx.lineWidth = lineWidthPx;
  ctx.strokeRect(barX, barY, totalWidthPx, barHeightPx);

  ctx.beginPath();
  for (let index = 0; index <= segmentCount; index += 1) {
    const x = barX + (index * segmentWidthPx);
    ctx.moveTo(x, barY);
    ctx.lineTo(x, barY + barHeightPx + tickHeightPx);
  }
  ctx.stroke();

  ctx.fillStyle = greyscale ? "#111111" : "#1b1711";
  labels.forEach((label, index) => {
    const x = barX + (index * segmentWidthPx);
    ctx.save();
    ctx.translate(x, labelOriginY);
    ctx.rotate(labelAngle);
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(label, 0, 0);
    ctx.restore();
  });
  ctx.save();
  ctx.translate(barX + totalWidthPx, labelOriginY);
  ctx.rotate(labelAngle);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(unitLabel, mmToPx(1.2, dpi), 0);
  ctx.restore();
  ctx.restore();
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
  const dkWfsFeatureCache = new Map();
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

      const dkRouteTypes = localEpsg === 25832
        ? (options.dkFriluftsdataRouteTypes ?? [])
        : [];
      const dkFacilityTypes = localEpsg === 25832
        ? (options.dkFriluftsdataFacilityTypes ?? [])
        : [];
      const dkRouteFeaturesPromise = dkRouteTypes.length
        ? fetchFilteredDkWfsFeatures({
            typeName: "fkg:fkg.t_5802_fac_li",
            propertyName: "geometri,rute_ty",
            attributeName: "rute_ty",
            selectedValues: dkRouteTypes,
            localBBox,
            localEpsg,
            cache: dkWfsFeatureCache,
          }).catch((error) => {
            console.warn("DK route overlay failed for PDF:", error);
            return [];
          })
        : Promise.resolve([]);
      const dkFacilityFeaturesPromise = dkFacilityTypes.length
        ? fetchFilteredDkWfsFeatures({
            typeName: "fkg:fkg.t_5800_fac_pkt",
            propertyName: "geometri,facil_ty",
            attributeName: "facil_ty",
            selectedValues: dkFacilityTypes,
            localBBox,
            localEpsg,
            cache: dkWfsFeatureCache,
          }).catch((error) => {
            console.warn("DK facility overlay failed for PDF:", error);
            return [];
          })
        : Promise.resolve([]);

      const [
        [baseImg, ...overlayImgs],
        dkRouteFeatures,
        dkFacilityFeatures,
      ] = await Promise.all([
        Promise.all([
          baseImgPromise,
          ...heightOverlayPromises,
          ...weakIceOverlayPromises,
          ...overlayPromises,
        ]),
        dkRouteFeaturesPromise,
        dkFacilityFeaturesPromise,
      ]);
      const heightOverlayImgs = overlayImgs.slice(0, heightOverlayPromises.length).filter(Boolean);
      const weakIceOverlayImgs = overlayImgs.slice(
        heightOverlayPromises.length,
        heightOverlayPromises.length + weakIceOverlayPromises.length
      ).filter(Boolean);
      const routeOverlayImgs = overlayImgs.slice(
        heightOverlayPromises.length + weakIceOverlayPromises.length
      ).filter(Boolean);
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
      if (dkRouteFeatures.length) {
        ctx.save();
        ctx.globalAlpha = ROUTE_OVERLAY_OPACITY;
        drawDkRouteFeaturesOnCanvas(ctx, dkRouteFeatures, localBBox, wPx, hPx, localEpsg);
        ctx.restore();
      }
      if (dkFacilityFeatures.length) {
        await drawDkFacilityFeaturesOnCanvas(
          ctx,
          dkFacilityFeatures,
          localBBox,
          wPx,
          hPx,
          localEpsg
        );
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
      if (options.showScaleRuler) {
        drawScaleRuler(ctx, localBBox, options.dpi, wPx, hPx, options.greyscale);
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
