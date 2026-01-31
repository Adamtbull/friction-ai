export default {
  async fetch(request, env) {
    var url = new URL(request.url);

    // Only respond to /api/*
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not Found", { status: 404 });
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    // ============ HEALTH CHECK ============

    if (url.pathname === "/api/health" && request.method === "GET") {
      return jsonResponse({
        ok: true,
        kvBound: Boolean(env.FRICTION_KV),
        time: new Date().toISOString()
      }, 200, request);
    }

    // ============ ADMIN ENDPOINTS ============

    // GET /api/admin/stats - Get anonymized usage statistics
    if (url.pathname === "/api/admin/stats" && request.method === "GET") {
      try {
        var adminAuth = await verifyAdminToken(request, env);
        if (!adminAuth.valid) {
          return jsonResponse({ error: "Unauthorized" }, 401, request);
        }

        if (!env.FRICTION_KV) {
          return jsonResponse(kvMissingError(), 503, request);
        }

        var stats = await getAnalyticsStats(env);
        return jsonResponse(stats, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || "Failed to get stats" }, 500, request);
      }
    }

    // GET /api/admin/users - Get user list (emails only, no content)
    if (url.pathname === "/api/admin/users" && request.method === "GET") {
      try {
        var adminAuth = await verifyAdminToken(request, env);
        if (!adminAuth.valid) {
          return jsonResponse({ error: "Unauthorized" }, 401, request);
        }

        if (!env.FRICTION_KV) {
          return jsonResponse(kvMissingError(), 503, request);
        }

        var users = await getUserList(env);
        return jsonResponse({ users: users }, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || "Failed to get users" }, 500, request);
      }
    }

    // ============ CHAT ENDPOINT ============

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        // Verify user authentication (bot protection)
        var authResult = await verifyUserToken(request, env);
        if (!authResult.valid) {
          return jsonResponse({ error: "Authentication required. Please sign in." }, 401, request);
        }

        var userEmail = authResult.email;
        var body = await request.json().catch(function () { return {}; });
        var model = body.model;
        var messages = Array.isArray(body.messages) ? body.messages : [];

        // Check model access
        var paidModels = ["claude", "gpt", "grok", "perplexity"];
        var isAdmin = userEmail === env.ADMIN_EMAIL;

        if (paidModels.indexOf(model) >= 0 && !isAdmin) {
          return jsonResponse({ error: "This model requires admin access." }, 403, request);
        }

        if (!messages.length) {
          return jsonResponse({ error: "No messages provided" }, 400, request);
        }

        // Clean/normalize messages
        var cleaned = messages
          .filter(function (m) { return m && typeof m.content === "string" && m.content.trim().length > 0; })
          .map(function (m) {
            return {
              role: m.role === "assistant" ? "assistant" : "user",
              content: m.content.trim()
            };
          });

        if (!cleaned.length) {
          return jsonResponse(
            { response: "Hey! Looks like your message didn't come through. Try sending something again?" },
            200,
            request
          );
        }

        if (cleaned[cleaned.length - 1].role !== "user") {
          return jsonResponse(
            { error: "Last message must be from user. Try again." },
            400,
            request
          );
        }

        var systemPrompt = getFamilyPlanningSystemPrompt();
        var messagesForModel = cleaned;
        if (model !== "perplexity") {
          messagesForModel = [{ role: "system", content: systemPrompt }].concat(cleaned);
        }

        var rateLimit = await enforceRateLimit(env, "chat:" + hashEmail(userEmail), 60, 600);
        if (!rateLimit.allowed) {
          return jsonResponseWithHeaders(
            { error: "Rate limit exceeded. Please wait and try again." },
            429,
            request,
            { "Retry-After": String(rateLimit.retryAfter) }
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
            responseText = await handleGemini(messagesForModel, env);
            break;
          case "claude":
            responseText = await handleClaude(messagesForModel, env);
            break;
          case "gpt":
            responseText = await handleGPT(messagesForModel, env);
            break;
          case "grok":
            responseText = await handleGrok(messagesForModel, env);
            break;
          case "perplexity":
            responseText = await handlePerplexity(cleaned, env, systemPrompt);
            break;
          default:
            return jsonResponse({ error: "Unknown model: " + model }, 400, request);
        }

        return jsonResponse({ response: responseText }, 200, request);
      } catch (err) {
        var errMsg = err && err.message ? err.message : "Server error";
        return jsonResponse({ error: errMsg }, 500, request);
      }
    }

    // ============ USER REGISTRATION ============

    // POST /api/auth/register - Track user signup
    if (url.pathname === "/api/auth/register" && request.method === "POST") {
      try {
        var authResult = await verifyUserToken(request, env);
        if (!authResult.valid) {
          return jsonResponse({ error: "Invalid token" }, 401, request);
        }

        // BUGFIX: only count signups when a brand-new user is created (previously counted every register call).
        var storeResult = await storeUser(env, authResult.email);
        if (storeResult && storeResult.isNew) {
          await logAnalytics(env, {
            type: "signup",
            userHash: hashEmail(authResult.email),
            timestamp: Date.now()
          });
        }

        return jsonResponse({ success: true }, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || "Registration failed" }, 500, request);
      }
    }

    // ============ ANALYTICS EVENT ENDPOINT ============
    // POST /api/analytics/event
    if (url.pathname === "/api/analytics/event" && request.method === "POST") {
      try {
        var analyticsAuth = await verifyUserToken(request, env);
        if (!analyticsAuth.valid) {
          return jsonResponse({ error: "Authentication required" }, 401, request);
        }

        if (!env.FRICTION_KV) {
          return jsonResponse(kvMissingError(), 503, request);
        }

        var eventBody = await request.json().catch(function () { return {}; });
        var eventName = typeof eventBody.event === "string" ? eventBody.event.trim() : "";
        var durationMs = eventBody.durationMs;

        if (!eventName || eventName.length > 64 || !/^[a-zA-Z0-9_\-:]+$/.test(eventName)) {
          return jsonResponse({ error: "Invalid event name" }, 400, request);
        }

        if (durationMs !== undefined) {
          if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 600000) {
            return jsonResponse({ error: "Invalid durationMs" }, 400, request);
          }
        }

        await trackEvent(env, hashEmail(analyticsAuth.email), eventName, durationMs);

        return jsonResponse({ success: true }, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || "Failed to track event" }, 500, request);
      }
    }

    // ============ USER DATA PERSISTENCE ============

    // GET /api/user/data - Load user's saved data (chat history, settings, goals)
    if (url.pathname === "/api/user/data" && request.method === "GET") {
      try {
        var authResult = await verifyUserToken(request, env);
        if (!authResult.valid) {
          return jsonResponse({ error: "Authentication required" }, 401, request);
        }

        return jsonResponse({ data: null }, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || "Failed to load data" }, 500, request);
      }
    }

    // POST /api/user/data - Save user's data
    if (url.pathname === "/api/user/data" && request.method === "POST") {
      try {
        var authResult = await verifyUserToken(request, env);
        if (!authResult.valid) {
          return jsonResponse({ error: "Authentication required" }, 401, request);
        }

        return jsonResponse({ success: true }, 200, request);
      } catch (err) {
        return jsonResponse({ error: err.message || "Failed to save data" }, 500, request);
      }
    }

    // ============ APPOINTMENT PARSE ENDPOINT ============
    // POST /api/appointments/structure
    if (url.pathname === "/api/appointments/structure" && request.method === "POST") {
      var bodyForFallback = {};
      try {
        // Require sign-in (same as /api/chat)
        var authResult2 = await verifyUserToken(request, env);
        if (!authResult2.valid) {
          return jsonResponse({ error: "Authentication required" }, 401, request);
        }

        var body = await request.json().catch(function () { return {}; });
        bodyForFallback = body || {};

        var rawText = typeof body.rawText === "string" ? body.rawText : "";
        var fixesText = typeof body.fixesText === "string" ? body.fixesText : "";
        var mode = body.mode === "fix" ? "fix" : "parse";

        if (!rawText.trim()) {
          return jsonResponse({ error: "rawText is required" }, 400, request);
        }

        var apptRate = await enforceRateLimit(env, "appointments:structure:" + hashEmail(authResult2.email), 20, 600);
        if (!apptRate.allowed) {
          return jsonResponseWithHeaders(
            { error: "Rate limit exceeded. Please wait and try again." },
            429,
            request,
            { "Retry-After": String(apptRate.retryAfter) }
          );
        }

        var appt = await handlePerplexityAppointment(rawText, fixesText, mode, env);
        return jsonResponse(appt, 200, request);
      } catch (err) {
        var fallback = heuristicAppointment(
          typeof bodyForFallback.rawText === "string" ? bodyForFallback.rawText : ""
        );
        return jsonResponse(
          {
            ...fallback,
            error: err && err.message ? err.message : "Failed to parse appointment"
          },
          200,
          request
        );
      }
    }

    // ============ APPOINTMENT IMAGE EXTRACT ============
    // POST /api/appointments/extract
    if (url.pathname === "/api/appointments/extract" && request.method === "POST") {
      try {
        var authResult3 = await verifyUserToken(request, env);
        if (!authResult3.valid) {
          return jsonResponse({ error: "Authentication required" }, 401, request);
        }

        var bodyExtract = await request.json().catch(function () { return {}; });
        var imageBase64 = typeof bodyExtract.imageBase64 === "string" ? bodyExtract.imageBase64 : "";
        var locale = typeof bodyExtract.locale === "string" ? bodyExtract.locale : "en-AU";
        var tz = typeof bodyExtract.tz === "string" ? bodyExtract.tz : "Australia/Sydney";

        if (!imageBase64.trim()) {
          return jsonResponse({ error: "imageBase64 is required" }, 400, request);
        }

        var extractRate = await enforceRateLimit(env, "appointments:extract:" + hashEmail(authResult3.email), 15, 600);
        if (!extractRate.allowed) {
          return jsonResponseWithHeaders(
            { error: "Rate limit exceeded. Please wait and try again." },
            429,
            request,
            { "Retry-After": String(extractRate.retryAfter) }
          );
        }

        var appointment = await extractAppointmentFromImageOpenAI(imageBase64, { locale: locale, tz: tz }, env);
        return jsonResponse({ appointment: appointment }, 200, request);
      } catch (err) {
        return jsonResponse({ error: err && err.message ? err.message : "Failed to extract appointment" }, 500, request);
      }
    }

    // ============ APPOINTMENT IMAGE SCAN ============
    // POST /api/appointments/scan
    if (url.pathname === "/api/appointments/scan" && request.method === "POST") {
      try {
        var authResultScan = await verifyUserToken(request, env);
        if (!authResultScan.valid) {
          return jsonResponse({ error: "Authentication required" }, 401, request);
        }

        var formData = await request.formData();
        var imageFile = formData.get("image");
        if (!imageFile || typeof imageFile.arrayBuffer !== "function") {
          return jsonResponse({ error: "image file is required" }, 400, request);
        }

        var scanRate = await enforceRateLimit(env, "appointments:scan:" + hashEmail(authResultScan.email), 15, 600);
        if (!scanRate.allowed) {
          return jsonResponseWithHeaders(
            { error: "Rate limit exceeded. Please wait and try again." },
            429,
            request,
            { "Retry-After": String(scanRate.retryAfter) }
          );
        }

        var appointmentScan = await extractAppointmentFromImageResponses(imageFile, env);
        return jsonResponse(appointmentScan, 200, request);
      } catch (err) {
        return jsonResponse({ error: err && err.message ? err.message : "Failed to scan appointment" }, 500, request);
      }
    }

    // ============ YOUTUBE ENDPOINTS ============

    // GET /api/youtube/resolve-channel?q=<input>
    if (url.pathname === "/api/youtube/resolve-channel" && request.method === "GET") {
      var q = url.searchParams.get("q");
      if (!q || !q.trim()) {
        return jsonResponse({ error: "Missing q query parameter." }, 400, request);
      }
      if (!env.YOUTUBE_API_KEY) {
        return jsonResponse({ error: "Server missing YOUTUBE_API_KEY." }, 500, request);
      }

      var trimmedQuery = q.trim();
      var directMatch = trimmedQuery.match(/\/channel\/(UC[a-zA-Z0-9_-]{20,})/);
      if (directMatch) {
        return jsonResponseWithHeaders(
          {
            channelId: directMatch[1],
            channelTitle: "",
            channelUrl: "https://www.youtube.com/channel/" + directMatch[1]
          },
          200,
          request,
          { "Cache-Control": "public, max-age=600" }
        );
      }

      var normalized = normalizeChannelQuery(trimmedQuery);
      var searchUrl =
        "https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=" +
        encodeURIComponent(normalized.query) +
        "&key=" +
        encodeURIComponent(env.YOUTUBE_API_KEY);
      var searchResult = await fetchJson(searchUrl);
      if (!searchResult.response.ok) {
        return jsonResponse({ error: "YouTube API error." }, 502, request);
      }
      var items = Array.isArray(searchResult.data.items) ? searchResult.data.items : [];
      if (items.length === 0) {
        return jsonResponse({ error: "Channel not found." }, 404, request);
      }
      var item = items[0];
      var channelId = item && item.id ? item.id.channelId : "";
      var channelTitle = item && item.snippet ? item.snippet.title || "" : "";
      var channelUrl = normalized.handle
        ? "https://www.youtube.com/@" + normalized.handle
        : "https://www.youtube.com/channel/" + channelId;

      return jsonResponseWithHeaders(
        {
          channelId: channelId,
          channelTitle: channelTitle,
          channelUrl: channelUrl
        },
        200,
        request,
        { "Cache-Control": "public, max-age=600" }
      );
    }

    // GET /api/youtube/channel-latest?channelId=<UC...>&limit=12
    if (url.pathname === "/api/youtube/channel-latest" && request.method === "GET") {
      var channelIdParam = url.searchParams.get("channelId");
      if (!channelIdParam || !channelIdParam.trim()) {
        return jsonResponse({ error: "Missing channelId query parameter." }, 400, request);
      }
      if (!env.YOUTUBE_API_KEY) {
        return jsonResponse({ error: "Server missing YOUTUBE_API_KEY." }, 500, request);
      }

      var limitParam = parseInt(url.searchParams.get("limit"), 10);
      if (!limitParam || limitParam < 1) limitParam = 12;
      if (limitParam > 30) limitParam = 30;

      var channelsUrl =
        "https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&id=" +
        encodeURIComponent(channelIdParam) +
        "&key=" +
        encodeURIComponent(env.YOUTUBE_API_KEY);
      var channelResult = await fetchJson(channelsUrl);
      if (!channelResult.response.ok) {
        return jsonResponse({ error: "YouTube API error." }, 502, request);
      }
      var channelItems = Array.isArray(channelResult.data.items) ? channelResult.data.items : [];
      if (channelItems.length === 0) {
        return jsonResponse({ error: "Channel not found." }, 404, request);
      }
      var channel = channelItems[0];
      var channelTitle = channel && channel.snippet ? channel.snippet.title || "" : "";
      var uploadsId =
        channel &&
        channel.contentDetails &&
        channel.contentDetails.relatedPlaylists &&
        channel.contentDetails.relatedPlaylists.uploads
          ? channel.contentDetails.relatedPlaylists.uploads
          : "";

      if (!uploadsId) {
        return jsonResponse({ error: "YouTube API error." }, 502, request);
      }

      var playlistUrl =
        "https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=" +
        encodeURIComponent(uploadsId) +
        "&maxResults=" +
        encodeURIComponent(limitParam) +
        "&key=" +
        encodeURIComponent(env.YOUTUBE_API_KEY);
      var playlistResult = await fetchJson(playlistUrl);
      if (!playlistResult.response.ok) {
        return jsonResponse({ error: "YouTube API error." }, 502, request);
      }

      var playlistItems = Array.isArray(playlistResult.data.items) ? playlistResult.data.items : [];
      var videos = playlistItems
        .map(function (item) {
          var snippet = item.snippet || {};
          var resourceId = snippet.resourceId || {};
          var videoId = resourceId.videoId || "";
          if (!videoId) return null;
          return {
            videoId: videoId,
            title: snippet.title || "",
            publishedAt: snippet.publishedAt || "",
            thumbnail: selectBestThumbnail(snippet.thumbnails || {}),
            url: "https://www.youtube.com/watch?v=" + videoId
          };
        })
        .filter(function (item) {
          return item;
        });

      return jsonResponseWithHeaders(
        {
          channel: {
            channelId: channelIdParam,
            channelTitle: channelTitle,
            channelUrl: "https://www.youtube.com/channel/" + channelIdParam
          },
          videos: videos
        },
        200,
        request,
        { "Cache-Control": "public, max-age=600" }
      );
    }

    // GET /api/youtube/channel-sample?channelId=<UC...>&pool=50
    if (url.pathname === "/api/youtube/channel-sample" && request.method === "GET") {
      var channelIdSample = url.searchParams.get("channelId");
      if (!channelIdSample || !channelIdSample.trim()) {
        return jsonResponse({ error: "Missing channelId query parameter." }, 400, request);
      }
      if (!env.YOUTUBE_API_KEY) {
        return jsonResponse({ error: "Server missing YOUTUBE_API_KEY." }, 500, request);
      }

      var poolParam = parseInt(url.searchParams.get("pool"), 10);
      if (!poolParam || poolParam < 1) poolParam = 50;
      if (poolParam > 50) poolParam = 50;

      var channelsSampleUrl =
        "https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&id=" +
        encodeURIComponent(channelIdSample) +
        "&key=" +
        encodeURIComponent(env.YOUTUBE_API_KEY);
      var channelSampleResult = await fetchJson(channelsSampleUrl);
      if (!channelSampleResult.response.ok) {
        return jsonResponse({ error: "YouTube API error." }, 502, request);
      }
      var channelSampleItems = Array.isArray(channelSampleResult.data.items) ? channelSampleResult.data.items : [];
      if (channelSampleItems.length === 0) {
        return jsonResponse({ error: "Channel not found." }, 404, request);
      }
      var channelSample = channelSampleItems[0];
      var channelSampleTitle = channelSample && channelSample.snippet ? channelSample.snippet.title || "" : "";
      var uploadsSampleId =
        channelSample &&
        channelSample.contentDetails &&
        channelSample.contentDetails.relatedPlaylists &&
        channelSample.contentDetails.relatedPlaylists.uploads
          ? channelSample.contentDetails.relatedPlaylists.uploads
          : "";

      if (!uploadsSampleId) {
        return jsonResponse({ error: "YouTube API error." }, 502, request);
      }

      var samplePlaylistUrl =
        "https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=" +
        encodeURIComponent(uploadsSampleId) +
        "&maxResults=" +
        encodeURIComponent(poolParam) +
        "&key=" +
        encodeURIComponent(env.YOUTUBE_API_KEY);
      var samplePlaylistResult = await fetchJson(samplePlaylistUrl);
      if (!samplePlaylistResult.response.ok) {
        return jsonResponse({ error: "YouTube API error." }, 502, request);
      }

      var sampleItems = Array.isArray(samplePlaylistResult.data.items) ? samplePlaylistResult.data.items : [];
      var sampleVideos = sampleItems
        .map(function (item) {
          var snippet = item.snippet || {};
          var resourceId = snippet.resourceId || {};
          var videoId = resourceId.videoId || "";
          if (!videoId) return null;
          return {
            videoId: videoId,
            title: snippet.title || "",
            publishedAt: snippet.publishedAt || "",
            thumbnail: selectBestThumbnail(snippet.thumbnails || {}),
            url: "https://www.youtube.com/watch?v=" + videoId
          };
        })
        .filter(function (item) {
          return item;
        });

      return jsonResponseWithHeaders(
        {
          channel: {
            channelId: channelIdSample,
            channelTitle: channelSampleTitle,
            channelUrl: "https://www.youtube.com/channel/" + channelIdSample
          },
          videos: sampleVideos
        },
        200,
        request,
        { "Cache-Control": "public, max-age=600" }
      );
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders(request) });
  }
};

