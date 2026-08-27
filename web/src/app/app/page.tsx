import type { Metadata } from "next";
import "./console.css";
import Console from "./Console";

export const metadata: Metadata = {
  title: "merrymen — the console",
  description: "Run your merryman: equity, the wall, the decision tape, and talk to the agent — one sleek surface.",
};

export const dynamic = "force-dynamic";

export default function AppConsolePage() {
  return <Console />;
}
