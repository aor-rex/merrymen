"use client";

import { useState } from "react";
import { avatarGradient, initialsOf } from "@/lib/agent-avatar";

/**
 * An agent's face. SQUIRCLE, always — a token logo is a circle, and that shape
 * difference is the only thing distinguishing the two at 24px in a holders
 * table or on an entry timeline, where they sit side by side with no label.
 *
 * TWO LAYERS, AND THE BOTTOM ONE IS ALWAYS THERE. The seeded gradient and
 * initials render first and never fail; a generated robot is painted over the
 * top when one arrives. So an agent is never a broken image, never an empty
 * square, and never a spinner — the same rule the token art follows, for the
 * same reason: roughly one launch in 250 publishes no logo, and a shattered
 * icon reads as a broken page rather than a missing file.
 *
 * The face is seeded on the SLUG, not the name. A name is owner-typed and
 * editable, and a feed where faces move between visits is a feed nobody learns
 * to read. An agent with no slug yet keeps the gradient, which is exactly what
 * it had before.
 *
 * The `wired` ring is the most repeated piece of information in the product: it
 * marks an agent your own agent reads, and it appears everywhere that agent
 * appears. Scrolling the feed should show you your network without your having
 * to read a word.
 */
export function AgentAvatar({
  name,
  slug = null,
  size = 40,
  wired = false,
}: {
  name: string;
  /** The public id. Null means no generated face — the gradient stands alone. */
  slug?: string | null;
  size?: number;
  wired?: boolean;
}) {
  const [failed, setFailed] = useState(false);

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
      {slug && !failed && (
        // eslint-disable-next-line @next/next/no-img-element -- next/image would
        // need the proxy's own route in next.config for no benefit; this is a
        // 160px square already served from our origin.
        <img
          className="mm-av-face"
          src={`/api/agent-face?seed=${encodeURIComponent(slug)}`}
          alt=""
          loading="lazy"
          decoding="async"
          width={size}
          height={size}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
