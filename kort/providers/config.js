/**
 * Provider configurations for multi-country map support.
 * Each provider defines WMTS tile sources and WMS overlays.
 */

export const PROVIDERS = {
  no: {
    id: "no",
    name: "Norway",
    flag: "\u{1F1F3}\u{1F1F4}",
    bounds: { minLat: 57.5, maxLat: 71.5, minLon: 4.0, maxLon: 31.5 },
    wmts: {
      capabilitiesUrl: "https://cache.kartverket.no/v1/wmts/1.0.0/WMTSCapabilities.xml",
      baseUrl: "https://cache.kartverket.no/v1/wmts/1.0.0",
      // Direct URL pattern for tiles (no proxy needed)
      tileUrlTemplate: "https://cache.kartverket.no/v1/wmts/1.0.0/{layer}/default/{matrixSet}/{z}/{y}/{x}.png",
      defaultLayer: "toporaster",
      matrixSet: "webmercator",
      // UTM matrix sets for PDF rendering
      utmMatrixSets: {
        25832: "utm32n",
        25833: "utm33n",
        25835: "utm35n",
      },
      maxZoom: 18,
      requiresProxy: false,
    },
    wms: {
      grid: {
        url: "https://wms.geonorge.no/skwms1/wms.rutenett",
        layer: "1km_rutelinje",
      },
      routes: {
        url: "https://wms.geonorge.no/skwms1/wms.friluftsruter2",
        layers: {
          ski: "Skiloype",
          hike: "Fotrute",
        },
      },
      height: {
        url: "https://wms.geonorge.no/skwms1/wms.hoyde-dtm",
        layer: "DTM:helning_grader",
      },
      weakIce: {
        url: "https://kart.nve.no/enterprise/services/SvekketIs1/MapServer/WMSServer",
        layers: [
          "SvekketIs",
          "SvekketIsElv",
          "SvekketIsIkkeVurdert",
          "OppsprukketIsLangsLand",
        ],
      },
    },
    attribution: "&copy; Kartverket",
    license: "CC BY 4.0",
  },

  se: {
    id: "se",
    name: "Sweden",
    flag: "\u{1F1F8}\u{1F1EA}",
    bounds: { minLat: 55.0, maxLat: 69.5, minLon: 10.5, maxLon: 24.5 },
    wmts: {
      // Use proxy for authenticated tiles
      proxyUrl: "/.netlify/functions/wmts-proxy?provider=se&layer={layer}&z={z}&x={x}&y={y}",
      // Direct upstream URL (for reference, used by proxy)
      upstreamUrl: "https://maps.lantmateriet.se/open/topowebb-ccby/v1/wmts/1.0.0/{layer}/default/3857/{z}/{y}/{x}.png",
      defaultLayer: "topowebb",
      matrixSet: "3857",
      maxZoom: 15, // Limited resolution compared to Norway
      requiresProxy: true,
      authType: "basic",
    },
    wms: null, // Swedish overlays to be added later
    attribution: "&copy; Lantm\u00e4teriet",
    license: "CC BY 4.0",
    warnings: {
      scale25k: "Swedish maps may show reduced detail at 1:25,000 scale due to source resolution limits.",
    },
  },

  fi: {
    id: "fi",
    name: "Finland",
    flag: "\u{1F1EB}\u{1F1EE}",
    bounds: { minLat: 59.5, maxLat: 70.5, minLon: 19.0, maxLon: 32.0 },
    wmts: {
      // Use proxy for API key authentication
      proxyUrl: "/.netlify/functions/wmts-proxy?provider=fi&layer={layer}&z={z}&x={x}&y={y}",
      // Direct upstream URL (for reference, used by proxy)
      upstreamUrl: "https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/{layer}/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.png",
      defaultLayer: "maastokartta",
      matrixSet: "WGS84_Pseudo-Mercator",
      maxZoom: 16,
      requiresProxy: true,
      authType: "apikey",
    },
    wms: null, // Finnish overlays to be added later
    attribution: "&copy; Maanmittauslaitos",
    license: "CC BY 4.0",
  },
};

