const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function extractChannelId(input) {
  if (!input) return "";
  const trimmed = input.trim();
  if (/^UC[a-zA-Z0-9_-]{20,}$/.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/\/channel\/(UC[a-zA-Z0-9_-]{20,})/);
  return match ? match[1] : "";
}

function parseChannelQuery(input) {
  const raw = input.trim();
  let handle = "";
  let query = raw;

  if (raw.startsWith("@")) {
    handle = raw.slice(1);
  }

  if (!handle && /^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const path = url.pathname || "";
      if (path.includes("/@")) {
        handle = path.split("/@")[1].split("/")[0];
      } else if (path.startsWith("/@")) {
        handle = path.slice(2).split("/")[0];
      } else if (path.includes("/user/")) {
        query = path.split("/user/")[1].split("/")[0];
      } else if (path.includes("/c/")) {
        query = path.split("/c/")[1].split("/")[0];
      } else if (path.length > 1) {
        query = path.replace(/\//g, " ").trim() || raw;
      }
    } catch (err) {
      query = raw;
    }
  }

  if (handle) {
    return { handle };
  }

  return { query: query.replace(/^@/, "") };
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function toChannelResponse(item) {
  const channelId = item?.id?.channelId || item?.id;
  const snippet = item?.snippet || {};
  return {
    channelId,
    channelTitle: snippet.title || snippet.channelTitle || "",
    channelUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : "",
  };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");

  if (!q || !q.trim()) {
    return json({ error: "Missing q query parameter." }, 400);
  }

  if (!env.YOUTUBE_API_KEY) {
    return json({ error: "Server missing YOUTUBE_API_KEY." }, 500);
  }

  const directChannelId = extractChannelId(q);
  if (directChannelId) {
    return json(
      {
        channelId: directChannelId,
        channelTitle: "",
        channelUrl: `https://www.youtube.com/channel/${directChannelId}`,
      },
      200,
      {
        "Cache-Control": "public, max-age=600",
      }
    );
  }

  const parsed = parseChannelQuery(q);

  if (parsed.handle) {
    const handleUrl = `${YOUTUBE_API_BASE}/channels?part=snippet&forHandle=${encodeURIComponent(
      parsed.handle
    )}&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`;
    const { response, data } = await fetchJson(handleUrl);
    if (!response.ok) {
      return json({ error: "YouTube API error.", details: data }, 502);
    }
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length > 0) {
      return json(toChannelResponse(items[0]), 200, {
        "Cache-Control": "public, max-age=600",
      });
    }
  }

  const query = parsed.query || q;
  const searchUrl = `${YOUTUBE_API_BASE}/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(
    query
  )}&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`;
  const { response, data } = await fetchJson(searchUrl);
  if (!response.ok) {
    return json({ error: "YouTube API error.", details: data }, 502);
  }
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) {
    return json({ error: "Channel not found." }, 404);
  }

  return json(toChannelResponse(items[0]), 200, {
    "Cache-Control": "public, max-age=600",
  });
}
