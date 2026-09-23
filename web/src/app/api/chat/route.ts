/** Dashboard narration. The partner adapter supplies its own authoritative state. */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { agentReplyResponse, type AgentChatBody } from "@/lib/agent-chat";

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
  // STREAMED ONLY WHEN ASKED. The chat screen sends `Accept: text/event-stream`
  // and reads the agent's words as they arrive; anything that did not ask gets
  // the one JSON answer it always got. See agentReplyResponse for what may be
  // shown before the reply is complete — nothing of a command marker, ever.
  const stream = /text\/event-stream/i.test(req.headers.get("accept") ?? "");
  return agentReplyResponse(body, { stream, signal: req.signal });
}
