const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8000;
const BASE_PATH = (process.env.BASE_PATH || "").replace(/\/+$/, "");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");

// --- Database setup ---
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT,
    thumbnail TEXT,
    api_key_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
  );
`);

// Migrate: add thumbnail column if missing
const cols = db.prepare("PRAGMA table_info(urls)").all();
if (!cols.some((c) => c.name === "thumbnail")) {
  db.exec("ALTER TABLE urls ADD COLUMN thumbnail TEXT");
}

// Ensure at least one API key exists
const keyCount = db.prepare("SELECT COUNT(*) as count FROM api_keys").get();
if (keyCount.count === 0) {
  const defaultKey = "adrian22";
  db.prepare("INSERT INTO api_keys (key, name) VALUES (?, ?)").run(
    defaultKey,
    "Default Key"
  );
  console.log(`\n  Generated default API key: ${defaultKey}\n`);
}

// --- Middleware ---
app.use(cors());
app.use(express.json());

// Health check at root (platform polls GET / for readiness)
if (BASE_PATH) {
  app.get("/", (req, res) => res.redirect(BASE_PATH + "/"));
}

// Mount everything under BASE_PATH
const router = express.Router();

// Inject BASE_PATH into index.html so the frontend knows the prefix
router.get("/", (req, res) => {
  const fs = require("fs");
  const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf-8");
  const injected = html.replace(
    "</head>",
    `<script>window.__BASE_PATH__ = "${BASE_PATH}";</script></head>`
  );
  res.type("html").send(injected);
});

router.use(express.static(path.join(__dirname, "public")));

function authenticateApiKey(req, res, next) {
  const apiKey =
    req.headers["x-api-key"] || req.query.api_key;
  if (!apiKey) {
    return res.status(401).json({ error: "Missing API key" });
  }
  const row = db.prepare("SELECT * FROM api_keys WHERE key = ?").get(apiKey);
  if (!row) {
    return res.status(403).json({ error: "Invalid API key" });
  }
  req.apiKeyRow = row;
  next();
}

// --- Thumbnail helpers ---

function extractYouTubeThumbnail(url) {
  try {
    const u = new URL(url);
    let videoId = null;
    if (u.hostname === "youtu.be") {
      videoId = u.pathname.slice(1);
    } else if (
      u.hostname === "www.youtube.com" ||
      u.hostname === "youtube.com" ||
      u.hostname === "m.youtube.com"
    ) {
      if (u.pathname === "/watch") {
        videoId = u.searchParams.get("v");
      } else if (u.pathname.startsWith("/shorts/")) {
        videoId = u.pathname.split("/shorts/")[1];
      } else if (u.pathname.startsWith("/embed/")) {
        videoId = u.pathname.split("/embed/")[1];
      } else if (u.pathname.startsWith("/live/")) {
        videoId = u.pathname.split("/live/")[1];
      }
    }
    if (videoId) {
      videoId = videoId.split(/[?&#]/)[0];
      return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    }
  } catch {}
  return null;
}

// --- API Routes ---

// Save a URL (skip duplicates)
router.post("/api/urls", authenticateApiKey, (req, res) => {
  const { url, title, thumbnail } = req.body;
  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }
  // Check for duplicate URL under this API key
  const existing = db
    .prepare("SELECT id FROM urls WHERE url = ? AND api_key_id = ?")
    .get(url, req.apiKeyRow.id);
  if (existing) {
    return res.status(409).json({ error: "URL already saved", id: existing.id });
  }
  // Use YouTube thumbnail if available, otherwise use what the client sent
  const thumb = extractYouTubeThumbnail(url) || thumbnail || null;
  const result = db
    .prepare("INSERT INTO urls (url, title, thumbnail, api_key_id) VALUES (?, ?, ?, ?)")
    .run(url, title || null, thumb, req.apiKeyRow.id);
  res.json({ id: result.lastInsertRowid, url, title, thumbnail: thumb });
});

// List URLs (with optional search)
router.get("/api/urls", authenticateApiKey, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const search = req.query.q ? `%${req.query.q}%` : null;

  let rows, total;
  if (search) {
    rows = db
      .prepare(
        "SELECT id, url, title, thumbnail, created_at FROM urls WHERE api_key_id = ? AND (title LIKE ? OR url LIKE ?) ORDER BY created_at DESC LIMIT ? OFFSET ?"
      )
      .all(req.apiKeyRow.id, search, search, limit, offset);
    total = db
      .prepare("SELECT COUNT(*) as count FROM urls WHERE api_key_id = ? AND (title LIKE ? OR url LIKE ?)")
      .get(req.apiKeyRow.id, search, search);
  } else {
    rows = db
      .prepare(
        "SELECT id, url, title, thumbnail, created_at FROM urls WHERE api_key_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
      )
      .all(req.apiKeyRow.id, limit, offset);
    total = db
      .prepare("SELECT COUNT(*) as count FROM urls WHERE api_key_id = ?")
      .get(req.apiKeyRow.id);
  }
  res.json({ urls: rows, total: total.count });
});

// Delete a URL
router.delete("/api/urls/:id", authenticateApiKey, (req, res) => {
  const result = db
    .prepare("DELETE FROM urls WHERE id = ? AND api_key_id = ?")
    .run(req.params.id, req.apiKeyRow.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: "URL not found" });
  }
  res.json({ deleted: true });
});

// --- API Key management ---

// List keys (no auth needed for dashboard bootstrapping — protect in production)
router.get("/api/keys", (req, res) => {
  const rows = db
    .prepare("SELECT id, key, name, created_at FROM api_keys ORDER BY created_at DESC")
    .all();
  res.json({ keys: rows });
});

// Create a new key
router.post("/api/keys", (req, res) => {
  const name = req.body.name || "Unnamed Key";
  const key = crypto.randomUUID();
  db.prepare("INSERT INTO api_keys (key, name) VALUES (?, ?)").run(key, name);
  res.json({ key, name });
});

// Delete a key
router.delete("/api/keys/:id", (req, res) => {
  db.prepare("DELETE FROM urls WHERE api_key_id = ?").run(req.params.id);
  const result = db.prepare("DELETE FROM api_keys WHERE id = ?").run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: "Key not found" });
  }
  res.json({ deleted: true });
});

// Mount router at BASE_PATH (or root if no BASE_PATH)
app.use(BASE_PATH || "/", router);

// --- Start ---
app.listen(PORT, "0.0.0.0", () => {
  console.log(`URL Collector running at http://0.0.0.0:${PORT}${BASE_PATH}/`);
});
