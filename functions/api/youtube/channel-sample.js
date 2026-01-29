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

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const channelId = url.searchParams.get("channelId");
  const poolParam = url.searchParams.get("pool");

  if (!channelId) {
    return json({ error: "Missing channelId query parameter." }, 400);
  }

  if (!env.YOUTUBE_API_KEY) {
    return json({ error: "Server missing YOUTUBE_API_KEY." }, 500);
  }

  let pool = 50;
  if (poolParam) {
    const parsed = parseInt(poolParam, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      return json({ error: "Invalid pool parameter." }, 400);
    }
    pool = Math.min(parsed, 50);
  }

  const channelUrl = `${YOUTUBE_API_BASE}/channels?part=contentDetails,snippet&id=${encodeURIComponent(
    channelId
  )}&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`;
  const { response: channelResponse, data: channelData } = await fetchJson(channelUrl);
  if (!channelResponse.ok) {
    return json({ error: "YouTube API error.", details: channelData }, 502);
  }
  const channelItems = Array.isArray(channelData.items) ? channelData.items : [];
  if (channelItems.length === 0) {
    return json({ error: "Channel not found." }, 404);
  }

  const channelItem = channelItems[0];
  const uploadsId = channelItem?.contentDetails?.relatedPlaylists?.uploads;
  const channelTitle = channelItem?.snippet?.title || "";

  if (!uploadsId) {
    return json({ error: "Uploads playlist not found." }, 404);
  }

  const playlistUrl = `${YOUTUBE_API_BASE}/playlistItems?part=snippet&playlistId=${encodeURIComponent(
    uploadsId
  )}&maxResults=${pool}&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`;
  const { response: playlistResponse, data: playlistData } = await fetchJson(playlistUrl);
  if (!playlistResponse.ok) {
    return json({ error: "YouTube API error.", details: playlistData }, 502);
  }

  const playlistItems = Array.isArray(playlistData.items) ? playlistData.items : [];
  const videos = playlistItems
    .map((item) => {
      const snippet = item?.snippet || {};
      const videoId = snippet?.resourceId?.videoId;
      if (!videoId) return null;
      return {
        videoId,
        title: snippet.title || "",
        publishedAt: snippet.publishedAt || "",
        thumbnail: pickBestThumbnail(snippet.thumbnails),
        url: `https://www.youtube.com/watch?v=${videoId}`,
      };
    })
    .filter(Boolean);

  return json(
    {
      channel: {
        channelId,
        channelTitle,
        channelUrl: `https://www.youtube.com/channel/${channelId}`,
      },
      videos,
    },
    200,
    {
      "Cache-Control": "public, max-age=600",
    }
  );
}
