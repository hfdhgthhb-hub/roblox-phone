import express from "express";
import { spawn, execFile } from "node:child_process";

const SECRET = process.env.SECRET || "";
const FPS = 8, SEG_SEC = 10, SEG_FRAMES = FPS * SEG_SEC;
const LW = 160, LH = 90;
const MAX_FF = 3;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const INVIDIOUS = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://yewtu.be",
  "https://invidious.f5.si",
  "https://iv.melmac.space",
  "https://invidious.privacyredirect.com",
  "https://vid.puffyan.us",
  "https://inv.tux.pizza",
  "https://invidious.reallyaweso.me",
  "https://yt.artemislena.eu",
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const app = express();

let active = 0;
const waitq = [];
function acquire() { return new Promise(res => { if (active < MAX_FF) { active++; res(); } else waitq.push(res); }); }
function release() { const n = waitq.shift(); if (n) n(); else active--; }

// ============ Stream resolver ============
const urlCache = new Map();

async function tryInvidious(id) {
  for (const base of INVIDIOUS) {
    try {
      const r = await fetch(`${base}/api/v1/videos/${id}`, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const j = await r.json();

      // Prefer pre-muxed mp4 (formatStreams), fall back to adaptiveFormats video-only
      let streams = (j.formatStreams || []).filter(s => s.url && s.container === "mp4");
      if (!streams.length) {
        streams = (j.adaptiveFormats || [])
          .filter(s => s.url && s.type && s.type.startsWith("video/"))
          .map(s => ({
            url: s.url,
            resolution: s.resolution || ((s.height || 0) + "p"),
            container: "mp4"
          }));
      }
      if (!streams.length) continue;

      streams.sort((a, b) => (parseInt(a.resolution) || 9999) - (parseInt(b.resolution) || 9999));
      const pick = streams.find(s => {
        const h = parseInt(s.resolution);
        return h >= 240 && h <= 480;
      }) || streams[0];
      console.log(`[inv] ${base} -> ${id} ${pick.resolution}`);
      return pick.url;
    } catch (_) { continue; }
  }
  return null;
}

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

  let url = await tryInvidious(id);
  if (!url) {
    try { url = await tryYtDlp(id); } catch (e) { url = null; }
  }
  if (!url) throw new Error("All sources failed for " + id);

  urlCache.set(id, { url, exp: Date.now() + 20 * 60 * 1000 });
  return url;
}

// ============ Segment cache (BIG WIN) ============
const segCache = new Map();      // key: id:si:vert -> { buf, ts }
const segInflight = new Map();

function evictSeg() {
  const now = Date.now();
  for (const [k, v] of segCache) {
    if (now - v.ts > 5 * 60 * 1000) segCache.delete(k);
  }
  if (segCache.size > 40) {
    const sorted = [...segCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < sorted.length - 40; i++) segCache.delete(sorted[i][0]);
  }
}

function extractSegment(url, si, vert) {
  return new Promise((resolve, reject) => {
    const W = vert ? LH : LW, H = vert ? LW : LH;
    const vf = `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
               `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,format=rgba`;
    const args = ["-loglevel", "error", "-ss", String(si * SEG_SEC),
      "-i", url, "-t", String(SEG_SEC), "-an",
      "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"];
    const ff = spawn("ffmpeg", args);
    const bufs = [];
    let errText = "";
    const timer = setTimeout(() => { try { ff.kill("SIGKILL"); } catch(_){} }, 90000);
    ff.stdout.on("data", d => bufs.push(d));
    ff.stderr.on("data", d => { if (errText.length < 300) errText += d.toString(); });
    ff.on("error", e => { clearTimeout(timer); reject(e); });
    ff.on("close", () => {
      clearTimeout(timer);
      const buf = Buffer.concat(bufs);
      if (buf.length === 0) return reject(new Error(errText.slice(-200) || "empty ffmpeg output"));
      resolve(buf);
    });
  });
}

async function getSegment(id, si, vert) {
  const key = `${id}:${si}:${vert ? 1 : 0}`;
  const hit = segCache.get(key);
  if (hit) { hit.ts = Date.now(); return hit.buf; }
  if (segInflight.has(key)) return segInflight.get(key);

  const p = (async () => {
    await acquire();
    try {
      const url = await resolveStream(id);
      const buf = await extractSegment(url, si, vert);
      segCache.set(key, { buf, ts: Date.now() });
      evictSeg();
      return buf;
    } finally { release(); }
  })().finally(() => segInflight.delete(key));

  segInflight.set(key, p);
  return p;
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

    const si = Math.floor(t / SEG_SEC);
    const fi = Math.round((t - si * SEG_SEC) * FPS);

    let seg;
    try { seg = await getSegment(id, si, vert); }
    catch (e) { return res.json({ error: String(e.message || e).slice(0, 220) }); }

    const W = vert ? LH : LW, H = vert ? LW : LH;
    const fb = W * H * 4;
    const totalFrames = Math.floor(seg.length / fb);
    if (totalFrames <= 0) return res.json({ ended: true });

    const start = Math.min(fi, totalFrames - 1);
    const send = Math.min(n, totalFrames - start);
    if (send <= 0) return res.json({ ended: true });

    const data = seg.subarray(start * fb, (start + send) * fb).toString("base64");

    // Prefetch next segment
    if (fi + send >= SEG_FRAMES / 2) {
      getSegment(id, si + 1, vert).catch(() => {});
    }

    res.json({ frames: send, w: W, h: H, data, env: "", envn: 0 });
  } catch (e) {
    res.json({ error: String(e).slice(0, 220) });
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

        // hqdefault is 480x360. Center-crop to target aspect, then scale.
        const vf = vert
          ? `crop=360*9/16:360:(iw-360*9/16)/2:0,scale=${W}:${H},format=rgba`
          : `crop=ih*16/9:ih:0:(ih-ih*9/16)/2,scale=${W}:${H},format=rgba`;

        const out2 = await new Promise((resolve, reject) => {
          const ff = spawn("ffmpeg", ["-loglevel", "error", "-i", "pipe:0", "-vf", vf,
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
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
    res.json({ error: String(e).slice(0, 220) });
  }
});

app.get("/health", (_q, r) => r.json({ ok: true }));
app.listen(process.env.PORT || 3000, () => console.log("video server up"));
