"use client";

/**
 * Paste an address, see what it holds. No key, no login, nothing to sign.
 *
 * WHY THE PAGE LOOKS LIKE THIS. The question behind almost every "I am locked
 * out" message is not "how do I withdraw" but "is my money still there, and
 * which of these addresses is my agent". Those are two different questions and
 * only the second one is hard, because there are three addresses in this system
 * and nothing has ever told people which is which. So the answer comes first,
 * in a sentence, and the balances come after it.
 *
 * NOTHING HERE CAN SPEND. `readAsOwner` builds its owner with
 * `ownerFromAddress`, whose signing methods throw by construction, so this page
 * could not authorise a transfer even if someone asked it to.
 */

import { useState } from "react";
import { formatUnits } from "viem";
import { isAddr, normalizeAddr } from "@/lib/address";
import { chainFor, readAddress, readAsOwner, verdictOf, type Lookup, type Reading } from "@/lib/account-lookup";
import { robinhoodChain, robinhoodTestnet } from "@merrymen/core";
import "@/styles/lookup.css";
import { useT } from "@/lib/i18n";

const MAINNET = robinhoodChain.id;
const TESTNET = robinhoodTestnet.id;

const fmtEth = (wei: bigint | null, unreadable: string) => (wei === null ? unreadable : `${formatUnits(wei, 18)} ETH`);

function ReadingCard({
  title,
  note,
  reading,
  extra,
}: {
  title: string;
  note: string;
  reading: Reading;
  extra?: { label: string; rows: { symbol: string; amount: string }[] };
}) {
  const t = useT();
  const nothing = reading.holdings.length === 0 && (reading.nativeWei === null || reading.nativeWei === 0n);
  return (
    <div className="mm-lookup-card">
      <h3>{title}</h3>
      <p className="mm-lookup-addr">{reading.address}</p>
      <p className="mm-lookup-meta">
        {note}
        {" · "}
        {reading.deployed === null
          ? t("common.deployUnknown")
          : reading.deployed
            ? t("common.deployYes")
            : t("common.deployNo")}
      </p>

      {nothing && !extra?.rows.length ? (
        <p className="mm-lookup-none">{t("common.lookupNothing")}</p>
      ) : (
        <div className="mm-lookup-rows">
          {reading.holdings.map((h) => (
            <div className="mm-lookup-row" key={h.address}>
              <span>{h.symbol}</span>
              <span>{h.amount}</span>
            </div>
          ))}
          {reading.nativeWei !== null && reading.nativeWei > 0n && (
            <div className="mm-lookup-row">
              <span>ETH (gas)</span>
              <span>{fmtEth(reading.nativeWei, t("common.unreadableWord"))}</span>
            </div>
          )}
          {extra?.rows.map((r) => (
            <div className="mm-lookup-row" key={`${extra.label}-${r.symbol}`}>
              <span>
                {r.symbol} <em>{extra.label}</em>
              </span>
              <span>{r.amount}</span>
            </div>
          ))}
        </div>
      )}

      {reading.unreadable.length > 0 && (
        <p className="mm-lookup-warn">
          {t("common.lookupUnreadable", { list: reading.unreadable.join(", ") })}
        </p>
      )}
    </div>
  );
}

/**
 * The sentence, decided by `verdictOf` and only rendered here.
 *
 * The distinction that matters most is the last one: an address that derives an
 * account which was never deployed is almost always someone's SIGN-IN wallet,
 * not their owner key — and telling them that is the whole reason this page
 * exists.
 */
function Verdict({ l }: { l: Lookup }) {
  const t = useT();
  const v = verdictOf(l);
  const derived = l.asOwner?.derived;

  if (v.kind === "both" || v.kind === "owner") {
    return (
      <div className="mm-lookup-verdict">
        <h2>{t("common.lookupOwnerTitle")}</h2>
        <p>
          {t("common.lookupOwnerPre")}<code>{derived}</code>{t("common.lookupOwnerPost")}
        </p>
        <p>
          {t("common.lookupOwnerKeyPre")}<code>{l.input}</code>{t("common.lookupOwnerKeyMid")}<code>npx merrymen recover</code>{t("common.lookupOwnerKeyPost")}
        </p>
      </div>
    );
  }

  if (v.kind === "account") {
    return (
      <div className="mm-lookup-verdict">
        <h2>{t("common.lookupAccountTitle")}</h2>
        <p>{t("common.lookupAccountSub")}</p>
        <p>
          {t("common.lookupAccountBody")}
        </p>
      </div>
    );
  }

  if (v.kind === "unreadable") {
    return (
      <div className="mm-lookup-verdict is-quiet">
        <h2>{t("common.lookupChainTitle")}</h2>
        <p>
          {t("common.lookupChainBody")}
        </p>
      </div>
    );
  }

  if (v.kind === "empty-deployed") {
    return (
      <div className="mm-lookup-verdict is-quiet">
        <h2>{t("common.lookupEmptyTitle")}</h2>
        <p>
          {t("common.lookupEmptyBody")}
        </p>
      </div>
    );
  }

  // Nothing, and nothing deployed either — the case that sends people looking
  // for a support backdoor that does not exist.
  return (
    <div className="mm-lookup-verdict is-quiet">
      <h2>{t("common.lookupNeverTitle")}</h2>
      <p>
        {t("common.lookupNeverPre")}<code>{derived}</code>{t("common.lookupNeverMid")}
      </p>
      <p>
        {t("common.lookupNeverPre2")}<strong>{t("common.lookupNeverBold1")}</strong>{t("common.lookupNeverMid2")}<strong>{t("common.lookupNeverBold2")}</strong>{t("common.lookupNeverPost")}
      </p>
    </div>
  );
}

