import type { Metadata } from "next";
import { TokensClient } from "./TokensClient";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/shell.css";
import "@/styles/feed.css";
import "@/styles/cards.css";

export const metadata: Metadata = {
  title: "Tokens — merrymen",
  description:
    "What is launching on Robinhood Chain and what is actually trading, read live from the chain and the index.",
};

export default function TokensPage() {
  return <TokensClient />;
}
