/**
 * Border detection and polygon clipping for multi-country tile compositing.
 *
 * Uses simplified country boundary polygons to:
 * 1. Detect which countries a tile/bbox intersects
 * 2. Generate clip polygons for compositing tiles at borders
 *
 * The GeoJSON files are loaded dynamically to avoid bundling issues.
 */

// Cache for loaded border polygons
let borderPolygons = null;
let loadingPromise = null;

/**
 * Load border polygons from GeoJSON files
 * @returns {Promise<{no: object, se: object, fi: object}>}
 */
async function loadBorderPolygons() {
  if (borderPolygons) {
    return borderPolygons;
  }

  if (loadingPromise) {
    return loadingPromise;
  }

  loadingPromise = (async () => {
    try {
      const [noResp, seResp, fiResp] = await Promise.all([
        fetch("./data/norway-polygon.geojson"),
        fetch("./data/sweden-polygon.geojson"),
        fetch("./data/finland-polygon.geojson"),
      ]);

      if (!noResp.ok || !seResp.ok || !fiResp.ok) {
        console.error("Failed to load border polygons:", {
          norway: noResp.status,
          sweden: seResp.status,
          finland: fiResp.status,
        });
        throw new Error("Failed to load border polygons");
      }

      let [noData, seData, fiData] = await Promise.all([
        noResp.json(),
        seResp.json(),
        fiResp.json(),
      ]);

      // Handle both Feature and FeatureCollection formats (OSM exports use FeatureCollection)
      function unwrapFeature(data, name) {
        if (data.type === "FeatureCollection") {
          if (!data.features || data.features.length === 0) {
            throw new Error(`${name} border polygon GeoJSON has no features`);
          }
          return data.features[0];
        }
        return data;
      }

      noData = unwrapFeature(noData, "Norway");
      seData = unwrapFeature(seData, "Sweden");
      fiData = unwrapFeature(fiData, "Finland");

      borderPolygons = {
        no: noData,
        se: seData,
        fi: fiData,
      };

      console.debug("Border polygons loaded:", {
        norway: noData.geometry?.type,
        sweden: seData.geometry?.type,
        finland: fiData.geometry?.type,
      });

      return borderPolygons;
    } catch (err) {
      loadingPromise = null; // Allow retry on next call
      throw err;
    }
  })();

  return loadingPromise;
}

/**
 * Check if a point is inside a polygon (ray-casting with even-odd rule)
 * @param {[number, number]} point - [lng, lat]
 * @param {Array<Array<[number, number]>>} rings - Polygon rings (even-odd rule handles both outer boundaries and holes)
 * @returns {boolean}
 */
function pointInPolygon(point, rings) {
  const [x, y] = point;
  let inside = false;

  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];

      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
  }

  return inside;
}

/**
 * Check if a bounding box intersects with a polygon.
 * Uses a heuristic: bbox corners in polygon, polygon vertices in bbox, and bbox center
 * in polygon. Does not check edge-edge intersections, so may miss narrow crossings
 * where no vertices fall inside the other shape.
 * @param {[number, number, number, number]} bbox - [minLon, minLat, maxLon, maxLat]
 * @param {object} geojson - GeoJSON Feature with Polygon or MultiPolygon geometry
 * @returns {boolean}
 */
function bboxIntersectsPolygon(bbox, geojson) {
  const [minLon, minLat, maxLon, maxLat] = bbox;

  // Get all polygon rings from the geometry
  const geometry = geojson.geometry || geojson;
  let polygons;

  if (geometry.type === "Polygon") {
    polygons = [geometry.coordinates];
  } else if (geometry.type === "MultiPolygon") {
    polygons = geometry.coordinates;
  } else {
    return false;
  }

  // Test bbox corners
  const corners = [
    [minLon, minLat],
    [minLon, maxLat],
    [maxLon, minLat],
    [maxLon, maxLat],
  ];

  for (const polygon of polygons) {
    // Check if any corner is inside the polygon
    for (const corner of corners) {
      if (pointInPolygon(corner, polygon)) {
        return true;
      }
    }

    // Check if any polygon vertex is inside the bbox
    for (const ring of polygon) {
      for (const [lon, lat] of ring) {
        if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat) {
          return true;
        }
      }
    }

    // Check if bbox center is inside the polygon (catches case where bbox is entirely inside)
    const center = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
    if (pointInPolygon(center, polygon)) {
      return true;
    }
  }

  return false;
}

/**
 * Get which providers/countries a tile bounding box intersects
 * @param {[number, number, number, number]} tileBbox - [minLon, minLat, maxLon, maxLat] in WGS84
 * @returns {Promise<string[]>} Array of provider IDs (e.g., ['no'], ['no', 'se'])
 */
export async function getTileProviders(tileBbox) {
  const polygons = await loadBorderPolygons();
  const providers = [];

  if (bboxIntersectsPolygon(tileBbox, polygons.no)) {
    providers.push("no");
  }
  if (bboxIntersectsPolygon(tileBbox, polygons.se)) {
    providers.push("se");
  }
  if (bboxIntersectsPolygon(tileBbox, polygons.fi)) {
    providers.push("fi");
  }

  return providers;
}

