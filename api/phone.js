// Vercel serverless: /api/phone?app=...&q=...&m=...
// All APIs verified working from datacenter IPs (September 2026)
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const JSON_HEADERS = { "User-Agent": UA, "Accept": "application/json" };

const strip = (s = "") =>
  s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
   .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();

// ========== YouTube (kept, marked offline in UI) ==========
const INNERTUBE = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false";
const CTX = { client: { clientName: "WEB", clientVersion: "2.20240726.00.00", hl: "en", gl: "US" } };
async function ytSearch(q) {
  try {
    const r = await fetch(INNERTUBE, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ context: CTX, query: q }),
    });
    const j = await r.json();
    const secs = j?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    const out = [];
    for (const s of secs) {
      for (const it of s.itemSectionRenderer?.contents || []) {
        const v = it.videoRenderer || it.reelItemRenderer;
        if (!v) continue;
        const vid = v.videoId;
        if (!vid || vid.length !== 11) continue;
        out.push({
          id: vid,
          title: v.title?.runs?.[0]?.text || "",
          sub: v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || "",
          meta: [v.viewCountText?.simpleText, v.publishedTimeText?.simpleText].filter(Boolean).join(" • "),
          length: v.lengthText?.simpleText || "LIVE",
          thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
          url: "https://www.youtube.com/watch?v=" + vid,
        });
      }
    }
    return { results: out.slice(0, 24) };
  } catch (e) { return { results: [], error: String(e).slice(0, 120) }; }
}

// ========== Google ==========
async function google(q) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { results: [], note: "No SERPER_API_KEY set" };
  try {
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ q, num: 15 }),
    });
    if (!r.ok) throw new Error("http " + r.status);
    const j = await r.json();
    return { results: (j.organic || []).map(x => ({ title: strip(x.title), url: x.link, snippet: strip(x.snippet || "") })), via: "serper" };
  } catch (e) { return { results: [], note: String(e).slice(0, 120) }; }
}

// ========== Wikipedia ==========
async function wiki(q) {
  const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=15&srsearch=" + encodeURIComponent(q), { headers: JSON_HEADERS });
  const j = await r.json();
  return { results: (j?.query?.search || []).map(x => ({
    title: x.title,
    url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(x.title.replace(/ /g, "_")),
    snippet: strip(x.snippet),
  })) };
}

// ========== Free AI (DuckDuckGo — verified working Sept 2026) ==========
const DDG_MODELS = {
  gpt4mini: "gpt-4o-mini",
  claude: "claude-3-haiku-20240307",
  llama: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  mistral: "mistralai/Mistral-Small-24B-Instruct-2501",
  o3mini: "o3-mini",
};
async function ddgChat(message, modelKey) {
  const model = DDG_MODELS[modelKey] || DDG_MODELS.gpt4mini;
  const statusRes = await fetch("https://duckduckgo.com/duckchat/v1/status", {
    headers: { "User-Agent": UA, "x-vqd-accept": "1", "Referer": "https://duckduckgo.com/" },
  });
  const vqd = statusRes.headers.get("x-vqd-4") || statusRes.headers.get("x-vqd-hash-1");
  if (!vqd) throw new Error("no vqd token");
  const chatRes = await fetch("https://duckduckgo.com/duckchat/v1/chat", {
    method: "POST",
    headers: {
      "User-Agent": UA, "x-vqd-4": vqd, "Content-Type": "application/json",
      "Accept": "text/event-stream", "Referer": "https://duckduckgo.com/",
      "Origin": "https://duckduckgo.com",
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: String(message).slice(0, 2000) }] }),
  });
  if (!chatRes.ok) throw new Error("ddg http " + chatRes.status);
  const text = await chatRes.text();
  let reply = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const js = line.slice(5).trim();
    if (js === "[DONE]") break;
    try { reply += JSON.parse(js).message || ""; } catch (_) {}
  }
  if (!reply) throw new Error("empty reply");
  return { reply, model: modelKey };
}

// ========== Weather ==========
async function getWeather(city) {
  const geoR = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`, { headers: JSON_HEADERS });
  const geo = await geoR.json();
  if (!geo.results?.length) throw new Error("City not found");
  const { latitude, longitude, name, country } = geo.results[0];
  const wr = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`, { headers: JSON_HEADERS });
  const w = await wr.json();
  return { city: `${name}, ${country}`, temp: w.current_weather.temperature, wind: w.current_weather.windspeed, code: w.current_weather.weathercode };
}

// ========== Crypto ==========
async function getCrypto() {
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,dogecoin,solana&vs_currencies=usd", { headers: JSON_HEADERS });
  if (!r.ok) throw new Error("coingecko http " + r.status);
  const j = await r.json();
  return { btc: j.bitcoin.usd, eth: j.ethereum.usd, doge: j.dogecoin.usd, sol: j.solana.usd };
}

// ========== Dictionary ==========
async function getDict(word) {
  const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { headers: JSON_HEADERS });
  if (!r.ok) throw new Error("Word not found");
  const j = await r.json();
  const m = j[0]?.meanings?.[0];
  return { word: j[0].word, pos: m?.partOfSpeech || "", meaning: m?.definitions?.[0]?.definition || "", example: m?.definitions?.[0]?.example || "" };
}

// ========== Pokémon ==========
async function getPokemon(name) {
  const r = await fetch(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(name.toLowerCase())}`, { headers: JSON_HEADERS });
  if (!r.ok) throw new Error("Pokémon not found");
  const j = await r.json();
  return { name: j.name, id: j.id, types: j.types.map(t => t.type.name), sprite: j.sprites.front_default, height: j.height, weight: j.weight };
}

// ========== Trivia ==========
async function getTrivia() {
  const r = await fetch("https://opentdb.com/api.php?amount=1&type=multiple", { headers: JSON_HEADERS });
  const j = await r.json();
  const q = j.results[0];
  return { question: q.question, correct: q.correct_answer, wrong: q.incorrect_answers, category: q.category };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=30");
  const { app, q, m } = req.query;
  try {
    if (app === "yt")         return res.json(await ytSearch(q || "trending"));
    if (app === "shorts")     return res.json(await ytSearch("#shorts " + (q || "viral")));
    if (app === "google")     return res.json(await google(q || ""));
    if (app === "wiki")       return res.json(await wiki(q || ""));
    if (app === "ai")         return res.json(await ddgChat(q || "", m));
    if (app === "weather")    return res.json(await getWeather(q || "London"));
    if (app === "crypto")     return res.json(await getCrypto());
    if (app === "dict")       return res.json(await getDict(q || "hello"));
    if (app === "pokemon")    return res.json(await getPokemon(q || "pikachu"));
    if (app === "trivia")     return res.json(await getTrivia());
    return res.status(400).json({ error: "bad app" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
      }
