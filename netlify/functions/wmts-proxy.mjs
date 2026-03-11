/**
 * WMTS Tile Proxy for Sweden (Lantmäteriet), Finland (Maanmittauslaitos),
 * and Denmark (Datafordeler / SDFI)
 *
 * Handles authentication for tile services that require credentials:
 * - Sweden: Basic Auth
 * - Finland: API key query parameter
 * - Denmark: API key query parameter
 *
 * Rate limiting relies on Netlify's built-in function invocation limits
 * and upstream provider rate limits.
 *
 * Usage from Leaflet:
 *   /.netlify/functions/wmts-proxy?provider=se&layer=topowebb&z={z}&x={x}&y={y}
 *   /.netlify/functions/wmts-proxy?provider=fi&layer=maastokartta&z={z}&x={x}&y={y}
 *   /.netlify/functions/wmts-proxy?provider=dk&layer=topo_skaermkort&z={z}&x={x}&y={y}
 *
 * Usage for DK high-detail WMS:
 *   /.netlify/functions/wmts-proxy?provider=dk&kind=wms&layer=dtk25&crs=EPSG:25832&bbox=minx,miny,maxx,maxy&width=1024&height=1024
 */

const PROVIDERS = {
  se: {
    name: "Sweden (Lantmäteriet)",
    upstream: "https://maps.lantmateriet.se/open/topowebb-ccby/v1/wmts/1.0.0/{layer}/default/3857/{z}/{y}/{x}.png",
    authType: "basic",
    envUser: "LM_USER",
    envPass: "LM_PASS",
    allowedLayers: new Set(["topowebb", "topowebb_nedtonad"]),
    maxZoom: 15,
  },
  fi: {
    name: "Finland (Maanmittauslaitos)",
    upstream: "https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/{layer}/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.png",
    authType: "apikey",
    envKey: "MML_API_KEY",
    authQueryParam: "api-key",
    allowedLayers: new Set(["maastokartta", "taustakartta"]),
    maxZoom: 16,
  },
  dk: {
    name: "Denmark (Datafordeler/SDFI)",
    upstream: "https://wmts.datafordeler.dk/Dkskaermkort/topo_skaermkort_wmts/1.0.0/wmts",
    wmsUpstream: "https://wms.datafordeler.dk/DKtopokort/dtk_25/1.0.0/WMS",
    upstreamType: "wmts-query",
    matrixSet: "View1",
    format: "image/jpeg",
    authType: "apikey",
    envKey: "DATAFORDELER_API_KEY",
    authQueryParam: "apikey",
    allowedLayers: new Set(["topo_skaermkort"]),
    allowedWmsLayers: new Set(["dtk25", "dtk_25", "topo_dtk25"]),
    maxZoom: 13,
    // View1 tile rows/cols are not global XYZ (0..2^z-1), so keep only sane bounds.
    coordinateValidation: "wmts-unbounded",
  },
};

const TRANSPARENT_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X5QkAAAAASUVORK5CYII=",
    "base64"
  )
);

function transparentPngResponse(req, cacheControl = "public, max-age=300") {
  return new Response(TRANSPARENT_PNG, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": cacheControl,
      "Access-Control-Allow-Origin": getAllowedOrigin(req),
    },
  });
}

// Allowed CORS origins: Netlify deploy URLs, custom domain, and localhost for dev
function getAllowedOrigin(req) {
  const origin = req.headers.get("origin") || "";
  const allowed = [
    process.env.URL,
    process.env.DEPLOY_PRIME_URL,
    "https://skispormodnord.dk",
    "https://www.skispormodnord.dk",
    "http://localhost:8888",
  ].filter(Boolean);

  if (allowed.includes(origin)) {
    return origin;
  }
  // Also allow any *.netlify.app deploy preview
  if (origin.endsWith(".netlify.app")) {
    return origin;
  }
  return allowed[0] || "";
}