/**
 * Get which providers/countries a point belongs to
 * @param {number} lon - Longitude in WGS84
 * @param {number} lat - Latitude in WGS84
 * @returns {Promise<string[]>} Array of provider IDs
 */
export async function getPointProviders(lon, lat) {
  const polygons = await loadBorderPolygons();
  const providers = [];

  const point = [lon, lat];

  for (const [id, geojson] of Object.entries(polygons)) {
    const geometry = geojson.geometry || geojson;
    let polygonsList;

    if (geometry.type === "Polygon") {
      polygonsList = [geometry.coordinates];
    } else if (geometry.type === "MultiPolygon") {
      polygonsList = geometry.coordinates;
    } else {
      continue;
    }

    for (const polygon of polygonsList) {
      if (pointInPolygon(point, polygon)) {
        providers.push(id);
        break;
      }
    }
  }

  return providers;
}

/**
 * Get the primary provider for a point (first match by priority: no, se, fi)
 * @param {number} lon - Longitude
 * @param {number} lat - Latitude
 * @returns {Promise<string>} Provider ID, defaults to 'no' if no match
 */
export async function getPrimaryProvider(lon, lat) {
  const providers = await getPointProviders(lon, lat);

  // Priority order for border areas
  if (providers.includes("no")) return "no";
  if (providers.includes("se")) return "se";
  if (providers.includes("fi")) return "fi";

  // Default fallback based on approximate location
  if (lat >= 55 && lon >= 10.5 && lon <= 24.5) return "se";
  if (lat >= 59.5 && lon >= 19) return "fi";
  return "no";
}

/**
 * Get the border polygon for a country (for use in clipping)
 * @param {string} countryId - Provider ID ('no', 'se', 'fi')
 * @returns {Promise<object>} GeoJSON geometry
 */
export async function getCountryPolygon(countryId) {
  const polygons = await loadBorderPolygons();
  return polygons[countryId]?.geometry || polygons[countryId];
}

/**
 * Convert a tile coordinate to a WGS84 bounding box
 * @param {number} z - Zoom level
 * @param {number} x - Tile X coordinate
 * @param {number} y - Tile Y coordinate
 * @returns {[number, number, number, number]} [minLon, minLat, maxLon, maxLat]
 */
export function tileToBbox(z, x, y) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  const maxLat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));

  const n2 = Math.PI - (2 * Math.PI * (y + 1)) / Math.pow(2, z);
  const minLat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n2) - Math.exp(-n2)));

  const minLon = (x / Math.pow(2, z)) * 360 - 180;
  const maxLon = ((x + 1) / Math.pow(2, z)) * 360 - 180;

  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Convert WGS84 coordinates to pixel position within a tile
 * @param {number} lon - Longitude
 * @param {number} lat - Latitude
 * @param {[number, number, number, number]} tileBbox - Tile bounding box
 * @param {number} tileSize - Tile size in pixels (default 256)
 * @returns {[number, number]} [x, y] pixel position
 */
export function coordsToTilePixel(lon, lat, tileBbox, tileSize = 256) {
  const [minLon, minLat, maxLon, maxLat] = tileBbox;
  const x = ((lon - minLon) / (maxLon - minLon)) * tileSize;
  const y = ((maxLat - lat) / (maxLat - minLat)) * tileSize;
  return [x, y];
}

/**
 * Generate a Canvas clip path from a GeoJSON polygon within tile bounds
 * This clips to the intersection of the country polygon and the tile
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {object} polygon - GeoJSON Polygon or MultiPolygon geometry
 * @param {[number, number, number, number]} tileBbox - Tile bounding box
 * @param {number} tileSize - Tile size in pixels
 */
export function applyPolygonClip(ctx, polygon, tileBbox, tileSize = 256) {
  const geometry = polygon.geometry || polygon;
  let rings;

  if (geometry.type === "Polygon") {
    rings = geometry.coordinates;
  } else if (geometry.type === "MultiPolygon") {
    // Include all rings (outer + inner/holes) for proper clipping
    rings = geometry.coordinates.flatMap(poly => poly);
  } else {
    return;
  }

  ctx.beginPath();

  for (const ring of rings) {
    let started = false;
    for (const [lon, lat] of ring) {
      const [px, py] = coordsToTilePixel(lon, lat, tileBbox, tileSize);

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

/**
 * Check if border polygons are loaded
 * @returns {boolean}
 */
export function areBordersLoaded() {
  return borderPolygons !== null;
}

/**
 * Preload border polygons (call at app startup)
 * @returns {Promise<void>}
 */
export async function preloadBorders() {
  await loadBorderPolygons();
}

export default {
  getTileProviders,
  getPointProviders,
  getPrimaryProvider,
  getCountryPolygon,
  tileToBbox,
  coordsToTilePixel,
  applyPolygonClip,
  areBordersLoaded,
  preloadBorders,
};
