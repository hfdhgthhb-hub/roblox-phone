// Vercel serverless: /api/phone?app=yt|shorts|google|wiki&q=...
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const strip = (s = "") =>
  s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'")
   .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

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

async function google(q) {
  const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
    headers: { "User-Agent": UA, "Accept": "text/html" },
  });
  const h = await r.text();
  const blocks = h.split('<div class="result results_links');
  const out = [];
  for (let i = 1; i < blocks.length && out.length < 15; i++) {
    const block = blocks[i];
    const titleMatch = block.match(/<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    if (titleMatch) {
      let u = titleMatch[1];
      const mm = u.match(/uddg=([^&]+)/);
      if (mm) u = decodeURIComponent(mm[1]);
      out.push({
        title: strip(titleMatch[2]),
        url: u,
        snippet: snippetMatch ? strip(snippetMatch[1]) : ""
      });
    }
  }
  return { results: out };
}

async function wiki(q) {
  const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=15&srsearch=" + encodeURIComponent(q), {
    headers: { "User-Agent": UA }
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
