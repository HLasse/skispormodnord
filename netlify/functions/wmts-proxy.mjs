/**
 * WMTS Tile Proxy for Sweden (Lantmäteriet) and Finland (Maanmittauslaitos)
 *
 * Handles authentication for tile services that require credentials:
 * - Sweden: Basic Auth
 * - Finland: API key parameter
 *
 * Rate limiting relies on Netlify's built-in function invocation limits
 * and upstream provider rate limits.
 *
 * Usage from Leaflet:
 *   /.netlify/functions/wmts-proxy?provider=se&layer=topowebb&z={z}&x={x}&y={y}
 *   /.netlify/functions/wmts-proxy?provider=fi&layer=maastokartta&z={z}&x={x}&y={y}
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
    allowedLayers: new Set(["maastokartta", "taustakartta"]),
    maxZoom: 16,
  },
};

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
    const maxTileIndex = Math.pow(2, z) - 1;
    if (x < 0 || x > maxTileIndex || y < 0 || y > maxTileIndex) {
      return new Response(
        `x/y out of range for zoom ${z} (expected 0..${maxTileIndex})`,
        { status: 400 }
      );
    }

    // Build upstream URL
    const upstream = provider.upstream
      .replace("{layer}", tileLayer)
      .replace("{z}", z)
      .replace("{y}", y)
      .replace("{x}", x);

    // Build request headers based on auth type
    const headers = {
      Accept: "image/png",
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
      // API key authentication (Finland)
      const apiKey = process.env[provider.envKey];

      if (!apiKey) {
        console.error(`Missing ${provider.envKey} environment variable for ${provider.name}`);
        return new Response(
          `Service configuration error for ${provider.name}. Contact administrator.`,
          { status: 500 }
        );
      }

      // Add API key as URL parameter
      upstreamUrl = `${upstream}?api-key=${apiKey}`;
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
        "Content-Type": "image/png",
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
