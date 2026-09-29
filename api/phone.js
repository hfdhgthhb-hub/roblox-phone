// Vercel serverless: /api/phone — FINAL FIXED VERSION
// Pollinations migrated to gen.pollinations.ai/v1 (text.pollinations.ai retired Feb 2026)
// Cascade: KeylessAI → Kilo → Pollinations-gen.  All timeouts 6s to fit Vercel Hobby 10s limit.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ALLOW = [
  "hn.algolia.com", "api.coinpaprika.com", "api.coinbase.com",
  "api.frankfurter.dev", "en.wikipedia.org", "api.dictionaryapi.dev",
  "pokeapi.co", "openlibrary.org", "covers.openlibrary.org",
  "itunes.apple.com", "www.themealdb.com", "www.thecocktaildb.com",
  "restcountries.com", "ll.thespacedevs.com", "api.artic.edu",
  "www.artic.edu", "api.jikan.moe", "api.github.com", "dog.ceo",
  "api.thecatapi.com", "official-joke-api.appspot.com", "dummyjson.com",
  "the-trivia-api.com", "opentdb.com", "geocoding-api.open-meteo.com",
  "api.open-meteo.com", "gen.pollinations.ai",
  "keylessai.thryx.workers.dev", "api.kilo.ai",
];

const ENTITIES = {
  "&amp;": "&", "&quot;": '"', "&#x27;": "'", "&#39;": "'",
  "&lt;": "<", "&gt;": ">", "&nbsp;": " ",
  "&hellip;": "...", "&mdash;": "\u2014", "&ndash;": "\u2013",
  "&rsquo;": "'", "&lsquo;": "'", "&ldquo;": '"', "&rdquo;": '"',
};
function strip(s = "") {
  let out = String(s).replace(/<[^>]+>/g, "");
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  out = out.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  return out.trim();
}

const JSON_HEADERS = { "User-Agent": UA, "Accept": "application/json" };

// ============================================================
// AI CASCADE — all providers keyless, 6s timeout each
// ============================================================
const AI_MODELS = { gpt: "openai", gpt4mini: "openai", o3mini: "openai",
  claude: "claude", llama: "llama", mistral: "mistral", gemini: "gemini" };

// Provider 1: KeylessAI (Cloudflare Worker, 4-upstream failover built in)
async function ai_keylessai(prompt, model, sys) {
  const r = await fetch("https://keylessai.thryx.workers.dev/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model === "claude" ? "claude-3-5-sonnet-latest" : "gpt-4o",
      messages: [{ role: "system", content: sys }, { role: "user", content: prompt }],
      max_tokens: 500, stream: false,
    }),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error("keylessai " + r.status);
  const j = await r.json();
  const reply = j?.choices?.[0]?.message?.content;
  if (!reply) throw new Error("keylessai empty");
  return reply;
}

// Provider 2: Kilo Gateway (no key, ~200 req/hr per IP)
async function ai_kilo(prompt, sys) {
  const r = await fetch("https://api.kilo.ai/api/gateway/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "kilo-auto/free",
      messages: [{ role: "system", content: sys }, { role: "user", content: prompt }],
      max_tokens: 500,
    }),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error("kilo " + r.status);
  const j = await r.json();
  const reply = j?.choices?.[0]?.message?.content;
  if (!reply) throw new Error("kilo empty");
  return reply;
}

// Provider 3: Pollinations gen/v1 (OpenAI-compatible, replaced retired text.pollinations.ai)
async function ai_pollinations(prompt, model, sys) {
  const pollModel = model === "claude" ? "claude"
    : model === "mistral" ? "mistral"
    : model === "llama" ? "llama"
    : model === "gemini" ? "gemini"
    : "openai";
  const r = await fetch("https://gen.pollinations.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: pollModel,
      messages: [{ role: "system", content: sys }, { role: "user", content: prompt }],
      max_tokens: 500, stream: false,
    }),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error("pollinations " + r.status);
  const j = await r.json();
  const reply = j?.choices?.[0]?.message?.content;
  if (!reply) throw new Error("pollinations empty");
  return reply;
}

// Provider 4: Pollinations GET (legacy fallback, still works on gen host)
async function ai_pollinations_get(prompt, model, sys) {
  const pollModel = model === "claude" ? "claude-airforce" : "openai";
  const u = "https://gen.pollinations.ai/text/" + encodeURIComponent(prompt)
    + "?model=" + pollModel + "&system=" + encodeURIComponent(sys);
  const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error("gen-get " + r.status);
  const t = (await r.text()).trim();
  if (!t || t.startsWith('{"error')) throw new Error("gen-get empty");
  return t;
}

