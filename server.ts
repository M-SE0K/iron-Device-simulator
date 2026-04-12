/**
 * server.ts — 커스텀 Next.js HTTP 서버 + ws WebSocket 서버
 *
 * 실행:
 *   개발: npx tsx server.ts
 *   프로덕션(Docker): node server.js  (tsc -p tsconfig.server.json 빌드 후)
 *
 * WebSocket 엔드포인트: ws://<host>/ws/audio
 */

import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer } from "ws";
import { handleWsConnection } from "./lib/ws-engine";
import { logServerReady, logWsUpgrade, logWsConnect } from "./lib/logger";

const dev      = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port     = parseInt(process.env.PORT ?? "3000", 10);

const app    = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("[server] 요청 처리 오류:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  // WebSocket 서버 — HTTP 업그레이드 요청을 직접 처리 (포트 공유)
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url ?? "/");
    if (pathname === "/ws/audio") {
      logWsUpgrade(pathname);
      wss.handleUpgrade(req, socket as Parameters<typeof wss.handleUpgrade>[1], head, (ws) => {
        logWsConnect();
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", handleWsConnection);

  httpServer.listen(port, hostname, () => {
    logServerReady(hostname, port, dev);
  });
});
