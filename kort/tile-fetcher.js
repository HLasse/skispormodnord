// tile-fetcher.js -- WMTS tile fetching, caching, stitching, cross-border compositing, WMS fetching
// Dependencies: constants.js, providers/, projection.js, errors.js, utils.js

import {
  CURRENT_PROVIDER,
  WMTS_CAPABILITIES_URL, WMTS_MAX_TILES_PER_PAGE, WMTS_MAX_TILES_BORDER_PAGE,
  WMTS_TILE_SIZE, TILE_BITMAP_CACHE_MAX_ENTRIES,
} from "./constants.js";
import { PROVIDERS, getLeafletTileUrl, getMaxZoom, getMinMaxZoom } from "./providers/config.js";
import { getTileProviders, getPrimaryProvider } from "./providers/borders.js";
import {
  proj4,
  optimalNorwayEpsg, reprojectUtmBbox, utmBboxToWgs84, utmBboxCornersToWgs84,
  computeAffineTransform, tileMatrixSetIdFromEpsg,
} from "./projection.js";
import { AppError, classifyTileError, withRetry } from "./errors.js";
import { getContext2d } from "./utils.js";

// --- WMTS capabilities cache ---
const wmtsConfigCache = new Map();

// --- Session-scoped tile cache ---
// Caches Promise<ImageBitmap> so concurrent requests for the same tile
// reuse a single in-flight fetch. Cleared after each PDF render.
let _tileBitmapCache = null;

const TILE_FETCH_CONCURRENCY = 8;
const TILE_SECOND_PASS_CONCURRENCY = 3;
const TILE_DRAW_RETRY_ATTEMPTS = 1;
const TILE_SECOND_PASS_RETRY_ATTEMPTS = 1;
const TILE_RETRY_BASE_DELAY_MS = 350;
const TILE_RETRY_MAX_DELAY_MS = 5000;

export function enableTileCache() {
  _tileBitmapCache = new Map();
}

export function clearTileCache() {
  if (_tileBitmapCache) {
    // Dispose all cached ImageBitmaps to release GPU/bitmap memory
    for (const promise of _tileBitmapCache.values()) {
      promise.then(bitmap => {
        try { bitmap.close(); } catch (_) { /* already closed or invalid */ }
      }).catch(() => { /* fetch failed, nothing to close */ });
    }
  }
  _tileBitmapCache = null;
}

function removeTileCacheEntry(url) {
  if (!_tileBitmapCache) return;
  _tileBitmapCache.delete(url);
}

function evictOldestTileCacheEntry() {
  if (!_tileBitmapCache || _tileBitmapCache.size === 0) return;
  const oldestKey = _tileBitmapCache.keys().next().value;
  if (oldestKey === undefined) return;
  removeTileCacheEntry(oldestKey);
}

// --- WMS fetching ---

export async function fetchWmsImage({ baseUrl, layer, styles, format, transparent }, bbox, widthPx, heightPx, epsgCode) {
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
    throw new AppError(
      "WMS-forespørgsel fejlede.",
      { technical: `WMS ${response.status} for ${url}`, recoverable: true, retryable: true }
    );
  }

  const blob = await response.blob();
  return createImageBitmap(blob);
}

// --- WMTS parsing ---

export function textContentOrNull(el, selector) {
  const node = el.querySelector(selector);
  return node ? node.textContent : null;
}

export function parseCorner(str) {
  // "x y" (space-separated)
  if (!str) return null;
  const parts = str.trim().split(/\s+/).map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0], parts[1]];
}