export function LookupClient() {
  const t = useT();
  const [value, setValue] = useState("");
  // Widened deliberately: `useState(MAINNET)` infers the literal 4663, and the
  // testnet radio then fails to typecheck against its own state setter.
  const [chainId, setChainId] = useState<number>(MAINNET);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Lookup | null>(null);
  // The verdict needs BOTH readings. Rendering it while one is still in flight
  // would tell someone "nothing was ever created here" about an account whose
  // balance is still loading, which is the single worst sentence to get wrong.
  const [settled, setSettled] = useState(false);

  /**
   * The two readings run SEPARATELY and render as they land.
   *
   * Awaiting both took about thirty seconds on chain 4663, because deriving an
   * account also scans for a class vault over a very large block range. Someone
   * who pasted their account address watched a spinner for half a minute to see
   * a balance that had been ready in two — and a page for people who think
   * their money is gone is the worst possible place to look broken.
   */
  async function run() {
    const addr = normalizeAddr(value);
    if (!isAddr(addr)) {
      setError(t("common.lookupBadAddr"));
      return;
    }
    const address = addr as `0x${string}`;
    setBusy(true);
    setError(null);
    setResult(null);
    setSettled(false);

    let chain;
    try {
      chain = chainFor(chainId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      return;
    }

    const base: Lookup = {
      input: address,
      chainId,
      asOwner: null,
      ownerError: null,
      asAccount: null,
      accountError: null,
    };
    setResult(base);

    // Merged into whatever is already on screen, so the slower half cannot
    // clobber the faster one when it finally arrives.
    const merge = (patch: Partial<Lookup>) =>
      setResult((prev) => ({ ...(prev ?? base), ...patch }));

    const direct = readAddress(chain, address)
      .then((asAccount) => merge({ asAccount }))
      .catch((e: unknown) => merge({ accountError: e instanceof Error ? e.message.split("\n")[0]! : String(e) }));

    const owner = readAsOwner(chain, address)
      .then((asOwner) => merge({ asOwner }))
      .catch((e: unknown) => merge({ ownerError: e instanceof Error ? e.message.split("\n")[0]! : String(e) }));

    await Promise.all([direct, owner]);
    setSettled(true);
    setBusy(false);
  }

  return (
    <div className="mm mm-lookup">
      <div className="mm-lookup-inner">
        <p className="mm-lookup-brand">merrymen</p>
        <h1>{t("common.lookupTitle")}</h1>
        <p className="mm-lookup-lede">
          {t("common.lookupLede")}
        </p>

        <div className="mm-lookup-form">
          <input
            className="mm-lookup-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
            aria-label="Address to look up"
          />
          <button className="mm-lookup-btn" onClick={() => void run()} disabled={busy}>
            {busy ? t("common.lookupReading") : t("common.lookupLookUp")}
          </button>
        </div>

        <div className="mm-lookup-chain">
          <label>
            <input type="radio" checked={chainId === MAINNET} onChange={() => setChainId(MAINNET)} />
            mainnet · {MAINNET}
          </label>
          <label>
            <input type="radio" checked={chainId === TESTNET} onChange={() => setChainId(TESTNET)} />
            testnet · {TESTNET}
          </label>
        </div>

        {error && <p className="mm-lookup-error">{error}</p>}

        {result && (
          <>
            {settled ? (
              <Verdict l={result} />
            ) : (
              <p className="mm-lookup-meta">{t("common.lookupPending")}</p>
            )}

            {result.asOwner && (
              <ReadingCard
                title={t("common.lookupReadOwner")}
                note={t("common.lookupNoteOwner")}
                reading={result.asOwner.reading}
                {...(result.asOwner.classHoldings.length > 0
                  ? {
                      extra: {
                        label: t("common.lookupVaultLabel"),
                        rows: result.asOwner.classHoldings.map((h) => ({ symbol: h.symbol, amount: h.amount })),
                      },
                    }
                  : {})}
              />
            )}
            {result.ownerError && (
              <p className="mm-lookup-warn">{t("common.lookupOwnerErr", { error: result.ownerError ?? "" })}</p>
            )}

            {result.asAccount && (
              <ReadingCard
                title={t("common.lookupReadAccount")}
                note={t("common.lookupNoteAccount")}
                reading={result.asAccount}
              />
            )}
            {result.accountError && (
              <p className="mm-lookup-warn">{t("common.lookupAccountErr", { error: result.accountError ?? "" })}</p>
            )}
          </>
        )}

        <div className="mm-lookup-help">
          <h2>{t("common.lookupHelpTitle")}</h2>
          <dl>
            <dt>{t("common.lookupHelpSignin")}</dt>
            <dd>
              {t("common.lookupHelpSigninBody")}
            </dd>
            <dt>{t("common.lookupHelpOwner")}</dt>
            <dd>
              {t("common.lookupHelpOwnerPre")}<strong>{t("common.lookupHelpOwnerBold")}</strong>{t("common.lookupHelpOwnerPost")}
            </dd>
            <dt>{t("common.lookupHelpAccount")}</dt>
            <dd>
              {t("common.lookupHelpAccountPre")}<em>{t("common.lookupHelpAccountEm")}</em>{t("common.lookupHelpAccountPost")}
            </dd>
          </dl>
          <p>
            {t("common.lookupRecoverPre")}<code>npx merrymen recover</code>{t("common.lookupRecoverPost")}
          </p>
        </div>
      </div>
    </div>
  );
}
