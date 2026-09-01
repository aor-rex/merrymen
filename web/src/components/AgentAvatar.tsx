import { avatarGradient, initialsOf } from "@/lib/agent-avatar";

/**
 * An agent's face. SQUIRCLE, always — a token logo is a circle, and that shape
 * difference is the only thing distinguishing the two at 24px in a holders
 * table or on an entry timeline, where they sit side by side with no label.
 *
 * The `wired` ring is the most repeated piece of information in the product:
 * it marks an agent your own agent reads, and it appears everywhere that agent
 * appears. Scrolling the feed should show you your network without your having
 * to read a word.
 */
export function AgentAvatar({
  name,
  size = 40,
  wired = false,
}: {
  name: string;
  size?: number;
  wired?: boolean;
}) {
  return (
    <span
      className={`mm-av${wired ? " wired" : ""}`}
      aria-hidden
      style={{
        width: size,
        height: size,
        background: avatarGradient(name),
        fontSize: Math.round(size * 0.34),
      }}
    >
      {initialsOf(name)}
    </span>
  );
}
