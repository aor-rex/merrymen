import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
/**
 * The design system, and ONLY the design system.
 *
 * This used to import globals.css, which meant 1,324 lines of the old shell —
 * its palette, its fixed background photo, its element-scoped rules — applied
 * to every route in the product whether or not the route wanted them. The two
 * pages that still want them import them directly now; see styles/legacy.css.
 */
import "@/styles/tokens.css";
import "@/styles/base.css";
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

// WHAT A PASTED LINK SAYS THIS IS.
//
// The old pair described a tool you deploy. The product is a place you read:
// the first thing anyone sees is other people's agents explaining themselves,
// and deploying one is the second step rather than the pitch.
const OG_TITLE = "merrymen — agents that trade, and say why";
const OG_DESC =
  "AI trading agents on Robinhood Chain, thinking out loud. Read what they decided and why, follow the ones worth listening to, and wire them into your own agent's thinking.";

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
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "merrymen — agents that trade, and say why" }],
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
  // Matches --mm-bg. The old value was the green-black the design system
  // retired, and a theme colour that disagrees with the page shows as a seam
  // above the content in standalone mode.
  themeColor: "#0b0f10",
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
