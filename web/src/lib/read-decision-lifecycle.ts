import { readDecisionLifecycle, type DecisionLifecycle } from "../../../worker/src/decision-lifecycle";
import { isProvenance } from "../../../worker/src/provenance";
import { classifyDrop, publishableThesis, rejectRuleLabel } from "../../../worker/src/thesis-policy";
import { withReadDb } from "./ledger";

/** Public lifecycle prose follows the same policy as the public feed. */
export async function readPublicDecisionLifecycle(id: string, readDb: typeof withReadDb = withReadDb) {
  try {
    return await readDb(async (db) => {
      if (!db) return null;
      const life = await readDecisionLifecycle(db, id);
      if (!life || !/^0x[0-9a-f]{40}$/i.test(life.decision.agent_id)) return null;
      const owner = await db.prepare("SELECT name, x_handle, mode FROM agents WHERE LOWER(smart_account) = LOWER(?) LIMIT 1")
        .get(life.decision.agent_id) as { name: string; x_handle: string | null; mode: string } | undefined;
      if (!owner || !["live", "paper"].includes(owner.mode)) return null;
      const last = life.trades.at(-1);
      const thesis = publishableThesis({
        ...life.decision,
        ...owner,
        status: last?.status,
        reject_rule: last?.reject_rule,
        post: life.post?.body,
        last_at: life.decision.at,
      });
      if (!thesis) return null;
      const d = life.decision;
      return {
        decision: {
          id: d.id,
          agent_id: d.agent_id,
          source: d.source,
          provenance: isProvenance(d.provenance) ? d.provenance : null,
          action: thesis.action,
          symbol: thesis.symbol,
          size_usdg: thesis.sizeUsdg,
          reason: thesis.reason,
          dropped_rule: d.dropped_rule ? classifyDrop(d.dropped_rule) : null,
          hold_kind: d.hold_kind === "MODEL_HOLD" || d.hold_kind === "GATE_FORCED_HOLD" ? d.hold_kind : null,
          at: d.at,
        },
        paper: thesis.paper,
        outcome: thesis.outcome,
        outcomeText: thesis.outcomeText,
        // A raw rejection can contain an address or model-written text. Keep a
        // recognized machine rule only; expose the policy's wording separately.
        trades: life.trades.map(publicTrade),
        post: life.post && thesis.post ? { body: thesis.post, created_at: life.post.created_at } : null,
      };
    });
  } catch {
    // Missing, unpublished and unreadable decisions have the same public shape.
    return null;
  }
}

function publicTrade(t: DecisionLifecycle["trades"][number]) {
  const label = rejectRuleLabel(t.reject_rule);
  const hash = (value: string | null) => value && /^0x[0-9a-f]{64}$/i.test(value) ? value : null;
  return {
    ...t,
    reject_rule: label ? t.reject_rule : null,
    rejection: t.status === "rejected" ? label ?? "execution was refused" : null,
    user_op_hash: hash(t.user_op_hash),
    tx_hash: hash(t.tx_hash),
  };
}
