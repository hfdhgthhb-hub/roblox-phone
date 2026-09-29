import express from "express";
import { spawn, execFile } from "node:child_process";

const SECRET = process.env.SECRET || "";
const FPS = 8, SEG_SEC = 10, SEG_FRAMES = FPS * SEG_SEC;
const LW = 160, LH = 90;
const MAX_FF = 3;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ============ Resolver sources (ordered by reliability in 2026) ============
// Piped is currently the most resilient free frontend
const PIPED = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.private.coffee",
  "https://pipedapi.leptons.xyz",
  "https://pipedapi.drgns.space",
  "https://piped-api.lunar.icu",
  "https://pipedapi.reallyaweso.me",
  "https://pipedapi.ducks.party",
];

// Cobalt instances (some work for YouTube)
const COBALT = [
  "https://cobalt-api.kwiatekmiki.com",
  "https://api.cobalt.tools",
  "https://co.eepy.today",
  "https://cobalt-api.ayo.tf",
];

// Invidious instances (fallback)
const INVIDIOUS = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://invidious.f5.si",
  "https://iv.melmac.space",
  "https://invidious.privacyredirect.com",
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const app = express();

let active = 0;
const waitq = [];
function acquire() { return new Promise(res => { if (active < MAX_FF) { active++; res(); } else waitq.push(res); }); }
function release() { const n = waitq.shift(); if (n) n(); else active--; }

// ============ Stream resolver ============
const urlCache = new Map();