// =====================
// CORS + RESPONSES
// =====================

function corsHeaders(request) {
  var origin = "";
  var allowOrigin = "null";
  if (request && request.headers) {
    origin = request.headers.get("Origin") || "";
    try {
      var requestUrl = new URL(request.url);
      if (origin && origin === requestUrl.origin) {
        allowOrigin = origin;
      }
    } catch (err) { }
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}

function jsonResponse(data, status, request) {
  if (!status) status = 200;
  var headers = Object.assign(
    { "Content-Type": "application/json" },
    corsHeaders(request)
  );
  return new Response(JSON.stringify(data), {
    status: status,
    headers: headers
  });
}

function jsonResponseWithHeaders(data, status, request, extraHeaders) {
  var headers = Object.assign(
    { "Content-Type": "application/json" },
    corsHeaders(request)
  );
  var merged = Object.assign({}, headers, extraHeaders || {});
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: merged
  });
}

function kvMissingError() {
  return {
    error: "Analytics unavailable. Bind the KV namespace variable FRICTION_KV in Cloudflare Worker \u2192 Settings \u2192 Bindings."
  };
}

// =====================
// YOUTUBE HELPERS
// =====================

function normalizeChannelQuery(input) {
  var trimmed = input.trim();
  var handle = "";
  var query = trimmed;

  if (trimmed.startsWith("@")) {
    handle = trimmed.slice(1);
  }

  if (!handle && /^https?:\/\//i.test(trimmed)) {
    try {
      var parsed = new URL(trimmed);
      var path = (parsed.pathname || "").replace(/\/+$/, "");
      if (path) {
        var segments = path.split("/").filter(function (segment) {
          return segment;
        });
        if (segments.length > 0) {
          var last = segments[segments.length - 1];
          query = last;
          if (last.startsWith("@")) {
            handle = last.slice(1);
          }
        }
      }
    } catch (err) {
      query = trimmed;
    }
  }

  if (handle) {
    return { handle: handle, query: handle };
  }

  return { handle: "", query: query.replace(/^@/, "") };
}