export async function getWmtsTileMatrixSet(tileMatrixSetId) {
  if (wmtsConfigCache.has(tileMatrixSetId)) return wmtsConfigCache.get(tileMatrixSetId);

  let res;
  try {
    res = await withRetry(() => fetch(WMTS_CAPABILITIES_URL, { mode: "cors" }), { maxRetries: 2, delay: 1000 });
  } catch (err) {
    throw new AppError(
      "WMTS GetCapabilities kunne ikke hentes. Tjek din internetforbindelse.",
      { technical: `WMTS capabilities fetch failed: ${err?.message || err}`, recoverable: false }
    );
  }
  if (!res.ok) {
    throw new AppError(
      "WMTS GetCapabilities fejlede.",
      { technical: `WMTS capabilities ${res.status}`, recoverable: false }
    );
  }
  const xmlText = await res.text();
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");

  // Find TileMatrixSet by identifier
  const sets = Array.from(doc.querySelectorAll("TileMatrixSet"));
  const setEl = sets.find((s) => textContentOrNull(s, "Identifier") === tileMatrixSetId);
  if (!setEl) {
    throw new AppError(
      `WMTS TileMatrixSet ikke fundet: ${tileMatrixSetId}`,
      { technical: `TileMatrixSet "${tileMatrixSetId}" not in capabilities`, recoverable: false }
    );
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
    throw new AppError(
      `Ingen TileMatrix fundet for ${tileMatrixSetId}.`,
      { technical: `No TileMatrix entries in set "${tileMatrixSetId}"`, recoverable: false }
    );
  }

  // Sort by increasing scaleDenominator (more zoomed in = smaller scaleDen)
  matrices.sort((a, b) => a.scaleDenominator - b.scaleDenominator);

  const config = { tileMatrixSetId, matrices };
  wmtsConfigCache.set(tileMatrixSetId, config);
  return config;
}

export function metersPerPixelFromScaleDenominator(scaleDenominator) {
  // OGC WMTS uses "pixel size" = 0.00028m for scale denominator.
  // resolution (m/px) = scaleDenominator * 0.00028
  return scaleDenominator * 0.00028;
}

export function chooseBestMatrix(matrices, desiredMPerPx) {
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

export function tileRangeForBBox(bbox, matrix) {
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

// --- Tile fetching ---

export async function fetchTileBitmap(url) {
  if (_tileBitmapCache) {
    const cached = _tileBitmapCache.get(url);
    if (cached) return cached;
    // Evict oldest entry if cache is at capacity (LRU by Map insertion order)
    if (_tileBitmapCache.size >= TILE_BITMAP_CACHE_MAX_ENTRIES) {
      evictOldestTileCacheEntry();
      // Do NOT close evicted bitmaps immediately. They may still be in use by
      // in-flight drawImage operations, which can throw "image source is detached".
      // Evicted bitmaps are left for GC; cache-held bitmaps are closed during
      // clearTileCache() at render teardown.
    }
    const promise = _fetchTileBitmapUncached(url);
    _tileBitmapCache.set(url, promise);
    // If the fetch fails, remove from cache so it can be retried
    promise.catch(() => removeTileCacheEntry(url));
    return promise;
  }
  return _fetchTileBitmapUncached(url);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const absoluteTs = Date.parse(value);
  if (!Number.isFinite(absoluteTs)) {
    return null;
  }
  return Math.max(0, absoluteTs - Date.now());
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableNetworkError(err) {
  const name = String(err?.name || "").toLowerCase();
  if (name === "aborterror" || name === "networkerror") return true;
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("failed to fetch")
    || msg.includes("networkerror")
    || msg.includes("load failed")
    || msg.includes("timeout");
}

function isDetachedImageError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  const name = String(err?.name || "").toLowerCase();
  return name === "invalidstateerror"
    || msg.includes("image source is detached")
    || (msg.includes("drawimage") && msg.includes("detached"));
}

function isRetryableTileError(err) {
  const status = Number(err?.status);
  if (Number.isFinite(status)) return isRetryableHttpStatus(status);
  return isRetryableNetworkError(err);
}

function retryDelayMs(attempt, err) {
  const retryAfter = Number(err?.retryAfterMs);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(TILE_RETRY_MAX_DELAY_MS, Math.max(50, Math.round(retryAfter)));
  }
  const exp = TILE_RETRY_BASE_DELAY_MS * (2 ** attempt);
  const jitter = Math.random() * TILE_RETRY_BASE_DELAY_MS;
  return Math.min(TILE_RETRY_MAX_DELAY_MS, Math.round(exp + jitter));
}

function invalidateTileCacheEntry(url) {
  removeTileCacheEntry(url);
}

export async function _fetchTileBitmapUncached(url, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const r = await fetch(url, { mode: "cors" });
      if (!r.ok) {
        const error = new Error(`WMTS tile fejlede (${r.status}).`);
        error.status = r.status;
        const retryAfterMs = parseRetryAfterMs(r.headers.get("Retry-After"));
        if (retryAfterMs !== null) {
          error.retryAfterMs = retryAfterMs;
        }
        throw error;
      }
      const b = await r.blob();
      return createImageBitmap(b);
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !isRetryableTileError(err)) break;
      await sleep(retryDelayMs(attempt, err));
    }
  }
  throw lastError;
}

