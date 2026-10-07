import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from "@/lib/locale";
import { translate } from "@/lib/i18n";

export default async function NotFound() {
  // No provider above this boundary, so the locale is read directly: the
  // server renders the same words the catalogue holds, with no hydration gap.
  const jar = await cookies();
  const locale = normalizeLocale(jar.get(LOCALE_COOKIE)?.value) ?? DEFAULT_LOCALE;
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  return <div className="terminal-host terminal-standalone"><main><a className="brand" href="/">merrymen</a><h1>{t("common.notFoundTitle")}</h1><p>{t("common.notFoundBody")}</p><a className="standalone-action" href="/">{t("common.backToMarkets")}</a></main></div>;
}
