import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Acceptance runs through a Cloudflare Quick Tunnel. Vinext validates the
  // browser module origin before React starts, so permit only that temporary
  // tunnel domain during development.
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
