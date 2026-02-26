// projection.js -- All proj4 usage, UTM zone inference, coordinate transforms, validation
// Dependencies: proj4 (CDN), constants.js, errors.js
// ZERO browser dependencies (no document, no window, no DOM) -- safe for worker.js

import proj4 from "https://cdn.jsdelivr.net/npm/proj4@2.9.0/+esm";
import { PAPER_SIZES_MM, CURRENT_PROVIDER } from "./constants.js";
import { PROVIDERS } from "./providers/config.js";
import { AppError } from "./errors.js";

// --- Validation ---

/**
 * Validate an EPSG code is a valid ETRS89/UTM zone (25801-25860).
 * Throws AppError with descriptive Danish message if invalid.
 */
export function validateEpsgCode(code) {
  const zone = code - 25800;
  if (!Number.isFinite(zone) || zone < 1 || zone > 60) {
    throw new AppError(
      `Ugyldig UTM-zone: ${zone}. Kun zoner 1-60 understoettes.`,
      { technical: `EPSG:${code} => zone ${zone}`, recoverable: false }
    );
  }
  return code;
}

// --- Zone inference ---

export function utmZoneFromLon(lon) {
  return Math.floor((lon + 180) / 6) + 1;
}

/**
 * Determine the best UTM EPSG code for Norway based on longitude.
 * Kartverket provides tile matrix sets for zones 32, 33, and 35 only.
 */
export function optimalNorwayEpsg(lon) {
  if (lon < 12) return 25832;
  if (lon < 24) return 25833;
  return 25835;
}

export function inferLocalEtrs89Utm(pointsLonLat) {
  const lons = pointsLonLat.map((p) => p[0]);
  const meanLon = lons.reduce((a, b) => a + b, 0) / lons.length;
  // If in Norway/Nordic longitude range (4 deg -- 31.5 deg E), snap to Kartverket's
  // available zones (32/33/35) so tiles and grid share the same UTM zone.
  if (meanLon >= 4 && meanLon <= 31.5) {
    return optimalNorwayEpsg(meanLon);
  }
  const zone = utmZoneFromLon(meanLon);
  return 25800 + zone;
}

// --- Core transforms ---

export function transformerForPoints(pointsLonLat) {
  if (!pointsLonLat || !pointsLonLat.length) {
    throw new AppError(
      "Ingen punkter at projicere.",
      { technical: "transformerForPoints called with empty array", recoverable: false }
    );
  }
  const epsg = inferLocalEtrs89Utm(pointsLonLat);
  validateEpsgCode(epsg);
  const zone = epsg - 25800;
  const utmDef = `+proj=utm +zone=${zone} +ellps=GRS80 +units=m +no_defs`;
  const transformer = proj4("EPSG:4326", utmDef);
  return { transformer, epsg, utmDef };
}

export function projectPoints(pointsLonLat, transformer) {
  const xs = [];
  const ys = [];
  for (const [lon, lat] of pointsLonLat) {
    const [x, y] = transformer.forward([lon, lat]);
    xs.push(x);
    ys.push(y);
  }
  return { xs, ys };
}

export function buildProjection(pointsLonLat) {
  const { transformer, epsg } = transformerForPoints(pointsLonLat);
  const { xs, ys } = projectPoints(pointsLonLat, transformer);
  return { pointsLonLat, transformer, epsg, xs, ys };
}

// --- Bbox reprojection ---

/**
 * Reproject a UTM bbox from one zone to another.
 */
