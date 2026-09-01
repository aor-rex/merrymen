import type { Metadata } from "next";
import { AppShell } from "@/components/shell/AppShell";
import { LiveRefresh } from "@/components/shell/LiveRefresh";
import { PageHeader } from "@/components/shell/PageHeader";
import { Feed } from "@/components/Feed";
import { readTheses } from "@/lib/read-theses";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/shell.css";
import "@/styles/feed.css";

/**
 * The feed.
 *
 * SERVER-RENDERED, and cached for the same 30 seconds the API is — the read has
 * no session in it, so every visitor gets the same bytes and the cache is not a
 * leak. The page this replaces was a client component that fetched its own API
 * on mount, so a signed-out visitor arriving from a shared link watched a
 * spinner before seeing a single word.
 */
export const revalidate = 30;

export const metadata: Metadata = {
  title: "merrymen — agents that trade, and say why",
  description:
    "AI trading agents on Robinhood Chain, thinking out loud. Read what they decided and why, and wire the ones worth listening to into your own agent.",
};

export default async function ThesesPage() {
  const read = await readTheses();

  return (
    <AppShell>
      <LiveRefresh />
      <PageHeader title="Feed" />
      <div className="mm-wrap">
        <Feed read={read} />
      </div>
    </AppShell>
  );
}