export default async (req) => {
  try {
    const url = new URL(req.url);

    // Parse query parameters
    const providerId = url.searchParams.get("provider");
    const kind = url.searchParams.get("kind") || "wmts";
    const zStr = url.searchParams.get("z");
    const xStr = url.searchParams.get("x");
    const yStr = url.searchParams.get("y");
    const layer = url.searchParams.get("layer");
    const debug = url.searchParams.get("debug") === "1";

    // Validate provider
    if (!providerId || !PROVIDERS[providerId]) {
      return new Response(
        `Invalid or missing provider. Allowed: ${Object.keys(PROVIDERS).join(", ")}`,
        { status: 400 }
      );
    }

    const provider = PROVIDERS[providerId];

    // DK WMS mode: proxy GetMap request with API key auth
    if (kind === "wms") {
      if (providerId !== "dk") {
        return new Response("kind=wms is only supported for provider=dk", { status: 400 });
      }

      const bbox = url.searchParams.get("bbox");
      const widthStr = url.searchParams.get("width");
      const heightStr = url.searchParams.get("height");
      const crs = url.searchParams.get("crs") || "EPSG:25832";
      const format = url.searchParams.get("format") || "image/jpeg";
      const layerName = layer || "dtk25";

      if (!bbox || !widthStr || !heightStr) {
        return new Response("Missing query params for WMS: bbox, width, height", { status: 400 });
      }
      if (!provider.allowedWmsLayers?.has(layerName)) {
        return new Response(
          `Invalid WMS layer for ${provider.name}. Allowed: ${[...(provider.allowedWmsLayers || [])].join(", ")}`,
          { status: 400 }
        );
      }
      if (!["image/jpeg", "image/png"].includes(format)) {
        return new Response("Invalid WMS format. Allowed: image/jpeg, image/png", { status: 400 });
      }
      const width = Number(widthStr);
      const height = Number(heightStr);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 12000 || height > 12000) {
        return new Response("width/height must be integers in range 1..12000", { status: 400 });
      }

      const bboxParts = bbox.split(",").map(Number);
      if (bboxParts.length !== 4 || bboxParts.some((v) => !Number.isFinite(v))) {
        return new Response("bbox must be 4 comma-separated numbers", { status: 400 });
      }

      const apiKey = process.env[provider.envKey];
      if (!apiKey) {
        console.error(`Missing ${provider.envKey} environment variable for ${provider.name}`);
        return new Response(
          `Service configuration error for ${provider.name}. Contact administrator.`,
          { status: 500 }
        );
      }

      const params = new URLSearchParams({
        SERVICE: "WMS",
        REQUEST: "GetMap",
        VERSION: "1.3.0",
        LAYERS: layerName,
        STYLES: "",
        FORMAT: format,
        TRANSPARENT: "FALSE",
        CRS: crs,
        BBOX: bbox,
        WIDTH: String(width),
        HEIGHT: String(height),
        [provider.authQueryParam || "apikey"]: apiKey,
      });
      const upstreamUrl = `${provider.wmsUpstream}?${params.toString()}`;
      const headers = {
        Accept: "image/*",
        "User-Agent": "gpx-playground-wmts-proxy/1.0",
      };

      const resp = await fetch(upstreamUrl, { headers });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        console.error(`Upstream WMS error for ${provider.name}: ${resp.status} ${resp.statusText}`, text);
        return new Response(
          `WMS fetch failed for ${provider.name}`,
          { status: resp.status >= 500 ? 502 : resp.status }
        );
      }
      const body = await resp.arrayBuffer();
      const upstreamCache = resp.headers.get("cache-control");
      const cacheControl = upstreamCache || "public, max-age=3600";
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": resp.headers.get("content-type") || format,
          "Cache-Control": cacheControl,
          "Access-Control-Allow-Origin": getAllowedOrigin(req),
        },
      });
    }

    if (kind !== "wmts") {
      return new Response("Invalid kind. Allowed: wmts, wms", { status: 400 });
    }

    // Validate required params
    if (zStr === null || xStr === null || yStr === null) {
      return new Response("Missing query params: z, x, y", { status: 400 });
    }

    // Validate layer
    const tileLayer = layer || [...provider.allowedLayers][0];
    if (!provider.allowedLayers.has(tileLayer)) {
      return new Response(
        `Invalid layer for ${provider.name}. Allowed: ${[...provider.allowedLayers].join(", ")}`,
        { status: 400 }
      );
    }

    // Numeric validation
    const z = Number(zStr);
    const x = Number(xStr);
    const y = Number(yStr);

    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
      return new Response("z, x, y must be integers", { status: 400 });
    }

    // Zoom range validation
    if (z < 0 || z > provider.maxZoom) {
      return new Response(
        `z out of range for ${provider.name} (expected 0..${provider.maxZoom})`,
        { status: 400 }
      );
    }

    // Tile coordinate range validation
    if (provider.coordinateValidation === "wmts-unbounded") {
      // Defensive upper bound only; actual availability is checked by upstream.
      if (Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000) {
        if (providerId === "dk") {
          return transparentPngResponse(req, "public, max-age=60");
        }
        return new Response("x/y out of allowed range", { status: 400 });
      }
    } else {
      const maxTileIndex = Math.pow(2, z) - 1;
      if (x < 0 || x > maxTileIndex || y < 0 || y > maxTileIndex) {
        return new Response(
          `x/y out of range for zoom ${z} (expected 0..${maxTileIndex})`,
          { status: 400 }
        );
      }
    }

    // Build upstream URL
    let upstream;
    if (provider.upstreamType === "wmts-query") {
      const params = new URLSearchParams({
        SERVICE: "WMTS",
        REQUEST: "GetTile",
        VERSION: "1.0.0",
        LAYER: tileLayer,
        STYLE: "default",
        TILEMATRIXSET: provider.matrixSet || "View1",
        TILEMATRIX: String(z),
        TILEROW: String(y),
        TILECOL: String(x),
        FORMAT: provider.format || "image/jpeg",
      });
      upstream = `${provider.upstream}?${params.toString()}`;
    } else {
      upstream = provider.upstream
        .replace("{layer}", tileLayer)
        .replace("{z}", z)
        .replace("{y}", y)
        .replace("{x}", x);
    }

    // Build request headers based on auth type
    const headers = {
      Accept: "image/*",
      "User-Agent": "gpx-playground-wmts-proxy/1.0",
    };

    let upstreamUrl = upstream;

    if (provider.authType === "basic") {
      // Basic authentication (Sweden)
      const user = process.env[provider.envUser];
      const pass = process.env[provider.envPass];

      if (!user || !pass) {
        console.error(`Missing ${provider.envUser}/${provider.envPass} environment variables for ${provider.name}`);
        return new Response(
          `Service configuration error for ${provider.name}. Contact administrator.`,
          { status: 500 }
        );
      }

      headers.Authorization = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    } else if (provider.authType === "apikey") {
      // API key authentication (Finland/Denmark)
      const apiKey = process.env[provider.envKey];

      if (!apiKey) {
        console.error(`Missing ${provider.envKey} environment variable for ${provider.name}`);
        return new Response(
          `Service configuration error for ${provider.name}. Contact administrator.`,
          { status: 500 }
        );
      }

      // Add API key as URL parameter
      const authParam = provider.authQueryParam || "api-key";
      const joiner = upstream.includes("?") ? "&" : "?";
      upstreamUrl = `${upstream}${joiner}${authParam}=${encodeURIComponent(apiKey)}`;
    }

    // Debug mode: return metadata
    if (debug) {
      const headResp = await fetch(upstreamUrl, {
        method: "HEAD",
        headers,
      });

      return new Response(
        JSON.stringify(
          {
            provider: providerId,
            providerName: provider.name,
            layer: tileLayer,
            upstream: upstream, // Don't expose API key in debug
            status: headResp.status,
            statusText: headResp.statusText,
            contentType: headResp.headers.get("content-type"),
            cacheControl: headResp.headers.get("cache-control"),
          },
          null,
          2
        ),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        }
      );
    }

    // Fetch tile from upstream
    const resp = await fetch(upstreamUrl, { headers });

    // Handle upstream errors
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (providerId === "dk" && (resp.status === 400 || resp.status === 404)) {
        // DK WMTS returns 400/404 for out-of-coverage tiles.
        // Return transparent image to avoid noisy console errors and keep rendering smooth.
        return transparentPngResponse(req);
      }
      console.error(`Upstream error for ${provider.name}: ${resp.status} ${resp.statusText}`, text);
      return new Response(
        `Tile fetch failed for ${provider.name}`,
        { status: resp.status >= 500 ? 502 : resp.status }
      );
    }

    const body = await resp.arrayBuffer();

    // Set cache headers - tiles are relatively stable
    const upstreamCache = resp.headers.get("cache-control");
    const cacheControl = upstreamCache || "public, max-age=86400"; // 24 hours default

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": resp.headers.get("content-type") || "image/png",
        "Cache-Control": cacheControl,
        "Access-Control-Allow-Origin": getAllowedOrigin(req),
      },
    });
  } catch (err) {
    console.error(`WMTS proxy error: ${err?.message || String(err)}`, err?.stack);
    return new Response("Internal proxy error", {
      status: 500,
    });
  }
};