async function drawTileWithRetry(url, drawFn, { maxRetries = TILE_DRAW_RETRY_ATTEMPTS } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const bmp = await fetchTileBitmap(url);
      drawFn(bmp);
      return;
    } catch (err) {
      lastError = err;
      const retryable = isRetryableTileError(err) || isDetachedImageError(err);
      if (attempt >= maxRetries || !retryable) break;
      invalidateTileCacheEntry(url);
      await sleep(retryDelayMs(attempt, err));
    }
  }
  throw lastError;
}

async function runWorkers(items, concurrency, workerFn) {
  if (!items.length) return;
  let cursor = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      await workerFn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function fetchAndDrawTilesWithRecovery(tasks, {
  logPrefix,
  drawTile,
  firstPassRetries = TILE_DRAW_RETRY_ATTEMPTS,
  secondPassRetries = TILE_SECOND_PASS_RETRY_ATTEMPTS,
  concurrency = TILE_FETCH_CONCURRENCY,
  retryConcurrency = TILE_SECOND_PASS_CONCURRENCY,
} = {}) {
  const firstPassFailures = [];

  await runWorkers(tasks, concurrency, async (task) => {
    try {
      await drawTileWithRetry(task.url, (bmp) => drawTile(task, bmp), { maxRetries: firstPassRetries });
    } catch (err) {
      firstPassFailures.push({ task, error: err });
      console.warn(`${logPrefix} First-pass tile failure ${firstPassFailures.length}/${tasks.length}: ${task.url}`, err?.message || err);
    }
  });

  if (firstPassFailures.length > 0) {
    await runWorkers(firstPassFailures, retryConcurrency, async (failure) => {
      try {
        await drawTileWithRetry(
          failure.task.url,
          (bmp) => drawTile(failure.task, bmp),
          { maxRetries: secondPassRetries }
        );
        failure.recovered = true;
      } catch (err) {
        failure.error = err;
      }
    });
  }

  const finalFailures = firstPassFailures.filter((failure) => !failure.recovered);
  const recoveredCount = firstPassFailures.length - finalFailures.length;
  return {
    firstPassFailureCount: firstPassFailures.length,
    recoveredCount,
    finalFailures,
  };
}

// --- Provider URL ---

export function getProviderTileUrl(providerId, layerId, tileMatrixSetId, matrixId, row, col) {
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

// --- Compositing orchestrator ---

/**
 * Fetch composite WMTS stitched image from multiple providers
 * Detects which countries the bbox spans and composites appropriately
 */
export async function fetchCompositeWmtsStitchedImage(bbox, widthPx, heightPx, epsgCode, layerId) {
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
    throw new AppError(
      "Ingen kortfliser kunne hentes fra nogen udbyder.",
      { technical: "All provider tile fetches failed", recoverable: false }
    );
  }

  // Composite the canvases with border clipping
  return compositeProviderImages(canvases, providers, bbox, epsgCode, widthPx, heightPx);
}

// --- Norway path ---

/**
 * Fetch stitched image for a specific provider
 */
export async function fetchWmtsStitchedImageForProvider(providerId, bbox, widthPx, heightPx, epsgCode, layerId, maxZoomLimit) {
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

  const {
    firstPassFailureCount,
    recoveredCount,
    finalFailures,
  } = await fetchAndDrawTilesWithRecovery(tasks, {
    logPrefix: `[PDF Norway matrix ${matrix.id}]`,
    drawTile: (tileTask, bmp) => {
      mctx.drawImage(
        bmp,
        tileTask.x * matrix.tileWidth,
        tileTask.y * matrix.tileHeight,
        matrix.tileWidth,
        matrix.tileHeight
      );
    },
  });

  let failedCount = 0;
  for (const failure of finalFailures) {
    failedCount += 1;
    const t = failure.task;
    console.warn(`[PDF Norway] Tile failed after retries ${failedCount}/${tasks.length}: ${t.url}`, failure.error?.message || failure.error);
    mctx.fillStyle = "#e0e0e0";
    mctx.fillRect(t.x * matrix.tileWidth, t.y * matrix.tileHeight, matrix.tileWidth, matrix.tileHeight);
  }

  if (recoveredCount > 0) {
    console.info(`[PDF Norway] Recovered ${recoveredCount}/${firstPassFailureCount} initially failed tiles for matrix ${matrix.id}`);
  }
  if (failedCount > 0) {
    console.error(`[PDF Norway] ${failedCount}/${tasks.length} tiles failed for matrix ${matrix.id}`);
  }
  if (failedCount > tasks.length * 0.2) {
    const tileError = classifyTileError(
      new Error(`Norway tile failures for matrix ${matrix.id}`),
      failedCount,
      tasks.length
    );
    throw tileError;
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

    console.debug(`[PDF Norway] Zone mismatch affine (${epsgCode}->${tileEpsg}):`, xf);
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

// --- SE/FI path ---

/**
 * Fetch stitched image using WebMercator tiles for providers that don't have UTM
 * This converts UTM bbox to WebMercator, fetches tiles, and reprojects
 */
export async function fetchWebMercatorStitchedImageForProvider(providerId, bbox, widthPx, heightPx, epsgCode, layerId, maxZoomLimit, maxTiles) {
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

  const {
    firstPassFailureCount,
    recoveredCount,
    finalFailures,
  } = await fetchAndDrawTilesWithRecovery(tasks, {
    logPrefix: `[PDF ${providerId} z${zoom}]`,
    drawTile: (tileTask, bmp) => {
      mctx.drawImage(bmp, tileTask.x * tileSize, tileTask.y * tileSize, tileSize, tileSize);
    },
  });

  let failedCount = 0;
  for (const failure of finalFailures) {
    failedCount += 1;
    const t = failure.task;
    console.warn(`[PDF ${providerId}] Tile failed after retries ${failedCount}/${tasks.length}: ${t.url}`, failure.error?.message || failure.error);
    mctx.fillStyle = "#e0e0e0";
    mctx.fillRect(t.x * tileSize, t.y * tileSize, tileSize, tileSize);
  }

  if (recoveredCount > 0) {
    console.info(`[PDF ${providerId}] Recovered ${recoveredCount}/${firstPassFailureCount} initially failed tiles at zoom ${zoom}`);
  }
  if (failedCount > 0) {
    console.error(`[PDF ${providerId}] ${failedCount}/${tasks.length} tiles failed`);
  }
  if (failedCount > tasks.length * 0.2) {
    const tileError = classifyTileError(
      new Error(`${providerId} tile failures`),
      failedCount,
      tasks.length
    );
    throw tileError;
  }

  // Calculate the WGS84 bounds of the mosaic
  const mosaicMinLon = minTileX / n * 360 - 180;
  const mosaicMaxLon = (maxTileX + 1) / n * 360 - 180;
  const mosaicMaxLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * minTileY / n))) * 180 / Math.PI;
  const mosaicMinLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (maxTileY + 1) / n))) * 180 / Math.PI;

  // Convert WGS84 lon/lat to mosaic pixel coordinates.
  // X is linear in longitude; Y uses Mercator math: y = ln(tan(pi/4 + lat/2))
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

  // Compute affine: mosaic pixels -> output canvas pixels
  // TL -> (0,0), TR -> (widthPx,0), BL -> (0,heightPx)
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

// --- Compositing ---

/**
 * Composite multiple provider canvases with border clipping
 */
export async function compositeProviderImages(canvases, providers, bbox, epsgCode, widthPx, heightPx) {
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
export function applyClipForUtmBbox(ctx, polygon, bbox, epsgCode, widthPx, heightPx) {
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
