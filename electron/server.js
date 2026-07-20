// electron/server.js — out/(정적 산출물)을 127.0.0.1에서 서빙하는 로컬 HTTP 서버.
//
// Next.js 정적 export는 애셋 경로가 절대경로(/_next/...)라 file://로 직접 열면 로딩이
// 깨지므로, 앱 내부에서만 쓰는 이 서버를 통해 http://127.0.0.1:<port>로 로드한다 — 외부에
// 노출되지 않고 이 프로세스 안에서만 존재하는 서버라 "서버리스(분석은 브라우저 WASM이
// 수행)" 원칙과 어긋나지 않는다.
const { app } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");

const PORT = 17872;

const OUT_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "out")
  : path.join(__dirname, "..", "out");

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      // "/" 특수 처리는 path.normalize() 이전에 해야 한다 — normalize()는 Windows에서
      // "/"를 "\\"로 바꿔버려 이 비교가 항상 실패하고(디렉터리 자체를 읽으려다 EISDIR로
      // 404 "Not found"만 뜨는 버그로 이어졌다).
      const requested = urlPath === "/" ? "/index.html" : urlPath;
      const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(OUT_DIR, safePath);

      // Next.js static export writes page routes as <route>.html
      fs.access(filePath, fs.constants.F_OK, (err) => {
        if (!err) return serveFile(res, filePath);
        serveFile(res, path.join(OUT_DIR, `${safePath}.html`));
      });
    });
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve());
  });
}

module.exports = { PORT, startServer };
