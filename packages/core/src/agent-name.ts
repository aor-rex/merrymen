/**
 * A NAME FOR AN AGENT NOBODY NAMED.
 *
 * Every agent used to start as "Robin" — the soul's default, the ledger
 * column's default, the feed's fallback — so the public surfaces filled with
 * clones: the same word, the same initials tile, the same three refusal rows
 * that were really three different agents. An owner who never reached the name
 * field had no way to know their agent was indistinguishable from a dozen
 * others.
 *
 * SEEDED ON THE SLUG, NOT ON ANYTHING THE OWNER TYPED. The slug is the one
 * public id that is minted once and never changes (identity-store.ts), so the
 * same agent gets the same suggestion on every screen and every visit, and the
 * web tier can compute it without a round trip. Two processes that agree on the
 * slug agree on the name.
 *
 * A SUGGESTION AND A FIRST NAME, NEVER A RENAME. The grants route writes it
 * only for a brand-new agent that arrived with no name at all; an existing
 * "Robin" keeps its name until its owner taps the chip that offers this one.
 * Renaming somebody's agent behind their back would be its own kind of
 * identity bug.
 *
 * The words are woodland and Sherwood, and deliberately say nothing about
 * money: no Gold, no Lucky, no Whale, no Bull. A name sits next to an agent's
 * figures on a page that ranks people, and a name that implies a result is a
 * claim nobody measured. Product words (Scout, Snipe, Shadow, Steady) are out
 * too — each one already means something on this screen.
 *
 * PURE and dependency-free, so the grants route, the Agent screen and a test
 * all run the identical function.
 */

/**
 * The stock name an agent carries until somebody names it.
 *
 * ONE DEFINITION: the worker soul re-exports this as DEFAULT_NAME, and the
 * Agent screen compares against it to decide whether to offer a name. If the
 * two drifted, the chip would either vanish for every unnamed agent or nag
 * every named one.
 */
export const DEFAULT_AGENT_NAME = "Robin";

const ADJECTIVES = [
  "Amber", "Ashen", "Autumn", "Birch", "Blue", "Bold", "Brindle", "Brisk",
  "Bronze", "Calm", "Cedar", "Clever", "Cobalt", "Copper", "Crimson", "Dapple",
  "Dawn", "Dusky", "Ember", "Evening", "Fallow", "Fennel", "Flint", "Frosty",
  "Gentle", "Granite", "Green", "Grey", "Hazel", "Heather", "Honey", "Hushed",
  "Indigo", "Iron", "Jolly", "Juniper", "Keen", "Larch", "Linden", "Lone",
  "Maple", "Marsh", "Meadow", "Merry", "Midnight", "Misty", "Morning", "Mossy",
  "Nimble", "Northern", "Ochre", "Olive", "Pale", "Pine", "Plum", "Quick",
  "Quiet", "Rainy", "Restless", "Rowan", "Ruddy", "Russet", "Rusty", "Sable",
  "Saffron", "Scarlet", "Silver", "Sly", "Smoky", "Snowy", "Sorrel", "Stormy",
  "Sunny", "Swift", "Tawny", "Thistle", "Umber", "Velvet", "Wandering", "Wild",
  "Windy", "Winter", "Wry",
] as const;

const NOUNS = [
  "Archer", "Badger", "Bard", "Bittern", "Bowman", "Brook", "Crane", "Crow",
  "Curlew", "Dormouse", "Drake", "Falcon", "Ferret", "Finch", "Fletcher", "Forester",
  "Fox", "Friar", "Glen", "Goshawk", "Grouse", "Hare", "Harrier", "Hart",
  "Hawk", "Hedgehog", "Heron", "Hound", "Jackdaw", "Jay", "Kestrel", "Kingfisher",
  "Kite", "Lark", "Linnet", "Lynx", "Magpie", "Mallard", "Marten", "Merlin",
  "Minstrel", "Mole", "Moth", "Newt", "Nightjar", "Otter", "Owl", "Pedlar",
  "Pike", "Piper", "Plover", "Quail", "Rambler", "Raven", "Rook", "Shrike",
  "Siskin", "Skylark", "Sparrow", "Squire", "Stag", "Starling", "Stoat", "Swallow",
  "Tanner", "Teal", "Thrush", "Tinker", "Vole", "Wagtail", "Warbler", "Weasel",
  "Wolf", "Woodpecker", "Wren", "Yeoman",
] as const;

/** Read-only view of the word lists, for tests that run every combination. */
export const GENERATED_NAME_PARTS: { readonly adjectives: readonly string[]; readonly nouns: readonly string[] } = {
  adjectives: ADJECTIVES,
  nouns: NOUNS,
};

/**
 * FNV-1a, 32-bit, then murmur3's finaliser. Not cryptographic and not trying
 * to be: nobody gains anything by steering their own suggestion, and a slug is
 * already 80 random bits. The finaliser just keeps nearby slugs from landing on
 * nearby names.
 */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * "Amber Heron" for one slug, forever. Null when there is no slug to seed on.
 *
 * NULL RATHER THAN A FALLBACK: a blank seed would hand every slug-less caller
 * the same generated name, which is the clone this exists to end.
 *
 * Every combination is two words of letters, at most 20 characters, so it
 * passes the soul's name rule in both of its copies — identity.test.ts runs
 * every one of them through both.
 */
export function agentNameForSlug(slug: string): string | null {
  const seed = slug.trim().toLowerCase();
  if (!seed) return null;
  const h = hash(seed);
  // Mixed radix: the adjective is the low digit and the noun the next one, so
  // every (adjective, noun) pair owns its own slice of the hash and the whole
  // grid is reachable rather than one list's worth of it.
  const adjective = ADJECTIVES[h % ADJECTIVES.length]!;
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length]!;
  return `${adjective} ${noun}`;
}