async function ai(msg, m) {
  const prompt = (msg || "hi").slice(0, 1500);
  const model = AI_MODELS[m] || "openai";
  const sys = "You are ChatGPT inside a Roblox game. Reply briefly in plain text, no markdown. "
    + "If the user asks for anything 18+, illegal, hacking, cheats, exploits, "
    + "or Roblox script help, politely decline and say 'Request declined.'";

  const providers = [
    ["KeylessAI", () => ai_keylessai(prompt, model, sys)],
    ["Kilo", () => ai_kilo(prompt, sys)],
    ["Pollinations", () => ai_pollinations(prompt, model, sys)],
    ["Pollinations-GET", () => ai_pollinations_get(prompt, model, sys)],
  ];

  const errors = [];
  for (const [name, fn] of providers) {
    try {
      const reply = await fn();
      return { reply: reply.slice(0, 1500), via: name };
    } catch (e) {
      errors.push(name + ": " + String(e.message || e).slice(0, 60));
    }
  }
  return { reply: null, error: "All AI providers busy", tried: errors };
}

// ============================================================
// YouTube (may return empty from Vercel IP)
// ============================================================
async function ytSearch(q) {
  try {
    const r = await fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: "19.35.36", androidSdkVersion: 30, hl: "en", gl: "US" } },
        query: q,
      }),
      signal: AbortSignal.timeout(6000),
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
          thumb: "https://i.ytimg.com/vi/" + v.videoId + "/mqdefault.jpg",
        });
      }
    }
    if (!out.length) return { results: [], note: "YouTube returned no results" };
    return { results: out.slice(0, 20) };
  } catch (e) {
    return { results: [], note: "YouTube unavailable" };
  }
}

// ============================================================
// Google (Serper primary, DDG fallback)
// ============================================================
async function google(q) {
  const key = process.env.SERPER_API_KEY;
  if (key) {
    try {
      const r = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        body: JSON.stringify({ q, num: 15 }),
        signal: AbortSignal.timeout(6000),
      });
      if (r.ok) {
        const j = await r.json();
        const results = (j.organic || []).map(x => ({ title: strip(x.title), url: x.link, sub: strip(x.snippet || "") }));
        if (results.length) return { results };
      }
    } catch (_) {}
  }
  try {
    const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000),
    });
    const html = await r.text();
    const results = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 15) {
      let url = m[1];
      const u = url.match(/uddg=([^&]+)/);
      if (u) url = decodeURIComponent(u[1]);
      results.push({ title: strip(m[2]), url, sub: strip(m[3]) });
    }
    if (results.length) return { results };
  } catch (_) {}
  return { results: [], note: "Search unavailable" };
}

// ============================================================
// Native handlers (all keyless, all free tier)
// ============================================================
async function wiki(q) {
  q = q || "Roblox";
  const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=15&srsearch=" + encodeURIComponent(q),
    { headers: JSON_HEADERS, signal: AbortSignal.timeout(6000) });
  const j = await r.json();
  const items = (j?.query?.search || []).map(x => ({
    title: x.title, sub: strip(x.snippet), meta: "en.wikipedia.org",
    url: "https://en.wikipedia.org/wiki/" + encodeURIComponent((x.title || "").replace(/ /g, "_")),
  }));
  return { results: items };
}

