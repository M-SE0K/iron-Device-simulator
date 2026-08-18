import type { NextConfig } from "next";

const MOBILE_BUILD = process.env.MOBILE_BUILD === "1";

const nextConfig: NextConfig = {
  ...(MOBILE_BUILD ? { output: "export" as const, images: { unoptimized: true } } : {}),
  env: {
    NEXT_PUBLIC_IRON_PERF: process.env.NEXT_PUBLIC_IRON_PERF ?? "0",
  },
};

export default nextConfig;
