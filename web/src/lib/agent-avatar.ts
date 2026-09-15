/**
 * A stable face per agent.
 *
 * There are no uploaded avatars in the product and no identicon generator, so
 * an agent's face is a seeded gradient plus its initials. Seeded on the NAME,
 * which is public everywhere the face appears — and which, before the identity
 * store existed, was the only thing the feed route sent that could seed
 * anything at all.
 *
 * DETERMINISTIC IS THE POINT. A feed where faces move between refreshes is a
 * feed nobody learns to read, and recognising an agent at a glance is most of
 * what makes a social product feel social.
 *
 * Pure and dependency-free so it can be called from a server component, a
 * client component and a share-card renderer without any of them differing.
 */

/** A hue in [0, 360). Cheap, stable, and not required to be well-distributed. */
export function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/** "Will Scarlet" -> "WS", "Much" -> "MU", "" -> "??". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** The gradient for an agent's square. Two stops, 42 degrees apart on the wheel. */
export function avatarGradient(name: string): string {
  const h = hueOf(name);
  return `linear-gradient(145deg, hsl(${h} 62% 62%), hsl(${(h + 42) % 360} 58% 44%))`;
}
