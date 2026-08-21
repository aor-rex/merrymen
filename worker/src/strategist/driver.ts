/**
 * LLM driver for the strategist. The driver's ONLY job is: signals in,
 * raw proposal JSON out. It never sees addresses, never builds intents, and
 * its output goes straight into parseProposals → proposalsToIntents where
 * deterministic code disposes.
 *
 * The brain is provider-agnostic (Groq by default, Claude as the upgrade) via
 * the shared llm layer's forced, strict-schema tool call — the model cannot
 * reply in prose, only in the proposal schema.
 * NullDriver: what runs when no LLM key is set — proposes nothing.
 */

import { llmToolCall, type LlmCreds } from "../llm";

/** Sanitized, typed market signals — numbers and enums only, no free text. */
export interface Signals {
  cashUsdg: number;
  vaultUsdg: number;
  equityUsdg: number;
  holdings: { symbol: string; valueUsdg: number; priceStale: boolean }[];
  prices: { symbol: string; usd: number; stale: boolean }[];
  tradableSymbols: string[];
  maxPerActionUsdg: number;
  utcHour: number;
  utcDay: number;
  /**
   * Pool liquidity per symbol, when it has been read. Kept to four numbers a
   * token on purpose: the model has a 2048-token budget for its whole answer,
   * and a full tick ladder would spend the reply on a histogram it cannot act
   * on. These four are the ones that change a decision — how much fits, and
   * where the next wall is either side.
   */
  depth?: {
    symbol: string;
    /** USDG buyable before price rises >0.5%. */
    buyUsdg: number;
    /** USDG sellable before price falls >0.5%. */
    sellUsdg: number;
    supportUsd: number | null;
    resistanceUsd: number | null;
  }[];
}

export interface ProposalDriver {
  name: string;
  propose(signals: Signals): Promise<unknown>;
}

/** No key, no model, no trades — the safe default. */
export const nullDriver: ProposalDriver = {
  name: "null",
  propose: async () => ({ actions: [] }),
};

const SYSTEM = `You are the strategist for a stock-token trading agent on Robinhood Chain.
Tokenized equities trade 24/7 while underlying markets close nights and weekends; Chainlink
prices are stale when markets are closed (that is expected, not an error). Idle cash earns
vault yield automatically — you do not manage the vault.

Propose portfolio actions via the propose_trades tool. Discipline rules:
- Only trade symbols from tradableSymbols. Sizes are in USDG and must respect maxPerActionUsdg.
- Prefer few, deliberate actions; propose holds when nothing is attractive.
- There is no order book on this chain, so you cannot see one. When \`depth\` is present it is
  the next best thing and a different thing: pool liquidity. Per symbol it gives the USDG you
  could trade before moving the price more than 0.5%, and the nearest prices where liquidity
  clusters. Size to buyUsdg/sellUsdg — proposing above it moves the price against yourself.
  Treat support/resistance as context, never as a signal on their own: that liquidity is
  posted by market makers who can withdraw it in a block, and a cluster is nobody's resting
  order. A symbol missing from \`depth\` simply has not been read; it is not a warning.
- Execution is quote-simulated and slippage-bounded downstream, and every action passes a
  policy wall you cannot override. Propose intent, not execution.`;

const PROPOSE_TOOL = {
  name: "propose_trades",
  description:
    "Propose the portfolio actions for this decision window. Every action is validated " +
    "against hard policy caps downstream; oversized or out-of-universe actions are dropped.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["buy", "sell", "hold"] },
            symbol: { type: "string" },
            sizeUsdg: { type: "number" },
            reason: { type: "string" },
          },
          // "reason" optional: Groq validates arguments server-side and llama
          // sometimes omits it; parseProposals defaults it to "" anyway.
          required: ["action", "symbol", "sizeUsdg"],
          additionalProperties: false,
        },
      },
    },
    required: ["actions"],
    additionalProperties: false,
  },
};

export function createDriver(creds: LlmCreds): ProposalDriver {
  return {
    name: `${creds.provider}:${creds.model}`,
    async propose(signals: Signals): Promise<unknown> {
      return llmToolCall(creds, {
        system: SYSTEM,
        maxTokens: 2048,
        tool: { name: PROPOSE_TOOL.name, description: PROPOSE_TOOL.description, schema: PROPOSE_TOOL.input_schema },
        messages: [{ role: "user", content: `Market and account signals:\n${JSON.stringify(signals, null, 2)}` }],
      });
    },
  };
}
