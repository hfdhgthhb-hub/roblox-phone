// Vercel serverless: /api/page  -> GitHub file: api/page.js
// Reads a web page for the phone Google app. Wikipedia via API, others direct then r.jina.ai.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const env = (k) => String(process.env[k] || "").trim();

function cp(n) { try { return String.fromCodePoint(n); } catch (_) { return ""; } }
function strip(s) {
  let o = String(s == null ? "" : s).replace(/<[^>]+>/g, "");
  o = o.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => cp(parseInt(h, 16)));
  o = o.replace(/&#(\d+);/g, (_, d) => cp(parseInt(d, 10)));
  return o.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
}
function isPrivate(h) {
  h = String(h || "").toLowerCase();
  return /^(localhost|127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)
    || h.indexOf(":") >= 0 || h.endsWith(".local") || h.endsWith(".internal") || /^\d+\.\d+\.\d+\.\d+$/.test(h);
}

async function wikiPage(url) {
  const host = url.hostname;
  let title = "";
  if (url.pathname.indexOf("/wiki/") === 0) title = decodeURIComponent(url.pathname.slice(6));
  else title = url.searchParams.get("title") || "";
  title = title.replace(/_/g, " ").trim();
  if (!title) return { error: "Open a Wikipedia article page" };
  const api = "https://" + host + "/w/api.php?action=query&format=json&redirects=1&prop=extracts%7Cpageimages%7Clinks"
    + "&explaintext=1&exsectionformat=wiki&piprop=thumbnail&pithumbsize=400&pllimit=20&plnamespace=0&titles=" + encodeURIComponent(title);
  const r = await fetch(api, { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return { error: "Wikipedia returned HTTP " + r.status };
  const j = await r.json();
  const pages = (j.query && j.query.pages) || {};
  const pg = pages[Object.keys(pages)[0]];
  if (!pg || pg.missing !== undefined) return { error: "Page not found" };
  const blocks = [];
  if (pg.thumbnail && pg.thumbnail.source) blocks.push({ t: "img", url: pg.thumbnail.source, text: "" });
  const stop = /^(see also|references|external links|notes|further reading|sources|footnotes)$/i;
  for (const raw of String(pg.extract || "").split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    const h = l.match(/^=+\s*(.*?)\s*=+$/);
    if (h) {
      if (stop.test(h[1])) break;
      if (h[1]) blocks.push({ t: "h", text: h[1].slice(0, 200) });
    } else if (l.length >= 30) {
      blocks.push({ t: "p", text: l.slice(0, 500) });
    }
    if (blocks.length >= 60) break;
  }
  const links = (pg.links || []).slice(0, 15).map((x) => ({
    text: x.title, url: "https://" + host + "/wiki/" + encodeURIComponent(String(x.title).replace(/ /g, "_")),
  }));
  if (blocks.length < 2) return { error: "Nothing readable on this page" };
  return { title: pg.title || title, blocks: blocks, links: links };
}

async function directPage(url) {
  if (isPrivate(url.hostname)) return { error: "Blocked address" };
  const r = await fetch(url.toString(), {
    headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow", signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) return { error: "Site returned HTTP " + r.status };
  if (!/html/i.test(r.headers.get("content-type") || "")) return { error: "Not a web page" };
  let html = (await r.text()).slice(0, 600000);
  const title = strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  html = html.replace(/<(script|style|noscript|svg|nav|footer|form)[\s\S]*?<\/\1>/gi, "");
  const blocks = [], links = [], seen = {};
  let m;
  const re = /<(h[1-3]|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  while ((m = re.exec(html)) && blocks.length < 60) {
    const text = strip(m[2]);
    if (m[1].toLowerCase().charAt(0) === "h") { if (text.length > 1) blocks.push({ t: "h", text: text.slice(0, 200) }); }
    else if (text.length >= 30) blocks.push({ t: "p", text: text.slice(0, 500) });
  }
  const lre = /<a[^>]+href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = lre.exec(html)) && links.length < 15) {
    let u;
    try { u = new URL(m[1], url); } catch (_) { continue; }
    const text = strip(m[2]);
    if (!/^https?:$/.test(u.protocol) || text.length < 3 || text.length > 80 || seen[u.href]) continue;
    seen[u.href] = 1;
    links.push({ text: text, url: u.href });
  }
  if (blocks.length < 2) return { error: "This site blocked the page (bot check)" };
  return { title: title, blocks: blocks, links: links };
}

function parseMd(md) {
  const title = ((md.match(/^Title:\s*(.+)$/m) || [])[1] || "").trim();
  const i = md.indexOf("Markdown Content:");
  if (i >= 0) md = md.slice(i + 17);
  const blocks = [], links = [], seen = {};
  for (const raw of md.split("\n")) {
    let l = raw.trim();
    if (!l || /^!\[/.test(l)) continue;
    let m;
    const lre = /\[([^\]]{3,80})\]\((https?:\/\/[^)\s]+)\)/g;
    while ((m = lre.exec(l)) && links.length < 15) {
      if (!seen[m[2]]) { seen[m[2]] = 1; links.push({ text: strip(m[1]), url: m[2] }); }
    }
    l = l.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").trim();
    const h = l.match(/^#{1,4}\s+(.*)/);
    if (h) { if (h[1].length > 1) blocks.push({ t: "h", text: h[1].slice(0, 200) }); }
    else if (l.length >= 30) blocks.push({ t: "p", text: l.slice(0, 500) });
    if (blocks.length >= 60) break;
  }
  return { title: title, blocks: blocks, links: links };
}
async function jinaPage(url) {
  const h = { "Accept": "text/plain", "X-Return-Format": "markdown", "User-Agent": UA };
  if (env("JINA_KEY")) h.Authorization = "Bearer " + env("JINA_KEY");
  const r = await fetch("https://r.jina.ai/" + url.toString(), { headers: h, signal: AbortSignal.timeout(4500) });
  const md = await r.text();
  if (!r.ok) return { error: "Reader returned HTTP " + r.status };
  if (/Target URL returned error|CAPTCHA|Just a moment/i.test(md.slice(0, 600))) return { error: "This site blocked the page (bot check)" };
  const out = parseMd(md);
  if (out.blocks.length < 2) return { error: "Nothing readable on this page" };
  return out;
}

async function page(u) {
  let url;
  try { url = new URL(u); } catch (_) { return { error: "Bad web address" }; }
  if (!/^https?:$/.test(url.protocol)) return { error: "Bad web address" };
  if (/(^|\.)wikipedia\.org$/i.test(url.hostname)) return wikiPage(url);
  let d = null;
  try { d = await directPage(url); } catch (_) { d = { error: "Site did not answer" }; }
  if (!d.error) return d;
  try {
    const j = await jinaPage(url);
    if (!j.error) return j;
  } catch (_) {}
  return d;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.setHeader("Content-Type", "application/json");
  try {
    return res.status(200).json(await page(String(req.query.u || "")));
  } catch (e) {
    return res.status(200).json({ error: "Could not load page (" + String(e && e.message || e).slice(0, 60) + ")" });
  }
                                       }
