export default {
async fetch(request, env) {
var url = new URL(request.url);

```
// Only respond to /api/*
if (!url.pathname.startsWith("/api/")) {
  return new Response("Not Found", { status: 404 });
}

// CORS preflight
if (request.method === "OPTIONS") {
  return new Response(null, { headers: corsHeaders() });
}

// ============ ADMIN ENDPOINTS ============

// GET /api/admin/stats - Get anonymized usage statistics
if (url.pathname === "/api/admin/stats" && request.method === "GET") {
  try {
    var adminAuth = await verifyAdminToken(request, env);
    if (!adminAuth.valid) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    
    var stats = await getAnalyticsStats(env);
    return jsonResponse(stats, 200);
  } catch (err) {
    return jsonResponse({ error: err.message || "Failed to get stats" }, 500);
  }
}

// GET /api/admin/users - Get user list (emails only, no content)
if (url.pathname === "/api/admin/users" && request.method === "GET") {
  try {
    var adminAuth = await verifyAdminToken(request, env);
    if (!adminAuth.valid) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    
    var users = await getUserList(env);
    return jsonResponse({ users: users }, 200);
  } catch (err) {
    return jsonResponse({ error: err.message || "Failed to get users" }, 500);
  }
}

// ============ CHAT ENDPOINT ============

if (url.pathname === "/api/chat" && request.method === "POST") {
  try {
    // Verify user authentication (bot protection)
    var authResult = await verifyUserToken(request, env);
    if (!authResult.valid) {
      return jsonResponse({ error: "Authentication required. Please sign in." }, 401);
    }
    
    var userEmail = authResult.email;
    var body = await request.json().catch(function() { return {}; });
    var model = body.model;
    var messages = Array.isArray(body.messages) ? body.messages : [];

    // Check model access
    var paidModels = ["claude", "gpt", "grok", "perplexity"];
    var isAdmin = userEmail === env.ADMIN_EMAIL;
    
    if (paidModels.indexOf(model) >= 0 && !isAdmin) {
      return jsonResponse({ error: "This model requires admin access." }, 403);
    }

    if (!messages.length) {
      return jsonResponse({ error: "No messages provided" }, 400);
    }

    // Clean/normalize messages
    var cleaned = messages
      .filter(function(m) { return m && typeof m.content === "string" && m.content.trim().length > 0; })
      .map(function(m) {
        return {
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content.trim()
        };
      });

    if (!cleaned.length) {
      return jsonResponse(
        { response: "Hey! Looks like your message didn't come through. Try sending something again?" },
        200
      );
    }

    if (cleaned[cleaned.length - 1].role !== "user") {
      return jsonResponse(
        { error: "Last message must be from user. Try again." },
        400
      );
    }

    // Log analytics (anonymized - no message content)
    await logAnalytics(env, {
      type: "message",
      userHash: hashEmail(userEmail),
      model: model,
      timestamp: Date.now()
    });

    var responseText;

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
    var errMsg = err && err.message ? err.message : "Server error";
    return jsonResponse({ error: errMsg }, 500);
  }
}

// ============ USER REGISTRATION ============

// POST /api/auth/register - Track user signup
if (url.pathname === "/api/auth/register" && request.method === "POST") {
  try {
    var authResult = await verifyUserToken(request, env);
    if (!authResult.valid) {
      return jsonResponse({ error: "Invalid token" }, 401);
    }
    
    await logAnalytics(env, {
      type: "signup",
      userHash: hashEmail(authResult.email),
      timestamp: Date.now()
    });
    
    // Store user in KV (just email + signup date, no content)
    await storeUser(env, authResult.email);
    
    return jsonResponse({ success: true }, 200);
  } catch (err) {
    return jsonResponse({ error: err.message || "Registration failed" }, 500);
  }
}

return new Response("Not Found", { status: 404, headers: corsHeaders() });
```

}
};

function corsHeaders() {
return {
"Access-Control-Allow-Origin": "*",
"Access-Control-Allow-Methods": "POST, OPTIONS",
"Access-Control-Allow-Headers": "Content-Type"
};
}

function jsonResponse(data, status) {
if (!status) status = 200;
var headers = {
"Content-Type": "application/json",
"Access-Control-Allow-Origin": "*",
"Access-Control-Allow-Methods": "POST, OPTIONS",
"Access-Control-Allow-Headers": "Content-Type"
};
return new Response(JSON.stringify(data), {
status: status,
headers: headers
});
}

// ============ MODEL HANDLERS ============

async function handleGemini(messages, env) {
var apiKey = env.GEMINI_API_KEY;
if (!apiKey) throw new Error("Gemini API key not configured");

var contents = messages.map(function(m) {
return {
role: m.role === "assistant" ? "model" : "user",
parts: [{ text: m.content }]
};
});

var endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(apiKey);

var res = await fetch(endpoint, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({
contents: contents,
generationConfig: {
temperature: 0.9,
topP: 0.95,
maxOutputTokens: 2048
}
})
});