function selectBestThumbnail(thumbnails) {
  if (thumbnails.maxres && thumbnails.maxres.url) return thumbnails.maxres.url;
  if (thumbnails.standard && thumbnails.standard.url) return thumbnails.standard.url;
  if (thumbnails.high && thumbnails.high.url) return thumbnails.high.url;
  if (thumbnails.medium && thumbnails.medium.url) return thumbnails.medium.url;
  if (thumbnails.default && thumbnails.default.url) return thumbnails.default.url;
  return "";
}

async function fetchJson(url) {
  var response = await fetch(url);
  var data = await response.json().catch(function () { return {}; });
  return { response: response, data: data };
}

// =====================
// MODEL HANDLERS
// =====================

async function handleGemini(messages, env) {
  var apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Gemini API key not configured");

  var contents = messages.map(function (m) {
    return {
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    };
  });

  var endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
    encodeURIComponent(apiKey);

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
  var out =
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;
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
      messages: messages.map(function (m) {
        return { role: m.role, content: m.content };
      })
    })
  });

  var data = await res.json().catch(function () { return {}; });
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
      messages: messages.map(function (m) {
        return { role: m.role, content: m.content };
      })
    })
  });

  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    throw new Error("OpenAI API error: " + JSON.stringify(data));
  }

  var out =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;
  if (!out) throw new Error("No valid response text from GPT-4o.");
  return out;
}

