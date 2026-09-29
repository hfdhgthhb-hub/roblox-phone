// Vercel serverless: /api/phone — FIXED
// Adds native handlers for wiki/weather/crypto/dict/pokemon/trivia.
// Fixes strip() numeric-entity decoding. Always answers HTTP 200.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ALLOW = [
  "hn.algolia.com", "api.coinpaprika.com", "api.coinbase.com",
  "api.frankfurter.app", "api.frankfurter.dev",
  "en.wikipedia.org", "api.dictionaryapi.dev", "pokeapi.co",
  "openlibrary.org", "covers.openlibrary.org",
  "itunes.apple.com", "www.themealdb.com", "www.thecocktaildb.com",
  "restcountries.com", "ll.thespacedevs.com",
  "api.artic.edu", "www.artic.edu",
  "api.jikan.moe", "api.github.com",
  "dog.ceo", "api.thecatapi.com",
  "official-joke-api.appspot.com", "dummyjson.com",
  "the-trivia-api.com", "opentdb.com",
  "geocoding-api.open-meteo.com", "api.open-meteo.com",
  "gen.pollinations.ai", "text.pollinations.ai",
];

// ---------- HTML strip (handles named + numeric entities) ----------
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
// YouTube search (InnerTube) — same as before, kept as-is
// ============================================================
async function ytSearch(q) {
  try {
    const r = await fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "en", gl: "US" } },
        query: q,
      }),
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
    return { results: [], note: "YouTube search unavailable" };
  }
}

// ============================================================
// Google (Serper, fallback DDG HTML)
// ============================================================
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
        const results = (j.organic || []).map(x => ({
          title: strip(x.title), url: x.link, sub: strip(x.snippet || ""),
        }));
        if (results.length) return { results };
      }
    } catch (_) {}
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
      results.push({ title: strip(m[2]), url, sub: strip(m[3]) });
    }
    if (results.length) return { results };
  } catch (_) {}
  return { results: [], note: "Search unavailable right now" };
}

// ============================================================
// AI (Pollinations, free, no key)
// ============================================================
const AI_MODELS = {
  gpt: "openai", gpt4mini: "openai", o3mini: "openai",
  claude: "claude-airforce",
  llama: "llama", mistral: "mistral", gemini: "gemini",
};
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
    } catch (_) {}
  }
  throw new Error("AI is busy, try again in a moment");
}

// ============================================================
// NEW NATIVE HANDLERS
// ============================================================

// ---------- Wikipedia ----------
async function wiki(q) {
  q = q || "Roblox";
  const r = await fetch(
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=15&srsearch=" + encodeURIComponent(q),
    { headers: JSON_HEADERS }
  );
  const j = await r.json();
  const items = (j?.query?.search || []).map(x => ({
    title: x.title,
    sub: strip(x.snippet),
    meta: "en.wikipedia.org",
    url: "https://en.wikipedia.org/wiki/" + encodeURIComponent((x.title || "").replace(/ /g, "_")),
  }));
  return { results: items };
}

