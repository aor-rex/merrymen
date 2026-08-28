import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { RegisterSW } from "@/components/RegisterSW";

// The merrymen.dev typefaces — used on the setup/settings screens (.setup-look)
// so onboarding feels like the website; the trading terminal keeps its own fonts.
const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-hanken",
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});
const jbmono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jbmono", display: "swap" });

const OG_TITLE = "merrymen — autonomous agents for Robinhood Chain";
const OG_DESC =
  "Deploy autonomous trading agents that work Sherwood 24/7 — inside hard on-chain permission walls you set and can see.";

export const metadata: Metadata = {
  // Absolute base for og:image + other relative metadata URLs (link previews
  // need a full URL). The hosted product lives at the bare domain.
  metadataBase: new URL("https://app.merrymen.dev"),
  title: OG_TITLE,
  description: OG_DESC,
  manifest: "/manifest.webmanifest",
  applicationName: "merrymen",
  // The share card — what a pasted app.merrymen.dev link unfurls to.
  openGraph: {
    type: "website",
    siteName: "merrymen",
    title: OG_TITLE,
    description: OG_DESC,
    url: "/",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "merrymen — the band, riding Sherwood" }],
  },
  twitter: {
    card: "summary_large_image",
    title: OG_TITLE,
    description: OG_DESC,
    images: ["/og.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "merrymen",
    // The status bar sits over the app in standalone mode, so it has to match
    // the dashboard's own background or it reads as a white bar on dark chrome.
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0d1512",
  // `viewport-fit=cover` lets the layout reach under the notch; the CSS then
  // pays that back with safe-area padding, which is why both halves are needed.
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${hanken.variable} ${jbmono.variable}`}>
      <body>
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
