"use client";

/**
 * The connect hub: the shortest way from "I use Claude" to "Claude can see my
 * agent", for owners who have never heard of MCP.
 *
 * One big button for Claude, because it is the assistant most owners have and
 * its link opens claude.ai's own Add connector dialog already filled in (then
 * Continue, Connect, Allow). Every other assistant gets one row with one
 * obvious action: its own install link where it has one, a command with a Copy
 * button where it lives in a terminal.
 *
 * NOTHING HERE GRANTS ACCESS. A link only puts the address into the assistant;
 * the assistant then sends the owner to the consent page, and nothing is
 * allowed until they click Allow there. The page needs no sign-in. Its one
 * signed-in read (which assistants are already connected) is best-effort: a
 * signed-out visitor, an error or a slow answer shows nothing, never an error.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronDown, Copy, Plug } from "lucide-react";
import { claudeCodePluginCommands, installCommands, installLinks } from "@/mcp/install-links";
import { useRichT, useT } from "@/lib/i18n";
import { BrandLockup } from "../BrandLockup";

/** The fields of a GET /api/mcp/connections row that the status line reads. */
interface ConnectionLite { clientName: string | null; clientHost: string | null; lastUsedAt: number | null }

/** How long the status read may take before the page stops waiting for it. */
const STATUS_TIMEOUT_MS = 10_000;

/**
 * merrymen.dev's static copy of the production setup text, the one a search
 * finds (assistant-setup.test.ts pins it to llmsTxt()). Any other server
 * serves its own at <app>/llms.txt.
 */
const SITE_LLMS_TXT = "https://merrymen.dev/llms.txt";

/** "last used 5 min ago", from epoch seconds. */
export function lastUsedWords(lastUsedAt: number | null, nowSec: number): string {
  if (!lastUsedAt) return "not used yet";
  const s = Math.max(0, nowSec - lastUsedAt);
  if (s < 60) return "last used just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `last used ${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `last used ${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  return `last used ${d} ${d === 1 ? "day" : "days"} ago`;
}

/**
 * The status line's words, or null when nothing is connected. Two Claude
 * connections read as one "Claude"; "last used" is the most recent use of any
 * of them. Rows are read defensively: this is a courtesy line, and a shape it
 * does not expect hides it rather than breaking the page.
 */
export function connectedSummary(rows: unknown, nowSec: number): { names: string; lastUsed: string; claude: boolean } | null {
  if (!Array.isArray(rows)) return null;
  const list = rows.filter((r): r is ConnectionLite => !!r && typeof r === "object");
  if (!list.length) return null;
  const names: string[] = [];
  for (const r of list) {
    const name = typeof r.clientName === "string" && r.clientName.trim() ? r.clientName.trim()
      : typeof r.clientHost === "string" && r.clientHost ? r.clientHost : "An assistant";
    if (!names.includes(name)) names.push(name);
  }
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
  const last = list.reduce<number | null>((max, r) => (typeof r.lastUsedAt === "number" && r.lastUsedAt > (max ?? 0) ? r.lastUsedAt : max), null);
  // Claude (web, desktop, mobile) connects as claude.ai; Claude Code also verifies at claude.ai, under its own name.
  const claude = list.some((r) => r.clientHost === "claude.ai" && !/\bcode\b/i.test(r.clientName ?? ""));
  return { names: shown, lastUsed: lastUsedWords(last, nowSec), claude };
}