export function reprojectUtmBbox(bbox, fromEpsg, toEpsg) {
  if (fromEpsg === toEpsg) return bbox;
  validateEpsgCode(fromEpsg);
  validateEpsgCode(toEpsg);
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

/**
 * Convert UTM bbox to WGS84 bbox for border detection.
 * Converts all 4 corners to handle rotation between UTM and WGS84.
 */
export function utmBboxToWgs84(bbox, epsgCode) {
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
export function utmBboxCornersToWgs84(bbox, epsgCode) {
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

// --- Affine math ---

/**
 * Compute a 2D affine transform from 3 point correspondences.
 * Given source points (src0, src1, src2) mapping to destination points (dst0, dst1, dst2),
 * returns {a, b, c, d, e, f} suitable for ctx.setTransform(a, b, c, d, e, f).
 */
export function computeAffineTransform(src0, src1, src2, dst0, dst1, dst2) {
  const [sx0, sy0] = src0;
  const [sx1, sy1] = src1;
  const [sx2, sy2] = src2;
  const [dx0, dy0] = dst0;
  const [dx1, dy1] = dst1;
  const [dx2, dy2] = dst2;

  const det = sx0 * (sy1 - sy2) - sx1 * (sy0 - sy2) + sx2 * (sy0 - sy1);
  const invDet = 1 / det;

  const a = ((dx0 * (sy1 - sy2) - dx1 * (sy0 - sy2) + dx2 * (sy0 - sy1)) * invDet);
  const c = ((dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) * invDet);
  const e = ((dx0 * (sx1 * sy2 - sx2 * sy1) + dx1 * (sx2 * sy0 - sx0 * sy2) + dx2 * (sx0 * sy1 - sx1 * sy0)) * invDet);

  const b = ((dy0 * (sy1 - sy2) - dy1 * (sy0 - sy2) + dy2 * (sy0 - sy1)) * invDet);
  const d = ((dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) * invDet);
  const f = ((dy0 * (sx1 * sy2 - sx2 * sy1) + dy1 * (sx2 * sy0 - sx0 * sy2) + dy2 * (sx0 * sy1 - sx1 * sy0)) * invDet);

  return { a, b, c, d, e, f };
}

// --- Grid convergence ---

export function computeGridConvergenceDeg(lonDeg, latDeg, epsgCode) {
  const zone = epsgCode ? (epsgCode - 25800) : utmZoneFromLon(lonDeg);
  const lon0 = zone * 6 - 183;
  const deltaLon = (lonDeg - lon0) * (Math.PI / 180);
  const lat = latDeg * (Math.PI / 180);
  const gamma = Math.atan(Math.tan(deltaLon) * Math.sin(lat));
  return (gamma * 180) / Math.PI;
}

// --- Matrix set lookup ---

export function tileMatrixSetIdFromEpsg(epsgCode, providerId = CURRENT_PROVIDER) {
  const provider = PROVIDERS[providerId];
  if (provider?.wmts?.utmMatrixSets?.[epsgCode]) {
    return provider.wmts.utmMatrixSets[epsgCode];
  }
  return provider?.wmts?.matrixSet || "webmercator";
}

// --- Scale/paper geometry ---

export function groundResolutionMPerPx(scale, dpi) {
  return (scale * 0.0254) / dpi;
}

export function paperDimensionsMm(paper, orientation) {
  if (!(paper in PAPER_SIZES_MM)) {
    throw new AppError(
      `Ikke understoettet papirstoerrelse: ${paper}`,
      { technical: `Paper size "${paper}" not in PAPER_SIZES_MM`, recoverable: false }
    );
  }
  let [wMm, hMm] = PAPER_SIZES_MM[paper];
  if (orientation === "landscape") {
    [wMm, hMm] = [hMm, wMm];
  }
  return [wMm, hMm];
}

export function paperPixels(paper, dpi, orientation) {
  const [wMm, hMm] = paperDimensionsMm(paper, orientation);
  const wPx = Math.round((wMm / 25.4) * dpi);
  const hPx = Math.round((hMm / 25.4) * dpi);
  return [wPx, hPx];
}

export function pageGroundSpan(scale, dpi, paper, orientation) {
  const [wPx, hPx] = paperPixels(paper, dpi, orientation);
  const res = groundResolutionMPerPx(scale, dpi);
  const wM = wPx * res;
  const hM = hPx * res;
  return { wPx, hPx, wM, hM };
}

// Re-export proj4 for modules that need raw proj4 access (e.g., worker reconstruction)
export { proj4 };
