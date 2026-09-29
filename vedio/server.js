import express from "express";
import { spawn, execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

// ================= CONFIG =================
const SECRET  = process.env.SECRET || "";
const PROXY   = process.env.YT_PROXY || "";
const COOKIES = process.env.YT_COOKIES || "";

const FPS = 8;
const SEG_SEC = 10;
const SEG_FRAMES = FPS * SEG_SEC;
const LW = 160, LH = 90;
const ENV_RATE = 32;
const NB = 20;
const AR = 8000;
const HOP = AR / ENV_RATE;
const FMIN = 120, FMAX = 3600;
const MAX_FF = 3;

// ✅ FIXED: ios first (best for datacenter IPs), then android, tv_embedded
const CLIENTS = ["ios", "android", "tv_embedded", "mweb", "web_safari", ""];

// ✅ FIXED: "worst video + worst audio" — always available, small, fast
const FORMAT = "wv*+wa/w/bv*+ba/b";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const app = express();

// ---------- optional PO-token provider ----------
let potUp = false;
if (existsSync("/opt/pot/server/build/main.js")) {
  try {
    const p = spawn("node", ["/opt/pot/server/build/main.js"], { stdio: "inherit" });
    p.on("error", () => {});
    potUp = true;
  } catch (_) {}
}
if (COOKIES) { try { writeFileSync("/tmp/yt-cookies.txt", COOKIES); } catch (_) {} }

// ---------- ffmpeg concurrency limiter ----------
let active = 0;
const waitq = [];
function acquire() {
  return new Promise(res => { if (active < MAX_FF) { active++; res(); } else waitq.push(res); });
}
function release() { const n = waitq.shift(); if (n) n(); else active--; }

// ================= yt-dlp extraction =================
const fmtCache = new Map();
const fmtInflight = new Map();
const failCache = new Map();
let goodClient = null;
let noJsFlag = false;

function shortErr(e) {
  const s = String((e && e.message) || e);
  const lines = s.split("\n").map(x => x.trim()).filter(Boolean);
  const errLine = [...lines].reverse().find(l => /ERROR/i.test(l)) || lines[lines.length - 1] || s;
  return errLine.slice(0, 220);
}

function ytdlpJson(id, client) {
  const args = ["-j", "--no-playlist", "--no-warnings", "--no-check-certificates", "--force-ipv4",
    "--socket-timeout", "15", "--retries", "2"];
  if (!noJsFlag) args.push("--js-runtimes", "node");
  if (PROXY) args.push("--proxy", PROXY);
  if (COOKIES) args.push("--cookies", "/tmp/yt-cookies.txt");
  if (client) args.push("--extractor-args", "youtube:player_client=" + client);
  args.push("-f", FORMAT, "https://www.youtube.com/watch?v=" + id);
  return new Promise((resolve, reject) => {
    execFile("yt-dlp", args, { timeout: 28000, maxBuffer: 30 * 1024 * 1024 }, (err, out, stderr) => {
      if (err) {
        const msg = (stderr || "") + " " + (err.message || "");
        if (/no such option/i.test(msg) && !noJsFlag) { noJsFlag = true; return ytdlpJson(id, client).then(resolve, reject); }
        return reject(new Error(msg));
      }
      try { resolve(JSON.parse(out.trim().split("\n")[0])); }
      catch (e) { reject(new Error("bad yt-dlp json")); }
    });
  });
}

function mkSrc(f) {
  const h = f.http_headers || {};
  const ua = h["User-Agent"] || UA;
  const hdr = Object.entries(h).filter(([k]) => k.toLowerCase() !== "user-agent")
    .map(([k, v]) => `${k}: ${v}\r\n`).join("");
  return { url: f.url, ua, hdr };
}

function pickFormats(j) {
  const fm = (j.requested_formats && j.requested_formats.length) ? j.requested_formats : [j];
  let video = null, audio = null;
  for (const f of fm) {
    if (!f.url) continue;
    const hv = f.vcodec && f.vcodec !== "none";
    const ha = f.acodec && f.acodec !== "none";
    if (hv && !video) video = mkSrc(f);
    if (ha && !audio) audio = mkSrc(f);
  }
  return { video, audio };
}

async function tryClients(id, log) {
  const order = goodClient !== null ? [goodClient, ...CLIENTS.filter(c => c !== goodClient)] : CLIENTS;
  const errs = [];
  for (const c of order) {
    const name = c || "default";
    try {
      const j = await ytdlpJson(id, c);
      const f = pickFormats(j);
      if (!f.video) throw new Error("no video format");
      goodClient = c;
      if (log) log.push({ client: name, ok: true, hasAudio: !!f.audio });
      return { ...f, exp: Date.now() + 20 * 60 * 1000 };
    } catch (e) {
      const m = shortErr(e);
      errs.push(`${name}: ${m}`);
      if (log) log.push({ client: name, ok: false, err: m });
    }
  }
  throw new Error(errs.join(" | "));
}

function extract(id) {
  const hit = fmtCache.get(id);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit);
  const bad = failCache.get(id);
  if (bad && bad.exp > Date.now()) return Promise.reject(new Error(bad.msg));
  if (fmtInflight.has(id)) return fmtInflight.get(id);
  const p = tryClients(id)
    .then(entry => { fmtCache.set(id, entry); return entry; })
    .catch(e => { failCache.set(id, { msg: shortErr(e), exp: Date.now() + 45000 }); throw e; })
    .finally(() => fmtInflight.delete(id));
  fmtInflight.set(id, p);
  return p;
}

