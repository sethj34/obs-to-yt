import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

const app = express();
app.use(cors());
app.use(express.json());

const UPLOAD_DIR = path.join(process.cwd(), "uploads", "videos");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DB_PATH = path.join(process.cwd(), "db.json");
function loadDb() {
  if (!fs.existsSync(DB_PATH)) return { videos: [] };
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}
function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---- helpers
function filePathFor(video) {
  return path.join(UPLOAD_DIR, video.filename);
}

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pruneMissingFiles(db) {
  const kept = [];
  const removed = [];

  for (const v of db.videos) {
    const p = filePathFor(v);
    if (fileExists(p)) kept.push(v);
    else removed.push(v);
  }

  if (removed.length > 0) {
    db.videos = kept;
    saveDb(db);
  }

  return { kept, removed };
}

const jobs = new Map();
function newJobId() {
  return crypto.randomBytes(10).toString("hex");
}

// line-based reader (so chunked stdout doesn't break parsing)
function attachLineReader(stream, onLine) {
  let acc = "";
  stream.on("data", (buf) => {
    acc += buf.toString("utf-8");
    let idx;
    while ((idx = acc.indexOf("\n")) !== -1) {
      const line = acc.slice(0, idx).trimEnd();
      acc = acc.slice(idx + 1);
      if (line.length) onLine(line);
    }
  });
  stream.on("end", () => {
    const line = acc.trim();
    if (line.length) onLine(line);
  });
}

function clampInt(n, min, max) {
  const x = Number.parseInt(n, 10);
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, x));
}

// ---- multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomBytes(12).toString("hex");
    const ext = path.extname(file.originalname) || "";
    cb(null, `${id}${ext}`);
  },
});
const upload = multer({ storage });

// ---- routes
app.post("/videos", upload.single("file"), (req, res) => {
  const title = req.body.title ?? req.file.originalname;
  const db = loadDb();

  const id = path.parse(req.file.filename).name;
  const record = {
    id,
    title,
    createdAt: new Date().toISOString(),
    filename: req.file.filename,
    originalName: req.file.originalname,
    sizeBytes: req.file.size,
    mimeType: req.file.mimetype,
  };

  db.videos.unshift(record);
  saveDb(db);

  res.status(201).json(record);
});

app.get("/videos", (req, res) => {
  const db = loadDb();
  const { kept } = pruneMissingFiles(db);
  res.json(kept);
});

app.delete("/videos/:id", (req, res) => {
  const db = loadDb();
  const idx = db.videos.findIndex((v) => v.id === req.params.id);
  if (idx === -1) return res.sendStatus(404);

  const [vid] = db.videos.splice(idx, 1);

  try {
    fs.unlinkSync(filePathFor(vid));
  } catch {}

  saveDb(db);
  res.json({ ok: true });
});

app.get("/videos/:id/stream", (req, res) => {
  const db = loadDb();
  const vid = db.videos.find((v) => v.id === req.params.id);
  if (!vid) return res.sendStatus(404);

  const filePath = filePathFor(vid);
  if (!fileExists(filePath)) {
    pruneMissingFiles(db);
    return res.sendStatus(404);
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": vid.mimeType || "video/mp4",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const match = range.match(/bytes=(\d+)-(\d*)/);
  if (!match) return res.sendStatus(416);

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (start >= fileSize || end >= fileSize || end < start) return res.sendStatus(416);

  const chunkSize = end - start + 1;

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
    "Accept-Ranges": "bytes",
    "Content-Length": chunkSize,
    "Content-Type": vid.mimeType || "video/mp4",
  });

  fs.createReadStream(filePath, { start, end }).pipe(res);
});

app.post("/videos/:id/upload/youtube", (req, res) => {
  const { privacy = "unlisted" } = req.body ?? {};
  const db = loadDb();
  const vid = db.videos.find((v) => v.id === req.params.id);
  if (!vid) return res.sendStatus(404);

  const filePath = filePathFor(vid);
  if (!fileExists(filePath)) return res.sendStatus(404);

  const jobId = newJobId();
  jobs.set(jobId, {
    id: jobId,
    type: "youtube_upload",
    videoId: vid.id,
    status: "running",
    progress: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    pid: null,
    stdout: "",
    stderr: "",
    result: null,
    error: null,
  });

  // make script path absolute so it works regardless of where node is launched from
  const scriptPath = path.join(process.cwd(), "youtube_upload.py");

  const args = [
    scriptPath,
    "--file",
    filePath,
    "--title",
    vid.title,
    "--privacy",
    privacy,
    "--videoId",
    vid.id,
  ];

  const py = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });

  // save PID
  {
    const job = jobs.get(jobId);
    if (job) job.pid = py.pid ?? null;
  }

  // if python3/script can't be spawned (ENOENT etc)
  py.on("error", (err) => {
    const job = jobs.get(jobId);
    if (!job) return;

    job.finishedAt = new Date().toISOString();
    job.status = "error";
    job.error = String(err?.message ?? err);
    job.result = { ok: false, reason: "spawn_failed" };
  });

  // stdout lines: progress + optional result
  attachLineReader(py.stdout, (line) => {
    const job = jobs.get(jobId);
    if (!job) return;

    job.stdout += line + "\n";

    // supports: "PROGRESS 37", "PROGRESS:37", "progress=37"
    const m = line.match(/PROGRESS\s*[:=]?\s*(\d{1,3})/i);
    if (m) job.progress = clampInt(m[1], 0, 100);

    // optional: python prints "RESULT {...json...}"
    const r = line.match(/^RESULT\s+(.+)$/i);
    if (r) {
      try {
        job.result = JSON.parse(r[1]);
      } catch {
        // ignore bad JSON, logs still captured
      }
    }
  });

  // stderr lines: store them for debugging / UI display
  attachLineReader(py.stderr, (line) => {
    const job = jobs.get(jobId);
    if (!job) return;

    job.stderr += line + "\n";
    job.error = (job.error ?? "") + line + "\n";
  });

  // "close" means process is fully done + streams flushed
  py.on("close", (code, signal) => {
    const job = jobs.get(jobId);
    if (!job) return;

    job.finishedAt = new Date().toISOString();

    if (code === 0) {
      job.status = "done";
      job.progress = 100;
      job.result = job.result ?? { ok: true };
    } else {
      job.status = "error";
      job.result = job.result ?? { ok: false, exitCode: code, signal };
      if (!job.error) job.error = `Exited with code ${code}${signal ? ` (signal ${signal})` : ""}\n`;
    }
  });

  res.status(202).json({ jobId });
});

app.get("/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.sendStatus(404);
  res.json(job);
});

app.listen(3001, () => {
  console.log("API running on http://localhost:3001");
});
