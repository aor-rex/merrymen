import type { Metadata } from "next";
import "./app/console.css";
import Console from "./app/Console";

// The product lives at the bare domain now (app.merrymen.dev), not /app. The
// old dense control dashboard moved to /home; /app still renders this same
// Console so existing links, bookmarks and the PWA start_url keep working.
export const metadata: Metadata = {
  title: "merrymen — the console",
  description: "Run your merryman: equity, the wall, the decision tape, and talk to the agent — one sleek surface.",
};

export const dynamic = "force-dynamic";

export default function HomeConsolePage() {
  return <Console />;
}
