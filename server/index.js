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

// helpers
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

const jobs = new Map();
function newJobId() {
  return crypto.randomBytes(10).toString("hex");
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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomBytes(12).toString("hex");
    const ext = path.extname(file.originalname) || "";
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({ storage });

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
  const idx = db.videos.findIndex(v => v.id === req.params.id);
  if (idx === -1) return res.sendStatus(404);

  const [vid] = db.videos.splice(idx, 1);

  // Delete file if present
  try {
    fs.unlinkSync(filePathFor(vid));
  } catch {}

  saveDb(db);
  res.json({ ok: true });
});

app.get("/videos/:id/stream", (req, res) => {
  const db = loadDb();
  const vid = db.videos.find(v => v.id === req.params.id);
  if (!vid) return res.sendStatus(404);

  const filePath = filePathFor(vid);
  if (!fileExists(filePath)) {

    // self-heal if someone deleted the file manually
    const { kept } = pruneMissingFiles(db);
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

app.listen(3001, () => {
  console.log("API running on http://localhost:3001");
});
