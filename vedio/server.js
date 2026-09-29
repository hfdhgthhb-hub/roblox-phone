import express from "express";
import { spawn, execFile } from "node:child_process";

const W = 240, H = 135, FPS = 10, CHUNK_SEC = 3;
const SECRET = process.env.SECRET || "";
const app = express();

const urlCache   = new Map();
const chunkCache = new Map();
const inflight   = new Map();

function getStream(id) {
  const hit = urlCache.get(id);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.url);
  const args = [
    "-g", "--no-playlist", "--no-warnings", "--no-check-certificates",
    "--socket-timeout", "20", "--retries", "5",
    "--extractor-args", "youtube:player_client=android,ios,web_embedded,tv_embedded,mweb",
    "-f", "bv*[height<=360][vcodec!*=av01]/b[height<=360]/b",
    "https://www.youtube.com/watch?v=" + id,
  ];
  return new Promise((resolve, reject) => {
    execFile("yt-dlp", args, { timeout: 35000, maxBuffer: 1024 * 1024 }, (err, out) => {
      if (err) return reject(err);
      const url = out.split("\n").map(s => s.trim()).find(s => s.startsWith("http"));
      if (!url) return reject(new Error("no url"));
      urlCache.set(id, { url, exp: Date.now() + 25 * 60 * 1000 });
      resolve(url);
    });
  });
}

function runFFmpeg(url, ss, dur, isImage) {
  return new Promise((resolve, reject) => {
    let args;
    if (isImage) {
      args = ["-loglevel", "error", "-i", url, "-vf", `scale=${W}:${H}:flags=fast_bilinear`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"];
    } else {
      args = ["-loglevel", "error", "-ss", String(ss), "-i", url, "-t", String(dur), "-an", "-vf", `fps=${FPS},scale=${W}:${H}:flags=fast_bilinear`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"];
    }
    const ff = spawn("ffmpeg", args);
    const bufs = [];
    ff.stdout.on("data", d => bufs.push(d));
    ff.stderr.on("data", () => {});
    ff.on("error", reject);
    ff.on("close", () => resolve(Buffer.concat(bufs)));
  });
}

async function getChunk(id, ci) {
  const key = `${id}:${ci}`;
  const hit = chunkCache.get(key);
  if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return hit;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const url = await getStream(id);
    const buf = await runFFmpeg(url, ci * CHUNK_SEC, CHUNK_SEC, false);
    const frames = Math.floor(buf.length / (W * H * 3));
    if (frames === 0) throw new Error("No frames returned");
    const entry = { data: buf.subarray(0, frames * W * H * 3), frames, ts: Date.now() };
    chunkCache.set(key, entry);
    if (chunkCache.size > 60) {
      let oldest = Infinity, ok = null;
      for (const [k, v] of chunkCache) if (v.ts < oldest) { oldest = v.ts; ok = k; }
      chunkCache.delete(ok);
    }
    return entry;
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

app.get("/frames", async (req, res) => {
  try {
    if (SECRET && req.query.k !== SECRET) return res.status(403).json({ error: "forbidden" });
    const id = String(req.query.id || "");
    const t  = Math.max(0, parseFloat(req.query.t || "0"));
    const n  = Math.min(10, Math.max(1, parseInt(req.query.n || "1", 10)));
    if (!/^[\w-]{11}$/.test(id)) return res.status(400).json({ error: "bad id" });

    const ci = Math.floor(t / CHUNK_SEC);
    const chunk = await getChunk(id, ci);
    const startFrame = Math.round((t - ci * CHUNK_SEC) * FPS);
    const avail = chunk.frames - startFrame;
    if (avail <= 0) return res.json({ ended: true });

    const send = Math.min(n, avail);
    const startB = startFrame * W * H * 3;
    const endB   = startB + send * W * H * 3;
    res.json({ frames: send, w: W, h: H, data: chunk.data.subarray(startB, endB).toString("base64") });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/image", async (req, res) => {
  try {
    if (SECRET && req.query.k !== SECRET) return res.status(403).json({ error: "forbidden" });
    const id = String(req.query.id || "");
    if (!/^[\w-]{11}$/.test(id)) return res.status(400).json({ error: "bad id" });
    const url = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    const buf = await runFFmpeg(url, 0, 0, true);
    res.json({ data: buf.toString("base64") });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/health", (_q, r) => r.json({ ok: true }));
app.listen(process.env.PORT || 3000, () => console.log("video server up"));
