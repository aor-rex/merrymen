import type { Metadata } from "next";
import { YouClient } from "./YouClient";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/shell.css";
import "@/styles/feed.css";
import "@/styles/agent.css";
import "@/styles/you.css";

/**
 * Per-caller by construction, so it must never be cached — the same reason
 * /api/feed and /api/grants are force-dynamic. The public pages are the
 * opposite case and are cached precisely because they read no session.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your agent — merrymen",
};

export default function YouPage() {
  return <YouClient />;
}