function getFamilyPlanningSystemPrompt() {
  return [
    "You are a Family Operations Assistant.",
    "",
    "You power a family planning web app that uses:",
    "- bubble profiles (people + household)",
    "- pop-out bubble menus for adding items",
    "- a scrollable activity feed",
    "- ADHD-friendly task execution",
    "- weekly AI summaries",
    "",
    "Your job is to transform all inputs into structured feed cards and micro-action plans.",
    "",
    "CORE UI MODEL",
    "There are profile bubbles:",
    "- Adult profiles",
    "- Child profiles",
    "- Household profile",
    "",
    "Each bubble has a pop-out action menu.",
    "",
    "Adult bubble actions:",
    "- add roster",
    "- add appointment",
    "- add event",
    "- add goal",
    "- add shared task",
    "- add note",
    "",
    "Child bubble actions:",
    "- add appointment",
    "- add milestone",
    "- add event",
    "- add goal",
    "- add note/photo",
    "",
    "Household bubble actions:",
    "- add shared event",
    "- add shared task",
    "- generate weekly plan",
    "",
    "Every action MUST generate a FEED CARD.",
    "",
    "FEED CARD TYPES",
    "Card types include:",
    "- roster imported",
    "- appointment added",
    "- prep required",
    "- milestone added",
    "- weekly summary",
    "- priority action",
    "- micro-task",
    "- conflict warning",
    "- handoff needed",
    "",
    "Cards must be:",
    "- short",
    "- scannable",
    "- action-oriented",
    "- checkbox friendly",
    "",
    "ADHD TASK MODE (MANDATORY)",
    "All tasks must be decomposed into micro-steps:",
    "- each step is concrete",
    "- each step takes 1–5 minutes",
    "- no abstract language",
    "- no multi-decision steps",
    "",
    "Each step must include:",
    "- time estimate",
    "- starter action",
    "",
    "Include timer tags:",
    "[TIMER:3]",
    "[TIMER:5]",
    "[TIMER:10]",
    "",
    "APPOINTMENT PREP LOGIC",
    "For every appointment within 7 days:",
    "Generate a PREP CARD with:",
    "- required items",
    "- paperwork",
    "- confirmations",
    "- packing",
    "- travel timing",
    "If data missing → ask short clarification questions.",
    "",
    "ROSTER LOGIC",
    "When roster data appears:",
    "- summarise shifts",
    "- detect overlaps between adults",
    "- detect fatigue risk (late → early)",
    "- create feed cards for conflicts",
    "- create calendar-ready summaries",
    "",
    "WEEKLY SUMMARY CARD",
    "Generate a pinned weekly summary card with:",
    "- week at a glance",
    "- roster overlaps",
    "- appointment list",
    "- prep tasks",
    "- top 5 priority actions",
    "- handoff suggestions",
    "- open questions",
    "",
    "STYLE RULES",
    "Use:",
    "- bullet lists",
    "- checkboxes",
    "- short lines",
    "- operational wording",
    "",
    "Avoid:",
    "- long paragraphs",
    "- motivational speech",
    "- vague tasks",
    "",
    "Always prefer:",
    "action > explanation"
  ].join("\n");
}

