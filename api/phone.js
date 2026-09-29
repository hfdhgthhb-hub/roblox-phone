// Vercel serverless: /api/phone  (GitHub: api/phone.js)
// Always answers HTTP 200 so Roblox never shows an HTTP error.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ALLOW = [
  "hn.algolia.com", "api.coinpaprika.com", "api.coinbase.com", "api.frankfurter.app", "api.frankfurter.dev",
  "en.wikipedia.org", "api.dictionaryapi.dev", "pokeapi.co", "openlibrary.org", "covers.openlibrary.org",
  "itunes.apple.com", "www.themealdb.com", "www.thecocktaildb.com", "restcountries.com",
  "ll.thespacedevs.com", "api.artic.edu", "www.artic.edu", "api.jikan.moe", "api.github.com",
  "dog.ceo", "api.thecatapi.com", "official-joke-api.appspot.com", "dummyjson.com",
  "the-trivia-api.com", "opentdb.com", "geocoding-api.open-meteo.com", "api.open-meteo.com",
  "gen.pollinations.ai", "text.pollinations.ai",
];

const strip = (s = "") =>
  String(s).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();

// ---------- YouTube search (InnerTube) ----------
async function ytSearch(q) {
  try {
    const r = await fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "en", gl: "US" } }, query: q }),
    });
    const j = await r.json();
    const secs = j?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    const out = [];
    for (const s of secs) {
      for (const it of s.itemSectionRenderer?.contents || []) {
        const v = it.videoRenderer || it.reelItemRenderer;
        if (!v || !v.videoId || v.videoId.length !== 11) continue;
        out.push({
          id: v.videoId,
          title: v.title?.runs?.[0]?.text || v.headline?.simpleText || "",
          sub: v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || "",
          meta: [v.viewCountText?.simpleText, v.publishedTimeText?.simpleText].filter(Boolean).join(" - "),
          length: v.lengthText?.simpleText || "",
          thumbnail: "https://i.ytimg.com/vi/" + v.videoId + "/mqdefault.jpg",
        });
      }
    }
    if (!out.length) return { results: [], note: "YouTube returned no results" };
    return { results: out.slice(0, 20) };
  } catch (e) {
    return { results: [], note: "YouTube search unavailable" };
  }
}

// ---------- Google search: Serper if key exists, else DuckDuckGo HTML ----------
async function google(q) {
  const key = process.env.SERPER_API_KEY;
  if (key) {
    try {
      const r = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        body: JSON.stringify({ q, num: 15 }),
      });
      if (r.ok) {
        const j = await r.json();
        const results = (j.organic || []).map(x => ({ title: strip(x.title), url: x.link, snippet: strip(x.snippet || "") }));
        if (results.length) return { results };
      }
    } catch (e) {}
  }
  try {
    const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), { headers: { "User-Agent": UA } });
    const html = await r.text();
    const results = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 15) {
      let url = m[1];
      const u = url.match(/uddg=([^&]+)/);
      if (u) url = decodeURIComponent(u[1]);
      results.push({ title: strip(m[2]), url, snippet: strip(m[3]) });
    }
    if (results.length) return { results };
  } catch (e) {}
  return { results: [], note: "Search unavailable right now" };
}

// ---------- AI chat (Pollinations, free, no key) ----------
const AI_MODELS = { gpt: "openai", gpt4mini: "openai", claude: "claude-airforce", llama: "llama", mistral: "mistral", gemini: "gemini", o3mini: "openai" };
async function ai(msg, m) {
  const prompt = (msg || "hi").slice(0, 1500);
  const model = AI_MODELS[m] || "openai";
  const sys = encodeURIComponent(
    "You are ChatGPT inside a Roblox game. Reply briefly in plain text, no markdown. " +
    "If the user asks for anything 18+, illegal, hacking, cheats, exploits, or Roblox script help, politely decline and say 'Request declined.'"
  );
  const tries = [
    ["https://gen.pollinations.ai/text/" + encodeURIComponent(prompt) + "?model=" + model + "&system=" + sys, 18000],
    ["https://text.pollinations.ai/" + encodeURIComponent(prompt) + "?model=" + model + "&system=" + sys, 9000],
    ["https://text.pollinations.ai/" + encodeURIComponent(prompt) + "?system=" + sys, 9000],
  ];
  for (const [u, ms] of tries) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(ms) });
      if (!r.ok) continue;
      const t = (await r.text()).trim();
      if (t && !t.startsWith('{"error')) return { reply: t.slice(0, 1500) };
    } catch (e) {}
  }
  throw new Error("AI is busy, try again in a moment");
}

// ---------- generic allow-listed proxy ----------
async function proxy(u, res) {
  let url;
  try { url = new URL(u); } catch (e) { return res.status(400).send("bad url"); }
  if (url.protocol !== "https:" || !ALLOW.some(h => url.hostname === h)) return res.status(403).send("host not allowed");
  const r = await fetch(url.toString(), { headers: { "User-Agent": UA, "Accept": "application/json,text/plain,*/*" }, redirect: "follow" });
  const body = await r.text();
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.status(r.ok ? 200 : r.status).send(body);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=30");
  const { app, q, u, m } = req.query;
  try {
    if (app === "fetch") return await proxy(String(u || ""), res);
    res.setHeader("Content-Type", "application/json");
    if (app === "yt")     return res.status(200).json(await ytSearch(q || "trending"));
    if (app === "shorts") return res.status(200).json(await ytSearch("#shorts " + (q || "viral")));
    if (app === "google") return res.status(200).json(await google(q || "roblox"));
    if (app === "ai")     return res.status(200).json(await ai(q || "", String(m || "")));
    return res.status(200).json({ results: [], note: "unknown app" });
  } catch (e) {
    return res.status(200).json({ results: [], note: "server error" });
  }
    }
