/** Dashboard narration. The partner adapter supplies its own authoritative state. */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { generateAgentReply, type AgentChatBody } from "@/lib/agent-chat";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (isHostedMode() && !tenantOf(req)) {
    return NextResponse.json({ reply: null, why: "not signed in" }, { status: 401 });
  }
  let body: AgentChatBody;
  try {
    body = await req.json() as AgentChatBody;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("bad body");
  } catch {
    return NextResponse.json({ reply: null, why: "bad body" }, { status: 400 });
  }
  const result = await generateAgentReply(body);
  return NextResponse.json(result, { status: result.why === "empty" ? 400 : 200 });
}