function stripJsonFences(text) {
  if (!text || typeof text !== "string") return "";
  var trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    trimmed = trimmed.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  return trimmed;
}

function sanitizeAppointmentValue(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function sanitizeAuPhone(value) {
  if (typeof value !== "string") return "";
  var trimmed = value.trim();
  if (!trimmed) return "";
  if (/\\b555\\b/.test(trimmed) && !/(\\+?61|\\b0[23478])/.test(trimmed)) {
    return "";
  }
  var cleaned = trimmed.replace(/[^0-9+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("61") && cleaned[0] !== "+") {
    cleaned = "+" + cleaned;
  }
  var digits = cleaned.replace(/\\D/g, "");
  if (digits.length < 8) return "";
  return cleaned;
}

function normalizeAppointmentExtract(raw) {
  var appt = raw && raw.appointment ? raw.appointment : raw || {};
  var confidence = Number(appt.confidence);
  if (Number.isNaN(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  return {
    title: sanitizeAppointmentValue(appt.title),
    personName: sanitizeAppointmentValue(appt.personName),
    date: sanitizeAppointmentValue(appt.date),
    time: sanitizeAppointmentValue(appt.time),
    doctorName: sanitizeAppointmentValue(appt.doctorName),
    clinicName: sanitizeAppointmentValue(appt.clinicName),
    address: sanitizeAppointmentValue(appt.address),
    phone: sanitizeAuPhone(appt.phone),
    notes: sanitizeAppointmentValue(appt.notes),
    confidence: confidence
  };
}

function normalizeAppointmentScan(raw) {
  var appt = raw || {};
  return {
    title: sanitizeAppointmentValue(appt.title),
    provider: sanitizeAppointmentValue(appt.provider),
    date: sanitizeAppointmentValue(appt.date),
    time: sanitizeAppointmentValue(appt.time),
    location: sanitizeAppointmentValue(appt.location),
    phone: sanitizeAuPhone(appt.phone),
    notes: sanitizeAppointmentValue(appt.notes)
  };
}

function arrayBufferToBase64(buffer) {
  var bytes = new Uint8Array(buffer);
  var binary = "";
  for (var i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function extractAppointmentFromImageResponses(imageFile, env) {
  var apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI API key not configured");

  var buffer = await imageFile.arrayBuffer();
  var base64 = arrayBufferToBase64(buffer);
  var mimeType = imageFile.type || "image/jpeg";
  var dataUrl = "data:" + mimeType + ";base64," + base64;
  var prompt = [
    "Extract appointment details from this image.",
    "Return JSON with keys: title, provider, date, time, location, phone, notes.",
    "Date must be YYYY-MM-DD and time must be HH:mm in 24h format.",
    "Use empty strings for unknown values. No markdown."
  ].join("\\n");

  var res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl }
          ]
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "appointment_scan",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              provider: { type: "string" },
              date: { type: "string" },
              time: { type: "string" },
              location: { type: "string" },
              phone: { type: "string" },
              notes: { type: "string" }
            },
            required: ["title", "provider", "date", "time", "location", "phone", "notes"]
          }
        }
      }
    })
  });

  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    throw new Error("OpenAI API error: " + JSON.stringify(data));
  }

  var content =
    data &&
    data.output &&
    data.output[0] &&
    data.output[0].content &&
    data.output[0].content[0] &&
    data.output[0].content[0].text;
  if (!content) throw new Error("No valid response from OpenAI vision.");
  var parsed = JSON.parse(stripJsonFences(content));
  return normalizeAppointmentScan(parsed);
}

