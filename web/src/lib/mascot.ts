/**
 * What the little merryman in the corner is doing, and the rule that keeps him
 * honest.
 *
 * HE IS DRIVEN BY TIMESTAMPS, NEVER BY A TIMER. A mascot that animates
 * "thinking" on a CSS loop looks identical whether the worker is reasoning
 * about the market or has been dead for a week. On a console whose entire pitch
 * is that you can see what the agent is really doing, that is not a harmless
 * flourish — it is the same failure as reporting a virtual seed as depth, in a
 * place nobody would think to check.
 *
 * So every mood below is a fact with a clock behind it: he draws when a trade
 * landed in the last two minutes, thinks when the worker wrote to the ledger in
 * the last two, rests when it is alive but quiet, and sleeps when nothing has
 * been heard at all.
 *
 * It lives here rather than in Console.tsx so it can be tested without pulling
 * the whole client tree — the component only renders what this decides.
 */

export type MascotMood = "loosed" | "thinking" | "resting" | "asleep";

/** How recent a ledger write or a fill has to be to count as happening now. */
export const MASCOT_RECENT_SEC = 120;

export function mascotMood(args: {
  mode: string;
  lastEventAt: string | undefined;
  lastTradeAt: string | undefined;
  now?: number;
}): { mood: MascotMood; say: string } {
  const now = args.now ?? Date.now();
  // An unparseable timestamp is INFINITELY old, not zero. Returning 0 would
  // read as "one millisecond ago" and pin him permanently to thinking.
  const ageOf = (s: string | undefined): number => {
    if (!s) return Infinity;
    const t = new Date(String(s).replace(" ", "T") + "Z").getTime();
    return Number.isNaN(t) ? Infinity : (now - t) / 1000;
  };
  if (ageOf(args.lastTradeAt) < MASCOT_RECENT_SEC) return { mood: "loosed", say: "just took a shot" };
  if (ageOf(args.lastEventAt) < MASCOT_RECENT_SEC) return { mood: "thinking", say: "reading the market" };
  if (args.mode === "idle") return { mood: "asleep", say: "not running" };
  // Alive but nothing new: say so rather than implying work. Most ticks are
  // uneventful, and "waiting" is the true description of the common case.
  return { mood: "resting", say: args.mode === "paper" ? "watching, on paper" : "watching" };
}
