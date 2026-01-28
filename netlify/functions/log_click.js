export async function handler(req) {
  // Netlify passes request details in this `req` object
  if (req.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing SUPABASE env vars" }),
    };
  }

  // Parse JSON body
  let payload;
  try {
    payload = req.body ? JSON.parse(req.body) : {};
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  const event = typeof payload.event === "string" ? payload.event : null;
  const path = typeof payload.path === "string" ? payload.path : null;

  if (!event || !path) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing required fields: event, path" }),
    };
  }

  // Put everything except event/path/timestamp into data
  // (We prefer server-side created_at; ignore client timestamp if present)
  // eslint-disable-next-line no-unused-vars
  const { event: _e, path: _p, timestamp: _t, ...rest } = payload;

  const headers = req.headers || {};

  // Best-effort country header (may be null depending on setup)
  const country =
    headers["x-country"] ||
    headers["X-Country"] ||
    headers["x-nf-country"] || // sometimes present
    headers["X-NF-Country"] ||
    null;

  const userAgent = headers["user-agent"] || headers["User-Agent"] || null;

  const row = {
    event,
    path,
    data: rest, // jsonb
    country,
    user_agent: userAgent,
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/click_events`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Insert failed", details: text }),
    };
  }

  // No content needed
  return { statusCode: 204, body: "" };
}