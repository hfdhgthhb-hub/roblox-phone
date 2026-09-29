// Vercel serverless: /api/phone  (v4)  -> GitHub file: api/phone.js
// YouTube: Data API (optional key) -> InnerTube WEB -> InnerTube ANDROID -> Piped
// Google : Serper -> Brave -> DuckDuckGo -> Wikipedia fallback
// AI     : races every provider you have keys for + keyless ones
// Optional Vercel env vars: YT_KEY, SERPER_API_KEY, BRAVE_KEY, GROQ_KEY,
//   OPENROUTER_KEY, OPENROUTER_MODEL, GEMINI_KEY, POLLINATIONS_KEY, SECRET

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const ALLOW = [
  "hn.algolia.com", "api.coinpaprika.com", "api.coingecko.com", "api.coinbase.com",
  "api.frankfurter.dev", "en.wikipedia.org", "api.dictionaryapi.dev",
  "pokeapi.co", "openlibrary.org", "covers.openlibrary.org",
  "itunes.apple.com", "www.themealdb.com", "www.thecocktaildb.com",
  "restcountries.com", "ll.thespacedevs.com", "lldev.thespacedevs.com", "api.artic.edu",
  "www.artic.edu", "api.jikan.moe", "api.github.com", "dog.ceo",
  "api.thecatapi.com", "official-joke-api.appspot.com", "dummyjson.com",
  "the-trivia-api.com", "opentdb.com", "geocoding-api.open-meteo.com",
  "api.open-meteo.com",
];

const ENTITIES = {
  "&amp;": "&", "&quot;": "\u0022", "&#x27;": "\u0027", "&#39;": "\u0027",
  "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&hellip;": "...",
  "&mdash;": "-", "&ndash;": "-", "&rsquo;": "\u0027", "&lsquo;": "\u0027",
  "&ldquo;": "\u0022", "&rdquo;": "\u0022",
};
function strip(s) {
  let out = String(s == null ? "" : s).replace(/<[^>]+>/g, "");
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  out = out.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  return out.trim();
}

const env = (k) => String(process.env[k] || "").trim();
const JH = { "User-Agent": UA, "Accept": "application/json" };

