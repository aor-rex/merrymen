/**
 * The publication gate, re-exported.
 *
 * The policy itself moved to `worker/src/thesis-policy.ts` when the
 * orchestrator became a second reader of it — it materialises each child's
 * followed theses into a file the agent's desk reads, and what it writes has to
 * be exactly what this feed publishes. The worker cannot import from `web/src`,
 * so the module moved rather than being copied: two copies of a publication
 * policy drift, and the drift is invisible until something private lands on a
 * page.
 *
 * This file exists so every `@/lib/thesis` import in the web tree keeps
 * working. Nothing here may add behaviour — a check that lives on this side
 * only would apply to the browser's copy and not to the agent's, which is the
 * exact asymmetry the move was made to prevent.
 */
export {
  PUBLISHABLE_STRATEGIES,
  REJECT_RULES,
  classifyDrop,
  outcomeOf,
  publishableThesis,
  type PublicThesis,
  type ThesisRow,
} from "@merrymen/thesis";