async function extractAppointmentFromImageOpenAI(imageBase64, options, env) {
  var apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI API key not configured");
  var locale = options && options.locale ? options.locale : "en-AU";
  var tz = options && options.tz ? options.tz : "Australia/Sydney";
  var prompt = [
    "Extract appointment details from this image.",
    "Return JSON only with schema:",
    '{"appointment":{"title":"","personName":"","date":"YYYY-MM-DD","time":"HH:MM","doctorName":"","clinicName":"","address":"","phone":"","notes":"","confidence":0}}',
    "Use locale " + locale + " and timezone " + tz + " to interpret dates/times.",
    "If a field is missing, use an empty string. confidence should be 0-1.",
    "Phone numbers must be AU-friendly (keep +61 or 04...); do not invent placeholders."
  ].join("\\n");

  var res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a precise assistant that returns JSON only." },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64," + imageBase64 } }
          ]
        }
      ]
    })
  });

  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    throw new Error("OpenAI API error: " + JSON.stringify(data));
  }

  var content =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;
  if (!content) throw new Error("No valid response from OpenAI vision.");
  var parsed = JSON.parse(stripJsonFences(content));
  return normalizeAppointmentExtract(parsed);
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
      messages: messages.map(function (m) {
        return { role: m.role, content: m.content };
      })
    })
  });

  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    throw new Error("Grok API error: " + JSON.stringify(data));
  }

  var out =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;
  if (!out) throw new Error("No valid response text from Grok.");
  return out;
}

async function handlePerplexity(messages, env, systemPrompt) {
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
  var systemContent = [
    systemPrompt,
    "You are a helpful assistant. Always include a 'Sources:' section at the end of your response with the full URLs of the websites you referenced, numbered to match your citations."
  ].filter(Boolean).join("\n\n");

  var messagesWithSystem = [
    {
      role: "system",
      content: systemContent
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

  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    throw new Error("Perplexity API error: " + JSON.stringify(data));
  }

  var out =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;
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

// =====================
// APPOINTMENT PARSING (Perplexity → strict JSON)
// =====================

function clampStr(s, maxLen) {
  if (typeof s !== "string") return "";
  var t = s.trim();
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function hasMedicalKeywords(text) {
  return /\b(dr|doctor|gp|clinic|hospital|medical|specialist|paediatric|appointment)\b/i.test(text || "");
}

function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  var trimmed = text.trim();

  // Already JSON?
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try { return JSON.parse(trimmed); } catch (e) { }
  }

  // Find first {...} block
  var start = trimmed.indexOf("{");
  var end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    var maybe = trimmed.slice(start, end + 1);
    try { return JSON.parse(maybe); } catch (e) { }
  }

  return null;
}

function normalizeAppointmentFields(obj, rawText) {
  var rt = (rawText || "").trim();

  var out = {
    title: clampStr(obj && obj.title, 60),
    date: clampStr(obj && obj.date, 10), // YYYY-MM-DD
    time: clampStr(obj && obj.time, 5),  // HH:MM
    venueName: clampStr(obj && obj.venueName, 80),
    address: clampStr(obj && obj.address, 140),
    contactName: clampStr(obj && obj.contactName, 60),
    phone: clampStr(obj && obj.phone, 30),
    notes: clampStr(obj && obj.notes, 2000),
    confidence: obj && obj.confidence ? obj.confidence : { source: "perplexity", score: 0.7 }
  };

  // Prevent the “whole SMS becomes title/clinic” bug
  if (out.title && rt && out.title.toLowerCase() === rt.toLowerCase()) out.title = "";
  if (out.venueName && rt && out.venueName.toLowerCase() === rt.toLowerCase()) out.venueName = "";

  // Default title
  if (!out.title) out.title = hasMedicalKeywords(rt) ? "Doctor appointment" : "Appointment";

  // Notes must include original raw text
  if (rt && (!out.notes || out.notes.indexOf(rt) === -1)) {
    out.notes = out.notes ? out.notes + "\n\nOriginal:\n" + rt : rt;
  }

  // If venueName looks like a paragraph, drop it
  if (out.venueName && out.venueName.length > 60 && /[.?!]/.test(out.venueName)) {
    out.venueName = "";
  }

  return out;
}

