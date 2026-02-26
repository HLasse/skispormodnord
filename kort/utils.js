// utils.js -- Pure utility functions (no state access, no DOM access)
// Zero dependencies -- imports NOTHING from other app modules.

// --- Color utilities ---

export function hexToRgb(hex) {
  const value = hex.replace("#", "");
  if (value.length !== 6) return null;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return { r, g, b };
}

export function rgbToHex({ r, g, b }) {
  const toHex = (v) => v.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function interpolateColor(startHex, endHex, t) {
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

// --- Bbox math ---

export function minMax(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

export function bboxFromPoints(xs, ys) {
  const { min: minx, max: maxx } = minMax(xs);
  const { min: miny, max: maxy } = minMax(ys);
  return [minx, miny, maxx, maxy];
}

export function bboxFromCenter(cx, cy, wM, hM) {
  return [cx - wM / 2, cy - hM / 2, cx + wM / 2, cy + hM / 2];
}

export function pointInBBox(x, y, bbox) {
  return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
}

export function segmentIntersectsBBox(x1, y1, x2, y2, bbox) {
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

export function shrinkBBox(bbox, marginX, marginY) {
  return [
    bbox[0] + marginX,
    bbox[1] + marginY,
    bbox[2] - marginX,
    bbox[3] - marginY,
  ];
}

// --- Clamping ---

export function clampOverlap(overlap) {
  return Math.max(0.0, Math.min(overlap, 0.9));
}

export function clampMargin(margin) {
  return Math.max(0.0, Math.min(margin, 0.45));
}

export function clampPdfQuality(quality) {
  return Math.max(0.1, Math.min(quality, 1));
}

// --- Formatting ---

export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "n/a";
  if (meters < 1000) {
    return `${meters.toFixed(0)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatScaleLabel(scale) {
  return String(scale).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function formatDeclination(deg) {
  if (!Number.isFinite(deg)) return "ukendt";
  const absVal = Math.abs(deg).toFixed(1);
  const hemi = deg >= 0 ? "\u00d8" : "V";
  return `${absVal}\u00b0 ${hemi}`;
}

export function formatConvergence(deg) {
  if (!Number.isFinite(deg)) return "ukendt";
  const absVal = Math.abs(deg).toFixed(1);
  const hemi = deg >= 0 ? "\u00d8" : "V";
  return `${absVal}\u00b0 ${hemi}`;
}

// --- Cache management ---

export function pruneCache(cache, limit) {
  while (cache.size > limit) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    cache.delete(firstKey);
  }
}

// --- Canvas helpers ---

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

export function getContext2d(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error(`Kunne ikke oprette 2D canvas context (${canvas.width}x${canvas.height}px). Prøv en mindre sidestørrelse.`);
  }
  return ctx;
}

// --- Async utility ---

export async function runWithConcurrency(taskFns, limit) {
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
