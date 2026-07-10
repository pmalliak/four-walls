/* =====================================================================
   Four Walls — local preview server (zero dependencies)
   ---------------------------------------------------------------------
   A tiny static file server for previewing the site locally. No npm
   install needed — only Node's built-in modules.

   Run:
     node tools/preview-server.js            # http://localhost:5173/
     node tools/preview-server.js 8080       # custom port
     PORT=8080 node tools/preview-server.js  # custom port via env

   On this Windows machine `node` may not be on PATH in a fresh shell
   (installed via winget after the shell started). If `node` is not
   found, call it with the full path:
     & "C:\Program Files\nodejs\node.exe" tools/preview-server.js

   Serves the repository root, so:
     /            -> index.html   (marketing site)
     /forms/      -> forms/index.html   (Έντυπα PWA)
   ===================================================================== */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.argv[2] || process.env.PORT || 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json; charset=utf-8",
  ".pdf": "application/pdf"
};

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    // Pretty listing URLs (mirrors the Worker): /akinito/<id> -> akinito.html
    if (/^\/akinito\/[^/]+$/.test(urlPath)) urlPath = "/akinito.html";
    // block path traversal
    const safe = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, "");
    let filePath = path.join(ROOT, safe);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.stat(filePath, (err, st) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found: " + safe);
        return;
      }
      if (st.isDirectory()) filePath = path.join(filePath, "index.html");
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
  } catch (e) {
    res.writeHead(500);
    res.end("500 " + e.message);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Four Walls preview running at http://localhost:" + PORT + "/");
  console.log("  site : http://localhost:" + PORT + "/");
  console.log("  forms: http://localhost:" + PORT + "/forms/");
  console.log("Press Ctrl+C to stop.");
});
