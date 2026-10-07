"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff } from "lucide-react";
import {
  DEFAULT_BASKET_SYMBOLS,
  ENERGY,
  STOCK_TOKENS,
  isEnergyReserveToken,
  isValidCustomToken,
  type CustomToken,
  isWallTooWide,
} from "@merrymen/core";
import { createPrivyOwnedWallet, isPrivyOwned, loadGrant, type Grant, type GrantCaps } from "@/lib/session";
import { usePrivyOwner } from "@/terminal/usePrivyOwner";
import { verifiedAdapter } from "@/lib/verified-adapter";
import { loadRecoveryGrants, trustedSavedGrant } from "@/lib/saved-grant-binding";
import { needsPermissionReplacement } from "@/lib/permission-replacement";
import { requestJson, RetryButton, SignIn, PRIVY_BETA, type AccountState } from "../HostedControls";
import { fetchAccountForSession } from "../account-session";
import { Face } from "../ui";
import { SkeletonRows } from "../Skeleton";
import { CAP_FIELD, parseAmount } from "@/lib/parse-amount";
import type { TierView } from "@/app/api/tier/route";
import { loadTier, newAgentQualifies } from "../tier";
import { count, decimalSeparator } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/messages/en";

/**
 * `circle` MARKS A STRATEGY THE WORKER WILL NOT ACTUALLY RUN FOR A NON-HOLDER.
 *
 * `even-keel` and `dip-hunter` are Merry Circle strategies
 * (worker/src/strategies/registry.ts CIRCLE_STRATEGIES). The tick gates them on
 * `holderTier.bonusStrategies` and, for anyone below Merry Man, writes ONE warn
 * event and returns — every tick, for ever.
 *
 * This list offered both with no marking at all, so the flow was: pick "Even
 * keel", read "Keep the stocks in your basket evenly weighted", sign a grant,
 * send real money, and watch an agent that never buys anything. Reported
 * exactly that way: "the agent hasn't bought automatically a single stock token
 * during all day.... I don't know if it makes sense and first buys must be done
 * by user".
 *
 * Marked rather than hidden, and still selectable: a strategy nobody can see is
 * a strategy nobody buys $MERRYMEN for, and an owner who holds it would find it
 * missing. What was wrong was letting somebody choose it without knowing.
 */
