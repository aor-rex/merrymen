import type { Metadata } from "next";
import Link from "next/link";
import { AgentDashboard } from "@/components/AgentDashboard";

export const metadata: Metadata = {
  title: "Your merryman, live — holdings and value from the chain",
  description:
    "Paste your agent's smart-account address and see what it holds right now, priced, read straight from Robinhood Chain in your browser. No account, no login, no server in between.",
};

export default function Dashboard() {
  return (
    <section className="watch-page">
      <div className="wrap">
        <div className="section-head">
          <div className="tag" data-reveal="fade">
            <span className="n">—</span> live dashboard
          </div>
          <h1 data-reveal="mask">See it working.</h1>
          <p className="watch-lede" data-reveal="up">
            Everything a merryman owns sits in a smart account on Robinhood Chain, and a chain is
            public by construction. So you can watch yours from anywhere — no login, no account with
            us, and no server of ours between you and the answer. Paste the address and the numbers
            below are read live, in this tab.
          </p>
        </div>

        <AgentDashboard />

        <div className="watch-notes">
          <h3>Where do I find the address?</h3>
          <p>
            Your own dashboard shows it at the top, and the phone app has it under{" "}
            <strong>Settings → the wall</strong>. It&apos;s the <strong>smart account</strong> — the
            one that holds the money — not the owner address your recovery phrase derives. Those are
            different addresses, and mixing them up is the single most common way people think their
            funds have vanished.
          </p>

          <h3>Why can&apos;t I see my trades and rejections here?</h3>
          <p>
            Because they aren&apos;t on the chain. A trade that <em>happened</em> is a transaction
            anyone can read — the{" "}
            <Link className="link" href="/watch">
              live tape
            </Link>{" "}
            shows those. But the reasoning behind it, and every trade your caps <em>refused</em>,
            live in the ledger on your own machine. We could only show you those by running a server
            that holds your data, which is the thing merrymen exists not to do. Your local dashboard
            has the full picture.
          </p>

          <h3>Is this safe to open on someone else&apos;s computer?</h3>
          <p>
            Yes — an address is public information and reveals no ability to spend. Pasting one here
            lets you look; it never lets anyone move anything. Your keys never leave your own
            machine, and nothing on this page asks for them.
          </p>
        </div>
      </div>
    </section>
  );
}