async function weather(q) {
  q = q || "London";
  const geoR = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(q),
    { headers: JSON_HEADERS, signal: AbortSignal.timeout(6000) });
  const geo = await geoR.json();
  if (!geo.results || !geo.results.length) return { results: [], note: "City not found" };
  const g = geo.results[0];
  const wR = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current_weather=true`,
    { headers: JSON_HEADERS, signal: AbortSignal.timeout(6000) });
  const w = await wR.json();
  const cw = w.current_weather || {};
  return { results: [{ title: `Now in ${g.name}, ${g.country || ""}`,
    sub: `${cw.temperature ?? "?"}°C · wind ${cw.windspeed ?? "?"} km/h`, meta: `code ${cw.weathercode ?? "?"}` }] };
}

async function crypto() {
  try {
    const r = await fetch("https://api.coinpaprika.com/v1/tickers?limit=15",
      { headers: JSON_HEADERS, signal: AbortSignal.timeout(6000) });
    const arr = await r.json();
    const items = (Array.isArray(arr) ? arr : []).map(x => {
      const price = x?.quotes?.USD?.price;
      const change = x?.quotes?.USD?.percent_change_24h;
      const changeStr = (change != null) ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "";
      return { title: `${x.name} (${x.symbol})`, sub: price != null ? `$${price.toFixed(2)} ${changeStr}` : "—", meta: `rank ${x.rank ?? "?"}` };
    });
    return { results: items };
  } catch (e) { return { results: [], note: "Crypto unavailable" }; }
}

async function dict(q) {
  q = q || "hello";
  const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(q),
    { headers: JSON_HEADERS, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return { results: [], note: "Word not found" };
  const arr = await r.json();
  const items = [];
  for (const entry of (Array.isArray(arr) ? arr : [])) {
    for (const m of (entry.meanings || [])) {
      for (const d of (m.definitions || []).slice(0, 3)) {
        items.push({ title: `${entry.word} (${m.partOfSpeech || "?"})`, sub: strip(d.definition || ""), meta: strip(d.example || "") });
      }
    }
  }
  return { results: items.slice(0, 20) };
}

async function pokemon(q) {
  q = (q || "pikachu").toLowerCase().trim();
  const r = await fetch("https://pokeapi.co/api/v2/pokemon/" + encodeURIComponent(q),
    { headers: JSON_HEADERS, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return { results: [], note: "Pokemon not found" };
  const j = await r.json();
  const types = (j.types || []).map(t => t.type.name).join(", ");
  let img = j?.sprites?.front_default;
  const art = j?.sprites?.other?.["official-artwork"]?.front_default;
  if (art) img = art;
  return { results: [{ title: `${j.name} #${j.id}`, sub: `types: ${types}`, meta: `height ${j.height} · weight ${j.weight}`, img, big: true }] };
}

async function trivia() {
  const r = await fetch("https://opentdb.com/api.php?amount=1&type=multiple",
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
  const j = await r.json();
  if (!j.results || !j.results[0]) return { error: "No trivia available" };
  const q = j.results[0];
  return { question: strip(q.question), correct: strip(q.correct_answer), wrong: (q.incorrect_answers || []).map(strip), category: strip(q.category) };
}

// ============================================================
// Allow-listed proxy
// ============================================================
async function proxy(u, res) {
  let url;
  try { url = new URL(u); } catch (_) { return res.status(400).send("bad url"); }
  if (url.protocol !== "https:" || !ALLOW.some(h => url.hostname === h)) return res.status(403).send("host not allowed");
  const r = await fetch(url.toString(), {
    headers: { "User-Agent": UA, "Accept": "application/json,text/plain,*/*" },
    redirect: "follow", signal: AbortSignal.timeout(6000),
  });
  const body = await r.text();
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.status(r.ok ? 200 : r.status).send(body);
}

// ============================================================
// MAIN
// ============================================================
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=30");
  const { app, q, u, m, k } = req.query;

  if (app === "fetch") {
    if (process.env.SECRET && k !== process.env.SECRET) return res.status(403).json({ error: "forbidden" });
    return await proxy(String(u || ""), res);
  }

  res.setHeader("Content-Type", "application/json");
  try {
    if (app === "yt")      return res.status(200).json(await ytSearch(q || "trending"));
    if (app === "shorts")  return res.status(200).json(await ytSearch("#shorts " + (q || "viral")));
    if (app === "google")  return res.status(200).json(await google(q || "roblox"));
    if (app === "ai")      return res.status(200).json(await ai(q || "", String(m || "")));
    if (app === "wiki")    return res.status(200).json(await wiki(q || ""));
    if (app === "weather") return res.status(200).json(await weather(q || ""));
    if (app === "crypto")  return res.status(200).json(await crypto());
    if (app === "dict")    return res.status(200).json(await dict(q || ""));
    if (app === "pokemon") return res.status(200).json(await pokemon(q || ""));
    if (app === "trivia")  return res.status(200).json(await trivia());
    return res.status(200).json({ results: [], note: "unknown app" });
  } catch (e) {
    return res.status(200).json({ results: [], note: "server error", error: String(e.message || e).slice(0, 200) });
  }
                                                                                                }
