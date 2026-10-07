"use client";
import { useT } from "@/lib/i18n";
export default function PageError({reset}:{reset:()=>void}) {
  const t = useT();
  return <div className="terminal-host terminal-standalone"><main><h1>{t("common.pageErrorTitle")}</h1><p>{t("common.pageErrorBody")}</p><button onClick={reset}>{t("common.tryAgain")}</button><p><a href="/">{t("common.backToMarkets")}</a></p></main></div>;
}