const STRATEGIES:{id:string;nameKey:MessageKey;descKey:MessageKey;circle?:boolean}[]=[
  {id:"steady-basket",nameKey:"onboard.strategy.steadyName",descKey:"onboard.strategy.steadyDesc"},
  {id:"even-keel",nameKey:"onboard.strategy.evenName",descKey:"onboard.strategy.evenDesc",circle:true},
  {id:"dip-hunter",nameKey:"onboard.strategy.dipName",descKey:"onboard.strategy.dipDesc",circle:true},
  {id:"llm-strategist",nameKey:"onboard.strategy.llmName",descKey:"onboard.strategy.llmDesc"},
];
const EXAMPLES:Record<string,MessageKey>={
  "steady-basket":"onboard.example.steady",
  "even-keel":"onboard.example.even",
  "dip-hunter":"onboard.example.dip",
  "llm-strategist":"onboard.example.llm",
};
const STEPS:MessageKey[]=["onboard.stepAgent","onboard.stepMarket","onboard.stepLimits","onboard.stepBackup","onboard.stepReady"];
const INITIAL_CAPS: GrantCaps={perTradeUsdg:10,dailyUsdg:50,expiryDays:7,maxDrawdownPct:5,maxOpsPerDay:24};
export function CreateAgent({account,accountFailed=false,retrying=false,onRefresh,onSignedIn,onBack,onDone,onFund}:{account:AccountState|null;accountFailed?:boolean;retrying?:boolean;onRefresh:()=>void;onSignedIn:()=>void;onBack:()=>void;onDone:()=>void;onFund:(grant:Grant)=>void}) {
  const t = useT();
  const [step,setStep]=useState<"agent"|"market"|"limits"|"backup"|"fund">("agent");
  const [name,setName]=useState("");
  const [strategy,setStrategy]=useState("steady-basket");
  /**
   * WHAT IT TRADES, ASKED DURING SETUP — and the reason this step exists at all.
   *
   * The wizard never asked. A new agent got the three-symbol equity default and
   * every universe decision was deferred to Settings, where an owner then found
   * a basket "full of all stocks", added a coin, and discovered it still would
   * not trade. Asking here costs one screen and removes that whole journey.
   *
   * THE SEQUENCING WIN IS THE POINT. `create()` seals `extraTokens` into the
   * grant it mints, so a coin named HERE is covered by the FIRST signature —
   * no re-sign, no coverage banner, no "why isn't it trading". The same coin
   * added afterwards needs a second signature before it can be sold, which is
   * the `no-exit` rule and the whole reason that journey is painful.
   */
  const [assetMode,setAssetMode]=useState<"all"|"stocks"|"crypto">("all");
  const [basket,setBasket]=useState<string[]>([...DEFAULT_BASKET_SYMBOLS]);
  /** Coins added in this wizard. Merged LOCALLY into the mint — see create(). */
  const [wizardTokens,setWizardTokens]=useState<CustomToken[]>([]);
  const [newCoin,setNewCoin]=useState({symbol:"",address:"",decimals:"18"});
  const [coinError,setCoinError]=useState("");
  /**
   * THIS READER STANDING AGAINST THE RULE, not the rule.
   *
   * The badge states the requirement; it never said whether YOU meet it, which
   * is the only half that decides whether to press the button. Reported as
   * "the app should warn more eye-catching when someone has chosen a
   * holder-only strategy and don't have access to it… I had to go to
   * /api/circle to check that and that's not good for normies".
   */
  const [tier,setTier]=useState<TierView|null>(null);
  useEffect(()=>{void loadTier().then(setTier);},[]);
  // Null on a legacy session — which is what keeps an existing Merryman on
  // its existing owner key.
  const privyOwner=usePrivyOwner();
  const [paper,setPaper]=useState(true);
  const [trade,setTrade]=useState("10");
  const [day,setDay]=useState("50");
  const [ack,setAck]=useState(false);
  const [backupAck,setBackupAck]=useState(false);
  const [reveal,setReveal]=useState(false);
  const [grant,setGrant]=useState<Grant|null>(null);
  const [armed,setArmed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [status,setStatus]=useState("");
  const [error,setError]=useState("");
  const savedContext=account ? `${account.session.hosted}:${account.session.address?.toLowerCase()??""}:${account.status.exists}` : "";
  const [savedRecovery,setSavedRecovery]=useState<{context:string;grant:Grant|null;failed:boolean}|null>(null);
  async function recoverableFor(session:AccountState["session"]):Promise<Grant|null>{
    for(const candidate of [loadGrant(),...loadRecoveryGrants()]){
      if(candidate&&await trustedSavedGrant(candidate,session,window.location.origin))return candidate;
    }
    return null;
  }
  useEffect(()=>{
    let active=true;
    if(!account){setSavedRecovery(null);return;}
    setSavedRecovery(null);
    void recoverableFor(account.session).then(saved=>{
      if(active)setSavedRecovery({context:savedContext,grant:saved,failed:false});
    }).catch(()=>{if(active)setSavedRecovery({context:savedContext,grant:null,failed:true});});
    return()=>{active=false;};
  },[account,savedContext]);
  useEffect(()=>{
    if(!account?.status.grant)return;
    void requestJson<{values:{liveTradingEnabled?:boolean;agentName?:string;strategy?:string}}>("/api/settings").then(({values})=>{setPaper(!(values.liveTradingEnabled ?? false));setName(values.agentName ?? "");setStrategy(values.strategy ?? "steady-basket");}).catch(()=>{});
    const local=loadGrant();
    if(local?.smartAccount.toLowerCase()===account.status.grant.smartAccount.toLowerCase()) {
      setGrant(local);setArmed(account.status.exists);
      const saved=localStorage.getItem(`merrymen.backup.${local.smartAccount.toLowerCase()}`)==="1";
      setStep(saved ? "fund" : "backup");
    }
  },[account?.status.grant?.smartAccount]);
  useEffect(()=>{
    if(!grant || step!=="backup")return;
    const guard=(event:BeforeUnloadEvent)=>{event.preventDefault();};
    window.addEventListener("beforeunload",guard);
    return()=>window.removeEventListener("beforeunload",guard);
  },[grant,step]);
  // A FAILED READ IS NOT A SLOW ONE. Both leave `account` null, and this line
  // said "Loading your account…" for either — for ever, after a failure, with
  // nothing to press. See AccountEntry.
  if(!account || accountFailed)return accountFailed
    ? <section className="create-agent"><p role="status">{retrying ? t("onboard.retryLoading") : <>{t("onboard.accountLoadFailed")}</>}</p><RetryButton retrying={retrying} onRetry={onRefresh}/></section>
    : <section className="create-agent"><SkeletonRows rows={3} label="Loading your account"/></section>;
  if(account.session.hosted && !account.session.address)return <section className="create-agent"><h1>{t("onboard.meetTitle")}</h1><p>{t("onboard.signinCopy")}</p><SignIn onDone={onSignedIn}/></section>;
  if(account.status.exists && !grant)return <section className="create-agent"><h1>{t("onboard.alreadyTitle")}</h1><p>{t("onboard.alreadyCopy")}</p><button className="flow-primary" onClick={onDone}>{t("onboard.openAgent")}</button><a href="/grant">{t("onboard.manageWallet")}</a></section>;
  const recovery=savedRecovery?.context===savedContext?savedRecovery:null;
  if((grant&&needsPermissionReplacement(grant))||(!account.status.exists&&recovery?.grant))return <section className="create-agent"><h1>{t("onboard.resumeTitle")}</h1><p>{t("onboard.resumeCopy")}</p><a href="/grant#resign">{t("onboard.resumeCta")}</a></section>;
  // This wizard always creates a mainnet account, including in paper mode.
  // Do not write settings or generate a key while the protected signer is
  // unavailable. Existing grants keep their backup, renew and recovery paths.
  if(!grant&&!privyOwner)return <section className="create-agent"><h1>{t("onboard.protectedTitle")}</h1><p>{t("onboard.protectedCopy")}</p>{PRIVY_BETA?<><p>{t("onboard.protectedReady")}</p><SignIn onDone={onSignedIn}/><RetryButton retrying={retrying} onRetry={onRefresh}/></>:<p>{t("onboard.protectedDisabled")}</p>}<a href="/grant">{t("onboard.protectedCta")}</a></section>;
  if(!grant&&!account.status.exists&&!recovery)return <section className="create-agent"><SkeletonRows rows={3} label="Checking your saved wallet"/></section>;
  if(!grant&&recovery?.failed)return <section className="create-agent"><h1>{t("onboard.savedCheckTitle")}</h1><p>{t("onboard.savedCheckCopy")}</p><a href="/grant#resign">{t("onboard.openWalletPerms")}</a><RetryButton retrying={retrying} onRetry={onRefresh}/></section>;
  async function create() {
    if(busy || grant || !account)return;
    if(!privyOwner){setError(t("onboard.errWalletNotReady"));return;}
    // WAS `validAmount`, which took a dot decimal and nothing else — while the
    // field above is `inputMode="decimal"`, which renders a COMMA key on a
    // Spanish, German, French, Portuguese, Turkish or Indonesian keyboard. The
    // app handed people the separator its only validator refused, then said
    // "Enter positive amounts", which names neither thing that is wrong. On
    // the one screen where somebody bounds their own risk, that is a dead end.
    const perTrade=parseAmount(trade,CAP_FIELD),perDay=parseAmount(day,CAP_FIELD);
    for(const [labelKey,r] of [["create.labelPerTrade",perTrade],["create.labelPerDay",perDay]] as const){
      if(r.ok)continue;
      // Each refusal names the actual problem, and the ambiguous one names both
      // readings rather than picking one: "1.000" is a thousand in Berlin and
      // one in Boston, and a cap is sealed into a signature that cannot be
      // edited afterwards.
      //
      // THE FIELD NAME IS A PLACEHOLDER, not a prefix glued on in front. "Per
      // trade: enter an amount" is English word order, and several of the
      // shipped languages put the label somewhere else in the sentence.
      const label=t(labelKey);
      setError(r.reason==="ambiguous"?t("create.errAmbiguous",{label,a:r.readings[0]!,b:r.readings[1]!})
        :r.reason==="out-of-range"?t("create.errRange",{label,min:r.min,max:r.max})
        // The example is written in the reader's own separator. A hint that
        // shows a dot to somebody whose keyboard has a comma is the original
        // bug wearing a helpful expression.
        :t("create.errAmount",{label,sep:decimalSeparator()}));
      return;
    }
    if(!perTrade.ok||!perDay.ok)return;
    if(perTrade.value>perDay.value){setError(t("create.errOrder"));return;}
    if(!paper&&!ack){setError(t("create.errAck"));return;}
    setBusy(true);setError("");
    try {
      // The account prop may have been loaded before another tab changed login.
      // Confirm this tenant and its no-agent status before any settings write.
      const current=await fetchAccountForSession(account.session);
      if(current.kind!=="ready"){
        onRefresh();
        throw new Error(t("onboard.errConfirmAccount"));
      }
      if(current.account.status.exists){throw new Error(t("onboard.errAlreadyActive"));}
      if(current.account.session.hosted&&privyOwner.account.address.toLowerCase()!==current.account.session.address?.toLowerCase())throw new Error(t("onboard.errWalletChanged"));
      // A stop may have removed the server grant while another tab retained
      // its revocation journal. Re-check immediately before any settings write
      // or new signature; the initial UI check is not an authorization cache.
      const saved=await recoverableFor(current.account.session);
      if(saved){setSavedRecovery({context:savedContext,grant:saved,failed:false});throw new Error(t("onboard.errResumeSaved"));}
      const settings=await requestJson<{values:{customTokens?:unknown[];v4AdapterAddress?:string;ponsAdapterAddress?:string;ponsClassVaultFactory?:string}}>("/api/settings");
      const address=(value?:string)=>value&&/^0x[0-9a-fA-F]{40}$/.test(value) ? value as `0x${string}` : undefined;
      const pons=await verifiedAdapter(address(settings.values.ponsAdapterAddress),4663,setStatus);
      // The market answers ride the settings write that was already happening —
      // one round trip, not four.
      await requestJson("/api/settings",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({owner:account.session.hosted?account.session.address:undefined,agentName:name.trim(),strategy,paperTradingEnabled:true,liveTradingEnabled:!paper,assetMode,basketSymbols:basket,customTokens:[...((settings.values.customTokens??[]) as CustomToken[]),...wizardTokens]})});
      /**
       * MERGED LOCALLY, NOT RE-READ — and getting this wrong would silently
       * undo the whole point of the step.
       *
       * `settings` was fetched BEFORE the PUT above, so re-reading
       * `settings.values.customTokens` here would miss every coin the owner just
       * named in the wizard. They would be stored, and then left out of the
       * signature that is about to be minted — so the agent would watch them and
       * refuse to buy them on `no-exit`, which is precisely the journey this
       * step exists to remove.
       */
      // The PARSED values, not `Number(trade)`. The raw string is what the
      // owner typed, and `Number("10,50")` is NaN while `Number("1.000")` is 1.
      const mintOptions={caps:{...INITIAL_CAPS,perTradeUsdg:perTrade.value,dailyUsdg:perDay.value},chainId:4663,extraTokens:[...((settings.values.customTokens??[]) as CustomToken[]),...wizardTokens].filter(isValidCustomToken) as CustomToken[],v4AdapterAddress:address(settings.values.v4AdapterAddress),ponsAdapterAddress:pons,ponsClassVaultFactory:address(settings.values.ponsClassVaultFactory),hostedAs:account?.session.hosted ? account.session.address as `0x${string}` : undefined,onStatus:setStatus};
      const result=await createPrivyOwnedWallet(privyOwner.account,privyOwner.did,mintOptions);
      setGrant(result.local);setArmed(result.handoff.ok);setStep("backup");setStatus("");
      if(!result.handoff.ok)setError(result.handoff.error ?? t("onboard.errActivateFailed"));
    }catch(e){setError(e instanceof Error ? e.message : t("onboard.errCreateFailed"));}
    finally{setBusy(false);}
  }
  async function retryActivation(){
    if(!grant || busy || !account)return;
    setBusy(true);setError("");
    try{
      if(needsPermissionReplacement(grant))throw new Error(t("onboard.errRevoked"));
      const current=await fetchAccountForSession(account.session);
      if(current.kind!=="ready"||!await trustedSavedGrant(grant,current.account.session,window.location.origin)){
        onRefresh();throw new Error(t("onboard.errVerifySaved"));
      }
      if(current.account.status.exists&&current.account.status.grant?.smartAccount.toLowerCase()!==grant.smartAccount.toLowerCase())throw new Error(t("onboard.errDifferentAgent"));
      if(needsPermissionReplacement(grant))throw new Error(t("onboard.errAwaitingReplacement"));
      const {demoOwnerPrivateKey:owner,...publicGrant}=grant;
      await requestJson("/api/grants",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(account?.session.hosted ? publicGrant : grant)});
      setArmed(true);onRefresh();
    }catch(e){setError(e instanceof Error ? e.message : t("onboard.errActivateGeneric"));}finally{setBusy(false);}
  }
  const index=["agent","market","limits","backup","fund"].indexOf(step);
  const strategyName=()=>{const found=STRATEGIES.find(s=>s.id===strategy);return found?t(found.nameKey):strategy;};
  return <section className="create-agent">
    <header className="create-heading"><button aria-label="Back" disabled={busy||step==="backup"} onClick={()=>step==="limits"?setStep("market"):step==="market"?setStep("agent"):onBack()}><ArrowLeft size={18}/></button><span>{t("onboard.header")}</span></header>
    <ol className="create-steps" aria-label="Setup progress">{STEPS.map((key,i)=><li key={key} aria-current={i===index?"step":undefined}><span>{i<index?<Check size={12}/>:i+1}</span>{t(key)}</li>)}</ol>
    {step==="agent" && <><div className="create-intro"><Face name={name||t("onboard.defaultName")} slug={null}/><h1>{t("onboard.meetTitle")}</h1><p>{t("onboard.agentSub")}</p></div><form onSubmit={e=>{e.preventDefault();if(!name.trim()){setError(t("create.errName"));return;}setError("");setStep("market");}}><label className="create-label" htmlFor="agent-name">{t("onboard.agentNameLabel")}</label><input className="create-input" id="agent-name" value={name} maxLength={24} placeholder={t("onboard.agentNamePlaceholder")} onChange={e=>setName(e.target.value)} required/><fieldset className="create-strategies"><legend>{t("onboard.strategyLegend")}</legend>{STRATEGIES.map(s=><label className={strategy===s.id?"selected":""} key={s.id}><input type="radio" name="strategy" value={s.id} checked={strategy===s.id} onChange={()=>setStrategy(s.id)}/><span><strong>{t(s.nameKey)}{s.circle&&<i className="tag holders" title="Runs only while you hold $MERRYMEN">{t("onboard.holdersBadge")}</i>}</strong><small>{t(s.descKey)}{s.circle?` ${t("onboard.circleSuffix")}`:""}</small></span><span className="create-radio" aria-hidden>{strategy===s.id&&<Check size={13}/>}</span></label>)}</fieldset><div className="create-example" aria-live="polite"><span>{t("onboard.strategyExample")}</span><p>{t(EXAMPLES[strategy]!)}</p></div>
            {/* THE READER'S STANDING, not the rule. The badge above states the
                requirement; this says whether THEY meet it, which is the only
                half that decides whether to press the button. "I had to go to
                /api/circle to check that and that's not good for normies." */}
            {/* JUDGED ON THE WALLET ALONE. The standing counts the owner's
                wallet and their current agent's account together, but a new
                agent is a new, empty account — so a figure that includes the
                old one would promise this agent tokens it will not have. And
                an unread count is a dash, never `?? 0`. */}
            {STRATEGIES.find((x) => x.id === strategy)?.circle &&
              tier &&
              tier.why !== "sign-in" &&
              !newAgentQualifies(tier) && (
                <div className="create-locked" role="status">
                  <strong>{t("onboard.lockedTitle")}</strong>
                  {tier.why === "unreadable" ? (
                    <p>{t("onboard.lockedUnreadable")}</p>
                  ) : (
                    <p>{t("onboard.lockedNeeds",{have:count(tier.holderTokens),need:count(tier.needTokens),tail:tier.energyGate?t("onboard.lockedEnergyTail",{full:count(ENERGY.fullTokens)}):""})}</p>
                  )}
                </div>
              )}
            {/* WHAT A NEW AGENT DOES NOT INHERIT. $MERRYMEN in the current
                agent's account counts toward THAT agent; it stays there, and
                a new agent starts without it. Said here, before the owner
                builds a second agent expecting the first one's standing. */}
            {tier && tier.agentTokens !== null && tier.agentTokens > 0 && (
              <p className="create-energy">{t("onboard.agentTokensStay",{amount:count(tier.agentTokens)})}</p>
            )}
            {/* AND, ON A DEPLOYMENT THAT GATES ENERGY, THE CAPACITY IT WILL
                HAVE — said before anybody funds it, never after. */}
            {tier &&
              tier.energyGate &&
              tier.why === "ok" &&
              tier.holderTokens !== null &&
              tier.holderTokens < ENERGY.fullTokens &&
              !STRATEGIES.find((x) => x.id === strategy)?.circle && (
                <p className="create-energy">{t("onboard.energyNote",{full:count(ENERGY.fullTokens)})}</p>
              )}<button className="flow-primary" type="submit">{t("onboard.setLimits")} <ArrowRight size={16}/></button></form></>}
    {step==="market" && <>
      {/* WHAT IT TRADES, ASKED ONCE, AT THE ONLY MOMENT IT IS FREE.
          Every answer here rides the settings write create() already makes, and
          any coin named here is sealed into the FIRST signature — so it needs
          no re-sign, no coverage banner, and none of the "why isn't it trading"
          journey that sent several owners to the group. */}
      <div className="create-intro"><h1>{t("onboard.marketTitle")}</h1><p>{t("onboard.marketCopy")}</p></div>
      <fieldset className="create-mode">
        <legend>{t("onboard.marketsLegend")}</legend>
        <label><input type="radio" name="assetMode" checked={assetMode==="all"} onChange={()=>setAssetMode("all")}/> {t("onboard.modeAll")}</label>
        <label><input type="radio" name="assetMode" checked={assetMode==="stocks"} onChange={()=>setAssetMode("stocks")}/> {t("onboard.modeStocks")}</label>
        <label><input type="radio" name="assetMode" checked={assetMode==="crypto"} onChange={()=>setAssetMode("crypto")}/> {t("onboard.modeCrypto")}</label>
      </fieldset>
      <p className="create-note">{assetMode==="stocks"?t("onboard.noteStocks"):assetMode==="crypto"?t("onboard.noteCrypto"):t("onboard.noteAll")}</p>

      {assetMode!=="crypto" && <>
        <label className="create-label">{t("onboard.stocksLabel")}</label>
        <div className="mm-chips">{STOCK_TOKENS.filter(t=>t.kind!=="memecoin").map(t=>
          <button key={t.symbol} type="button" className={`mm-toggle${basket.includes(t.symbol)?" on":""}`} aria-pressed={basket.includes(t.symbol)} onClick={()=>setBasket(b=>b.includes(t.symbol)?b.filter(s=>s!==t.symbol):[...b,t.symbol])}>{t.symbol}</button>)}
        </div>
      </>}

      {assetMode!=="stocks" && <>
        <label className="create-label">{t("onboard.coinsLabel")}</label>
        {wizardTokens.length===0
          ? <p className="create-note">{t("onboard.noCoins")}</p>
          : <div className="mm-chips">{wizardTokens.map(t=>
              <button key={t.address} type="button" className={`mm-toggle${basket.includes(t.symbol)?" on":""}`} aria-pressed={basket.includes(t.symbol)} onClick={()=>setBasket(b=>b.includes(t.symbol)?b.filter(s=>s!==t.symbol):[...b,t.symbol])}>{t.symbol}</button>)}
            </div>}
        <div className="create-limits">
          <label>{t("onboard.coinSymbol")}<input className="create-input" value={newCoin.symbol} maxLength={12} placeholder="CATE" onChange={e=>setNewCoin(n=>({...n,symbol:e.target.value}))}/></label>
          <label>{t("onboard.coinAddress")}<input className="create-input" value={newCoin.address} placeholder="0x…" onChange={e=>setNewCoin(n=>({...n,address:e.target.value}))}/></label>
          <label>{t("onboard.coinDecimals")}<input className="create-input" inputMode="numeric" value={newCoin.decimals} onChange={e=>setNewCoin(n=>({...n,decimals:e.target.value}))}/></label>
        </div>
        <button type="button" className="copy-btn" onClick={()=>{
          setCoinError("");
          const candidate={symbol:newCoin.symbol.trim(),address:newCoin.address.trim(),decimals:Number(newCoin.decimals)};
          if(!isValidCustomToken(candidate)){setCoinError(t("onboard.errCoinInvalid"));return;}
          // $MERRYMEN is energy, never a coin the permission covers (every signer drops it).
          if(isEnergyReserveToken(candidate.address)){setCoinError(t("onboard.errCoinEnergy"));return;}
          if(wizardTokens.some(t=>t.address.toLowerCase()===candidate.address.toLowerCase())){setCoinError(t("onboard.errCoinDup"));return;}
          // BOTH WRITES, as everywhere else: added AND selected. The distinction
          // between "know about this" and "trade it" is real, but hiding the
          // second half is what made it a trap.
          setWizardTokens(t=>[...t,candidate as CustomToken]);
          setBasket(b=>b.includes(candidate.symbol)?b:[...b,candidate.symbol]);
          setNewCoin({symbol:"",address:"",decimals:"18"});
        }}>{t("onboard.addCoin")}</button>
        {coinError && <p className="create-note" role="alert">{coinError}</p>}
      </>}

      {basket.length===0 && <p className="create-note" role="status">{t("onboard.errEmptyBasket")}</p>}
      <button className="flow-primary" disabled={basket.length===0} onClick={()=>{setError("");setStep("limits");}}>{t("onboard.continue")}</button>
    </>}
    {step==="limits" && <><div className="create-intro"><h1>{t("onboard.limitsTitleA")}<br/>{t("onboard.limitsTitleB")}</h1><p>{t("onboard.limitsCopy")}</p></div><div className="create-limits"><label>{t("onboard.perTradeUsd")}<input className="create-input" inputMode="decimal" value={trade} onChange={e=>setTrade(e.target.value)} maxLength={12}/></label><label>{t("onboard.perDayUsd")}<input className="create-input" inputMode="decimal" value={day} onChange={e=>setDay(e.target.value)} maxLength={12}/></label></div><dl className="fund-breakdown"><div><dt>{t("onboard.bdPermission")}</dt><dd>7 days</dd></div><div><dt>{t("onboard.bdDrawdown")}</dt><dd>5%</dd></div><div><dt>{t("onboard.bdMaxOps")}</dt><dd>24 per day</dd></div><div><dt>{t("onboard.bdNetwork")}</dt><dd>Robinhood Chain</dd></div></dl><fieldset className="create-mode"><legend>{t("mode.legend")}</legend><label><input type="radio" name="mode" checked={paper} onChange={()=>setPaper(true)}/> {t("mode.paperOption")}</label><label><input type="radio" name="mode" checked={!paper} onChange={()=>setPaper(false)}/> {t("mode.liveOption")}</label></fieldset><p className="create-note">{paper?t("mode.paperNote"):t("mode.liveNote")}</p>{!paper&&<label className="create-check"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>{t("mode.ack")}</label>}<button className="flow-primary" disabled={busy} onClick={()=>void create()}>{busy?t("onboard.creating"):t("onboard.createCta")}</button></>}
    {/* TWO OWNER MODELS, TWO DIFFERENT TRUTHS TO TELL.
        A Privy-owned account has NO key here, by design — showing dots and
        asking somebody to confirm they saved them is asking them to lie, and
        the sibling screen went further and warned them off funding an account
        that was working. So this step says what is actually true of each. */}
    {step==="backup"&&grant&&isPrivyOwned(grant)&&<><div className="create-intro"><h1>{t("onboard.homeTitle")}</h1><p>{t("onboard.homePrivyCopy")}</p></div><div className="create-secret"><code>{t("onboard.heldByPrivy")}</code></div><label className="create-check"><input type="checkbox" checked={backupAck} onChange={e=>setBackupAck(e.target.checked)}/>{t("onboard.privyAck")}</label><button className="flow-primary" disabled={!backupAck} onClick={()=>{localStorage.setItem(`merrymen.backup.${grant.smartAccount.toLowerCase()}`,"1");setStep("fund");}}>{t("onboard.continue")}</button></>}
    {step==="backup"&&grant&&!isPrivyOwned(grant)&&<><div className="create-intro"><h1>{t("onboard.homeTitle")}</h1><p>{t("onboard.homeKeyCopy")}</p></div><label className="create-label">{t("onboard.recoveryLabel")}</label><div className="create-secret"><code>{reveal ? grant.demoOwnerPrivateKey : "•••• •••• •••• •••• •••• ••••"}</code><button aria-label={reveal?"Hide recovery key":"Reveal recovery key"} onClick={()=>setReveal(!reveal)}>{reveal?<EyeOff size={18}/>:<Eye size={18}/>}</button></div><label className="create-check"><input type="checkbox" checked={backupAck} onChange={e=>setBackupAck(e.target.checked)}/>{t("onboard.keyAck")}</label><button className="flow-primary" disabled={!backupAck} onClick={()=>{localStorage.setItem(`merrymen.backup.${grant.smartAccount.toLowerCase()}`,"1");setReveal(false);setStep("fund");}}>{t("onboard.continue")}</button></>}
    {step==="fund"&&grant&&<><div className="create-intro"><h1>{armed?t("onboard.readyTitle"):t("onboard.connectTitle")}</h1><p>{armed?(paper ? t("onboard.fundArmedPaper") : t("onboard.fundArmedLive")):t("onboard.fundPending")}</p></div>{armed?<><dl className="fund-breakdown"><div><dt>{t("onboard.sumAgent")}</dt><dd>{name || t("onboard.defaultName")}</dd></div><div><dt>{t("onboard.sumStrategy")}</dt><dd>{strategyName()}</dd></div><div><dt>{t("onboard.sumMode")}</dt><dd>{paper ? t("onboard.sumPaper") : t("onboard.sumLive")}</dd></div></dl>{strategy==="llm-strategist"&&<p className="create-note">{t("onboard.aiCheckPre")} <a href="/settings">{t("onboard.settingsLink")}</a> {t("onboard.aiCheckPost")}</p>}{!paper&&<button className="flow-primary" onClick={()=>onFund(grant)}>{t("onboard.addFunds")}</button>}<button className="flow-primary" onClick={()=>{onRefresh();onDone();}}>{t("onboard.openYourAgent")}</button></>:<button className="flow-primary" disabled={busy} onClick={()=>void retryActivation()}>{t("onboard.retryActivation")}</button>}</>}
    {status&&<p role="status" className="create-note">{status}</p>}{error&&<p role="alert" className="flow-error">{error}{isWallTooWide(error)&&<> <a href="/settings">{t("onboard.reviewTokens")}</a></>}</p>}
  </section>;
}
