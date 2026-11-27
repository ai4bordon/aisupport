import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Контракт `docs/api-contract.md` §3: `/v1/chat` — публичный маршрут,
  // реализация живёт в `src/app/api/chat/route.ts`.
  // §5: `/agent/run` — маршрут ядра для каналов, реализация — в
  // `src/app/api/agent/run/route.ts`.
  async rewrites() {
    return [
      { source: "/v1/chat", destination: "/api/chat" },
      { source: "/v1/chat/:path*", destination: "/api/chat/:path*" },
      { source: "/agent/run", destination: "/api/agent/run" },
    ];
  },
};

export default nextConfig;
