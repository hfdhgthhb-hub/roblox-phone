// Vercel serverless: /api/phone?app=yt|shorts|google|wiki&q=...
// Optional env vars in Vercel: BRAVE_API_KEY, GOOGLE_API_KEY + GOOGLE_CX
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const strip = (s = "") =>
  s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
   .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();

const attr = (tag, name) => {
  const m = tag.match(new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i"));
  return m ? (m[1] ?? m[2] ?? "") : "";
};

const fixUrl = (u) => {
  u = u.replace(/&amp;/g, "&");
  const mm = u.match(/[?&]uddg=([^&]+)/);
  if (mm) u = decodeURIComponent(mm[1]);
  if (u.startsWith("//")) u = "https:" + u;
  return u;
};

// ---------------- YouTube (unchanged, works) ----------------
const INNERTUBE = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false";
const CTX = { client: { clientName: "WEB", clientVersion: "2.20240726.00.00", hl: "en", gl: "US" } };

async function ytSearch(q) {
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
      const isShort = !!it.reelItemRenderer || v.thumbnailOverlays?.some?.(o => o.thumbnailOverlayTimeStatusRenderer?.style === "SHORTS");
      out.push({
        id: vid,
        title: v.title?.runs?.[0]?.text || v.headline?.simpleText || "",
        sub: v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || "",
        meta: [v.viewCountText?.simpleText, v.publishedTimeText?.simpleText].filter(Boolean).join(" • "),
        length: v.lengthText?.simpleText || (isShort ? "Short" : "LIVE"),
        short: isShort,
        thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        url: isShort ? "https://www.youtube.com/shorts/" + vid : "https://www.youtube.com/watch?v=" + vid,
      });
    }
  }
  return { results: out.slice(0, 24) };
}

// ---------------- Web search backends (tried in order) ----------------
async function brave(q) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error("no BRAVE_API_KEY");
  const r = await fetch("https://api.search.brave.com/res/v1/web/search?count=15&q=" + encodeURIComponent(q),
    { headers: { "Accept": "application/json", "X-Subscription-Token": key } });
  if (!r.ok) throw new Error("http " + r.status);
  const j = await r.json();
  return (j.web?.results || []).map(x => ({ title: strip(x.title), url: x.url, snippet: strip(x.description || "") }));
}

async function googleCse(q) {
  const key = process.env.GOOGLE_API_KEY, cx = process.env.GOOGLE_CX;
  if (!key || !cx) throw new Error("no GOOGLE_API_KEY/GOOGLE_CX");
  const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&num=10&q=` + encodeURIComponent(q));
  if (!r.ok) throw new Error("http " + r.status);
  const j = await r.json();
  return (j.items || []).map(x => ({ title: strip(x.title), url: x.link, snippet: strip(x.snippet || "") }));
}

async function ddgLite(q) {
  const r = await fetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html" },
    body: "q=" + encodeURIComponent(q),
  });
  const h = await r.text();
  if (!r.ok && r.status !== 200) throw new Error("http " + r.status);
  const links = [...h.matchAll(/<a\b[^>]*class=['"][^'"]*result-link[^'"]*['"][^>]*>[\s\S]*?<\/a>/gi)];
  if (!links.length) throw new Error("no result-link (blocked? http " + r.status + ")");
  const out = [];
  links.forEach((m, i) => {
    const tag = m[0].match(/<a\b[^>]*>/i)[0];
    const end = m.index + m[0].length;
    const next = i + 1 < links.length ? links[i + 1].index : h.length;
    const sn = h.slice(end, next).match(/class=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/i);
    out.push({ title: strip(m[0]), url: fixUrl(attr(tag, "href")), snippet: sn ? strip(sn[1]) : "" });
  });
  return out.slice(0, 15);
}

async function ddgHtml(q) {
  const r = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html" },
    body: "q=" + encodeURIComponent(q),
  });
  const h = await r.text();
  const links = [...h.matchAll(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>[\s\S]*?<\/a>/gi)];
  if (!links.length) throw new Error("no result__a (blocked? http " + r.status + ")");
  const out = [];
  links.forEach((m, i) => {
    const tag = m[0].match(/<a\b[^>]*>/i)[0];
    const end = m.index + m[0].length;
    const next = i + 1 < links.length ? links[i + 1].index : h.length;
    const sn = h.slice(end, next).match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|td|div)>/i);
    out.push({ title: strip(m[0]), url: fixUrl(attr(tag, "href")), snippet: sn ? strip(sn[1]) : "" });
  });
  return out.slice(0, 15);
}

async function mojeek(q) {
  const r = await fetch("https://www.mojeek.com/search?q=" + encodeURIComponent(q), {
    headers: { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9" },
  });
  const h = await r.text();
  const links = [...h.matchAll(/<a\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi)];
  if (!links.length) throw new Error("no title links (http " + r.status + ")");
  const out = [];
  links.forEach((m, i) => {
    const tag = m[0].match(/<a\b[^>]*>/i)[0];
    const end = m.index + m[0].length;
    const next = i + 1 < links.length ? links[i + 1].index : h.length;
    const sn = h.slice(end, next).match(/<p\b[^>]*class=["'][^"']*\bs\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title: strip(m[0]), url: attr(tag, "href").replace(/&amp;/g, "&"), snippet: sn ? strip(sn[1]) : "" });
  });
  return out.filter(x => x.url.startsWith("http")).slice(0, 15);
}

async function marginalia(q) {
  const r = await fetch("https://api2.marginalia-search.com/search?count=15&query=" + encodeURIComponent(q),
    { headers: { "API-Key": "public", "Accept": "application/json", "User-Agent": UA } });
  if (!r.ok) throw new Error("http " + r.status);
  const j = await r.json();
  return (j.results || []).map(x => ({ title: strip(x.title || x.url), url: x.url, snippet: strip(x.description || "") }));
}

async function google(q) {
  if (!q) return { results: [] };
  const backends = [["brave", brave], ["googlecse", googleCse], ["ddg-lite", ddgLite], ["ddg-html", ddgHtml],
                    ["mojeek", mojeek], ["marginalia", marginalia]];
  const tried = [];
  for (const [name, fn] of backends) {
    try {
      const results = (await fn(q)).filter(x => x.url && x.title);
      if (results.length) return { results, via: name };
      tried.push(name + ": 0 results");
    } catch (e) {
      if (!/^no (BRAVE|GOOGLE)/.test(String(e.message))) tried.push(name + ": " + String(e.message).slice(0, 60));
    }
  }
  return { results: [], note: "All search backends failed: " + tried.join("; ") };
}

async function wiki(q) {
  const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=15&srsearch=" + encodeURIComponent(q), {
    headers: { "User-Agent": UA },
  });
  const j = await r.json();
  return { results: (j?.query?.search || []).map(x => ({
    title: x.title,
    url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(x.title.replace(/ /g, "_")),
    snippet: strip(x.snippet),
  })) };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=60");
  const { app, q } = req.query;
  try {
    if (app === "yt")     return res.json(await ytSearch(q || "trending"));
    if (app === "shorts") return res.json(await ytSearch("#shorts " + (q || "viral")));
    if (app === "google") return res.json(await google(q || ""));
    if (app === "wiki")   return res.json(await wiki(q || ""));
    return res.status(400).json({ error: "bad app" });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
