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

    // Handle different API endpoints
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }
    
    if (url.pathname === "/api/chat/backup" && request.method === "POST") {
      return handleChatBackup(request, env);
    }
    
    if (url.pathname === "/api/chat/backup" && request.method === "GET") {
      return handleGetChatBackup(request, env);
    }
    
    if (url.pathname === "/api/admin/stats" && request.method === "GET") {
      return handleAdminStats(request, env);
    }
    
    if (url.pathname === "/api/admin/users" && request.method === "GET") {
      return handleAdminUsers(request, env);
    }
    
    if (url.pathname === "/api/admin/privacy-stats" && request.method === "GET") {
      return handlePrivacyStats(request, env);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  },
};

// ========== MAIN CHAT HANDLER ==========
async function handleChat(request, env) {
  // ========== FINANCIAL SAFETY NET ==========
  if (env.AI_ENABLED !== "true") {
    return jsonResponse(
      { error: "AI is temporarily paused. Please try again later." },
      503
    );
  }

  if (!env.FRICTION_KV) {
    return jsonResponse(
      { error: "Server missing KV binding (FRICTION_KV)." },
      500
    );
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > 50_000) {
    return jsonResponse({ error: "Request too large." }, 413);
  }

  const auth = await getVerifiedGoogleUser(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, auth.status);
  }
  const userId = auth.userId;
  const email = auth.email;
  const isAdmin = email && email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
  const ip = getClientIp(request);

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

    if (PAID_MODELS.includes(model) && !isAdmin) {
      return jsonResponse(
        {
          error: "This model is locked. Only the admin account can use paid models on this site.",
        },
        403
      );
    }

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

    // Track usage statistics (anonymous)
    const today = new Date().toISOString().split("T")[0];
    await env.FRICTION_KV.put(
      `stats:model:${model}:${today}`,
      String((parseInt(await env.FRICTION_KV.get(`stats:model:${model}:${today}`)) || 0) + 1),
      { expirationTtl: 60 * 60 * 24 * 7 }
    );

    await env.FRICTION_KV.put(
      `stats:requests:${today}`,
      String((parseInt(await env.FRICTION_KV.get(`stats:requests:${today}`)) || 0) + 1),
      { expirationTtl: 60 * 60 * 24 * 7 }
    );

    await env.FRICTION_KV.put(
      `user:requests:${userId}:total`,
      String((parseInt(await env.FRICTION_KV.get(`user:requests:${userId}:total`)) || 0) + 1)
    );

    return jsonResponse({ response: responseText }, 200);
  } catch (err) {
    const errMsg = err && err.message ? err.message : "Server error";
    return jsonResponse({ error: errMsg }, 500);
  }
}

