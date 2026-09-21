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

  // ── Settings ───────────────────────────────────────────────────────
  //
  // 149 strings, the largest surface in the product and the one with the
  // second live-trading switch on it. `settings` therefore requires `mode`
  // like the others: a translated Settings page whose trading-mode row still
  // read English would be the same dead end, on the screen where somebody
  // goes specifically to change that.
  //
  // Keys are slugged from the English so a reader of the JSX can tell what a
  // key says without opening this file. Identical English shares one key,
  // which is why there are 149 of them for 156 sites.
  "settings.label.aiProvider": "AI provider",
  "settings.label.baseUrl": "base URL",
  "settings.label.model": "model",
  "settings.label.pimlicoApiKey": "Pimlico API key",
  "settings.label.agentName": "Agent name",
  "settings.label.profilePicture": "Profile picture",
  "settings.label.banner": "Banner",
  "settings.label.strategy": "Strategy",
  "settings.label.symbol": "symbol",
  "settings.label.contractAddress": "contract address",
  "settings.label.decimals": "decimals",
  "settings.label.minimumPoolDepthUsd": "minimum pool depth (USD)",
  "settings.label.maxSpotVsAverage": "max spot-vs-average gap (bps)",
  "settings.label.checkEveryMinutes": "check every (minutes)",
  "settings.label.scoutBudgetUsdg": "scout budget (USDG)",
  "settings.label.maxPerTokenUsdg": "max per token (USDG)",
  "settings.label.perEntryUsdg": "per entry (USDG)",
  "settings.label.maxOpenPositions": "max open positions",
  "settings.label.maximumHoldingTimeSeconds": "maximum holding time (seconds)",
  "settings.label.minimumCurveDepthUsdg": "minimum curve depth (USDG)",
  "settings.label.botToken": "bot token",
  "settings.label.connection": "connection",
  "settings.label.chatTradeCeiling": "chat trade ceiling",
  "settings.label.dailyTransferBudget": "daily transfer budget",
  "settings.label.tradePingsHowOften": "trade pings — how often",
  "settings.label.dailyReportHour": "daily report hour",
  "settings.label.stepBudget": "step budget",
  "settings.label.filesRoot": "files root",
  "settings.label.transcriptionKeyVoice": "transcription key (voice)",
  "settings.label.mainnetRpcOverride": "mainnet RPC override",
  "settings.label.testnetRpcOverride": "testnet RPC override",
  "settings.label.bundlerUrlOverride": "bundler URL override",
  "settings.label.breakerContract": "breaker contract",
  "settings.label.v4AdapterContract": "v4 adapter contract",
  "settings.label.ponsCurveAdapterContract": "Pons curve adapter contract",
  "settings.label.classVaultFactoryContract": "Class vault factory contract",
  "settings.label.rialtoIntegratorKey": "Rialto integrator key",
  "settings.label.rialtoKeyHeader": "Rialto key header",
  "settings.label.virtualsApiKey": "Virtuals API key",
  "settings.label.bitqueryApiKey": "bitquery api key",
  "settings.label.merryCircleToken": "merry circle token",
  "settings.label.swapVenue": "swap venue",
  "settings.label.maxSlippage": "max slippage",
  "settings.label.performanceFee": "performance fee",
  "settings.label.marketCheckInterval": "Market check interval",
  "settings.label.buyAmountPerCheck": "Buy amount per check",
  "settings.label.takeProfit": "take profit",
  "settings.label.idleCashFloor": "idle cash floor",
  "settings.label.gapBudget": "gap budget",
  "settings.label.claudeVisionModel": "Claude / vision model",
  "settings.label.strategistDecisionInterval": "Strategist decision interval",
  "settings.label.llmMaxPerAction": "LLM max per action",
  "settings.hint.anyOpenaiCompatibleEndpoint": "Any OpenAI-compatible endpoint, e.g. https://your-host/v1",
  "settings.hint.requiredForRealTrading": "Required for real trading on Robinhood Chain. Not needed for Paper, or on the testnet.",
  "settings.hint.upTo24Letters": "Up to 24 letters, numbers, or spaces.",
  "settings.hint.pngJpegOrWebp": "PNG, JPEG or WebP. Cropped to a square and re-encoded; nothing else from the file is kept.",
  "settings.hint.pngJpegOrWebp2": "PNG, JPEG or WebP. Cropped wide for the top of your agent&rsquo;s profile.",
  "settings.hint.18ForMostTokens": "18 for most tokens — check the contract if unsure",
  "settings.hint.minimumLiquidityRequiredTo": "Minimum liquidity required to use a token’s price. Lower values accept more price-manipulation risk.",
  "settings.hint.maximumDifferenceBetweenThe": "Maximum difference between the current and average pool price. 100 bps = 1%.",
  "settings.hint.maximumPurchaseCostOf": "Maximum purchase cost of all open scout positions. Selling restores the available budget.",
  "settings.hint.maximumTotalPurchaseCost": "Maximum total purchase cost per scout token, including additional buys.",
  "settings.hint.spentOnASingle": "Spent on a single class entry. 0 means nothing is bought, whatever the switch says.",
  "settings.hint.howManyClassPositions": "How many class positions may be held at once. 0 = no limit beyond the scout budget.",
  "settings.hint.forBondingCurvePositions": "For bonding-curve positions: attempt an exit after this duration, even when a market price is unavailable. Quotes, liquidity and signed limits still apply.",
  "settings.hint.realMoneyRaisedInto": "Real money raised into the curve, excluding the virtual seed it opens with. Below this, an entry is refused.",
  "settings.hint.getYourBotToken": "Get your bot token from @BotFather.",
  "settings.hint.maxUsdgPerChat": "Max USDG per chat-triggered trade — beneath your grant caps.",
  // FIXED BECAUSE THE TRANSLATORS CAUGHT IT, and four of them caught the same
  // thing independently. "on top of the grant caps" was read in Spanish,
  // Portuguese, Russian and Chinese as an EXTRA ALLOWANCE added to the signed
  // caps — more money — rather than as a second ceiling that also applies.
  // Four careful readers making one error is evidence about the sentence, not
  // about them, so the English says which it means now.
  "settings.hint.maxUsdgChatTransfers": "Max USDG chat transfers may send per day. A second limit; your signed grant caps still apply.",
  "settings.hint.batchTheRoutineTrade": "Batch the routine trade notifications so you're not pinged every fill. Warnings, price alerts, reminders and the daily report always come through right away.",
  "settings.hint.localHour023": "Local hour (0–23) after which the campfire report is sent.",
  "settings.hint.maximumStepsPerTask": "Maximum steps per task.",
  "settings.hint.folderAvailableToLs": "Folder available to /ls and /get. Use an absolute path. Leave blank to disable file access.",
  "settings.hint.transcriptionApiKeyFor": "Transcription API key for voice notes. Leave blank to disable voice.",
  "settings.hint.optionalCustomConnectionTo": "Optional custom connection to Robinhood Chain mainnet.",
  "settings.hint.optional": "Optional.",
  "settings.hint.overridesThePimlicoConnection": "Overrides the Pimlico connection. Must support your wallet’s network.",
  "settings.hint.breakerregistryContractOnYour": "BreakerRegistry contract on your wallet’s network.",
  "settings.hint.v4selfswapContractOnYour": "V4SelfSwap contract on your wallet’s network. Update trading permissions after saving.",
  "settings.hint.ponsselftradeContractOnYour": "PonsSelfTrade contract on your wallet’s network. Updating trading permissions authorizes this contract to spend your permitted tokens.",
  "settings.hint.ponsclassvaultfactoryOnYourWallet": "PonsClassVaultFactory on your wallet’s network — version 1 or version 2. Leave it empty to use the one this chain pins. This lets your agent buy tokens that did not exist when you signed; they are held in a vault of your own, because a token your account holds directly cannot be sold. THE TWO VERSIONS LOOK IDENTICAL FROM OUTSIDE and behave differently — v1 holds one spending ceiling for everything, v2 holds one per funding asset — so the signer reads the version off the address you paste and tells you which one it is about to seal before you sign. Setting this alone changes nothing: it has to be sealed by updating trading permissions, and buying only starts when you also turn on the class route, which is in “Custom tokens & discovery” above — not here. Changing it after you hold a position points your agent at a DIFFERENT, empty vault — sell and sweep first.",
  "settings.hint.requiredToTradeThrough": "Required to trade through Rialto.",
  "settings.hint.getThisFromYour": "Get this from your agent’s page on app.virtuals.io.",
  "settings.hint.requiredForTokenDiscovery": "Required for token discovery unless you use a Merry Circle token.",
  "settings.hint.claimWithYourMerrymen": "Claim with your $MERRYMEN wallet for AI and token discovery access. A saved Bitquery key takes priority for discovery.",
  "settings.hint.rialtoRequiresAnIntegrator": "Rialto requires an integrator key.",
  "settings.hint.vsThePreTrade": "vs the pre-trade quote.",
  "settings.hint.calculatedOnNewPeak": "Calculated on new peak profits. Fees are recorded but not collected.",
  "settings.hint.anActiveBookIs": "An active book is reviewed at least every five minutes, subject to available reads and budget.",
  "settings.hint.amountSpreadAcrossThe": "Amount spread across the Steady Basket.",
  "settings.hint.steadyBasketSellA": "steady-basket: sell a leg once it is this far ahead of what it cost. 0 never sells — and this is the only exit this strategy has, so at 0 it only ever buys.",
  "settings.hint.steadyBasketCashKept": "steady-basket: cash kept liquid; the excess sweeps to the Morpho vault.",
  "settings.hint.weekendGapTotalUsdg": "weekend-gap: total USDG deployed per gap window.",
  "settings.hint.modelForAnthropicAnd": "Model for Anthropic and screen analysis.",
  "settings.hint.hardStrategistCeilingPer": "Hard strategist ceiling per proposed trade — beneath the grant caps.",
  "settings.label.liveTrading": "live trading",
  "settings.label.letTrencherTradeFor": "let trencher trade for real",
  "settings.label.assetMode": "asset mode",
  "settings.label.watchForNewPairs": "watch for new pairs",
  "settings.label.tradeThePlatformCoin": "trade the platform coin list",
  "settings.label.researchBeforeDeciding": "research before deciding",
  "settings.label.scoutMode": "scout mode",
  "settings.label.classRoute": "class route",
  "settings.label.enableTelegram": "enable telegram",
  "settings.label.allowControlCommands": "allow control commands",
  "settings.label.allowTransfers": "allow transfers",
  "settings.label.proactivePings": "proactive pings",
  "settings.label.enableRemoteControl": "enable remote control",
  "settings.label.capabilities": "capabilities",
  "settings.label.agentModeAgent": "🤖 agent mode · /agent",
  "settings.label.freeFormShellFor": "free-form shell for /agent",
  "settings.label.shellAllowlist": "shell allowlist",
  "settings.label.appAllowlist": "app allowlist",
  "settings.label.streamToVirtuals": "stream to Virtuals",
  "settings.section.tradingMode": "Trading mode",
  "settings.section.whatItTrades": "What it trades",
  "settings.section.agentSettings": "Agent settings",
  "settings.section.tradingBasket": "Trading basket",
  "settings.section.telegramControls": "Telegram controls",
  "settings.section.computerAccess": "Computer access",
  "settings.section.merryCircle": "Merry Circle",
  "settings.section.connections": "Connections",
  "settings.section.virtuals": "Virtuals",
  "settings.section.tradingPreferences": "Trading preferences",
  "settings.hint.appliesWhenTheStrategy": "Applies when the strategy is Trencher. Off restores its standard exit profile.",
  "settings.hint.allowsLiveTrencherTrades": "\r\n                Allows live Trencher trades in tokens covered by your trading permissions.\r\n              ",
  "settings.hint.noneYetAddOne": "\r\n                  None yet — add one below, or take a suggestion from your agent.\r\n                ",
  "settings.hint.threeThingsHaveTo": "\r\n            Three things have to be true before your agent buys a token you added:\r\n            it&apos;s ",
  "settings.hint.requiresABitqueryKey": "\r\n                Requires a Bitquery key or Merry Circle token in Connections.\r\n              ",
  "settings.hint.discoverySendsAlertsAutonomous": "\r\n            Discovery sends alerts. Autonomous Trencher can evaluate verified pool tokens without adding them here once you sign its ",
  "settings.hint.llmStrategistOnlyOn": "\r\n                llm-strategist only. On, a decision becomes a short research loop: it can pull\r\n                depth, check what a position cost, and read back its own past decisions before it\r\n                acts — and it writes what it concluded, in its own words, to your feed. Off by\r\n                default because it costs up to a few model calls per window instead of one.\r\n              ",
  "settings.hint.separateFromSealingA": "\r\n                Separate from sealing a vault at /grant. That says this key COULD reach one; this\r\n                says go and do it.\r\n              ",
  "settings.hint.thenSend": "\r\n              Then send ",
  "settings.hint.offTheBotCan": "Off = the bot can answer questions but not change state.",
  "settings.hint.requiresExistingTransferPermission": "\r\n                Requires existing transfer permission. Otherwise, use Withdraw in Profile.\r\n              ",
  "settings.hint.theBotMessagesYou": "The bot messages you first: trades landing, drawdown/gas/expiry warnings, price alerts, and the daily campfire report.",
  "settings.hint.theMasterSwitchOff": "The master switch. Off = every PC command is refused, regardless of the toggles below.",
  "settings.hint.clickToToggleOnly": "Click to toggle. Only enabled groups work; the rest are refused. “vision” and “voice” need extra keys below.",
  "settings.hint.sendATaskWith": "\r\n              Send a task with ",
  "settings.hint.offAgentMayOnly": "\r\n                  Off: /agent may only run your allowlisted commands. On: it may compose its own\r\n                  commands (installs, builds, git) — destructive commands and secrets paths are\r\n                  refused always.\r\n                ",
  "settings.hint.onlyTheseExactCommands": "Only these exact commands (or command + args) may run via /run — and each still needs /confirm. Chaining/redirects are always refused.",
  "settings.hint.namesOpenMayLaunch": "Names /open may launch. Full https:// URLs open without an allowlist.",
  "settings.hint.publishesLandedTradesAnd": "\r\n                Publishes landed trades and the daily report to your agent&apos;s public page on\r\n                app.virtuals.io. ",
  "settings.unit.usdg": "USDG",
  "settings.unit.h": "h",
  "settings.unit.steps": "steps",
  "settings.unit.bps": "bps",
  "settings.unit.sec": "sec",
  "settings.unit.min": "min",
} as const;

/** Every message the product can show. A key outside this set will not compile. */
export type MessageKey = keyof typeof EN;
