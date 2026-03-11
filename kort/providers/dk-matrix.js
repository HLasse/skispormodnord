/**
 * Static WMTS matrix metadata for Datafordeler Skærmkort (View1).
 *
 * Source references:
 * - Skærmkortet Klassisk WMTS docs (matrix set: View1)
 * - Legacy technical metadata (origin/resolutions) carried into modern endpoint
 *
 * We keep this local so DK support does not depend on fetching GetCapabilities
 * during runtime.
 */

export const DK_WMTS_MATRIX_SET = "View1";
export const DK_WMTS_TILE_SIZE = 256;
export const DK_WMTS_EPSG = 25832;
export const DK_WMTS_TOP_LEFT = [120000, 6500000];
export const DK_WMTS_MAX_LEVEL = 13;
const DK_BASE_RESOLUTION_M_PER_PX = 1638.4;

/**
 * Build matrices sorted by ascending scale denominator (fine -> coarse),
 * matching the order expected by chooseBestMatrix + "step coarser" logic.
 */
export function getDkWmtsMatrices() {
  const matrices = [];
  for (let level = 0; level <= DK_WMTS_MAX_LEVEL; level += 1) {
    const resolution = DK_BASE_RESOLUTION_M_PER_PX / (2 ** level);
    matrices.push({
      id: String(level),
      level,
      scaleDenominator: resolution / 0.00028,
      topLeftCorner: DK_WMTS_TOP_LEFT,
      tileWidth: DK_WMTS_TILE_SIZE,
      tileHeight: DK_WMTS_TILE_SIZE,
      resolution,
    });
  }
  matrices.sort((a, b) => a.scaleDenominator - b.scaleDenominator);
  return matrices;
}
