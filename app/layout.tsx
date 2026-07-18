import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Toaster } from "sonner"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

// Same resolution chain as lib/email.ts:appUrl — inlined so the root layout
// doesn't pull the email module (Resend SDK, admin client) into its graph.
const metadataBaseUrl =
  process.env.NEXT_PUBLIC_APP_URL ||
  (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
  "http://localhost:3000"

export const metadata: Metadata = {
  metadataBase: new URL(metadataBaseUrl),
  title: "BuildFox — Project Manager",
  description: "Construction project management by BuildFox",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "BuildFox",
    statusBarStyle: "black-translucent",
  },
}

export const viewport: Viewport = {
  themeColor: "#021b42",
  // Expose env(safe-area-inset-*) so the shell can pad around the iPhone
  // notch / home indicator when installed as a home-screen app (the manifest
  // + black-translucent status bar draw content full-bleed under them).
  viewportFit: "cover",
  // Android: shrink the layout when the on-screen keyboard opens so pinned
  // dialog footers (AI assistant input, drawer save bars) stay visible.
  interactiveWidget: "resizes-content",
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster
          position="bottom-right"
          richColors
          closeButton
          toastOptions={{ className: "text-sm" }}
        />
      </body>
    </html>
  )
}
