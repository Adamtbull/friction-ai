// functions/api/youtube/metadata.js

const YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3/videos";
const MAX_IDS = 50;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function pickBestThumbnail(thumbnails) {
  if (!thumbnails) return "";
  return (
    thumbnails.maxres?.url ||
    thumbnails.standard?.url ||
    thumbnails.high?.url ||
    thumbnails.medium?.url ||
    thumbnails.default?.url ||
    ""
  );
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const idsParam = url.searchParams.get("ids");

  if (!idsParam) {
    return json({ error: "Missing ids query parameter." }, 400);
  }

  const ids = idsParam
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return json({ error: "No valid video IDs provided." }, 400);
  }

  if (ids.length > MAX_IDS) {
    return json({ error: `Too many ids. Maximum is ${MAX_IDS}.` }, 400);
  }

  if (!env.YOUTUBE_API_KEY) {
    return json({ error: "Server missing YOUTUBE_API_KEY." }, 500);
  }

  const apiUrl = `${YOUTUBE_API_URL}?part=snippet,contentDetails&id=${encodeURIComponent(
    ids.join(",")
  )}&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`;

  const response = await fetch(apiUrl);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return json({ error: "YouTube API error.", details: data }, 502);
  }

  const items = Array.isArray(data.items) ? data.items : [];
  const result = {};

  items.forEach((item) => {
    const videoId = item?.id;
    if (!videoId) return;
    const snippet = item?.snippet || {};
    const thumbnail = pickBestThumbnail(snippet.thumbnails);

    result[videoId] = {
      videoId,
      title: snippet.title || "",
      channelTitle: snippet.channelTitle || "",
      publishedAt: snippet.publishedAt || "",
      thumbnail: thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
  });

  return json(result, 200, {
    "Cache-Control": "public, max-age=1200",
  });
}
