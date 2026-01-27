export async function onRequestPost({ request, env }) {
  // Kill switch (flip AI_ENABLED=false to instantly stop costs)
  if (env.AI_ENABLED !== "true") {
    return json({ error: "AI is temporarily paused. Please try again later." }, 503);
  }

  // KV required for limits + token caching
  if (!env.FRICTION_KV) {
    return json({ error: "Server missing KV binding (FRICTION_KV)." }, 500);
  }

  // Hard cap request size (prevents giant prompts = giant bills)
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > 50_000) {
    return json({ error: "Request too large." }, 413);
  }

  // Require Google auth (prevents anonymous cost drain)
  const auth = await getVerifiedGoogleUser(request, env);
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }

  const userId = auth.userId;
  const ip = getClientIp(request);

  // Enforce per-user + per-ip + daily caps
  const rl = await enforceLimits({ env, userId, ip });
  if (!rl.ok) {
    return json(
      { error: rl.error, retry_after_seconds: rl.retryAfterSeconds },
      429,
      { "Retry-After": String(rl.retryAfterSeconds) }
    );
  }

  // Parse body
  const body = await request.json().catch(() => ({}));
  const { model, messages } = body;

  if (!model || !Array.isArray(messages)) {
    return json({ error: "Invalid request. Expected { model, messages[] }" }, 400);
  }

  // Clean + cap message size
  const cleaned = messages
    .filter(m => m && typeof m.content === "string" && String(m.content).trim().length > 0)
    .map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").trim().slice(0, 8000),
    }));

  if (!cleaned.length) {
    return json({ error: "No messages provided" }, 400);
  }

  try {
    let responseText = "";

    switch (model) {
      case "gemini": {
        const GEMINI_KEY = env.GEMINI_API_KEY;
        if (!GEMINI_KEY) return json({ error: "Server missing GEMINI_API_KEY" }, 500);

        const contents = cleaned.map(m => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }]
        }));

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;

        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents,
            generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
          })
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: "Gemini API error", details: data }, r.status);

        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (!text) return json({ error: "Gemini returned no text", details: data }, 502);

        responseText = text;
        break;
      }

      case "claude": {
        if (!env.ANTHROPIC_API_KEY) return json({ error: "Server missing ANTHROPIC_API_KEY" }, 500);

        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            messages: cleaned.map(m => ({ role: m.role, content: m.content }))
          })
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: "Claude API error", details: data }, r.status);

        responseText = data?.content?.[0]?.text || "No response from Claude";
        break;
      }

      case "gpt": {
        if (!env.OPENAI_API_KEY) return json({ error: "Server missing OPENAI_API_KEY" }, 500);

        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "gpt-4o",
            temperature: 0.7,
            messages: cleaned.map(m => ({ role: m.role, content: m.content }))
          })
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: "OpenAI API error", details: data }, r.status);

        responseText = data?.choices?.[0]?.message?.content || "No response from GPT-4o";
        break;
      }

      case "grok": {
        if (!env.XAI_API_KEY) return json({ error: "Server missing XAI_API_KEY" }, 500);

        const r = await fetch("https://api.x.ai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.XAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "grok-3",
            messages: cleaned.map(m => ({ role: m.role, content: m.content })),
            temperature: 0.7
          })
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: "Grok API error", details: data }, r.status);

        responseText = data?.choices?.[0]?.message?.content || "No response from Grok";
        break;
      }

      case "perplexity": {
        if (!env.PERPLEXITY_API_KEY) return json({ error: "Server missing PERPLEXITY_API_KEY" }, 500);

        const r = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.PERPLEXITY_API_KEY}`
          },
          body: JSON.stringify({
            model: "sonar",
            messages: cleaned.map(m => ({ role: m.role, content: m.content }))
          })
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: "Perplexity API error", details: data }, r.status);

        responseText = data?.choices?.[0]?.message?.content || "No response from Perplexity";
        break;
      }

      case "bing": {
        responseText = "Bing Search integration coming soon!";
        break;
      }

      default:
        return json({ error: `Unknown model: ${model}` }, 400);
    }

    return json({ response: responseText });
  } catch (err) {
    return json({ error: err?.message || "Server error" }, 500);
  }
}

// ---------- CORS / JSON helpers ----------
function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      ...extraHeaders
    }
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

// ---------- Rate limiting + Auth helpers ----------
function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// Expects: Authorization: Bearer <google_id_token>
async function getVerifiedGoogleUser(request, env) {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) return { ok: false, status: 500, error: "Server missing GOOGLE_CLIENT_ID." };

  const authz = request.headers.get("Authorization") || "";
  const match = authz.match(/^Bearer\s+(.+)$/i);
  const idToken = match ? match[1].trim() : "";
  if (!idToken) return { ok: false, status: 401, error: "Missing Authorization Bearer token." };

  // Cache token->sub for 1 hour (reduces Google tokeninfo calls)
  const cacheKey = "tok:" + hashShort(idToken);
  const cached = await env.FRICTION_KV.get(cacheKey, "json").catch(() => null);
  if (cached && cached.sub && cached.aud === clientId) {
    return { ok: true, userId: cached.sub };
  }

  const verifyUrl = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);
  const res = await fetch(verifyUrl);
  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.aud !== clientId || !data.sub) {
    return { ok: false, status: 401, error: "Invalid sign-in token." };
  }

  await env.FRICTION_KV.put(cacheKey, JSON.stringify({ sub: data.sub, aud: data.aud }), {
    expirationTtl: 3600
  });

  return { ok: true, userId: data.sub };
}

function hashShort(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

async function enforceLimits({ env, userId, ip }) {
  const kv = env.FRICTION_KV;

  // Burst per user: 5 / 10s
  const userBurst = await bumpCounter(kv, `u:${userId}:10s`, 10);
  if (userBurst.count > 5) {
    return { ok: false, error: "Slow down a bit (friction time).", retryAfterSeconds: userBurst.retryAfter };
  }

  // Burst per IP backup: 10 / 10s
  const ipBurst = await bumpCounter(kv, `ip:${ip}:10s`, 10);
  if (ipBurst.count > 10) {
    return { ok: false, error: "Too many requests from this network.", retryAfterSeconds: ipBurst.retryAfter };
  }

  // Daily cap per user: 200/day (Sydney day)
  const dayKey = `u:${userId}:day:${dayStampSydney()}`;
  const ttl = secondsUntilSydneyMidnight();
  const userDaily = await bumpCounter(kv, dayKey, ttl);
  if (userDaily.count > 200) {
    return { ok: false, error: "Daily limit reached. Come back tomorrow.", retryAfterSeconds: userDaily.retryAfter };
  }

  return { ok: true };
}

async function bumpCounter(kv, key, ttlSeconds) {
  const now = Date.now();
  const raw = await kv.get(key).catch(() => null);

  let count = 0;
  let start = now;

  if (raw) {
    const parts = raw.split("|");
    count = Number(parts[0] || "0");
    start = Number(parts[1] || String(now));
  }

  count += 1;

  const windowMs = ttlSeconds * 1000;
  const elapsed = now - start;
  const retryAfter = Math.max(1, Math.ceil((windowMs - elapsed) / 1000));

  await kv.put(key, `${count}|${start}`, { expirationTtl: ttlSeconds });
  return { count, retryAfter };
}

function dayStampSydney() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(d)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function secondsUntilSydneyMidnight() {
  // v1 approximation, good enough for daily caps
  const tz = "Australia/Sydney";
  const now = new Date();

  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(now);

  const [mdy, hms] = s.split(", ");
  const [mm, dd, yyyy] = mdy.split("/");
  const localNow = new Date(`${yyyy}-${mm}-${dd}T${hms}Z`);
  const next = new Date(localNow);
  next.setUTCHours(24, 0, 0, 0);

  return Math.max(60, Math.ceil((next.getTime() - localNow.getTime()) / 1000));
}