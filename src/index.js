// src/index.js

// Which models cost you money:
const FREE_MODELS = ["gemini"];
const PAID_MODELS = ["claude", "gpt", "grok", "perplexity"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only respond to /api/*
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not Found", { status: 404 });
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // Only handle POST /api/chat
    if (url.pathname === "/api/chat" && request.method === "POST") {
      // ========== FINANCIAL SAFETY NET (applies to ALL models) ==========

      // Kill switch
      if (env.AI_ENABLED !== "true") {
        return jsonResponse(
          { error: "AI is temporarily paused. Please try again later." },
          503
        );
      }

      // Require KV for limits
      if (!env.FRICTION_KV) {
        return jsonResponse(
          { error: "Server missing KV binding (FRICTION_KV)." },
          500
        );
      }

      // Hard cap request size (prevents giant prompts)
      const contentLength = request.headers.get("content-length");
      if (contentLength && Number(contentLength) > 50_000) {
        return jsonResponse({ error: "Request too large." }, 413);
      }

      // Require Google auth (prevents anonymous cost-drain)
      const auth = await getVerifiedGoogleUser(request, env);
      if (!auth.ok) {
        return jsonResponse({ error: auth.error }, auth.status);
      }
      const userId = auth.userId;
      const email = auth.email;
      const isAdmin = email && email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
      const ip = getClientIp(request);

      // Enforce limits (per-user + per-ip + daily)
      const rl = await enforceLimits({ env, userId, ip });
      if (!rl.ok) {
        return jsonResponse(
          {
            error: rl.error,
            retry_after_seconds: rl.retryAfterSeconds,
          },
          429,
          { "Retry-After": String(rl.retryAfterSeconds) }
        );
      }

      // ================================================================

      try {
        // Read body text first so we can enforce a max size even if no content-length
        const bodyText = await request.text();
        if (bodyText.length > 50_000) {
          return jsonResponse({ error: "Request too large." }, 413);
        }

        const body = JSON.parse(bodyText || "{}");
        const model = body.model;
        const messages = Array.isArray(body.messages) ? body.messages : [];

        if (!messages.length) {
          return jsonResponse({ error: "No messages provided" }, 400);
        }

        // Enforce model access based on admin status
        if (PAID_MODELS.includes(model) && !isAdmin) {
          return jsonResponse(
            {
              error: "This model is locked. Only the admin account can use paid models on this site.",
            },
            403
          );
        }

        // Clean/normalize messages + cap size per message
        const cleaned = messages
          .filter(
            (m) =>
              m && typeof m.content === "string" && m.content.trim().length > 0
          )
          .map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content.trim().slice(0, 8000),
          }));

        if (!cleaned.length) {
          return jsonResponse(
            {
              response:
                "Hey! Looks like your message didn't come through. Try sending something again?",
            },
            200
          );
        }

        // Most APIs expect the last turn to be from user
        if (cleaned[cleaned.length - 1].role !== "user") {
          return jsonResponse(
            { error: "Last message must be from user. Try again." },
            400
          );
        }

        let responseText;

        switch (model) {
          case "gemini":
            responseText = await handleGemini(cleaned, env);
            break;
          case "claude":
            responseText = await handleClaude(cleaned, env);
            break;
          case "gpt":
            responseText = await handleGPT(cleaned, env);
            break;
          case "grok":
            responseText = await handleGrok(cleaned, env);
            break;
          case "perplexity":
            responseText = await handlePerplexity(cleaned, env);
            break;
          default:
            return jsonResponse({ error: "Unknown model: " + model }, 400);
        }

        return jsonResponse({ response: responseText }, 200);
      } catch (err) {
        const errMsg = err && err.message ? err.message : "Server error";
        return jsonResponse({ error: errMsg }, 500);
      }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  },
};

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...extra,
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...corsHeaders(extraHeaders),
  };
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// ======= GOOGLE AUTH (ID TOKEN) =======
// Expects: Authorization: Bearer <google_id_token>
async function getVerifiedGoogleUser(request, env) {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return { ok: false, status: 500, error: "Server missing GOOGLE_CLIENT_ID." };
  }

  const authz = request.headers.get("Authorization") || "";
  const match = authz.match(/^Bearer\s+(.+)$/i);
  const idToken = match ? match[1].trim() : "";

  if (!idToken) {
    return { ok: false, status: 401, error: "Missing Authorization Bearer token." };
  }

  // Cache token->sub for 1 hour in KV to reduce calls to Google tokeninfo
  const cacheKey = "tok:" + hashShort(idToken);
  const cached = await env.FRICTION_KV.get(cacheKey, "json").catch(() => null);
  if (cached && cached.sub && cached.aud === clientId) {
    return { 
      ok: true, 
      userId: cached.sub,
      email: cached.email,
      isAdmin: cached.email && cached.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase()
    };
  }

  const verifyUrl =
    "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);

  const res = await fetch(verifyUrl);
  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.aud !== clientId || !data.sub || !data.email) {
    return { ok: false, status: 401, error: "Invalid sign-in token." };
  }

  const isAdmin = data.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
  
  await env.FRICTION_KV.put(
    cacheKey,
    JSON.stringify({ 
      sub: data.sub, 
      aud: data.aud,
      email: data.email,
      isAdmin: isAdmin 
    }),
    { expirationTtl: 3600 }
  );

  return { 
    ok: true, 
    userId: data.sub,
    email: data.email,
    isAdmin: isAdmin
  };
}

function hashShort(str) {
  // Non-crypto short hash for KV keying (fine for caching)
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// ======= LIMITS (KV-based) =======
async function enforceLimits({ env, userId, ip }) {
  const kv = env.FRICTION_KV;

  // Burst per user: 5 / 10 seconds
  const userBurst = await bumpCounter(kv, `u:${userId}:10s`, 10);
  if (userBurst.count > 5) {
    return {
      ok: false,
      error: "Slow down a bit (friction time). Try again shortly.",
      retryAfterSeconds: userBurst.retryAfter,
    };
  }

  // Burst per IP backup: 10 / 10 seconds
  const ipBurst = await bumpCounter(kv, `ip:${ip}:10s`, 10);
  if (ipBurst.count > 10) {
    return {
      ok: false,
      error: "Too many requests from this network. Try again shortly.",
      retryAfterSeconds: ipBurst.retryAfter,
    };
  }

  // Daily cap per user: 200 / day (Sydney day)
  const dayKey = `u:${userId}:day:${dayStampSydney()}`;
  const ttl = secondsUntilSydneyMidnight();
  const userDaily = await bumpCounter(kv, dayKey, ttl);
  if (userDaily.count > 200) {
    return {
      ok: false,
      error: "Daily limit reached. Come back tomorrow.",
      retryAfterSeconds: userDaily.retryAfter,
    };
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
  // v1 approximation, good enough for daily limits
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

// ============ MODEL HANDLERS ============

async function handleGemini(messages, env) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini API key not configured");

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
    encodeURIComponent(apiKey);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: 0.9,
        topP: 0.95,
        maxOutputTokens: 2048,
      },
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error("Gemini API error: " + text);

  const data = JSON.parse(text);
  const out =
    data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!out) throw new Error("No valid response text from Gemini.");
  return out;
}

async function handleClaude(messages, env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Claude API key not configured");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Claude API error: " + JSON.stringify(data));

  const out = data?.content?.[0]?.text;
  if (!out) throw new Error("No valid response text from Claude.");
  return out;
}

async function handleGPT(messages, env) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI API key not configured");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0.7,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("OpenAI API error: " + JSON.stringify(data));

  const out = data?.choices?.[0]?.message?.content;
  if (!out) throw new Error("No valid response text from GPT-4o.");
  return out;
}

async function handleGrok(messages, env) {
  const apiKey = env.XAI_API_KEY;
  if (!apiKey) throw new Error("Grok API key not configured");

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: "grok-3",
      temperature: 0.7,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Grok API error: " + JSON.stringify(data));

  const out = data?.choices?.[0]?.message?.content;
  if (!out) throw new Error("No valid response text from Grok.");
  return out;
}

async function handlePerplexity(messages, env) {
  const apiKey = env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("Perplexity API key not configured");

  // Merge consecutive same-role messages
  const alternating = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (alternating.length === 0) {
      alternating.push({ role: msg.role, content: msg.content });
    } else {
      const last = alternating[alternating.length - 1];
      if (last.role === msg.role) {
        last.content += "\n\n" + msg.content;
      } else {
        alternating.push({ role: msg.role, content: msg.content });
      }
    }
  }

  const messagesWithSystem = [
    {
      role: "system",
      content:
        "You are a helpful assistant. Always include a 'Sources:' section at the end of your response with the full URLs of the websites you referenced, numbered to match your citations.",
    },
    ...alternating,
  ];

  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: "sonar",
      messages: messagesWithSystem,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Perplexity API error: " + JSON.stringify(data));

  let out = data?.choices?.[0]?.message?.content;
  if (!out) throw new Error("No valid response text from Perplexity.");

  const citations = data.citations;
  if (citations && citations.length > 0 && out.indexOf("Sources:") === -1) {
    out += "\n\nSources:";
    for (let j = 0; j < citations.length; j++) {
      out += "\n[" + (j + 1) + "] " + citations[j];
    }
  }

  return out;
}