var text = await res.text();
if (!res.ok) {
throw new Error("Gemini API error: " + text);
}

var data = JSON.parse(text);
var out = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
if (!out) throw new Error("No valid response text from Gemini.");
return out;
}

async function handleClaude(messages, env) {
var apiKey = env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("Claude API key not configured");

var res = await fetch("https://api.anthropic.com/v1/messages", {
method: "POST",
headers: {
"Content-Type": "application/json",
"x-api-key": apiKey,
"anthropic-version": "2023-06-01"
},
body: JSON.stringify({
model: "claude-sonnet-4-20250514",
max_tokens: 2048,
messages: messages.map(function(m) {
return { role: m.role, content: m.content };
})
})
});

var data = await res.json().catch(function() { return {}; });
if (!res.ok) {
throw new Error("Claude API error: " + JSON.stringify(data));
}

var out = data && data.content && data.content[0] && data.content[0].text;
if (!out) throw new Error("No valid response text from Claude.");
return out;
}

async function handleGPT(messages, env) {
var apiKey = env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OpenAI API key not configured");

var res = await fetch("https://api.openai.com/v1/chat/completions", {
method: "POST",
headers: {
"Content-Type": "application/json",
"Authorization": "Bearer " + apiKey
},
body: JSON.stringify({
model: "gpt-4o",
temperature: 0.7,
messages: messages.map(function(m) {
return { role: m.role, content: m.content };
})
})
});

var data = await res.json().catch(function() { return {}; });
if (!res.ok) {
throw new Error("OpenAI API error: " + JSON.stringify(data));
}

var out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
if (!out) throw new Error("No valid response text from GPT-4o.");
return out;
}

async function handleGrok(messages, env) {
var apiKey = env.XAI_API_KEY;
if (!apiKey) throw new Error("Grok API key not configured");

var res = await fetch("https://api.x.ai/v1/chat/completions", {
method: "POST",
headers: {
"Content-Type": "application/json",
"Authorization": "Bearer " + apiKey
},
body: JSON.stringify({
model: "grok-3",
temperature: 0.7,
messages: messages.map(function(m) {
return { role: m.role, content: m.content };
})
})
});

var data = await res.json().catch(function() { return {}; });
if (!res.ok) {
throw new Error("Grok API error: " + JSON.stringify(data));
}

var out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
if (!out) throw new Error("No valid response text from Grok.");
return out;
}

async function handlePerplexity(messages, env) {
var apiKey = env.PERPLEXITY_API_KEY;
if (!apiKey) throw new Error("Perplexity API key not configured");

// Perplexity requires strict alternation: user, assistant, user, assistant
// Merge consecutive same-role messages
var alternating = [];
for (var i = 0; i < messages.length; i++) {
var msg = messages[i];
if (alternating.length === 0) {
alternating.push({ role: msg.role, content: msg.content });
} else {
var last = alternating[alternating.length - 1];
if (last.role === msg.role) {
// Merge consecutive same-role messages
last.content += "\n\n" + msg.content;
} else {
alternating.push({ role: msg.role, content: msg.content });
}
}
}

// Add system message to request full URLs in response
var messagesWithSystem = [
{
role: "system",
content: "You are a helpful assistant. Always include a 'Sources:' section at the end of your response with the full URLs of the websites you referenced, numbered to match your citations."
}
].concat(alternating);

var res = await fetch("https://api.perplexity.ai/chat/completions", {
method: "POST",
headers: {
"Content-Type": "application/json",
"Authorization": "Bearer " + apiKey
},
body: JSON.stringify({
model: "sonar",
messages: messagesWithSystem
})
});

var data = await res.json().catch(function() { return {}; });
if (!res.ok) {
throw new Error("Perplexity API error: " + JSON.stringify(data));
}

var out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
if (!out) throw new Error("No valid response text from Perplexity.");

// Also try to append citations from API response if available
var citations = data.citations;
if (citations && citations.length > 0 && out.indexOf("Sources:") === -1) {
out += "\n\nSources:";
for (var j = 0; j < citations.length; j++) {
out += "\n[" + (j + 1) + "] " + citations[j];
}
}

return out;
}

// ============ AUTH FUNCTIONS ============

async function verifyUserToken(request, env) {
var authHeader = request.headers.get("Authorization");
if (!authHeader || !authHeader.startsWith("Bearer ")) {
return { valid: false, error: "No token provided" };
}

var token = authHeader.substring(7);

try {
// Decode JWT without verification first to get the payload
var parts = token.split(".");
if (parts.length !== 3) {
return { valid: false, error: "Invalid token format" };
}

```
var payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));

// Check expiration
if (payload.exp && payload.exp * 1000 < Date.now()) {
  return { valid: false, error: "Token expired" };
}

// Check issuer (Google)
if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
  return { valid: false, error: "Invalid issuer" };
}

// Check audience (your client ID)
if (payload.aud !== env.GOOGLE_CLIENT_ID) {
  return { valid: false, error: "Invalid audience" };
}

return { valid: true, email: payload.email, name: payload.name };
```

} catch (err) {
return { valid: false, error: "Token verification failed" };
}
}