// --- Piped resolver ---
async function tryPiped(id) {
  for (const base of PIPED) {
    try {
      const r = await fetch(`${base}/streams/${id}`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      if (!j.videoStreams || !j.videoStreams.length) continue;
      // Sort by height ascending, pick smallest >= 240
      const streams = j.videoStreams
        .filter(s => s.url && s.videoOnly !== true)
        .sort((a, b) => (a.height || 9999) - (b.height || 9999));
      const pick = streams.find(s => s.height >= 240 && s.height <= 480) || streams[0];
      if (!pick || !pick.url) continue;
      console.log(`[piped] ${base} resolved ${id} -> ${pick.height}p`);
      return pick.url;
    } catch (_) { continue; }
  }
  return null;
}

// --- Cobalt resolver ---
async function tryCobalt(id) {
  for (const base of COBALT) {
    try {
      const r = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA },
        body: JSON.stringify({
          url: `https://www.youtube.com/watch?v=${id}`,
          videoQuality: "360",
          youtubeVideoCodec: "h264",
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.status !== "stream" && j.status !== "redirect") continue;
      if (!j.url) continue;
      console.log(`[cobalt] ${base} resolved ${id}`);
      return j.url;
    } catch (_) { continue; }
  }
  return null;
}

// --- Invidious resolver ---
async function tryInvidious(id) {
  for (const base of INVIDIOUS) {
    try {
      const r = await fetch(`${base}/api/v1/videos/${id}?fields=formatStreams,adaptiveFormats`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      let streams = (j.formatStreams || []).filter(s => s.url && s.container === "mp4");
      if (!streams.length) {
        streams = (j.adaptiveFormats || [])
          .filter(s => s.url && s.type && s.type.startsWith("video/"))
          .map(s => ({ url: s.url, resolution: s.resolution || ((s.height || 0) + "p"), container: "mp4" }));
      }
      if (!streams.length) continue;
      streams.sort((a, b) => (parseInt(a.resolution) || 9999) - (parseInt(b.resolution) || 9999));
      const pick = streams.find(s => {
        const h = parseInt(s.resolution);
        return h >= 240 && h <= 480;
      }) || streams[0];
      console.log(`[inv] ${base} resolved ${id} -> ${pick.resolution}`);
      return pick.url;
    } catch (_) { continue; }
  }
  return null;
}

// --- yt-dlp fallback ---
function tryYtDlp(id) {
  return new Promise((resolve, reject) => {
    const args = ["-g", "--no-playlist", "--no-warnings", "--no-check-certificates",
      "--force-ipv4", "--socket-timeout", "15", "--retries", "2",
      "--extractor-args", "youtube:player_client=default;player_skip=webpage",
      "https://www.youtube.com/watch?v=" + id];
    execFile("yt-dlp", args, { timeout: 25000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(err);
      const url = out.split("\n").map(s => s.trim()).find(s => s.startsWith("http"));
      if (!url) return reject(new Error("no url"));
      resolve(url);
    });
  });
}

async function resolveStream(id) {
  const hit = urlCache.get(id);
  if (hit && hit.exp > Date.now()) return hit.url;

  // Try Piped first (most reliable in 2026)
  let url = await tryPiped(id);
  
  // Then cobalt
  if (!url) url = await tryCobalt(id);
  
  // Then Invidious
  if (!url) url = await tryInvidious(id);
  
  // Finally yt-dlp
  if (!url) {
    try { url = await tryYtDlp(id); } catch (e) { url = null; }
  }
  
  if (!url) throw new Error("All sources failed for " + id);

  urlCache.set(id, { url, exp: Date.now() + 20 * 60 * 1000 });
  return url;
}

// ============ FFmpeg ============
function runFFmpeg(url, ss, dur, vert, wantImage) {
  return new Promise((resolve, reject) => {
    const W = vert ? LH : LW, H = vert ? LW : LH;
    let args;
    if (wantImage) {
      args = ["-loglevel", "error", "-i", url,
        "-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,format=rgba`,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"];
    } else {
      args = ["-loglevel", "error", "-ss", String(ss), "-i", url, "-t", String(dur), "-an",
        "-vf", `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,format=rgba`,
        "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"];
    }
    const ff = spawn("ffmpeg", args);
    const bufs = [];
    const timer = setTimeout(() => { try { ff.kill("SIGKILL"); } catch(_){} }, 60000);
    ff.stdout.on("data", d => bufs.push(d));
    ff.stderr.on("data", () => {});
    ff.on("error", e => { clearTimeout(timer); reject(e); });
    ff.on("close", () => { clearTimeout(timer); resolve(Buffer.concat(bufs)); });
  });
}

// ============ Routes ============
function auth(req, res) {
  if (SECRET && req.query.k !== SECRET) { res.status(403).json({ error: "forbidden" }); return false; }
  return true;
}

app.get("/frames", async (req, res) => {
  try {
    if (!auth(req, res)) return;
    const id = String(req.query.id || "");
    const t = Math.max(0, parseFloat(req.query.t || "0") || 0);
    const n = Math.min(8, Math.max(1, parseInt(req.query.n || "4", 10) || 4));
    const vert = req.query.v === "1";
    if (!/^[\w-]{11}$/.test(id)) return res.json({ error: "bad id" });

    let url;
    try { url = await resolveStream(id); }
    catch (e) { return res.json({ error: String(e.message || e).slice(0, 200) }); }

    const si = Math.floor(t / SEG_SEC);
    const fi = Math.round((t - si * SEG_SEC) * FPS);

    await acquire();
    let buf;
    try {
      buf = await runFFmpeg(url, si * SEG_SEC, SEG_SEC, vert, false);
    } catch (e) {
      release();
      return res.json({ error: "ffmpeg: " + String(e.message || e).slice(0, 200) });
    }
    release();

    const W = vert ? LH : LW, H = vert ? LW : LH;
    const fb = W * H * 4;
    const totalFrames = Math.floor(buf.length / fb);
    if (totalFrames <= 0) return res.json({ ended: true });

    const send = Math.min(n, totalFrames - fi);
    if (send <= 0) return res.json({ ended: true });

    const data = buf.subarray(fi * fb, (fi + send) * fb).toString("base64");
    res.json({ frames: send, w: W, h: H, data, env: "", envn: 0 });
  } catch (e) {
    res.json({ error: String(e).slice(0, 200) });
  }
});

// ============ Thumbnails ============
const thumbCache = new Map();
app.get("/thumbs", async (req, res) => {
  try {
    if (!auth(req, res)) return;
    const ids = String(req.query.ids || "").split(",").filter(x => /^[\w-]{11}$/.test(x)).slice(0, 6);
    const vert = req.query.v === "1";
    const out = {};
    const W = vert ? 72 : 128, H = vert ? 128 : 72;

    await Promise.all(ids.map(async id => {
      const key = id + (vert ? "v" : "h");
      if (thumbCache.has(key)) { out[id] = thumbCache.get(key); return; }
      try {
        const src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        const r = await fetch(src, { headers: { "User-Agent": UA } });
        if (!r.ok) return;
        const input = Buffer.from(await r.arrayBuffer());
        const vf = vert
          ? `crop=360*9/16:360:(iw-360*9/16)/2:0,scale=${W}:${H},format=rgba`
          : `crop=ih*16/9:ih:0:(ih-ih*9/16)/2,scale=${W}:${H},format=rgba`;
        const out2 = await new Promise((resolve, reject) => {
          const ff = spawn("ffmpeg", ["-loglevel", "error", "-i", "pipe:0", "-vf", vf, "-frames:v", "1",
            "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
          const bufs = [];
          ff.stdout.on("data", d => bufs.push(d));
          ff.on("error", reject);
          ff.on("close", () => resolve(Buffer.concat(bufs)));
          ff.stdin.end(input);
        });
        if (out2.length === W * H * 4) {
          const b64 = out2.toString("base64");
          thumbCache.set(key, b64);
          out[id] = b64;
        }
      } catch (_) {}
    }));

    if (thumbCache.size > 300) thumbCache.delete(thumbCache.keys().next().value);
    res.json({ w: W, h: H, thumbs: out });
  } catch (e) {
    res.json({ error: String(e).slice(0, 200) });
  }
});

app.get("/health", (_q, r) => r.json({ ok: true }));
app.listen(process.env.PORT || 3000, () => console.log("video server up"));
