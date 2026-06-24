import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-lib is a heavy pure-JS dependency used only server-side (CAW form fill).
  // Keep it out of the bundler so it loads from node_modules at runtime.
  serverExternalPackages: ["pdf-lib"],
  // The CAW form fill reads the blank template PDFs from disk at runtime via a
  // computed path, which Turbopack's tracing can't detect — force them into the
  // serverless function bundle for the utilities routes/actions.
  outputFileTracingIncludes: {
    "/utilities": ["./lib/utilities/caw/templates/*.pdf"],
    "/utilities/**": ["./lib/utilities/caw/templates/*.pdf"],
    "/api/**": ["./lib/utilities/caw/templates/*.pdf"],
  },
};

export default nextConfig;