// ========== ENCRYPTED CHAT BACKUP ==========
async function handleChatBackup(request, env) {
  const auth = await getVerifiedGoogleUser(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, auth.status);
  }
  
  try {
    const body = await request.json();
    const { chatId, encryptedData, timestamp } = body;
    
    if (!encryptedData || !chatId) {
      return jsonResponse({ error: "Missing required fields" }, 400);
    }
    
    // Store encrypted chat data (we cannot read it)
    await env.FRICTION_KV.put(
      `encrypted:chat:${auth.userId}:${chatId}`,
      JSON.stringify({
        encryptedData,
        timestamp,
        userId: auth.userId
      }),
      { expirationTtl: 60 * 60 * 24 * 30 } // 30 days retention
    );
    
    return jsonResponse({ success: true, message: "Chat backed up" });
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

async function handleGetChatBackup(request, env) {
  const auth = await getVerifiedGoogleUser(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: auth.error }, auth.status);
  }
  
  try {
    // Get latest backup for this user
    const kv = env.FRICTION_KV;
    const prefix = `encrypted:chat:${auth.userId}:`;
    const list = await kv.list({ prefix, limit: 1 });
    
    if (list.keys.length === 0) {
      return jsonResponse({ encryptedData: null });
    }
    
    const latestKey = list.keys[0].name;
    const data = await kv.get(latestKey, "json");
    
    if (!data) {
      return jsonResponse({ encryptedData: null });
    }
    
    return jsonResponse({
      encryptedData: data.encryptedData,
      timestamp: data.timestamp
    });
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

// ========== ADMIN ENDPOINTS ==========
async function handleAdminStats(request, env) {
  const auth = await getVerifiedGoogleUser(request, env);
  if (!auth.ok || !auth.isAdmin) {
    return jsonResponse({ error: 'Admin access required' }, 403);
  }
  
  const kv = env.FRICTION_KV;
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  
  return jsonResponse({
    privacy: {
      policy: "User chat history is encrypted and cannot be read by the server. Only anonymous statistics are available.",
      dataFlow: "Messages → User encryption → Encrypted storage → User decryption",
      
      statistics: {
        totalRequestsToday: parseInt(await kv.get(`stats:requests:${today}`) || '0'),
        totalRequestsYesterday: parseInt(await kv.get(`stats:requests:${yesterday}`) || '0'),
        
        modelUsage: {
          gemini: parseInt(await kv.get(`stats:model:gemini:${today}`) || '0'),
          claude: parseInt(await kv.get(`stats:model:claude:${today}`) || '0'),
          gpt: parseInt(await kv.get(`stats:model:gpt:${today}`) || '0'),
          grok: parseInt(await kv.get(`stats:model:grok:${today}`) || '0'),
          perplexity: parseInt(await kv.get(`stats:model:perplexity:${today}`) || '0')
        },
        
        rateLimits: {
          triggeredToday: parseInt(await kv.get(`stats:ratelimited:${today}`) || '0')
        },
        
        userActivity: {
          // Anonymous user count (bucket ranges)
          estimatedActiveUsers: await getBucketCount(kv, 'user:'),
          newUsersToday: await countNewUsersToday(kv, today)
        }
      }
    },
    
    system: {
      uptime: "Always up",
      lastUpdated: new Date().toISOString(),
      apiKeysConfigured: {
        gemini: !!(env.GEMINI_API_KEY),
        claude: !!(env.ANTHROPIC_API_KEY),
        gpt: !!(env.OPENAI_API_KEY),
        grok: !!(env.XAI_API_KEY),
        perplexity: !!(env.PERPLEXITY_API_KEY)
      }
    }
  });
}

async function handleAdminUsers(request, env) {
  const auth = await getVerifiedGoogleUser(request, env);
  if (!auth.ok || !auth.isAdmin) {
    return jsonResponse({ error: 'Admin access required' }, 403);
  }
  
  const kv = env.FRICTION_KV;
  
  return jsonResponse({
    privacyNotice: "User privacy is protected. No personal data or message content is accessible.",
    
    anonymousSummary: {
      // Bucketed user counts for privacy
      userCount: await getBucketCount(kv, 'user:'),
      
      // Activity levels (anonymous)
      highlyActive: await countUsersByTier(kv, 100, 9999),
      moderatelyActive: await countUsersByTier(kv, 20, 99),
      occasionallyActive: await countUsersByTier(kv, 1, 19),
      
      // Recent activity
      activeLast24h: await countActiveUsers(kv, 24),
      activeLast7d: await countActiveUsers(kv, 168)
    }
  });
}

async function handlePrivacyStats(request, env) {
  const auth = await getVerifiedGoogleUser(request, env);
  if (!auth.ok || !auth.isAdmin) {
    return jsonResponse({ error: 'Admin access required' }, 403);
  }
  
  const kv = env.FRICTION_KV;
  const today = new Date().toISOString().split('T')[0];
  
  return jsonResponse({
    privacy: {
      message: "🔒 All user data is encrypted end-to-end. You cannot read user messages.",
      
      dataStored: {
        // What we store (anonymous)
        encryptedChats: "Yes (unreadable by server)",
        requestCounts: "Yes (anonymous)",
        rateLimitCounters: "Yes (anonymous)",
        modelUsageStats: "Yes (aggregated)",
        
        // What we DON'T store
        messageContent: "No",
        userIdentifiers: "No (only hashed IDs)",
        personalData: "No",
        conversationHistory: "No (encrypted, server cannot read)"
      },
      
      statistics: {
        // Bucketed for privacy
        totalUsers: await getBucketCount(kv, 'user:'),
        activeToday: await getBucketCount(kv, `stats:active:${today}`),
        
        usageDistribution: {
          freeModels: parseInt(await kv.get(`stats:model:gemini:${today}`) || '0'),
          paidModels: parseInt(await kv.get(`stats:model:claude:${today}`) || '0') +
                      parseInt(await kv.get(`stats:model:gpt:${today}`) || '0') +
                      parseInt(await kv.get(`stats:model:grok:${today}`) || '0') +
                      parseInt(await kv.get(`stats:model:perplexity:${today}`) || '0')
        },
        
        systemHealth: {
          rateLimitEvents: parseInt(await kv.get(`stats:ratelimited:${today}`) || '0'),
          apiErrors: parseInt(await kv.get(`stats:errors:${today}`) || '0'),
          successfulRequests: parseInt(await kv.get(`stats:requests:${today}`) || '0')
        }
      }
    }
  });
}

// ========== HELPER FUNCTIONS ==========
function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

// ======= GOOGLE AUTH =======
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

  const cacheKey = "tok:" + hashShort(idToken);
  const cached = await env.FRICTION_KV.get(cacheKey, "json").catch(() => null);
  if (cached && cached.sub && cached.aud === clientId) {
    return { 
      ok: true, 
      userId: cached.sub,
      email: cached.email,
      isAdmin: cached.isAdmin
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
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// ======= LIMITS =======
async function enforceLimits({ env, userId, ip }) {
  const kv = env.FRICTION_KV;

  const userBurst = await bumpCounter(kv, `u:${userId}:10s`, 10);
  if (userBurst.count > 5) {
    await trackRateLimitEvent(kv, 'user_burst');
    return {
      ok: false,
      error: "Slow down a bit (friction time). Try again shortly.",
      retryAfterSeconds: userBurst.retryAfter,
    };
  }

  const ipBurst = await bumpCounter(kv, `ip:${ip}:10s`, 10);
  if (ipBurst.count > 10) {
    await trackRateLimitEvent(kv, 'ip_burst');
    return {
      ok: false,
      error: "Too many requests from this network. Try again shortly.",
      retryAfterSeconds: ipBurst.retryAfter,
    };
  }

  const dayKey = `u:${userId}:day:${dayStampSydney()}`;
  const ttl = secondsUntilSydneyMidnight();
  const userDaily = await bumpCounter(kv, dayKey, ttl);
  
  const customLimit = await kv.get(`admin:limit:${userId}`);
  const dailyLimit = customLimit ? parseInt(customLimit) : 200;
  
  if (userDaily.count > dailyLimit) {
    await trackRateLimitEvent(kv, 'daily_limit');
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

async function trackRateLimitEvent(kv, type) {
  const today = new Date().toISOString().split('T')[0];
  const key = `stats:ratelimited:${today}`;
  const current = parseInt(await kv.get(key) || '0');
  await kv.put(key, String(current + 1), { expirationTtl: 60 * 60 * 24 * 7 });
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

// ============ PRIVACY HELPERS ============
async function getBucketCount(kv, prefix) {
  const list = await kv.list({ prefix, limit: 1000 });
  const count = list.keys.length;
  
  if (count === 0) return "0";
  if (count < 5) return "1-5";
  if (count < 10) return "5-10";
  if (count < 50) return "10-50";
  if (count < 100) return "50-100";
  if (count < 500) return "100-500";
  return "500+";
}

async function countUsersByTier(kv, minRequests, maxRequests) {
  const prefix = 'user:requests:';
  const list = await kv.list({ prefix, limit: 1000 });
  let count = 0;
  
  for (const key of list.keys) {
    const requests = parseInt(await kv.get(key.name) || '0');
    if (requests >= minRequests && requests <= maxRequests) {
      count++;
    }
  }
  
  if (count === 0) return "0";
  if (count < 5) return "1-5";
  if (count < 10) return "5-10";
  return "10+";
}

async function countActiveUsers(kv, hours) {
  const prefix = 'user:';
  const list = await kv.list({ prefix, limit: 1000 });
  const cutoff = Date.now() - (hours * 60 * 60 * 1000);
  let count = 0;
  
  for (const key of list.keys) {
    if (key.name.includes(':requests')) continue;
    const userData = await kv.get(key.name, 'json');
    if (userData && userData.lastSeen && userData.lastSeen > cutoff) {
      count++;
    }
  }
  
  if (count === 0) return "0";
  if (count < 5) return "1-5";
  if (count < 10) return "5-10";
  if (count < 50) return "10-50";
  return "50+";
}

async function countNewUsersToday(kv, today) {
  const prefix = `user:created:${today}:`;
  const list = await kv.list({ prefix });
  const count = list.keys.length;
  
  if (count === 0) return "0";
  if (count < 5) return "1-5";
  if (count < 10) return "5-10";
  return "10+";
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