function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

// ================= ffmpeg helpers =================
function ffIn(src, ss, dur) {
  const a = ["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1"];
  if (PROXY) a.push("-http_proxy", PROXY);
  if (src.ua) a.push("-user_agent", src.ua);
  if (src.hdr) a.push("-headers", src.hdr);
  a.push("-ss", String(ss), "-i", src.url, "-t", String(dur));
  return a;
}

function ffmpegRun(args, input) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args);
    const bufs = [];
    let err = "";
    const timer = setTimeout(() => { try { ff.kill("SIGKILL"); } catch (_) {} }, 60000);
    ff.stdout.on("data", d => bufs.push(d));
    ff.stderr.on("data", d => { if (err.length < 500) err += d.toString(); });
    ff.stdin.on("error", () => {});
    ff.on("error", e => { clearTimeout(timer); reject(e); });
    ff.on("close", () => { clearTimeout(timer); resolve(Buffer.concat(bufs)); });
    if (input) ff.stdin.end(input); else ff.stdin.end();
  });
}

// ================= video segment jobs =================
const jobs = new Map();

function evictJobs() {
  if (jobs.size <= 14) return;
  const sorted = [...jobs.values()].filter(j => j.done).sort((a, b) => a.ts - b.ts);
  for (const j of sorted) { if (jobs.size <= 14) break; jobs.delete(j.key); }
}

