import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  output: "standalone",
  devIndicators: false,
  experimental: { agentUpgrade: "security" },
};
export default nextConfig;
