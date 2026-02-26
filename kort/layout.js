// layout.js -- Page layout computation engine
// Pure computation: takes parameters, returns results. NO state dependency.
// Dependencies: constants.js (paper sizes, overlap ranges), utils.js (bbox math),
//               projection.js (pageGroundSpan, paperDimensionsMm)

import { DEFAULT_OVERLAP, DEFAULT_MARGIN, PAGE_FILL_COLOR } from "./constants.js";
import {
  bboxFromPoints, bboxFromCenter, pointInBBox, shrinkBBox,
  clampOverlap, clampMargin,
} from "./utils.js";
import { pageGroundSpan, buildProjection } from "./projection.js";

// --- Color assignment ---

export function computePageColors(count) {
  return Array.from({ length: count }, () => PAGE_FILL_COLOR);
}

// --- Track analysis ---

export function densifyTrack(xs, ys, maxStepMeters) {
  if (xs.length < 2) return { xs: xs.slice(), ys: ys.slice() };
  const denseX = [];
  const denseY = [];
  for (let i = 0; i < xs.length - 1; i += 1) {
    const x1 = xs[i];
    const y1 = ys[i];
    const x2 = xs[i + 1];
    const y2 = ys[i + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / maxStepMeters));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      denseX.push(x1 + dx * t);
      denseY.push(y1 + dy * t);
    }
  }
  denseX.push(xs[xs.length - 1]);
  denseY.push(ys[ys.length - 1]);
  return { xs: denseX, ys: denseY };
}

export function cumulativeDistances(xs, ys) {
  const distances = Array.from({ length: xs.length }, () => 0);
  for (let i = 1; i < xs.length; i += 1) {
    const dx = xs[i] - xs[i - 1];
    const dy = ys[i] - ys[i - 1];
    distances[i] = distances[i - 1] + Math.hypot(dx, dy);
  }
  return distances;
}

