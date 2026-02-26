// gpx-parser.js -- GPX XML parsing and track metrics
// Dependencies: projection.js
// parseGPX and trackLengthFromProjected have ZERO browser-specific deps (DOMParser is available in workers)

import { transformerForPoints, projectPoints } from "./projection.js";

/**
 * Parse GPX XML text and extract track points as [lon, lat] pairs.
 * Uses DOMParser which is available in both main thread and Web Workers.
 */
export function parseGPX(xmlText) {
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

/**
 * Compute total track length in meters from projected coordinates.
 */
export function trackLengthFromProjected(xs, ys) {
  let total = 0;
  for (let i = 1; i < xs.length; i += 1) {
    const dx = xs[i] - xs[i - 1];
    const dy = ys[i] - ys[i - 1];
    total += Math.hypot(dx, dy);
  }
  return total;
}

/**
 * Compute track length from WGS84 points, using projected coordinates if available.
 * @param {Array} pointsLonLat - Array of [lon, lat] pairs
 * @param {Object} [projectionState] - Optional existing projection state with xs, ys
 */
export function computeTrackLengthMeters(pointsLonLat, projectionState) {
  const xs = projectionState?.xs;
  const ys = projectionState?.ys;
  if (xs && ys && xs.length === ys.length) {
    return trackLengthFromProjected(xs, ys);
  }
  const { transformer } = transformerForPoints(pointsLonLat);
  const projected = projectPoints(pointsLonLat, transformer);
  return trackLengthFromProjected(projected.xs, projected.ys);
}

// --- Worker management (browser-only) ---

/**
 * Ensure the GPX parsing Web Worker is initialized.
 * Returns the worker instance or null if workers are not supported.
 * @param {Object} state - Application state containing gpxWorker, gpxWorkerPending
 * @param {Object} proj4Ref - proj4 reference for reconstructing transformers
 */
export function ensureGpxWorker(state, proj4Ref) {
  if (state.gpxWorker) return state.gpxWorker;
  if (typeof window === "undefined" || !window.Worker) return null;
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });
  worker.addEventListener("message", (event) => {
    const data = event.data || {};
    const { id, ok, payload, error } = data;
    const pending = state.gpxWorkerPending.get(id);
    if (!pending) return;
    state.gpxWorkerPending.delete(id);
    if (!ok) {
      pending.reject(new Error(error || "Worker-fejl ved GPX-parsing."));
      return;
    }
    try {
      const { pointsLonLat, xs, ys, epsg, utmDef } = payload;
      const transformer = proj4Ref("EPSG:4326", utmDef);
      pending.resolve({ pointsLonLat, xs, ys, epsg, transformer });
    } catch (err) {
      pending.reject(err);
    }
  });
  worker.addEventListener("error", () => {
    const error = new Error("Web worker fejlede.");
    state.gpxWorkerPending.forEach(({ reject }) => reject(error));
    state.gpxWorkerPending.clear();
  });
  state.gpxWorker = worker;
  return worker;
}

/**
 * Parse a large GPX file using a Web Worker for non-blocking parsing.
 * @param {File} file - The GPX file to parse
 * @param {Object} state - Application state containing worker state
 * @param {Object} proj4Ref - proj4 reference for reconstructing transformers
 */
export async function parseLargeGpxWithWorker(file, state, proj4Ref) {
  const worker = ensureGpxWorker(state, proj4Ref);
  if (!worker) {
    throw new Error("Web worker understoettes ikke i denne browser.");
  }
  const xmlText = await file.text();
  const id = (state.gpxWorkerRequestId += 1);
  const promise = new Promise((resolve, reject) => {
    state.gpxWorkerPending.set(id, { resolve, reject });
  });
  worker.postMessage({ id, xmlText });
  return promise;
}
