import type { NextConfig } from "next";
import path from 'node:path';
const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@context/contracts", "@context/domain", "@context/sync-client", "@context/workspace-client", "@context/workspace-ui"],
  outputFileTracingRoot: path.resolve(__dirname, '..'),
  devIndicators: false,
  experimental: { agentUpgrade: "security" },
  turbopack: { root: path.resolve(__dirname, '..') },
};
export default nextConfig;
