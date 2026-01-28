export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Parse payload (allow empty body)
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    body = {};
  }

  const eventName = typeof body.event === "string" ? body.event : "button_click";
  const path = typeof body.path === "string" ? body.path : null;

  // Best-effort country.
  // Netlify commonly provides `x-country` on requests passing through their proxy.  [oai_citation:1‡Netlify Support Forums](https://answers.netlify.com/t/x-country-header-returning-incorrect-code/96035)
  const country =
    event.headers["x-country"] ||
    event.headers["X-Country"] ||
    null;

  const userAgent = event.headers["user-agent"] || null;

  const insertPayload = {
    event: eventName,
    country,
    path,
    user_agent: userAgent,
    // created_at is set by default in DB (now())
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/click_events`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(insertPayload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { statusCode: 500, body: `Insert failed: ${text}` };
  }

  return { statusCode: 204, body: "" };
}