async function verifyAdminToken(request, env) {
var userAuth = await verifyUserToken(request, env);
if (!userAuth.valid) {
return userAuth;
}

if (userAuth.email !== env.ADMIN_EMAIL) {
return { valid: false, error: "Admin access required" };
}

return userAuth;
}

// ============ ANALYTICS FUNCTIONS ============

function hashEmail(email) {
// Simple hash for anonymization - not cryptographically secure but good enough for analytics
var hash = 0;
for (var i = 0; i < email.length; i++) {
var char = email.charCodeAt(i);
hash = ((hash << 5) - hash) + char;
hash = hash & hash;
}
return "user_" + Math.abs(hash).toString(36);
}

async function logAnalytics(env, data) {
if (!env.FRICTION_KV) return; // KV namespace not configured

try {
var today = new Date().toISOString().split("T")[0];
var key = "analytics:" + today;

```
var existing = await env.FRICTION_KV.get(key);
var dayData = existing ? JSON.parse(existing) : { messages: 0, users: {}, models: {}, signups: 0 };

if (data.type === "message") {
  dayData.messages++;
  dayData.users[data.userHash] = (dayData.users[data.userHash] || 0) + 1;
  dayData.models[data.model] = (dayData.models[data.model] || 0) + 1;
} else if (data.type === "signup") {
  dayData.signups++;
}

await env.FRICTION_KV.put(key, JSON.stringify(dayData), { expirationTtl: 90 * 24 * 60 * 60 }); // 90 days
```

} catch (err) {
console.error("Analytics error:", err);
}
}

async function getAnalyticsStats(env) {
if (!env.FRICTION_KV) {
return { error: "Analytics not configured" };
}

try {
var stats = {
today: null,
last7Days: { messages: 0, uniqueUsers: 0, signups: 0, models: {} },
last30Days: { messages: 0, uniqueUsers: 0, signups: 0, models: {} }
};

```
var allUsers7 = {};
var allUsers30 = {};

for (var i = 0; i < 30; i++) {
  var date = new Date();
  date.setDate(date.getDate() - i);
  var key = "analytics:" + date.toISOString().split("T")[0];
  
  var dayData = await env.FRICTION_KV.get(key);
  if (dayData) {
    var parsed = JSON.parse(dayData);
    
    if (i === 0) {
      stats.today = {
        messages: parsed.messages,
        uniqueUsers: Object.keys(parsed.users).length,
        signups: parsed.signups,
        models: parsed.models
      };
    }
    
    if (i < 7) {
      stats.last7Days.messages += parsed.messages;
      stats.last7Days.signups += parsed.signups;
      Object.assign(allUsers7, parsed.users);
      for (var model in parsed.models) {
        stats.last7Days.models[model] = (stats.last7Days.models[model] || 0) + parsed.models[model];
      }
    }
    
    stats.last30Days.messages += parsed.messages;
    stats.last30Days.signups += parsed.signups;
    Object.assign(allUsers30, parsed.users);
    for (var model in parsed.models) {
      stats.last30Days.models[model] = (stats.last30Days.models[model] || 0) + parsed.models[model];
    }
  }
}

stats.last7Days.uniqueUsers = Object.keys(allUsers7).length;
stats.last30Days.uniqueUsers = Object.keys(allUsers30).length;

// Get total user count
var userList = await env.FRICTION_KV.get("users:list");
stats.totalUsers = userList ? JSON.parse(userList).length : 0;

return stats;
```

} catch (err) {
return { error: err.message };
}
}

async function storeUser(env, email) {
if (!env.FRICTION_KV) return;

try {
var userList = await env.FRICTION_KV.get("users:list");
var users = userList ? JSON.parse(userList) : [];

```
var existing = users.find(function(u) { return u.email === email; });
if (!existing) {
  users.push({
    email: email,
    signupDate: new Date().toISOString(),
    lastActive: new Date().toISOString()
  });
  await env.FRICTION_KV.put("users:list", JSON.stringify(users));
} else {
  existing.lastActive = new Date().toISOString();
  await env.FRICTION_KV.put("users:list", JSON.stringify(users));
}
```

} catch (err) {
console.error("Store user error:", err);
}
}

async function getUserList(env) {
if (!env.FRICTION_KV) return [];

try {
var userList = await env.FRICTION_KV.get("users:list");
return userList ? JSON.parse(userList) : [];
} catch (err) {
return [];
}
}