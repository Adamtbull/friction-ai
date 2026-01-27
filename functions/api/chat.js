// functions/api/chat.js

const ADMIN_EMAIL = "fatboydimsim@gmail.com";

// Which models cost you money:
const FREE_MODELS = ["gemini"];
const PAID_MODELS = ["claude", "gpt", "grok", "perplexity"];

// Cache Google JWKS in-memory (per isolate) to avoid fetching every request
let JWKS_CACHE = { keys: null, fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const { model, messages } = body;

    if (!model || !Array.isArray(messages)) {
      return json({ error: "Invalid request. Expected { model, messages[] }" }, 400);
    }

    // 1) Require Google ID token
    const auth = request.headers.get("Authorization") || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return json({ error: "Missing Authorization Bearer token" }, 401);

    const idToken = m[1].trim();

    // 2) Verify token (signature + claims)
    if (!env.GOOGLE_CLIENT_ID) {
      return json({ error: "Server missing GOOGLE_CLIENT_ID (env var)" }, 500);
    }

    const claims = await verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID);

    const userEmail = (claims.email || "").toLowerCase();
    const isAdmin = userEmail === ADMIN_EMAIL.toLowerCase();

    // 3) Enforce model access
    if (PAID_MODELS.includes(model) && !isAdmin) {
      return json(
        {
          error:
            "This model is locked. Only the admin account can use paid models on this site.",
        },
        403
      );
    }

    // Optional: also restrict unknown model names
    if (![...FREE_MODELS, ...PAID_MODELS].includes(model)) {
      return json({ error: `Unknown model: ${model}` }, 400);
    }

    // 4) Now call the chosen provider
    let responseText = "";

    switch (model) {
      case "gemini": {
        const GEMINI_KEY = env.GEMINI_API_KEY;
        if (!GEMINI_KEY) return json({ error: "Server missing GEMINI_API_KEY" }, 500);

        const contents = messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: String(m.content || "") }],
        }));

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(
          GEMINI_KEY
        )}`;

        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents,
            generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
          }),
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
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            messages: messages.map((m) => ({
              role: m.role === "assistant" ? "assistant" : "user",
              content: String(m.content || ""),
            })),
          }),
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
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o",
            temperature: 0.7,
            messages: messages.map((m) => ({
              role: m.role,
              content: String(m.content || ""),
            })),
          }),
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
            Authorization: `Bearer ${env.XAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "grok-3",
            temperature: 0.7,
            messages: messages.map((m) => ({
              role: m.role,
              content: String(m.content || ""),
            })),
          }),
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
            Authorization: `Bearer ${env.PERPLEXITY_API_KEY}`,
          },
          body: JSON.stringify({
            model: "sonar",
            messages: messages.map((m) => ({
              role: m.role,
              content: String(m.content || ""),
            })),
          }),
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: "Perplexity API error", details: data }, r.status);

        responseText = data?.choices?.[0]?.message?.content || "No response from Perplexity";
        break;
      }
    }

    return json({ response: responseText }, 200);
  } catch (err) {
    return json({ error: err?.message || "Server error" }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders() });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// -------------------------
// Google ID token verification (RS256)
// -------------------------
async function verifyGoogleIdToken(idToken, expectedAud) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Invalid ID token format");

  const header = JSON.parse(decodeBase64UrlToString(parts[0]));
  const payload = JSON.parse(decodeBase64UrlToString(parts[1]));
  const sigBytes = decodeBase64UrlToBytes(parts[2]);

  if (header.alg !== "RS256") throw new Error("Unexpected JWT alg");
  if (!header.kid) throw new Error("Missing kid in JWT header");

  // Validate claims (before signature is okay, but we do both)
  const now = Math.floor(Date.now() / 1000);

  // issuer must be accounts.google.com or https://accounts.google.com
  if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") {
    throw new Error("Invalid issuer");
  }

  if (payload.aud !== expectedAud) throw new Error("Invalid audience (aud)");
  if (!payload.exp || now >= payload.exp) throw new Error("Token expired");

  // Fetch JWKS and verify signature
  const jwks = await getGoogleJwks();
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("No matching Google public key (kid)");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    sigBytes,
    signedData
  );

  if (!ok) throw new Error("Invalid token signature");

  return payload;
}

async function getGoogleJwks() {
  const now = Date.now();
  if (JWKS_CACHE.keys && now - JWKS_CACHE.fetchedAt < JWKS_TTL_MS) return JWKS_CACHE.keys;

  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs", { method: "GET" });
  if (!r.ok) throw new Error("Failed to fetch Google certs");
  const jwks = await r.json();

  JWKS_CACHE = { keys: jwks, fetchedAt: now };
  return jwks;
}

function decodeBase64UrlToString(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeBase64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}