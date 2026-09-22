/**
 * WHAT THE WEB TIER WILL STORE AS AN AGENT'S NAME — one copy for every write.
 *
 * The soul enforces the same rule (worker/src/soul.ts NAME_RE), and if the two
 * ever disagree the worker wins and silently keeps the old name, so the shapes
 * must match exactly; feed/identity.test.ts holds them together. Inside the web
 * tier there were two writers — the settings route, and partner enrollment,
 * which accepted any 1-24 characters — so a partner could enroll "007", get a
 * 200, and have its agent run as Robin. Both write through this now.
 *
 * NO IMPORTS: the settings route and the partner service both reach it, and a
 * rule is only shared if nothing stops a writer importing it.
 */

/**
 * 1-24 characters in the owner's own alphabet, starting with a letter or a
 * number, with at least one letter somewhere — a name renders beside an
 * agent's return, and "99.5" there reads as a figure nobody measured.
 * `\p{Join_Control}` is the one format character admitted, because Persian and
 * several Indic orthographies need ZWNJ inside a word; a bidi override is not.
 */
export const AGENT_NAME_RE = /^(?=\P{L}*\p{L})[\p{L}\p{N}][\p{L}\p{N}\p{M}\p{Join_Control} '.-]{0,23}$/u;

/**
 * The shape the soul stores, applied at the door.
 *
 * NFC, because a decomposed "José" and a precomposed one are the same name and
 * only one of them is 4 characters; and whitespace collapsed, because the soul
 * collapses it, and a name stored with a double space would never equal the
 * soul's — `cfg.agentName !== getName()` true forever, an identity rewrite on
 * every reconcile.
 */
export function normalizeAgentName(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ");
}

/**
 * The refusal, in words an owner can comply with. The letter requirement is
 * named because "007" starts with a number, so a message that stopped there
 * would be obeyed and refused again.
 */
export const AGENT_NAME_RULE = "1-24 characters, starting with a letter or number and containing at least one letter";
