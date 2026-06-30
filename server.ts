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
import { handleWsConnection } from "./src/features/audio/lib/ws-engine";
import { logServerReady, logWsUpgrade, logWsConnect } from "./src/features/audio/lib/logger";
import { TOKEN_COOKIE, verifyToken } from "./src/features/auth/lib/auth";

/** Cookie 헤더에서 단일 쿠키 값 추출 (의존성 없이 최소 구현) */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

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

  httpServer.on("upgrade", async (req, socket, head) => {
    const { pathname } = parse(req.url ?? "/");
    if (pathname !== "/ws/audio") {
      socket.destroy();
      return;
    }

    // 인가(docs/04 §4.3): irontune_token 쿠키의 JWT 를 검증해 승인된 사용자만 분석 WS 허용.
    // 토큰은 APPROVED 에게만 발급되므로 status claim 도 재확인한다. (무효 → 401 후 소켓 종료)
    const token = readCookie(req.headers.cookie, TOKEN_COOKIE);
    const auth = token ? await verifyToken(token).catch(() => null) : null;
    if (!auth || auth.status !== "APPROVED") {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    logWsUpgrade(pathname);
    wss.handleUpgrade(req, socket as Parameters<typeof wss.handleUpgrade>[1], head, (ws) => {
      logWsConnect();
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", handleWsConnection);

  httpServer.listen(port, hostname, () => {
    logServerReady(hostname, port, dev);
  });
});