/** Select an element's text, so an owner whose browser refused the clipboard can copy it by hand. */
function selectText(id: string): void {
  const el = document.getElementById(id);
  const selection = window.getSelection();
  if (!el || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
  // The text may sit in another section (the ChatGPT row copies the address box).
  el.scrollIntoView({ block: "nearest" });
}

/**
 * A Copy button with a way out. The clipboard is missing on plain http and can
 * be refused (permissions, an embedded browser); then the text is selected
 * instead and the button says so. "Copied" shows for two seconds and is
 * announced to screen readers. The timer dies with the component: a stray
 * timeout outliving its component once broke CI.
 */
function CopyButton({ text, target, label, children }: { text: string; target: string; label: string; children?: ReactNode }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  async function copy() {
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      selectText(target);
    }
    // The clipboard answers asynchronously; the page may have gone meanwhile.
    if (!alive.current) return;
    setState(copied ? "copied" : "manual");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setState("idle");
    }, copied ? 2000 : 8000);
  }

  return (
    <>
      <button type="button" className="mcp-hub-copy" aria-label={label} onClick={() => void copy()}>
        {state === "copied" ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {state === "copied" ? t("connect.mcpCopied") : (children ?? t("connect.mcpCopy"))}
      </button>
      <span className={state === "manual" ? "mcp-hub-copy-note" : "sr-only"} role="status" aria-live="polite">
        {state === "copied" ? t("connect.mcpCopied") : state === "manual" ? t("connect.mcpCopyManual") : ""}
      </span>
    </>
  );
}

/** A link that opens in a new tab and says so to screen readers. */
function Out({ href, className, label, children }: { href: string; className?: string; label?: string; children: ReactNode }) {
  const t = useT();
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer" aria-label={label ? `${label}${t("connect.newTab")}` : undefined}>
      {children}
      {!label && <span className="sr-only">{t("connect.newTab")}</span>}
    </a>
  );
}

/** Commands shown as they will be pasted (wrapped on a phone, never cut), with one Copy for all of them. */
function Command({ lines, label }: { lines: string[]; label: string }) {
  const id = useId();
  const text = lines.join("\n");
  return (
    <div className="mcp-hub-command">
      <pre id={id}><code>{text}</code></pre>
      <CopyButton text={text} target={id} label={label} />
    </div>
  );
}

function Row({ name, children }: { name: string; children: ReactNode }) {
  return <li className="mcp-hub-row"><h3>{name}</h3>{children}</li>;
}

