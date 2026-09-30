import express from "express";
import { spawn } from "node:child_process";

const SECRET = process.env.SECRET || "";
const app = express();

const IMG_ALLOW = [
  "i.ytimg.com", "img.youtube.com",
  "upload.wikimedia.org", "commons.wikimedia.org",
  "covers.openlibrary.org",
  "is1-ssl.mzstatic.com", "is2-ssl.mzstatic.com", "is3-ssl.mzstatic.com",
  "is4-ssl.mzstatic.com", "is5-ssl.mzstatic.com",
  "www.themealdb.com", "www.thecocktaildb.com",
  "flagcdn.com", "restcountries.com",
  "images.unsplash.com",
  "raw.githubusercontent.com", "avatars.githubusercontent.com",
  "images.dog.ceo", "cdn2.thecatapi.com",
  "www.artic.edu", "artic-web.imgix.net",
  "cdn.myanimelist.net", "the-trivia-api.com",
  "gstatic.com",
];

function isAllowedHost(u) {
  try {
    const h = new URL(u).hostname;
    return IMG_ALLOW.some(a => h === a || h.endsWith("." + a));
  } catch (_) { return false; }
}

function auth(req, res) {
  if (!SECRET || req.query.k !== SECRET) {
    res.status(403).json({ error: "forbidden" });
    return false;
  }
  return true;
}

app.get("/img", async (req, res) => {
  if (!auth(req, res)) return;
  try {
    const url = String(req.query.url || "");
    const W = Math.min(256, Math.max(32, parseInt(req.query.w || "128", 10)));
    const H = Math.min(256, Math.max(32, parseInt(req.query.h || "128", 10)));
    if (!/^https:\/\//.test(url)) return res.json({ error: "bad url" });
    if (!isAllowedHost(url)) return res.json({ error: "host not allowed" });

    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.json({ error: "fetch " + r.status });
    const cl = parseInt(r.headers.get("content-length") || "0", 10);
    if (cl > 12 * 1024 * 1024) return res.json({ error: "too large" });
    const input = Buffer.from(await r.arrayBuffer());

    const vf = "scale=" + W + ":" + H + ":force_original_aspect_ratio=decrease,pad=" + W + ":" + H + ":(ow-iw)/2:(oh-ih)/2:black,format=rgba";
    const out2 = await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", ["-loglevel", "error", "-i", "pipe:0", "-vf", vf,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
      const bufs = [];
      const kill = setTimeout(() => { try { ff.kill("SIGKILL"); } catch (_) {} }, 8000);
      ff.stdout.on("data", d => bufs.push(d));
      ff.on("error", reject);
      ff.on("close", () => { clearTimeout(kill); resolve(Buffer.concat(bufs)); });
      ff.stdin.end(input);
    });

    if (out2.length !== W * H * 4) return res.json({ error: "bad size" });
    res.json({ w: W, h: H, data: out2.toString("base64") });
  } catch (e) {
    res.json({ error: String(e).slice(0, 200) });
  }
});

app.get("/frames", (_q, r) => r.json({ error: "video unavailable" }));
app.get("/health", (_q, r) => r.json({ ok: true }));

app.listen(process.env.PORT || 3000, () => console.log("video server up"));
