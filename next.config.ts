import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-lib is a heavy pure-JS dependency used only server-side (utility form
  // fill). Keep it out of the bundler so it loads from node_modules at runtime.
  serverExternalPackages: ["pdf-lib"],
  // The utility form fill (CAW, Lumber One) reads the blank template PDFs from
  // disk at runtime via a computed path, which Turbopack's tracing can't detect
  // — force them into the serverless function bundle for the utilities
  // routes/actions.
  outputFileTracingIncludes: {
    "/utilities": [
      "./lib/utilities/caw/templates/*.pdf",
      "./lib/utilities/lumber-one/templates/*.pdf",
    ],
    "/utilities/**": [
      "./lib/utilities/caw/templates/*.pdf",
      "./lib/utilities/lumber-one/templates/*.pdf",
    ],
    "/api/**": [
      "./lib/utilities/caw/templates/*.pdf",
      "./lib/utilities/lumber-one/templates/*.pdf",
    ],
  },
  // Baseline security headers on every response.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // The app is never embedded in a frame — deny to block clickjacking.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