export function McpConnectClient({ url, app, enabled, disabledWhy }: { url: string; app: string; enabled: boolean; disabledWhy: string | null }) {
  const t = useT();
  const rt = useRichT();
  const links = installLinks(url);
  const commands = installCommands(url);
  // The Claude Code plugin, offered only where this page serves the address it points at.
  const plugin = claudeCodePluginCommands(url);
  // The setup text an assistant follows (mcp/assistant-setup.ts) for this server's address.
  const llms = plugin ? SITE_LLMS_TXT : `${app}/llms.txt`;
  const addressId = useId();
  const [connected, setConnected] = useState<ReturnType<typeof connectedSummary>>(null);

  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), STATUS_TIMEOUT_MS);
    void (async () => {
      try {
        const response = await fetch("/api/mcp/connections", { cache: "no-store", credentials: "same-origin", signal: abort.signal });
        if (!response.ok) return;
        const data = await response.json() as { connections?: unknown };
        if (!abort.signal.aborted) setConnected(connectedSummary(data.connections, Math.floor(Date.now() / 1000)));
      } catch {
        // Signed out, offline or slow: the line is simply not shown.
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      clearTimeout(timeout);
      abort.abort();
    };
  }, [enabled]);

  return (
    <div className="terminal-host partner-connect mcp-connect">
      <header className="connect-header">
        <BrandLockup />
        <span className="connect-header-label">{t("connect.mcpHeader")}</span>
      </header>
      <main className="connect-main">
        <div className="connect-context">
          <span className="connect-eyebrow">{t("connect.consentEyebrow")}</span>
          <h1>{t("connect.mcpTitleA")}<br />{t("connect.mcpTitleB")}</h1>
          <p>{t("connect.mcpIntro")}</p>
        </div>
        <div className="connect-panel mcp-hub">
          {!enabled ? <>
            <h2>{t("connect.mcpOff")}</h2>
            {disabledWhy && <p className="mcp-hub-fine">{t("connect.mcpOffWhy", { why: disabledWhy })}</p>}
            <a className="connect-cancel" href="/">{t("connect.mcpBack")}</a>
          </> : <>
            {connected && (
              <p className="mcp-hub-status">
                <Plug size={14} aria-hidden />
                <span>{t("connect.mcpStatus", { names: connected.names, lastUsed: connected.lastUsed })} <a href="/connect/apps" aria-label={t("connect.mcpManageLabel")}>{t("connect.mcpManage")}</a></span>
              </p>
            )}

            <section className="mcp-hub-section" aria-labelledby="mcp-hub-claude">
              <h2 id="mcp-hub-claude">{t("connect.mcpAddClaude")}</h2>
              {connected?.claude && <p className="mcp-hub-fine">{t("connect.mcpClaudeDone")}</p>}
              <Out className="flow-primary" href={links.claude}>{t("connect.mcpAddClaude")} <ArrowUpRight size={16} aria-hidden /></Out>
              <ol className="mcp-hub-steps">
                <li>{rt("connect.mcpStep1", { cont: t("connect.mcpContinue"), conn: t("connect.mcpConnect") })}</li>
                <li>{rt("connect.mcpStep2", { allow: t("connect.mcpAllow") })}</li>
                <li>{t("connect.mcpStep3")}</li>
              </ol>
              <p className="mcp-hub-fine">{t("connect.mcpClaudeNote")}</p>
              <p className="mcp-hub-fine">{t("connect.mcpOrgPre")} <Out href={links.claudeOrg}>{t("connect.mcpOrgLink")}</Out>{t("connect.mcpOrgPost")}</p>
            </section>

            <section className="mcp-hub-section" aria-labelledby="mcp-hub-others">
              <h2 id="mcp-hub-others" className="mcp-hub-h2">{t("connect.mcpOthers")}</h2>
              <ul className="mcp-hub-rows">
                <Row name="Claude Code">
                  {plugin ? <>
                    <p>{t("connect.mcpPluginOnce")}</p>
                    <Command lines={[plugin[0]]} label={t("connect.mcpCopyCmd1")} />
                    <Command lines={[plugin[1]]} label={t("connect.mcpCopyCmd2")} />
                    <p>{t("connect.mcpPluginThenPre")}<code>/mcp</code>{t("connect.mcpPluginThenMid")}<code>/merrymen:status</code>, <code>/merrymen:why</code>, <code>/merrymen:portfolio</code>{t("connect.mcpPluginThenPost")}</p>
                    <p className="mcp-hub-fine">{t("connect.mcpPluginAlt")}</p>
                  </> : <p>{t("connect.mcpPluginNo")}</p>}
                  <Command lines={commands.claudeCode} label={t("connect.mcpCopyClaudeCode")} />
                  <p className="mcp-hub-fine">{t("connect.mcpTellHint")}</p>
                  <Command lines={[t("connect.mcpTell", { llms })]} label={t("connect.mcpCopyTell")} />
                </Row>
                <Row name="ChatGPT">
                  <p>{t("connect.mcpChatgpt")}</p>
                  <div className="mcp-hub-actions">
                    <CopyButton text={url} target={addressId} label={t("connect.mcpCopyAddressLabel")}>{t("connect.mcpCopyAddress")}</CopyButton>
                    <Out className="mcp-hub-action" href={links.chatgpt}>{t("connect.mcpOpenChatgpt")} <ArrowUpRight size={14} aria-hidden /></Out>
                  </div>
                </Row>
                <Row name="Codex">
                  <Command lines={commands.codex} label={t("connect.mcpCopyCodex")} />
                  <p>{t("connect.mcpCodexNote")}</p>
                </Row>
                <Row name="Cursor">
                  <div className="mcp-hub-actions">
                    <Out className="mcp-hub-action" href={links.cursor}>{t("connect.mcpAddCursor")} <ArrowUpRight size={14} aria-hidden /></Out>
                  </div>
                </Row>
                <Row name="VS Code">
                  <div className="mcp-hub-actions">
                    <Out className="mcp-hub-action" href={links.vscode}>{t("connect.mcpAddVscode")} <ArrowUpRight size={14} aria-hidden /></Out>
                    <Out className="mcp-hub-minor" href={links.vscodeInsiders} label={t("connect.mcpInsidersLabel")}>{t("connect.mcpInsiders")}</Out>
                  </div>
                </Row>
              </ul>
              <details className="mcp-hub-more">
                <summary>{t("connect.mcpMore")} <ChevronDown size={16} aria-hidden /></summary>
                <ul className="mcp-hub-rows">
                  <Row name="Gemini CLI">
                    <Command lines={commands.gemini} label={t("connect.mcpCopyGemini")} />
                    <p>{t("connect.mcpPluginThenPre")}<code>/mcp auth merrymen</code>{t("connect.mcpGeminiPost")}</p>
                  </Row>
                  <Row name="Kiro">
                    <div className="mcp-hub-actions"><Out className="mcp-hub-action" href={links.kiro}>{t("connect.mcpAddKiro")} <ArrowUpRight size={14} aria-hidden /></Out></div>
                  </Row>
                  {/* App links (lmstudio://, goose://) open the app itself, so no new tab. */}
                  <Row name="LM Studio">
                    <div className="mcp-hub-actions"><a className="mcp-hub-action" href={links.lmstudio}>{t("connect.mcpAddLm")}</a></div>
                  </Row>
                  <Row name="Goose">
                    <div className="mcp-hub-actions"><a className="mcp-hub-action" href={links.goose}>{t("connect.mcpAddGoose")}</a></div>
                  </Row>
                  <Row name="Windsurf / Devin">
                    <Command lines={commands.devin} label={t("connect.mcpCopyDevin")} />
                  </Row>
                  <Row name="Anything else">
                    <p>{t("connect.mcpOtherPre")}<a href="/connect/apps">{t("connect.appsLink")}</a>.</p>
                  </Row>
                </ul>
              </details>
            </section>

            <section className="mcp-hub-section mcp-hub-address" aria-labelledby="mcp-hub-address">
              <h2 id="mcp-hub-address" className="mcp-hub-h2">{t("connect.mcpServerAddr")}</h2>
              <div className="mcp-hub-address-row">
                <code id={addressId}>{url}</code>
                <CopyButton text={url} target={addressId} label={t("connect.mcpCopyServerLabel")} />
              </div>
            </section>

            <section className="mcp-hub-section mcp-hub-know" aria-labelledby="mcp-hub-know">
              <h2 id="mcp-hub-know" className="mcp-hub-h2">{t("connect.mcpKnow")}</h2>
              <ul>
                <li>{t("connect.mcpKnow1")}</li>
                <li>{t("connect.mcpKnow2pre")}<a href="/connect/apps">{t("connect.appsLink")}</a>.</li>
                <li>{t("connect.mcpKnow3")}</li>
                <li>{t("connect.mcpKnow4")}</li>
                <li>{t("connect.mcpKnow5")}</li>
              </ul>
            </section>

            {/* Small print for an assistant that fetched this page while setting Merrymen up: llms.txt in brief. */}
            <section className="mcp-hub-section mcp-hub-ai" aria-labelledby="mcp-hub-ai">
              <h2 id="mcp-hub-ai">{t("connect.mcpAi")}</h2>
              <ul>
                <li>{t("connect.mcpAiRun")}<code>claude mcp list</code>{t("connect.mcpAiEntry")}<code>{url}</code>{t("connect.mcpAiSetup")}<code>{commands.claudeCode[0]}</code>{t("connect.mcpAiType")}<code>/mcp</code>{t("connect.mcpAiAuth")}<code>claude mcp login</code>{t("connect.mcpAiNoKey")}</li>
                <li>{t("connect.mcpAiChatPre")}<Out href={links.claude}>{t("connect.mcpAiChatLink")}</Out>.</li>
                <li>{t("connect.mcpAiFull")}<a href={llms}>{llms}</a></li>
              </ul>
            </section>
          </>}
        </div>
      </main>
      <footer className="connect-footer">{t("connect.mcpFooterBrand")} <a href="/connect/apps">{t("connect.appsLink")}</a></footer>
    </div>
  );
}