function getVideoJob(id, si, vert, fmt) {
  const key = `${id}:${si}:${vert ? 1 : 0}`;
  let j = jobs.get(key);
  if (j) { j.ts = Date.now(); return j; }
  const W = vert ? LH : LW, H = vert ? LW : LH;
  const frameBytes = W * H * 4;
  j = { key, buf: Buffer.allocUnsafe(SEG_FRAMES * frameBytes), len: 0, done: false, err: "", frameBytes, W, H, ts: Date.now() };
  jobs.set(key, j);
  evictJobs();
  (async () => {
    await acquire();
    try {
      await new Promise(resolve => {
        const vf = `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
                   `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,format=rgba`;
        const args = [...ffIn(fmt.video, si * SEG_SEC, SEG_SEC), "-an", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"];
        const ff = spawn("ffmpeg", args);
        let errText = "";
        const timer = setTimeout(() => { try { ff.kill("SIGKILL"); } catch (_) {} }, 70000);
        ff.stdout.on("data", d => {
          const room = j.buf.length - j.len;
          if (room <= 0) return;
          const c = Math.min(room, d.length);
          d.copy(j.buf, j.len, 0, c);
          j.len += c;
        });
        ff.stderr.on("data", d => { if (errText.length < 600) errText += d.toString(); });
        ff.on("error", e => { clearTimeout(timer); j.err = String(e); resolve(); });
        ff.on("close", () => {
          clearTimeout(timer);
          if (j.len === 0) j.err = j.err || errText.trim().slice(-200);
          resolve();
        });
      });
    } finally { j.done = true; release(); }
  })();
  return j;
}

// ================= audio envelope (Goertzel bands) =================
const BANDS = Array.from({ length: NB }, (_, i) => FMIN * Math.pow(FMAX / FMIN, i / (NB - 1)));
const HANN = Float64Array.from({ length: HOP }, (_, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (HOP - 1)));
const HANN_SUM = HANN.reduce((a, b) => a + b, 0);
const PROBES = BANDS.map(f => [f * 0.87, f, f * 1.15].map(ff => 2 * Math.cos(2 * Math.PI * ff / AR)));

function computeEnv(pcm) {
  const samples = Math.floor(pcm.length / 2);
  const steps = SEG_SEC * ENV_RATE;
  const out = new Uint8Array(steps * NB);
  const x = new Float64Array(HOP);
  for (let s = 0; s < steps; s++) {
    const off = s * HOP;
    if (off + HOP > samples) break;
    for (let n = 0; n < HOP; n++) x[n] = (pcm.readInt16LE((off + n) * 2) / 32768) * HANN[n];
    for (let b = 0; b < NB; b++) {
      let pw = 0;
      for (const coeff of PROBES[b]) {
        let s1 = 0, s2 = 0;
        for (let n = 0; n < HOP; n++) { const s0 = x[n] + coeff * s1 - s2; s2 = s1; s1 = s0; }
        pw += Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
      }
      const amp = 2 * Math.sqrt(pw / 3) / HANN_SUM;
      const db = 20 * Math.log10(amp + 1e-9);
      out[s * NB + b] = Math.round(Math.min(1, Math.max(0, (db + 55) / 55)) * 255);
    }
  }
  return out;
}

const audioJobs = new Map();
function getAudioEnv(id, si, fmt) {
  const key = `${id}:${si}`;
  const e = audioJobs.get(key);
  if (e) return e.p;
  if (!fmt.audio) return Promise.resolve(null);
  const p = (async () => {
    await acquire();
    try {
      const args = [...ffIn(fmt.audio, si * SEG_SEC, SEG_SEC), "-vn", "-ac", "1", "-ar", String(AR), "-f", "s16le", "pipe:1"];
      const pcm = await ffmpegRun(args);
      return pcm.length >= HOP * 2 ? computeEnv(pcm) : null;
    } finally { release(); }
  })().catch(() => null);
  audioJobs.set(key, { p, ts: Date.now() });
  if (audioJobs.size > 40) audioJobs.delete(audioJobs.keys().next().value);
  return p;
}

setInterval(() => {
  const old = Date.now() - 8 * 60 * 1000;
  for (const [k, j] of jobs) if (j.done && j.ts < old) jobs.delete(k);
  for (const [k, v] of audioJobs) if (v.ts < old) audioJobs.delete(k);
}, 60000);

// ================= routes =================
function auth(req, res) {
  if (SECRET && req.query.k !== SECRET) { res.status(403).json({ error: "forbidden" }); return false; }
  return true;
}

app.get("/frames", async (req, res) => {
  try {
    if (!auth(req, res)) return;
    const id = String(req.query.id || "");
    if (!/^[\w-]{11}$/.test(id)) return res.json({ error: "bad id" });
    const t = Math.max(0, parseFloat(req.query.t || "0") || 0);
    const n = Math.min(8, Math.max(1, parseInt(req.query.n || "4", 10) || 4));
    const vert = req.query.v === "1";

    let fmt;
    try { fmt = await withTimeout(extract(id), 22000, "warming up (yt-dlp still working)"); }
    catch (e) { return res.json({ error: shortErr(e) }); }

    let si = Math.floor(t / SEG_SEC);
    let fi = Math.round((t - si * SEG_SEC) * FPS);
    if (fi >= SEG_FRAMES) { si++; fi = 0; }

    const job = getVideoJob(id, si, vert, fmt);
    const audioP = getAudioEnv(id, si, fmt);
    const need = Math.min(n, SEG_FRAMES - fi);
    const fb = job.frameBytes;
    const t0 = Date.now();
    while (true) {
      const have = Math.floor(job.len / fb) - fi;
      if (have >= need || job.done) break;
      if (have >= 1 && Date.now() - t0 > 1500) break;
      if (Date.now() - t0 > 20000) break;
      await sleep(50);
    }
    const have = Math.floor(job.len / fb) - fi;
    if (have <= 0) {
      if (job.done) {
        jobs.delete(job.key);
        if (job.err) {
          if (/403|forbidden|expired/i.test(job.err)) fmtCache.delete(id);
          return res.json({ error: "ffmpeg: " + job.err });
        }
        return res.json({ ended: true });
      }
      return res.json({ error: "still loading" });
    }

    if (fi + need >= SEG_FRAMES / 2 && !(job.done && Math.floor(job.len / fb) < SEG_FRAMES)) {
      getVideoJob(id, si + 1, vert, fmt);
      getAudioEnv(id, si + 1, fmt);
    }

    const send = Math.min(need, have);
    const data = job.buf.subarray(fi * fb, (fi + send) * fb).toString("base64");
    const envArr = await Promise.race([audioP, sleep(4000).then(() => null)]);
    let env = "", envn = 0;
    if (envArr) {
      const e0 = Math.round(fi / FPS * ENV_RATE);
      envn = Math.round(send / FPS * ENV_RATE);
      env = Buffer.from(envArr.buffer, envArr.byteOffset + e0 * NB, envn * NB).toString("base64");
    }
    res.json({ frames: send, w: job.W, h: job.H, data, env, envn, nb: NB });
  } catch (e) {
    res.json({ error: shortErr(e) });
  }
});

// ---------- thumbnails ----------
const thumbCache = new Map();
async function makeThumb(id, vert) {
  const src = `https://i.ytimg.com/vi/${id}/${vert ? "hqdefault" : "mqdefault"}.jpg`;
  const r = await fetch(src, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("thumb http " + r.status);
  const input = Buffer.from(await r.arrayBuffer());
  const W = vert ? 72 : 128, H = vert ? 128 : 72;
  const vf = vert ? `crop=ih*9/16:ih,scale=${W}:${H},format=rgba` : `scale=${W}:${H},format=rgba`;
  const out = await ffmpegRun(["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", vf, "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], input);
  if (out.length !== W * H * 4) throw new Error("thumb size " + out.length);
  return out.toString("base64");
}

app.get("/thumbs", async (req, res) => {
  try {
    if (!auth(req, res)) return;
    const ids = String(req.query.ids || "").split(",").filter(x => /^[\w-]{11}$/.test(x)).slice(0, 6);
    const vert = req.query.v === "1";
    const out = {};
    await Promise.all(ids.map(async id => {
      const key = id + (vert ? "v" : "h");
      let b = thumbCache.get(key);
      if (!b) {
        try {
          b = await makeThumb(id, vert);
          thumbCache.set(key, b);
          if (thumbCache.size > 300) thumbCache.delete(thumbCache.keys().next().value);
        } catch (_) { return; }
      }
      out[id] = b;
    }));
    res.json({ w: vert ? 72 : 128, h: vert ? 128 : 72, thumbs: out });
  } catch (e) {
    res.json({ error: shortErr(e) });
  }
});

// ---------- diagnostics ----------
app.get("/debug", async (req, res) => {
  if (!auth(req, res)) return;
  const id = /^[\w-]{11}$/.test(String(req.query.id || "")) ? String(req.query.id) : "dQw4w9WgXcQ";
  fmtCache.delete(id); failCache.delete(id);
  const log = [];
  let ok = false;
  try { await tryClients(id, log); ok = true; } catch (_) {}
  const ver = await new Promise(r => execFile("yt-dlp", ["--version"], (e, o) => r(e ? "missing: " + e.message : o.trim())));
  res.json({ ok, id, ytdlp: ver, potProviderStarted: potUp, proxy: !!PROXY, cookies: !!COOKIES, goodClient, tried: log });
});

app.get("/health", (_q, r) => r.json({ ok: true }));
app.listen(process.env.PORT || 3000, () => console.log("video server up"));