function heuristicAppointment(rawText) {
  var t = (rawText || "").trim();
  var title = hasMedicalKeywords(t) ? "Doctor appointment" : "Appointment";

  // AU-ish phone extraction
  var phoneMatch =
    t.match(/(\+61\s?\d{1,2}\s?\d{3,4}\s?\d{3,4})/i) ||
    t.match(/\b0\d\s?\d{4}\s?\d{4}\b/) ||
    t.match(/\b04\d{2}\s?\d{3}\s?\d{3}\b/);

  var phone = phoneMatch ? phoneMatch[0].replace(/\s+/g, " ").trim() : "";

  // Date DD/MM/YYYY
  var dateMatch = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  var date = "";
  if (dateMatch) {
    var dd = parseInt(dateMatch[1], 10);
    var mo = parseInt(dateMatch[2], 10);
    var yy = parseInt(dateMatch[3], 10);
    if (yy < 100) yy += 2000;
    if (dd >= 1 && dd <= 31 && mo >= 1 && mo <= 12) {
      date =
        String(yy).padStart(4, "0") +
        "-" +
        String(mo).padStart(2, "0") +
        "-" +
        String(dd).padStart(2, "0");
    }
  }

  // Time
  var timeMatch = t.match(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/i);
  var time = "";
  if (timeMatch) {
    var hh = parseInt(timeMatch[1], 10);
    var mm = parseInt(timeMatch[2], 10);
    var ampm = (timeMatch[3] || "").toLowerCase();
    if (!isNaN(hh) && !isNaN(mm) && mm >= 0 && mm < 60) {
      if (ampm === "pm" && hh < 12) hh += 12;
      if (ampm === "am" && hh === 12) hh = 0;
      time = String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
    }
  }

  return {
    title: title,
    date: date,
    time: time,
    venueName: "",
    address: "",
    contactName: "",
    phone: phone,
    notes: t,
    confidence: { source: "heuristic", score: 0.35 }
  };
}

async function handlePerplexityAppointment(rawText, fixesText, mode, env) {
  var apiKey = env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("Perplexity API key not configured");

  var system = {
    role: "system",
    content:
      "You extract appointment details. Output STRICT JSON only. No markdown, no commentary, no Sources. " +
      "Do NOT place the entire raw text into title or venueName. Keep fields short. " +
      "If uncertain, use empty strings. " +
      "Return date as YYYY-MM-DD and time as HH:MM (24h) if possible. " +
      "Always include notes with the original raw text."
  };

  var user = {
    role: "user",
    content:
      "RAW TEXT:\n" + rawText + "\n\n" +
      (fixesText && fixesText.trim()
        ? "USER CORRECTIONS (apply only these; do not overwrite unrelated fields):\n" + fixesText + "\n\n"
        : "") +
      "Return JSON with keys: title, date, time, venueName, address, contactName, phone, notes.\n" +
      "Mode: " + mode
  };

  var res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify({
      model: "sonar",
      temperature: 0.2,
      messages: [system, user]
    })
  });

  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error("Perplexity API error: " + JSON.stringify(data));

  var content =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;

  var obj = extractJsonObject(content || "");
  if (!obj) {
    // AI didn't obey JSON-only. Use heuristic.
    return Object.assign({}, heuristicAppointment(rawText), {
      confidence: { source: "heuristic_after_ai_nonjson", score: 0.3 }
    });
  }

  return normalizeAppointmentFields(obj, rawText);
}

// =====================
// AUTH FUNCTIONS
// =====================

async function verifyUserToken(request, env) {
  var authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { valid: false, error: "No token provided" };
  }

  var token = authHeader.substring(7);

  try {
    var verified = await verifyGoogleToken(token, env);
    if (!verified.valid) {
      return verified;
    }
    return { valid: true, email: verified.email, name: verified.name };
  } catch (err) {
    return { valid: false, error: "Token verification failed" };
  }
}

async function verifyGoogleToken(token, env) {
  if (!env.GOOGLE_CLIENT_ID) {
    return { valid: false, error: "Server missing Google client ID" };
  }

  var url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token);
  var res = await fetch(url);
  if (!res.ok) {
    return { valid: false, error: "Token verification failed" };
  }

  var data = await res.json().catch(function () { return {}; });
  if (data.aud !== env.GOOGLE_CLIENT_ID) {
    return { valid: false, error: "Invalid audience" };
  }
  if (data.iss !== "https://accounts.google.com" && data.iss !== "accounts.google.com") {
    return { valid: false, error: "Invalid issuer" };
  }
  var exp = Number(data.exp || 0);
  if (exp && exp * 1000 < Date.now()) {
    return { valid: false, error: "Token expired" };
  }
  if (!data.email) {
    return { valid: false, error: "Email missing" };
  }

  return { valid: true, email: data.email, name: data.name };
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

// =====================
// ANALYTICS FUNCTIONS
// =====================

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

    var existing = await env.FRICTION_KV.get(key);
    var dayData = existing
      ? JSON.parse(existing)
      : { messages: 0, users: {}, models: {}, signups: 0 };

    if (data.type === "message") {
      dayData.messages++;
      dayData.users[data.userHash] = (dayData.users[data.userHash] || 0) + 1;
      dayData.models[data.model] = (dayData.models[data.model] || 0) + 1;
    } else if (data.type === "signup") {
      // Signups represent brand-new user records created that day.
      dayData.signups++;
    }

    await env.FRICTION_KV.put(key, JSON.stringify(dayData), {
      expirationTtl: 90 * 24 * 60 * 60
    }); // 90 days
  } catch (err) {
    console.error("Analytics error:", err);
  }
}

