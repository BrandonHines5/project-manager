import type { MetadataRoute } from "next"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Hines Homes — Project Manager",
    short_name: "PM",
    description: "Internal project management for Hines Homes",
    start_url: "/",
    display: "standalone",
    background_color: "#021b42",
    theme_color: "#021b42",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  }
}
