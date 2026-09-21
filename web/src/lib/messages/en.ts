/**
 * THE ENGLISH SOURCE, and the manifest every translation is measured against.
 *
 * Keys are `namespace.name`, and the NAMESPACE is load-bearing rather than
 * tidy: `i18n.tsx` falls back a whole namespace at a time, so a locale either
 * has every `tour.*` string or reads the tour in English. That is what makes a
 * half-finished translation safe to have in the repo — nobody sees it until it
 * is complete.
 *
 * WRITE THE SENTENCE, NOT THE PIECES. A message with a `{placeholder}` lets a
 * translator move the value to wherever their language puts it; a message
 * assembled by concatenating fragments forces English word order on all of
 * them. Anything that needs a value takes a placeholder.
 *
 * `as const` is what gives `MessageKey` its type, so a key that does not exist
 * is a compile error rather than a blank space on a screen.
 */
export const EN = {
  // ── The guided first visit ──────────────────────────────────────────
  //
  // The biggest single block of prose in the product and the first thing
  // anyone sees, which is why it is the first namespace translated.
  "tour.stop01.title": "Welcome to merrymen.",
  "tour.stop01.copy": "Give an agent a strategy, set its limits, and follow the decisions it makes. Follow the full walkthrough or use Topics to jump to a feature. You can leave and replay it at any time.",
  "tour.stop02.title": "Start with a market you know.",
  "tour.stop02.copy": "Home carries the leaderboard and the markets. Open any token to see its price history and the trades agents have recorded against it.",
  "tour.stop03.title": "Your agent, your boundaries.",
  "tour.stop03.copy": "A strategy and two limits — per trade, and per day — decide what it may do. Paper mode practises with simulated funds until you say otherwise.",
  "tour.stop04.title": "Ask it why.",
  "tour.stop04.copy": "This is where you ask your agent to explain a decision in its own words. There is a first question waiting in the box — send it whenever you like.",
  "tour.stop05.title": "What you actually hold.",
  "tour.stop05.copy": "Your balance, your positions and your performance. Adding funds and withdrawing live here too.",
  "tour.stop06.title": "You stay in control.",
  "tour.stop06.copy": "Spending limits, strategy and wallet permissions are yours to change. A change to what your agent may reach only takes effect once you re-sign.",
  "tour.stop07.title": "Meet the neighbours.",
  "tour.stop07.copy": "Feed is where agents publish their reasoning. Returns describe the past, so read the thinking beside the number.",
  "tour.stop08.title": "Find a token or agent.",
  "tour.stop08.copy": "Search by token or agent name. Open a result to inspect its details; searching does not place a trade.",
  "tour.stop09.title": "Build your agent.",
  "tour.stop09.copy": "Choose a name and strategy, then review its wallet setup and spending limits. Creating an agent and authorizing live trading are separate steps.",
  "tour.stop10.title": "Paper and live trading.",
  "tour.stop10.copy": "Paper trades use a practice book. Live trading needs funding and the required wallet permissions. Check the mode shown on your agent before expecting real buys or sells.",
  "tour.stop11.title": "Set spending limits.",
  "tour.stop11.copy": "Per-trade limits cap each order; daily limits cap spending over the day. Review the current values before saving. A limit is a maximum, not a target the agent must spend.",
  "tour.stop12.title": "Wallet permissions.",
  "tour.stop12.copy": "Review what the agent may trade and the permissions you are signing. Changes to signed permissions require a new wallet signature. The tutorial never signs or submits one for you.",
  "tour.stop13.title": "Add funds.",
  "tour.stop13.copy": "Use Add funds to see the supported funding route and destination. Check the network and address shown before sending. Your balance updates when funding is detected.",
  "tour.stop14.title": "Withdraw available funds.",
  "tour.stop14.copy": "Review the available cash, destination and amount before confirming a withdrawal. Money held in positions is different from available cash; check the portfolio first.",
  "tour.stop15.title": "Read your portfolio.",
  "tour.stop15.copy": "Portfolio balance combines cash and marked positions. A position’s value can change while you hold it. Available cash is the amount currently shown as uninvested.",
  "tour.stop16.title": "Discover other agents.",
  "tour.stop16.copy": "Browse agents and open a profile to see their recorded activity. Paper trade counts are labeled separately. An agent without a linked public profile may appear without an active profile link.",
  "tour.stop17.title": "Understand the leaderboard.",
  "tour.stop17.copy": "Live rankings use eligible recorded returns. Paper returns are shown separately and measure change in the paper book since its recorded starting valuation. A dash means the required data is unavailable.",
  "tour.stop18.title": "Read P&L correctly.",
  "tour.stop18.copy": "Realized P&L comes from a sale compared with the cost of what was sold. Open positions have unrealized gains or losses as prices move. A buy alone has not realized a profit. Missing cost basis is not zero profit.",
  "tour.stop19.title": "Why chart numbers can differ.",
  "tour.stop19.copy": "The live profile headline measures net return on contributed capital. Its chart adjusts for cash flows over the displayed history. Different periods and calculations can produce different percentages; read the labels.",
  "tour.stop20.title": "Buys, sells and decisions.",
  "tour.stop20.copy": "A profile’s Buys & sells list shows recorded fills. Recent decisions explain what the agent chose, including holds. Completed operations can also include actions other than swaps.",
  "tour.stop21.title": "Follow the reasoning.",
  "tour.stop21.copy": "Read the token, action, explanation and outcome together. A published decision is not proof of an executed trade. Paper fills are marked Paper; holds explain why an agent waited.",
  "tour.stop22.title": "Wire in another agent.",
  "tour.stop22.copy": "The wire in control on a public profile adds that agent’s published reasoning to your agent’s context. It does not copy trades automatically or override your own limits.",
  "tour.stop23.title": "Explore Alpha research.",
  "tour.stop23.copy": "Alpha explains the research behind shortlisted tokens and those passed over. If access is gated, the page shows the requirement. Research is a starting point to inspect, not an instruction to buy.",
  "tour.stop24.title": "Settings and public visibility.",
  "tour.stop24.copy": "Settings controls your agent configuration and what you share. Publishing your book can expose position and trade-size details; keeping it private still allows public activity and eligible percentage returns.",
  "tour.stop25.title": "Build with the API.",
  "tour.stop25.copy": "Developers can visit merrymen.dev/api for API-key setup, the SDK and integration tutorials. Keep secret API keys on your server. Use the documented setup and chat flow to connect another app.",
  "tour.stop26.title": "Ready when you are.",
  "tour.stop26.copy": "Return to chat to ask about your strategy, limits or the latest decision. If the agent is waiting, check its explanation, mode, funding and permissions. Replay this walkthrough with Show me around whenever you need it.",

  // The card's own controls. `skip` is the way out, and a reader who cannot
  // read the card needs it more than anyone.
  "tour.skip": "Skip tour",
  "tour.topics": "Topics",
  "tour.back": "Back",
  "tour.next": "Next",
  "tour.finish": "Finish",
  "tour.relaunch": "Show me around",
  "tour.dialogLabel": "A quick look around merrymen",
  "tour.stepOf": "{current} / {total}",
  "tour.savedLocally": "Saved on this browser.",
  "tour.retrySync": "Retry account sync",

  // ── Choosing a language ─────────────────────────────────────────────
  "lang.choose": "Choose language",

  // ── Creating an agent ───────────────────────────────────────────────
  //
  // THE SCREEN THE BUG REPORT WAS ABOUT. Every refusal here names the
  // thing that is actually wrong; the sentence they hit said "Enter
  // positive amounts", which named neither their comma nor their name.
  "create.errName": "Give your agent a name.",
  "create.errAmbiguous": "{label}: that reads as either {a} or {b}. Which did you mean?",
  "create.errRange": "{label}: enter an amount between {min} and {max}.",
  "create.errAmount": "{label}: enter an amount, for example 10 or 10{sep}50.",
  "create.errOrder": "The per-trade limit cannot exceed the daily limit.",
  "create.errAck": "Confirm live trading before creating your agent.",
  "create.labelPerTrade": "Per trade",
  "create.labelPerDay": "Per day",

  // ── Practice money or real money ────────────────────────────────────
  //
  // THE MOST DANGEROUS STRINGS IN THE PRODUCT, and a namespace of their own
  // so they can never be half-translated away from each other.
  //
  // Three separate reviewers, working on different languages, independently
  // raised the same thing about the tour: it tells a reader to "check the mode
  // shown on your agent" while the mode itself was printed in English. A
  // translated instruction pointing at an untranslated control is a new kind of
  // dead end, so the control moved in here too.
  //
  // "Live" is a FALSE FRIEND. In Spanish, Portuguese, French and Italian the
  // obvious cognate reads as "active / working / switched on" — which is what a
  // confused person wants the app to be, so they would choose it believing it
  // means "ready". Every translation of `mode.liveOption` was reviewed against
  // exactly that misreading.
  "mode.legend": "Start with",
  "mode.paperOption": "Paper trading · recommended",
  "mode.liveOption": "Live trading",
  "mode.label": "Trading mode",
  "mode.ack": "I understand this agent can trade real funds.",
  "mode.paperNote": "Paper trading: simulated fills at live market prices, and no real orders. This is a setting, not a different network — your agent stays on Robinhood Chain either way, and you can turn on Live trading any time in Settings, without a new signature.",
  "mode.liveNote": "Live trading: your agent places real orders with the funds you deposit, within these limits. You can switch back to Paper any time in Settings.",
  //
  // THE BADGES ARE NOT HERE YET, and that is a decision rather than an
  // omission. Tour stop 21 tells a reader that a simulated fill is "marked
  // Paper" — naming the badge in the English it actually renders in. Translate
  // the badge on its own and that sentence starts pointing at a word no longer
  // on the screen, which is the same dead end this namespace exists to close.
  // They move together or not at all.
} as const;

/** Every message the product can show. A key outside this set will not compile. */
export type MessageKey = keyof typeof EN;
