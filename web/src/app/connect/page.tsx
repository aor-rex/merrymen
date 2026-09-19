import type { Metadata } from "next";
import { Providers } from "@/terminal/Providers";
import { ConnectClient } from "./ConnectClient";
import "./connect.css";

export const metadata: Metadata = {
  title: "Connect your agent · merrymen",
  description: "Choose what another app can access through your Merrymen agent.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ConnectPage() {
  return <Providers><ConnectClient /></Providers>;
}
