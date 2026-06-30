import type { NextConfig } from "next";

// QEMU(amd64) 에뮬레이션 컨테이너 빌드는 메모리(≈3.8GB)가 빠듯해 next build 의
// 타입체크/린트 단계에서 OOM(→ write EPIPE)으로 죽는다. 로컬에서 tsc·next build 로
// 이미 검증하므로, 컨테이너 빌드(DOCKER_BUILD=1)에서는 이 단계를 건너뛴다.
// (로컬/일반 빌드는 그대로 엄격하게 검사한다.)
const DOCKER_BUILD = process.env.DOCKER_BUILD === "1";

const nextConfig: NextConfig = {
  // standalone 제거 — 커스텀 server.ts와 충돌 방지
  // koffi는 .node 네이티브 바이너리 → webpack 번들링 제외, 런타임에 require()
  serverExternalPackages: ["koffi", "ws"],
  typescript: { ignoreBuildErrors: DOCKER_BUILD },
  eslint: { ignoreDuringBuilds: DOCKER_BUILD },
};

export default nextConfig;
