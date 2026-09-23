import path from "node:path";
import { config } from "dotenv";
import type { NextConfig } from "next";

// The workspace keeps one .env at the repo root; Next only reads its own
// directory, so load it here for the server (DATABASE_URL and friends).
config({ path: path.join(process.cwd(), "..", "..", ".env"), quiet: true });

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources, not builds.
  transpilePackages: ["@context-cup/db", "@context-cup/shared"],
  serverExternalPackages: ["pg"],
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
