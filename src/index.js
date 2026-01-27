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
      try {
        const body = await request.json().catch(() => ({}));
        const model = body.model;
        const messages = Array.isArray(body.messages) ? body.messages : [];

        if (!messages.length) {
          return jsonResponse({ error: "No messages provided" }, 400);
        }

        // Clean/normalize messages
        const cleaned = messages
          .filter(
            (m) =>
              m &&
              typeof m.content === "string" &&
              m.content.trim().length > 0
          )
          .map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content.trim(),
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

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data, status = 200) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
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
  if (!res.ok) {
    throw new Error("Gemini API error: " + text);
  }

  const data = JSON.parse(text);
  const out =
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
  if (!res.ok) {
    throw new Error("Claude API error: " + JSON.stringify(data));
  }

  const out = data && data.content && data.content[0] && data.content[0].text;
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
  if (!res.ok) {
    throw new Error("OpenAI API error: " + JSON.stringify(data));
  }

  const out =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;

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
  if (!res.ok) {
    throw new Error("Grok API error: " + JSON.stringify(data));
  }

  const out =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;

  if (!out) throw new Error("No valid response text from Grok.");
  return out;
}

async function handlePerplexity(messages, env) {
  const apiKey = env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("Perplexity API key not configured");

  // Perplexity requires strict alternation: user, assistant, user, assistant
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

  // Add system message to request full URLs in response
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
  if (!res.ok) {
    throw new Error("Perplexity API error: " + JSON.stringify(data));
  }

  let out =
    data &&
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;

  if (!out) throw new Error("No valid response text from Perplexity.");

  // Also try to append citations from API response if available
  const citations = data.citations;
  if (citations && citations.length > 0 && out.indexOf("Sources:") === -1) {
    out += "\n\nSources:";
    for (let j = 0; j < citations.length; j++) {
      out += "\n[" + (j + 1) + "] " + citations[j];
    }
  }

  return out;
}