export function windowEndIndex(distances, startIndex, windowMeters, minPoints) {
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

export function meanPoints(xs, ys, startIndex, endIndex) {
  const count = endIndex - startIndex + 1;
  let sumX = 0;
  let sumY = 0;
  for (let i = startIndex; i <= endIndex; i += 1) {
    sumX += xs[i];
    sumY += ys[i];
  }
  return { x: sumX / count, y: sumY / count };
}

// --- Candidate selection ---

export function candidateCenterIndices(startIndex, endIndex) {
  const maxCandidates = 10;
  const span = endIndex - startIndex;
  const step = Math.max(1, Math.floor(span / maxCandidates));
  const indices = [];
  for (let i = startIndex; i <= endIndex; i += step) {
    indices.push(i);
  }
  if (indices[indices.length - 1] !== endIndex) {
    indices.push(endIndex);
  }
  return indices;
}

export function unitVector(dx, dy) {
  const mag = Math.hypot(dx, dy);
  if (!mag) return { x: 1, y: 0 };
  return { x: dx / mag, y: dy / mag };
}

export function lastIndexInside(bbox, xs, ys, startIndex) {
  let last = startIndex;
  for (let i = startIndex; i < xs.length; i += 1) {
    if (!pointInBBox(xs[i], ys[i], bbox)) break;
    last = i;
  }
  return last;
}

// --- Grid layout ---

export function computePageGrid(bbox, pageWM, pageHM, overlap) {
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

export function pageTrackIndex(pageBBox, xs, ys) {
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

export function recenterPageBBox(pageBBox, xs, ys, pageWM, pageHM) {
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

export function alignBBoxesToGrid(originalBBoxes, desiredBBoxes, rows, cols, pageWM, pageHM) {
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

// --- Adaptive layout ---

export function computeAdaptivePages(xs, ys, options) {
  if (options.disableDp) {
    return computeAdaptivePagesGreedy(xs, ys, options);
  }
  const densifyStep = 80;
  const densified = densifyTrack(xs, ys, densifyStep);
  const denseXs = densified.xs;
  const denseYs = densified.ys;
  const overlap = clampOverlap(options.overlap);
  const margin = clampMargin(options.margin ?? DEFAULT_MARGIN);
  const innerFraction = Math.max(overlap, margin);
  const distances = cumulativeDistances(denseXs, denseYs);
  const maxIndex = denseXs.length - 1;
  const metricsByOrientation = {
    portrait: pageGroundSpan(options.scale, options.dpi, options.paper, "portrait"),
    landscape: pageGroundSpan(options.scale, options.dpi, options.paper, "landscape"),
  };
  const windowFactor = 0.9;
  const minWindowPoints = 8;
  const slideRangeFactor = 0.2;
  const slideSteps = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1];

  const buildCandidates = (startIdx, orientation) => {
    const metrics = metricsByOrientation[orientation];
    const windowMeters = Math.max(metrics.wM, metrics.hM) * windowFactor;
    const centerEnd = windowEndIndex(
      distances,
      startIdx,
      windowMeters,
      minWindowPoints
    );
    const centerIndices = candidateCenterIndices(startIdx, centerEnd);
    const dir = unitVector(
      denseXs[centerEnd] - denseXs[startIdx],
      denseYs[centerEnd] - denseYs[startIdx]
    );
    const slideRange = Math.max(metrics.wM, metrics.hM) * slideRangeFactor;
    const marginX = (metrics.wM * innerFraction) / 2;
    const marginY = (metrics.hM * innerFraction) / 2;
    const candidates = [];

    centerIndices.forEach((centerIdx) => {
      const baseCenter = meanPoints(denseXs, denseYs, startIdx, centerIdx);
      slideSteps.forEach((step) => {
        const center = {
          x: baseCenter.x + dir.x * slideRange * step,
          y: baseCenter.y + dir.y * slideRange * step,
        };
        const bbox = bboxFromCenter(center.x, center.y, metrics.wM, metrics.hM);
        const inner = shrinkBBox(bbox, marginX, marginY);
        if (!pointInBBox(denseXs[startIdx], denseYs[startIdx], inner)) return;
        const endIndex = lastIndexInside(inner, denseXs, denseYs, startIdx);
        const coveredDist = distances[endIndex] - distances[startIdx];
        const segmentCenter = meanPoints(denseXs, denseYs, startIdx, endIndex);
        const offsetX = (segmentCenter.x - center.x) / (metrics.wM / 2);
        const offsetY = (segmentCenter.y - center.y) / (metrics.hM / 2);
        const centerPenalty = Math.hypot(offsetX, offsetY);
        candidates.push({
          orientation,
          bbox,
          wPx: metrics.wPx,
          hPx: metrics.hPx,
          wM: metrics.wM,
          hM: metrics.hM,
          endIndex,
          coveredDist,
          centerPenalty,
          startIndex: startIdx,
          isTerminal: endIndex >= maxIndex,
        });
      });
    });

    if (!candidates.length) {
      const fallbackCenter = { x: xs[startIdx], y: ys[startIdx] };
      const bbox = bboxFromCenter(
        fallbackCenter.x,
        fallbackCenter.y,
        metrics.wM,
        metrics.hM
      );
      const inner = shrinkBBox(bbox, marginX, marginY);
      const endIndex = lastIndexInside(inner, denseXs, denseYs, startIdx);
      candidates.push({
        orientation,
        bbox,
        wPx: metrics.wPx,
        hPx: metrics.hPx,
        wM: metrics.wM,
        hM: metrics.hM,
        endIndex,
        coveredDist: distances[endIndex] - distances[startIdx],
        centerPenalty: 0,
        startIndex: startIdx,
        isTerminal: endIndex >= maxIndex,
      });
    }

    return candidates;
  };

  const pickBest = (candidates) => {
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (
        candidate.totalPages < best.totalPages ||
        (candidate.totalPages === best.totalPages &&
          (candidate.totalCoveredDist > best.totalCoveredDist ||
            (candidate.totalCoveredDist === best.totalCoveredDist &&
              candidate.totalCenterPenalty < best.totalCenterPenalty)))
      ) {
        best = candidate;
      }
    }
    return best;
  };

  const memo = new Map();

  const bestFrom = (startIdx) => {
    if (startIdx > maxIndex) {
      return { totalPages: 0, totalCoveredDist: 0, totalCenterPenalty: 0, seq: [] };
    }
    if (memo.has(startIdx)) return memo.get(startIdx);
    const candidates = [
      ...buildCandidates(startIdx, "portrait"),
      ...buildCandidates(startIdx, "landscape"),
    ];

    const scored = candidates.map((candidate) => {
      let remainder = { totalPages: 0, totalCoveredDist: 0, totalCenterPenalty: 0, seq: [] };
      if (!candidate.isTerminal) {
        const nextIndex = Math.min(
          Math.max(candidate.endIndex, startIdx + 1),
          maxIndex
        );
        remainder = bestFrom(nextIndex);
      }
      return {
        ...candidate,
        totalPages: 1 + remainder.totalPages,
        totalCoveredDist: candidate.coveredDist + remainder.totalCoveredDist,
        totalCenterPenalty: candidate.centerPenalty + remainder.totalCenterPenalty,
        seq: [candidate, ...remainder.seq],
      };
    });

    const best = pickBest(scored);
    memo.set(startIdx, best);
    return best;
  };

  const bestPath = bestFrom(0);
  const pages = bestPath.seq.map((entry) => ({
    bbox: entry.bbox,
    orientation: entry.orientation,
    wPx: entry.wPx,
    hPx: entry.hPx,
    wM: entry.wM,
    hM: entry.hM,
  }));

  for (let i = 0; i < denseXs.length; i += 1) {
    const x = denseXs[i];
    const y = denseYs[i];
    let covered = false;
    for (let p = 0; p < pages.length; p += 1) {
      if (pointInBBox(x, y, pages[p].bbox)) {
        covered = true;
        break;
      }
    }
    if (!covered) {
      return computeAdaptivePages(xs, ys, { ...options, disableDp: true });
    }
  }

  return pages;
}

export function computeAdaptivePagesGreedy(xs, ys, options) {
  const overlap = clampOverlap(options.overlap);
  const margin = clampMargin(options.margin ?? DEFAULT_MARGIN);
  const innerFraction = Math.max(overlap, margin);
  const distances = cumulativeDistances(xs, ys);
  const maxIndex = xs.length - 1;
  const metricsByOrientation = {
    portrait: pageGroundSpan(options.scale, options.dpi, options.paper, "portrait"),
    landscape: pageGroundSpan(options.scale, options.dpi, options.paper, "landscape"),
  };
  const windowFactor = 0.9;
  const minWindowPoints = 8;
  const slideRangeFactor = 0.2;
  const slideSteps = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1];

  const buildCandidates = (startIdx, orientation) => {
    const metrics = metricsByOrientation[orientation];
    const windowMeters = Math.max(metrics.wM, metrics.hM) * windowFactor;
    const centerEnd = windowEndIndex(
      distances,
      startIdx,
      windowMeters,
      minWindowPoints
    );
    const centerIndices = candidateCenterIndices(startIdx, centerEnd);
    const dir = unitVector(xs[centerEnd] - xs[startIdx], ys[centerEnd] - ys[startIdx]);
    const slideRange = Math.max(metrics.wM, metrics.hM) * slideRangeFactor;
    const marginX = (metrics.wM * innerFraction) / 2;
    const marginY = (metrics.hM * innerFraction) / 2;
    const candidates = [];

    centerIndices.forEach((centerIdx) => {
      const baseCenter = meanPoints(xs, ys, startIdx, centerIdx);
      slideSteps.forEach((step) => {
        const center = {
          x: baseCenter.x + dir.x * slideRange * step,
          y: baseCenter.y + dir.y * slideRange * step,
        };
        const bbox = bboxFromCenter(center.x, center.y, metrics.wM, metrics.hM);
        const inner = shrinkBBox(bbox, marginX, marginY);
        if (!pointInBBox(xs[startIdx], ys[startIdx], inner)) return;
        const endIndex = lastIndexInside(inner, xs, ys, startIdx);
        const coveredDist = distances[endIndex] - distances[startIdx];
        const segmentCenter = meanPoints(xs, ys, startIdx, endIndex);
        const offsetX = (segmentCenter.x - center.x) / (metrics.wM / 2);
        const offsetY = (segmentCenter.y - center.y) / (metrics.hM / 2);
        const centerPenalty = Math.hypot(offsetX, offsetY);
        candidates.push({
          orientation,
          bbox,
          wPx: metrics.wPx,
          hPx: metrics.hPx,
          wM: metrics.wM,
          hM: metrics.hM,
          endIndex,
          coveredDist,
          centerPenalty,
        });
      });
    });

    if (!candidates.length) {
      const fallbackCenter = { x: xs[startIdx], y: ys[startIdx] };
      const bbox = bboxFromCenter(
        fallbackCenter.x,
        fallbackCenter.y,
        metrics.wM,
        metrics.hM
      );
      const inner = shrinkBBox(bbox, marginX, marginY);
      const endIndex = lastIndexInside(inner, xs, ys, startIdx);
      candidates.push({
        orientation,
        bbox,
        wPx: metrics.wPx,
        hPx: metrics.hPx,
        wM: metrics.wM,
        hM: metrics.hM,
        endIndex,
        coveredDist: distances[endIndex] - distances[startIdx],
        centerPenalty: 0,
      });
    }

    return candidates;
  };

  const pickBest = (candidates) => {
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (
        candidate.endIndex > best.endIndex ||
        (candidate.endIndex === best.endIndex &&
          (candidate.coveredDist > best.coveredDist ||
            (candidate.coveredDist === best.coveredDist &&
              candidate.centerPenalty < best.centerPenalty)))
      ) {
        best = candidate;
      }
    }
    return best;
  };

  const pages = [];
  let startIndex = 0;
  while (startIndex <= maxIndex) {
    const candidates = [
      ...buildCandidates(startIndex, "portrait"),
      ...buildCandidates(startIndex, "landscape"),
    ];
    const best = pickBest(candidates);
    pages.push({
      bbox: best.bbox,
      orientation: best.orientation,
      wPx: best.wPx,
      hPx: best.hPx,
      wM: best.wM,
      hM: best.hM,
    });
    if (best.endIndex >= maxIndex) break;
    const nextIndex = best.endIndex > startIndex ? best.endIndex : startIndex + 1;
    startIndex = Math.min(nextIndex, maxIndex);
  }

  return pages;
}

// --- Orchestrator ---

export function computeLayoutPages(pointsLonLat, options) {
  const projection = options.projection ?? null;
  let transformer;
  let epsg;
  let xs;
  let ys;
  if (projection?.transformer && projection?.epsg && projection?.xs && projection?.ys) {
    ({ transformer, epsg, xs, ys } = projection);
  } else {
    const fresh = buildProjection(pointsLonLat);
    ({ transformer, epsg, xs, ys } = fresh);
  }
  const bbox = bboxFromPoints(xs, ys);
  const overlap = clampOverlap(options.overlap);
  let pages = [];
  let statusLine = "";

  if (options.orientation === "auto") {
    const margin = clampMargin(options.margin ?? DEFAULT_MARGIN);
    pages = computeAdaptivePages(xs, ys, { ...options, overlap, margin });
    statusLine = `Sider: ${pages.length} | ${options.paper} | 1:${options.scale} | overlap ${(overlap * 100).toFixed(1)}% | margin ${(margin * 100).toFixed(0)}% | auto`;
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
      wM,
      hM,
    }));

    statusLine = `Sider: ${rows} rækker x ${cols} kolonner | ${options.paper} | 1:${options.scale} | overlap ${(overlap * 100).toFixed(1)}%`;
  }

  return { pages, xs, ys, epsg, transformer, statusLine };
}
