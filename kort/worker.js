// worker.js -- Web Worker for non-blocking GPX parsing
// Uses shared imports from gpx-parser.js and projection.js instead of duplicating code.

import { parseGPX } from './gpx-parser.js';
import { transformerForPoints, projectPoints } from './projection.js';

self.addEventListener("message", (event) => {
  const { id, xmlText } = event.data || {};
  try {
    const pointsLonLat = parseGPX(xmlText);
    const { transformer, epsg, utmDef } = transformerForPoints(pointsLonLat);
    const { xs, ys } = projectPoints(pointsLonLat, transformer);
    self.postMessage({
      id,
      ok: true,
      payload: { pointsLonLat, xs, ys, epsg, utmDef },
    });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