async function jget(url, ms, headers) {
  const r = await fetch(url, { headers: headers || JH, signal: AbortSignal.timeout(ms || 6000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function jpost(url, body, headers, ms) {
  const r = await fetch(url, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json", "User-Agent": UA }, headers || {}),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms || 8000),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

// ---------------------------------------------------------------- YouTube
function txt(x) {
  if (!x) return "";
  if (typeof x === "string") return x;
  if (x.simpleText) return x.simpleText;
  if (Array.isArray(x.runs)) return x.runs.map((r) => r.text || "").join("");
  return "";
}
function collectVideos(node, out, seen, depth) {
  if (!node || typeof node !== "object" || depth > 14 || out.length >= 30) return;
  if (Array.isArray(node)) {
    for (const n of node) collectVideos(n, out, seen, depth + 1);
    return;
  }
  const id = node.videoId;
  const title = txt(node.title) || txt(node.headline);
  if (typeof id === "string" && id.length === 11 && title && !seen[id]) {
    seen[id] = true;
    const sub = txt(node.ownerText) || txt(node.longBylineText) || txt(node.shortBylineText) || "";
    const views = txt(node.viewCountText) || txt(node.shortViewCountText) || "";
    const when = txt(node.publishedTimeText) || "";
    out.push({
      id: id,
      title: strip(title),
      sub: strip(sub),
      meta: [views, when].filter(Boolean).join(" - "),
      length: txt(node.lengthText) || "",
      thumb: "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg",
    });
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === "object") collectVideos(v, out, seen, depth + 1);
  }
}
async function innertube(q, client, ua) {
  const j = await jpost(
    "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
    { context: { client: client }, query: q },
    { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9", "Origin": "https://www.youtube.com" },
    7000
  );
  const out = [];
  collectVideos(j, out, {}, 0);
  if (!out.length) throw new Error("no videos");
  return out;
}
async function ytApi(q, shorts, trending) {
  const key = env("YT_KEY");
  if (!key) throw new Error("no key");
  let url;
  if (trending) {
    url = "https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&regionCode=US&maxResults=20&key=" + key;
  } else {
    url = "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=20&q="
      + encodeURIComponent(q) + (shorts ? "&videoDuration=short" : "") + "&key=" + key;
  }
  const j = await jget(url, 6000);
  const out = (j.items || []).map((x) => {
    const id = typeof x.id === "string" ? x.id : (x.id && x.id.videoId);
    const sn = x.snippet || {};
    const th = sn.thumbnails || {};
    return {
      id: id,
      title: strip(sn.title || ""),
      sub: strip(sn.channelTitle || ""),
      meta: (sn.publishedAt || "").slice(0, 10),
      length: "",
      thumb: (th.medium && th.medium.url) || (th.default && th.default.url) || ("https://i.ytimg.com/vi/" + id + "/mqdefault.jpg"),
    };
  }).filter((x) => x.id);
  if (!out.length) throw new Error("api empty");
  return out;
}
const PIPED = ["https://pipedapi.kavin.rocks", "https://pipedapi.adminforge.de", "https://api.piped.private.coffee"];
async function piped(q) {
  return Promise.any(PIPED.map(async (base) => {
    const j = await jget(base + "/search?filter=videos&q=" + encodeURIComponent(q), 5000);
    const out = (j.items || []).map((x) => {
      const m = String(x.url || "").match(/v=([\w-]{11})/);
      if (!m) return null;
      return {
        id: m[1], title: strip(x.title || ""), sub: strip(x.uploaderName || ""),
        meta: [x.views != null ? x.views + " views" : "", x.uploadedDate || ""].filter(Boolean).join(" - "),
        length: x.duration > 0 ? Math.floor(x.duration / 60) + ":" + String(x.duration % 60).padStart(2, "0") : "",
        thumb: "https://i.ytimg.com/vi/" + m[1] + "/mqdefault.jpg",
      };
    }).filter(Boolean);
    if (!out.length) throw new Error("piped empty");
    return out;
  }));
}
async function ytSearch(q, shorts) {
  const trending = (q === "trending" || q === "");
  const query = shorts ? "#shorts " + q : q;
  const tries = [];
  if (env("YT_KEY")) tries.push(() => ytApi(q, shorts, trending && !shorts));
  tries.push(() => innertube(query, { clientName: "WEB", clientVersion: "2.20260301.00.00", hl: "en", gl: "US" }, UA));
  tries.push(() => innertube(query, { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en", gl: "US" },
    "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip"));
  tries.push(() => piped(query));
  const errs = [];
  for (const t of tries) {
    try {
      const out = await t();
      return { results: out.slice(0, 20) };
    } catch (e) {
      errs.push(String(e && e.message || e).slice(0, 40));
    }
  }
  return { results: [], note: "YouTube blocked this server (" + errs.join(", ") + "). Add YT_KEY in Vercel env." };
}

// ---------------------------------------------------------------- Wikipedia / Google
async function wiki(q) {
  q = q || "Roblox";
  const j = await jget("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=15&srsearch=" + encodeURIComponent(q), 6000);
  const items = ((j && j.query && j.query.search) || []).map((x) => ({
    title: x.title,
    sub: strip(x.snippet),
    meta: "en.wikipedia.org",
    url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(String(x.title || "").replace(/ /g, "_")),
  }));
  return { results: items };
}
async function google(q) {
  q = q || "roblox";
  const sk = env("SERPER_API_KEY");
  if (sk) {
    try {
      const j = await jpost("https://google.serper.dev/search", { q: q, num: 15 }, { "X-API-KEY": sk }, 6000);
      const results = (j.organic || []).map((x) => ({ title: strip(x.title), url: x.link, meta: x.link, sub: strip(x.snippet || "") }));
      if (results.length) return { results: results };
    } catch (_) {}
  }
  const bk = env("BRAVE_KEY");
  if (bk) {
    try {
      const j = await jget("https://api.search.brave.com/res/v1/web/search?count=15&q=" + encodeURIComponent(q), 6000,
        { "Accept": "application/json", "X-Subscription-Token": bk });
      const results = ((j.web && j.web.results) || []).map((x) => ({ title: strip(x.title), url: x.url, meta: x.url, sub: strip(x.description || "") }));
      if (results.length) return { results: results };
    } catch (_) {}
  }
  try {
    const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000),
    });
    const html = await r.text();
    const results = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 15) {
      let url = m[1];
      const u = url.match(/uddg=([^&]+)/);
      if (u) url = decodeURIComponent(u[1]);
      results.push({ title: strip(m[2]), url: url, meta: url, sub: strip(m[3]) });
    }
    if (results.length) return { results: results };
  } catch (_) {}
  try {
    const w = await wiki(q);
    if (w.results.length) {
      w.results.unshift({ title: "Showing Wikipedia results", sub: "Google search API is not set up. Add SERPER_API_KEY or BRAVE_KEY in Vercel.", meta: "" });
      return w;
    }
  } catch (_) {}
  return { results: [], note: "Search unavailable" };
}

// ---------------------------------------------------------------- AI
const SYS = "You are a helpful assistant inside a Roblox game phone. Reply briefly in plain text, no markdown. If the user asks for anything 18+, illegal, hacking, cheats, exploits, or Roblox script help, politely decline and say Request declined.";
async function oai(url, key, model, prompt, extra) {
  const body = Object.assign({
    model: model,
    messages: [{ role: "system", content: SYS }, { role: "user", content: prompt }],
    max_tokens: 400,
    stream: false,
  }, extra || {});
  const j = await jpost(url, body, key ? { Authorization: "Bearer " + key } : {}, 8500);
  const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!t) throw new Error("empty");
  return t;
}
async function gemini(prompt) {
  const model = env("GEMINI_MODEL") || "gemini-2.5-flash";
  const j = await jpost(
    "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + env("GEMINI_KEY"),
    { systemInstruction: { parts: [{ text: SYS }] }, contents: [{ role: "user", parts: [{ text: prompt }] }] },
    {}, 8500);
  const t = j && j.candidates && j.candidates[0] && j.candidates[0].content
    && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
  if (!t) throw new Error("empty");
  return t;
}
async function ai(msg, m) {
  const prompt = String(msg || "hi").slice(0, 1500);
  const P = [];
  if (env("GROQ_KEY")) P.push(["Groq", () => oai("https://api.groq.com/openai/v1/chat/completions", env("GROQ_KEY"), "llama-3.3-70b-versatile", prompt)]);
  if (env("OPENROUTER_KEY")) {
    const main = env("OPENROUTER_MODEL") || "openrouter/free";
    P.push(["OpenRouter", () => oai("https://openrouter.ai/api/v1/chat/completions", env("OPENROUTER_KEY"), main, prompt,
      { models: [main, "meta-llama/llama-3.3-70b-instruct:free"] })]);
  }
  if (env("GEMINI_KEY")) P.push(["Gemini", () => gemini(prompt)]);
  const pk = env("POLLINATIONS_KEY");
  P.push(["Pollinations", () => oai("https://gen.pollinations.ai/v1/chat/completions", pk, m === "mistral" ? "mistral" : "openai", prompt)]);
  P.push(["KeylessAI", () => oai("https://keylessai.thryx.workers.dev/v1/chat/completions", "", "gpt-4o", prompt)]);
  P.push(["Kilo", () => oai("https://api.kilo.ai/api/gateway/chat/completions", "", "kilo-auto/free", prompt)]);
  const errs = [];
  try {
    return await Promise.any(P.map(([name, fn]) =>
      fn().then((t) => ({ reply: String(t).slice(0, 1500), via: name }))
        .catch((e) => { errs.push(name + ": " + String(e && e.message || e).slice(0, 40)); throw e; })));
  } catch (_) {
    return { reply: null, error: "All AI providers failed. Add GROQ_KEY (free) in Vercel env.", tried: errs };
  }
}

// ---------------------------------------------------------------- small APIs
const WMO = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 80: "Rain showers", 81: "Rain showers", 82: "Violent showers",
  95: "Thunderstorm", 96: "Thunderstorm + hail", 99: "Thunderstorm + hail",
};
async function weather(q) {
  q = q || "London";
  const geo = await jget("https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(q), 6000);
  if (!geo.results || !geo.results.length) return { results: [], note: "City not found" };
  const g = geo.results[0];
  const w = await jget("https://api.open-meteo.com/v1/forecast?latitude=" + g.latitude + "&longitude=" + g.longitude
    + "&current_weather=true&daily=temperature_2m_max,temperature_2m_min&timezone=auto", 6000);
  const cw = w.current_weather || {};
  const items = [{
    title: "Now in " + g.name + ", " + (g.country || ""),
    sub: (cw.temperature != null ? cw.temperature : "?") + " C - " + (WMO[cw.weathercode] || "Unknown"),
    meta: "wind " + (cw.windspeed != null ? cw.windspeed : "?") + " km/h",
  }];
  const d = w.daily || {};
  (d.time || []).slice(0, 5).forEach((day, i) => {
    items.push({ title: day, sub: "High " + d.temperature_2m_max[i] + " C  /  Low " + d.temperature_2m_min[i] + " C", meta: "" });
  });
  return { results: items };
}
async function crypto() {
  try {
    const arr = await jget("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=15&page=1", 6000);
    return {
      results: arr.map((x) => ({
        title: x.name + " (" + String(x.symbol || "").toUpperCase() + ")",
        sub: "$" + x.current_price + "  " + (x.price_change_percentage_24h != null ? (x.price_change_percentage_24h >= 0 ? "+" : "") + x.price_change_percentage_24h.toFixed(2) + "%" : ""),
        meta: "rank " + x.market_cap_rank,
      })),
    };
  } catch (_) {}
  try {
    const arr = await jget("https://api.coinpaprika.com/v1/tickers?limit=15", 6000);
    return {
      results: arr.map((x) => {
        const u = x.quotes && x.quotes.USD;
        const ch = u && u.percent_change_24h;
        return {
          title: x.name + " (" + x.symbol + ")",
          sub: u && u.price != null ? "$" + u.price.toFixed(2) + "  " + (ch != null ? (ch >= 0 ? "+" : "") + ch.toFixed(2) + "%" : "") : "-",
          meta: "rank " + x.rank,
        };
      }),
    };
  } catch (_) {}
  return { results: [], note: "Crypto unavailable" };
}
async function dict(q) {
  q = q || "hello";
  const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(q), { headers: JH, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return { results: [], note: "Word not found" };
  const arr = await r.json();
  const items = [];
  for (const entry of (Array.isArray(arr) ? arr : [])) {
    for (const m of (entry.meanings || [])) {
      for (const d of (m.definitions || []).slice(0, 3)) {
        items.push({ title: entry.word + " (" + (m.partOfSpeech || "?") + ")", sub: strip(d.definition || ""), meta: strip(d.example || "") });
      }
    }
  }
  return { results: items.slice(0, 20) };
}
async function pokemon(q) {
  q = String(q || "pikachu").toLowerCase().trim();
  const r = await fetch("https://pokeapi.co/api/v2/pokemon/" + encodeURIComponent(q), { headers: JH, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return { results: [], note: "Pokemon not found" };
  const j = await r.json();
  const types = (j.types || []).map((t) => t.type.name).join(", ");
  let img = j.sprites && j.sprites.front_default;
  const art = j.sprites && j.sprites.other && j.sprites.other["official-artwork"] && j.sprites.other["official-artwork"].front_default;
  if (art) img = art;
  return { results: [{ title: j.name + " #" + j.id, sub: "types: " + types, meta: "height " + j.height + " - weight " + j.weight, img: img, big: true }] };
}
async function trivia() {
  try {
    const j = await jget("https://opentdb.com/api.php?amount=1&type=multiple", 5000);
    const q = j.results && j.results[0];
    if (q) return { question: strip(q.question), correct: strip(q.correct_answer), wrong: (q.incorrect_answers || []).map(strip), category: strip(q.category) };
  } catch (_) {}
  const j2 = await jget("https://the-trivia-api.com/v2/questions?limit=1", 6000);
  const q2 = j2 && j2[0];
  if (!q2) return { error: "No trivia available" };
  return { question: strip(q2.question && q2.question.text), correct: strip(q2.correctAnswer), wrong: (q2.incorrectAnswers || []).map(strip), category: strip(q2.category) };
}

// ---------------------------------------------------------------- allow-list proxy (fallback for Roblox)
async function proxy(u, res) {
  let url;
  try { url = new URL(u); } catch (_) { return res.status(400).send("bad url"); }
  if (url.protocol !== "https:" || !ALLOW.some((h) => url.hostname === h)) return res.status(403).send("host not allowed");
  const r = await fetch(url.toString(), {
    headers: { "User-Agent": UA, "Accept": "application/json,text/plain,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(7000),
  });
  const body = await r.text();
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.status(r.ok ? 200 : r.status).send(body);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=30");
  const { app, q, u, m, k } = req.query;

  if (app === "fetch") {
    if (process.env.SECRET && k !== process.env.SECRET) return res.status(403).json({ error: "forbidden" });
    try { return await proxy(String(u || ""), res); }
    catch (e) { return res.status(502).send("proxy error"); }
  }

  res.setHeader("Content-Type", "application/json");
  try {
    if (app === "yt") return res.status(200).json(await ytSearch(String(q || "trending"), false));
    if (app === "shorts") return res.status(200).json(await ytSearch(String(q || "viral"), true));
    if (app === "google") return res.status(200).json(await google(String(q || "roblox")));
    if (app === "ai") return res.status(200).json(await ai(String(q || ""), String(m || "")));
    if (app === "wiki") return res.status(200).json(await wiki(String(q || "")));
    if (app === "weather") return res.status(200).json(await weather(String(q || "")));
    if (app === "crypto") return res.status(200).json(await crypto());
    if (app === "dict") return res.status(200).json(await dict(String(q || "")));
    if (app === "pokemon") return res.status(200).json(await pokemon(String(q || "")));
    if (app === "trivia") return res.status(200).json(await trivia());
    if (app === "ping") return res.status(200).json({ ok: true });
    return res.status(200).json({ results: [], note: "unknown app" });
  } catch (e) {
    return res.status(200).json({ results: [], note: "server error", error: String(e && e.message || e).slice(0, 200) });
  }
}
