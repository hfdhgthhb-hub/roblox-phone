import express from "express";
import { spawn } from "node:child_process";

const SECRET = process.env.SECRET || "";
const app = express();

function auth(req, res) {
  if (SECRET && req.query.k !== SECRET) {
    res.status(403).json({ error: "forbidden" });
    return false;
  }
  return true;
}

// ============ Image proxy (thumbnails from any HTTPS URL) ============
app.get("/img", async (req, res) => {
  try {
    if (!auth(req, res)) return;
    const url = String(req.query.url || "");
    const W = Math.min(256, Math.max(32, parseInt(req.query.w || "128", 10)));
    const H = Math.min(256, Math.max(32, parseInt(req.query.h || "128", 10)));
    if (!/^https:\/\//.test(url)) return res.json({ error: "bad url" });

    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return res.json({ error: "fetch " + r.status });
    const input = Buffer.from(await r.arrayBuffer());

    const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,format=rgba`;
    const out2 = await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", ["-loglevel", "error", "-i", "pipe:0", "-vf", vf,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
      const bufs = [];
      ff.stdout.on("data", d => bufs.push(d));
      ff.on("error", reject);
      ff.on("close", () => resolve(Buffer.concat(bufs)));
      ff.stdin.end(input);
    });

    if (out2.length !== W * H * 4) return res.json({ error: "bad size" });
    res.json({ w: W, h: H, data: out2.toString("base64") });
  } catch (e) {
    res.json({ error: String(e).slice(0, 200) });
  }
});

app.get("/frames", async (_q, res) => {
  res.json({ error: "video unavailable" });
});

app.get("/health", (_q, r) => r.json({ ok: true }));
app.listen(process.env.PORT || 3000, () => console.log("video server up"));