// ---------- Weather ----------
async function weather(q) {
  q = q || "London";
  const geoR = await fetch(
    "https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(q),
    { headers: JSON_HEADERS }
  );
  const geo = await geoR.json();
  if (!geo.results || !geo.results.length) return { results: [], note: "City not found" };
  const g = geo.results[0];
  const wR = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current_weather=true`,
    { headers: JSON_HEADERS }
  );
  const w = await wR.json();
  const cw = w.current_weather || {};
  return {
    results: [{
      title: `Now in ${g.name}, ${g.country || ""}`,
      sub: `${cw.temperature ?? "?"}°C · wind ${cw.windspeed ?? "?"} km/h`,
      meta: `weather code ${cw.weathercode ?? "?"}`,
    }],
  };
}

// ---------- Crypto (CoinPaprika) ----------
async function crypto() {
  try {
    const r = await fetch("https://api.coinpaprika.com/v1/tickers?limit=15", { headers: JSON_HEADERS });
    const arr = await r.json();
    const items = (Array.isArray(arr) ? arr : []).map(x => {
      const price = x?.quotes?.USD?.price;
      const change = x?.quotes?.USD?.percent_change_24h;
      const changeStr = (change != null) ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "";
      return {
        title: `${x.name} (${x.symbol})`,
        sub: price != null ? `$${price.toFixed(2)} ${changeStr}` : "—",
        meta: `rank ${x.rank ?? "?"}`,
      };
    });
    return { results: items };
  } catch (e) {
    return { results: [], note: "Crypto data unavailable" };
  }
}

// ---------- Dictionary ----------
async function dict(q) {
  q = q || "hello";
  const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(q), { headers: JSON_HEADERS });
  if (!r.ok) return { results: [], note: "Word not found" };
  const arr = await r.json();
  const items = [];
  for (const entry of (Array.isArray(arr) ? arr : [])) {
    for (const m of (entry.meanings || [])) {
      for (const d of (m.definitions || []).slice(0, 3)) {
        items.push({
          title: `${entry.word} (${m.partOfSpeech || "?"})`,
          sub: strip(d.definition || ""),
          meta: strip(d.example || ""),
        });
      }
    }
  }
  return { results: items.slice(0, 20) };
}

// ---------- Pokemon ----------
async function pokemon(q) {
  q = (q || "pikachu").toLowerCase().trim();
  const r = await fetch("https://pokeapi.co/api/v2/pokemon/" + encodeURIComponent(q), { headers: JSON_HEADERS });
  if (!r.ok) return { results: [], note: "Pokemon not found" };
  const j = await r.json();
  const types = (j.types || []).map(t => t.type.name).join(", ");
  let img = j?.sprites?.front_default;
  const art = j?.sprites?.other?.["official-artwork"]?.front_default;
  if (art) img = art;
  return {
    results: [{
      title: `${j.name} #${j.id}`,
      sub: `types: ${types}`,
      meta: `height ${j.height} · weight ${j.weight}`,
      img,
      big: true,
    }],
  };
}

// ---------- Trivia (special shape: {question, correct, wrong, category}) ----------
async function trivia() {
  const r = await fetch("https://opentdb.com/api.php?amount=1&type=multiple", { headers: { "User-Agent": UA } });
  const j = await r.json();
  if (!j.results || !j.results[0]) return { error: "No trivia available" };
  const q = j.results[0];
  return {
    question: strip(q.question),
    correct: strip(q.correct_answer),
    wrong: (q.incorrect_answers || []).map(strip),
    category: strip(q.category),
  };
}

// ============================================================
// Allow-listed proxy (used by PhoneServer for apps without native handlers)
// ============================================================
async function proxy(u, res) {
  let url;
  try { url = new URL(u); } catch (_) { return res.status(400).send("bad url"); }
  if (url.protocol !== "https:" || !ALLOW.some(h => url.hostname === h)) {
    return res.status(403).send("host not allowed");
  }
  const r = await fetch(url.toString(), {
    headers: { "User-Agent": UA, "Accept": "application/json,text/plain,*/*" },
    redirect: "follow",
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
  const { app, q, u, m } = req.query;

  try {
    // Raw proxy path returns text/plain, not JSON
    if (app === "fetch") return await proxy(String(u || ""), res);

    res.setHeader("Content-Type", "application/json");

    if (app === "yt")      return res.status(200).json(await ytSearch(q || "trending"));
    if (app === "shorts")  return res.status(200).json(await ytSearch("#shorts " + (q || "viral")));
    if (app === "google")  return res.status(200).json(await google(q || "roblox"));
    if (app === "ai")      return res.status(200).json(await ai(q || "", String(m || "")));

    // New native handlers
    if (app === "wiki")    return res.status(200).json(await wiki(q || ""));
    if (app === "weather") return res.status(200).json(await weather(q || ""));
    if (app === "crypto")  return res.status(200).json(await crypto());
    if (app === "dict")    return res.status(200).json(await dict(q || ""));
    if (app === "pokemon") return res.status(200).json(await pokemon(q || ""));
    if (app === "trivia")  return res.status(200).json(await trivia());

    return res.status(200).json({ results: [], note: "unknown app: " + String(app || "") });
  } catch (e) {
    return res.status(200).json({ results: [], note: "server error", error: String(e.message || e).slice(0, 200) });
  }
      }
