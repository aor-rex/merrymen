import type { Metadata } from "next";
import { DeveloperConsole } from "./DeveloperConsole";
import "./developer.css";

export const metadata: Metadata = { title: "Developers — API & SDK", description: "Create your Merrymen API key, download the browser SDK, and build agent creation and chat into your app." };
export default function ApiPage() { return <DeveloperConsole />; }