/**
 * Get provider by ID
 * @param {string} id - Provider ID (e.g., 'no', 'se', 'fi')
 * @returns {object|null} Provider configuration or null if not found
 */
export function getProvider(id) {
  return PROVIDERS[id] || null;
}

/**
 * Get all provider IDs
 * @returns {string[]} Array of provider IDs
 */
export function getProviderIds() {
  return Object.keys(PROVIDERS);
}

/**
 * Get the WMTS tile URL for a provider
 * @param {string} providerId - Provider ID
 * @param {object} params - Tile parameters { layer, matrixSet, z, y, x }
 * @returns {string} Tile URL
 */
export function getTileUrl(providerId, { layer, matrixSet, z, y, x }) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const wmts = provider.wmts;
  const tileLayer = layer || wmts.defaultLayer;
  const tileMatrixSet = matrixSet || wmts.matrixSet;

  if (wmts.requiresProxy) {
    // Use proxy URL
    return wmts.proxyUrl
      .replace("{layer}", tileLayer)
      .replace("{z}", z)
      .replace("{x}", x)
      .replace("{y}", y);
  }

  // Direct URL
  return wmts.tileUrlTemplate
    .replace("{layer}", tileLayer)
    .replace("{matrixSet}", tileMatrixSet)
    .replace("{z}", z)
    .replace("{y}", y)
    .replace("{x}", x);
}

/**
 * Get the Leaflet-compatible tile URL template for a provider
 * @param {string} providerId - Provider ID
 * @param {string} [layer] - Optional layer override
 * @returns {string} Tile URL template with {z}, {x}, {y} placeholders
 */
export function getLeafletTileUrl(providerId, layer) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const wmts = provider.wmts;
  const tileLayer = layer || wmts.defaultLayer;

  if (wmts.requiresProxy) {
    return wmts.proxyUrl.replace("{layer}", tileLayer);
  }

  return wmts.tileUrlTemplate
    .replace("{layer}", tileLayer)
    .replace("{matrixSet}", wmts.matrixSet);
}

/**
 * Get the maximum zoom level for a provider
 * @param {string} providerId - Provider ID
 * @returns {number} Maximum zoom level
 */
export function getMaxZoom(providerId) {
  const provider = PROVIDERS[providerId];
  return provider?.wmts?.maxZoom || 18;
}

/**
 * Get the minimum max zoom across multiple providers
 * @param {string[]} providerIds - Array of provider IDs
 * @returns {number} Minimum of all max zoom levels
 */
export function getMinMaxZoom(providerIds) {
  if (!providerIds || providerIds.length === 0) {
    return 18;
  }
  return Math.min(...providerIds.map(getMaxZoom));
}

/**
 * Get WMS configuration for a provider
 * @param {string} providerId - Provider ID
 * @param {string} wmsType - WMS type (e.g., 'grid', 'routes', 'height', 'weakIce')
 * @returns {object|null} WMS configuration or null if not available
 */
export function getWmsConfig(providerId, wmsType) {
  const provider = PROVIDERS[providerId];
  return provider?.wms?.[wmsType] || null;
}

/**
 * Check if a provider has a specific WMS layer type
 * @param {string} providerId - Provider ID
 * @param {string} wmsType - WMS type
 * @returns {boolean}
 */
export function hasWmsLayer(providerId, wmsType) {
  return getWmsConfig(providerId, wmsType) !== null;
}

/**
 * Get UTM tile matrix set ID for a provider and EPSG code
 * @param {string} providerId - Provider ID
 * @param {number} epsgCode - EPSG code (e.g., 25832, 25833, 25835)
 * @returns {string|null} Matrix set ID or null if not available
 */
export function getUtmMatrixSet(providerId, epsgCode) {
  const provider = PROVIDERS[providerId];
  return provider?.wmts?.utmMatrixSets?.[epsgCode] || null;
}

/**
 * Get attribution string for visible providers
 * @param {string[]} providerIds - Array of visible provider IDs
 * @returns {string} Combined attribution string
 */
export function getCombinedAttribution(providerIds) {
  const unique = [...new Set(providerIds)];
  return unique
    .map(id => PROVIDERS[id]?.attribution)
    .filter(Boolean)
    .join(" | ");
}

export default PROVIDERS;
