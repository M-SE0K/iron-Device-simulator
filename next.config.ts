import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone 제거 — 커스텀 server.ts와 충돌 방지
  // koffi는 .node 네이티브 바이너리 → webpack 번들링 제외, 런타임에 require()
  serverExternalPackages: ["koffi", "ws"],
};

export default nextConfig;