async function trackEvent(env, userHash, eventName, durationMs) {
  if (!env.FRICTION_KV) return;

  try {
    var today = new Date().toISOString().split("T")[0];
    await updateEventAggregate(env, "analytics:events:" + today, 90 * 24 * 60 * 60, userHash, eventName, durationMs);
    await updateEventAggregate(env, "analytics:events:total", 365 * 24 * 60 * 60, userHash, eventName, durationMs);
  } catch (err) {
    console.error("Event analytics error:", err);
  }
}

async function updateEventAggregate(env, key, ttlSeconds, userHash, eventName, durationMs) {
  var existing = await env.FRICTION_KV.get(key);
  var aggregate = existing ? JSON.parse(existing) : { events: {}, sums: {}, users: {} };

  aggregate.events = aggregate.events || {};
  aggregate.sums = aggregate.sums || {};
  aggregate.users = aggregate.users || {};

  aggregate.events[eventName] = (aggregate.events[eventName] || 0) + 1;
  if (durationMs !== undefined) {
    var sumKey = eventName + ":durationMs";
    aggregate.sums[sumKey] = (aggregate.sums[sumKey] || 0) + durationMs;
  }
  if (userHash) {
    aggregate.users[userHash] = 1;
  }

  await env.FRICTION_KV.put(key, JSON.stringify(aggregate), {
    expirationTtl: ttlSeconds
  });
}

function mergeCountMaps(target, source) {
  if (!source) return;
  for (var key in source) {
    target[key] = (target[key] || 0) + source[key];
  }
}

async function getAnalyticsStats(env) {
  if (!env.FRICTION_KV) {
    return kvMissingError();
  }

  try {
    var stats = {
      today: null,
      last7Days: { messages: 0, uniqueUsers: 0, signups: 0, models: {} },
      last30Days: { messages: 0, uniqueUsers: 0, signups: 0, models: {} },
      eventsToday: {},
      eventsLast7Days: {},
      eventsLast30Days: {},
      durationSumsToday: {},
      durationSumsLast7Days: {},
      durationSumsLast30Days: {},
      uniqueUsersToday: 0,
      uniqueUsersLast7Days: 0,
      uniqueUsersLast30Days: 0
    };

    var allUsers7 = {};
    var allUsers30 = {};
    var eventUsers7 = {};
    var eventUsers30 = {};

    for (var i = 0; i < 30; i++) {
      var date = new Date();
      date.setDate(date.getDate() - i);
      var key = "analytics:" + date.toISOString().split("T")[0];
      var eventKey = "analytics:events:" + date.toISOString().split("T")[0];

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
        for (var model2 in parsed.models) {
          stats.last30Days.models[model2] = (stats.last30Days.models[model2] || 0) + parsed.models[model2];
        }
      }

      var eventData = await env.FRICTION_KV.get(eventKey);
      if (eventData) {
        var parsedEvent = JSON.parse(eventData);
        var eventCounts = parsedEvent.events || {};
        var durationSums = parsedEvent.sums || {};
        var usersMap = parsedEvent.users || {};

        if (i === 0) {
          stats.eventsToday = eventCounts;
          stats.durationSumsToday = durationSums;
          stats.uniqueUsersToday = Object.keys(usersMap).length;
        }

        if (i < 7) {
          mergeCountMaps(stats.eventsLast7Days, eventCounts);
          mergeCountMaps(stats.durationSumsLast7Days, durationSums);
          Object.assign(eventUsers7, usersMap);
        }

        mergeCountMaps(stats.eventsLast30Days, eventCounts);
        mergeCountMaps(stats.durationSumsLast30Days, durationSums);
        Object.assign(eventUsers30, usersMap);
      }
    }

    stats.last7Days.uniqueUsers = Object.keys(allUsers7).length;
    stats.last30Days.uniqueUsers = Object.keys(allUsers30).length;
    stats.uniqueUsersLast7Days = Object.keys(eventUsers7).length;
    stats.uniqueUsersLast30Days = Object.keys(eventUsers30).length;

    // Get total user count
    var userList = await env.FRICTION_KV.get("users:list");
    stats.totalUsers = userList ? JSON.parse(userList).length : 0;

    return stats;
  } catch (err) {
    return { error: err.message };
  }
}

async function storeUser(env, email) {
  if (!env.FRICTION_KV) return { isNew: false };

  try {
    var userList = await env.FRICTION_KV.get("users:list");
    var users = userList ? JSON.parse(userList) : [];

    var existing = users.find(function (u) { return u.email === email; });
    if (!existing) {
      users.push({
        email: email,
        signupDate: new Date().toISOString(),
        lastActive: new Date().toISOString()
      });
      await env.FRICTION_KV.put("users:list", JSON.stringify(users));
      return { isNew: true };
    }

    existing.lastActive = new Date().toISOString();
    await env.FRICTION_KV.put("users:list", JSON.stringify(users));
    return { isNew: false };
  } catch (err) {
    console.error("Store user error:", err);
    return { isNew: false };
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

async function enforceRateLimit(env, key, limit, windowSeconds) {
  if (!env.FRICTION_KV) {
    return { allowed: true, retryAfter: 0 };
  }

  var now = Date.now();
  var bucket = Math.floor(now / (windowSeconds * 1000));
  var storageKey = "rate:" + key + ":" + bucket;
  var existing = await env.FRICTION_KV.get(storageKey);
  var count = existing ? parseInt(existing, 10) : 0;

  if (count >= limit) {
    var elapsed = Math.floor((now / 1000) % windowSeconds);
    return { allowed: false, retryAfter: Math.max(1, windowSeconds - elapsed) };
  }

  await env.FRICTION_KV.put(storageKey, String(count + 1), {
    expirationTtl: windowSeconds
  });

  return { allowed: true, retryAfter: 0 };
}
