"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { FreshCard, MarketCard, chainGap } from "@/components/TokenCards";
import type { Payload } from "@/app/api/discoveries/route";

/**
 * What is launching, and what is trading.
 *
 * A client component because /api/discoveries is `force-dynamic` behind an
 * in-process single-flight memo — it does live index and on-chain reads, and
 * the page must not block a server render on them.
 *
 * THE ORDER OF THE TWO EMPTY STATES IS LOAD-BEARING and pinned by
 * api/discoveries/honesty.test.ts. The quiet-launchpad sentence is a confident
 * claim about a venue that runs at hundreds of launches an hour, and it may
 * only be made when the launch scan actually SUCCEEDED. So the unreadable case
 * is checked first, always.
 *
 * (That test compares source positions, so this comment deliberately does not
 * quote the sentence itself — doing so put a match above the code and failed
 * the check it was describing.)
 */

type Tab = "fresh" | "market";

export function TokensClient() {
  const [disc, setDisc] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<Tab>("fresh");

  useEffect(() => {
    let alive = true;
    let first = true;
    const load = async () => {
      // Gate the poll, never the first load — a tab opened in the background
      // would otherwise sit on its placeholder forever.
      if (!first && document.visibilityState !== "visible") return;
      first = false;
      try {
        const r = await fetch("/api/discoveries");
        const d = (await r.json()) as Payload;
        if (alive) {
          setDisc(d);
          setFailed(false);
        }
      } catch {
        if (alive && !disc) setFailed(true);
      }
    };
    void load();
    // Two minutes: every render costs live index reads and, when a model is
    // configured, one scout call. This is not a ticker.
    const id = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const gap = disc ? chainGap(disc) : "";

  return (
    <AppShell>
      <PageHeader
        title="Tokens"
        sub="Read live from the chain and the index — never from an agent's own ledger."
        right={
          <div className="mm-seg" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "fresh"}
              className={tab === "fresh" ? "on" : ""}
              onClick={() => setTab("fresh")}
            >
              Just launched
            </button>
            <button
              role="tab"
              aria-selected={tab === "market"}
              className={tab === "market" ? "on" : ""}
              onClick={() => setTab("market")}
            >
              Trading now
            </button>
          </div>
        }
      />

      <div className="mm-wrap">
        {/* Once per page, not once per card: the three on-chain reads fail as a
            WAVE, so thirty "unknown"s would read as thirty broken coins. */}
        {gap && <div className="mm-readfail">{gap}</div>}

        {failed && !disc ? (
          <div className="mm-empty">
            <h2>Couldn&rsquo;t read the market just now</h2>
            <p>So this is what we don&rsquo;t know, not an empty market. It retries on its own.</p>
          </div>
        ) : !disc ? (
          <div className="mm-cards">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="mm-card skel" />
            ))}
          </div>
        ) : tab === "fresh" ? (
          <FreshList disc={disc} />
        ) : (
          <MarketList disc={disc} />
        )}
      </div>
    </AppShell>
  );
}

function FreshList({ disc }: { disc: Payload }) {
  // UNREADABLE FIRST. Saying "nothing launched" when the scan failed is a
  // confident claim about a launchpad running at hundreds of launches an hour.
  if (!disc.chain.launchpad) {
    return (
      <div className="mm-empty">
        <h2>The launch scan didn&rsquo;t come back</h2>
        <p>
          So we can&rsquo;t say what has launched — not that nothing has. The chain turned this read
          down and it retries on its own.
        </p>
      </div>
    );
  }
  if (disc.fresh.length === 0) {
    return (
      <div className="mm-empty">
        <h2>Nothing launched in the last few minutes has anyone trading it</h2>
        <p>
          The bar is 25 trades from 3 distinct addresses. Plenty launches; almost none of it is
          traded by more than the launcher.
        </p>
      </div>
    );
  }
  return (
    <div className="mm-cards">
      {disc.fresh.map((f) => (
        <FreshCard key={f.token} f={f} />
      ))}
    </div>
  );
}

function MarketList({ disc }: { disc: Payload }) {
  if (disc.indexUnreachable) {
    return (
      <div className="mm-empty">
        <h2>The index didn&rsquo;t answer</h2>
        <p>
          Prices, depth and volume all come from it, so there is nothing to show — which is not the
          same as nothing trading.
        </p>
      </div>
    );
  }
  if (disc.rows.length === 0) {
    return (
      <div className="mm-empty">
        <h2>Nothing cleared the screen</h2>
        <p>Scanned {disc.scanned} pools. None of them had enough behind it to be worth a card.</p>
      </div>
    );
  }
  return (
    <div className="mm-cards">
      {disc.rows.map((r) => (
        <MarketCard key={r.token} r={r} />
      ))}
    </div>
  );
}
