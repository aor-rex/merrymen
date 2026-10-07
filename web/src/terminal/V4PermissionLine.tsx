import React from "react";
import { grantHasV4, grantV4Adapter, type StoredGrant } from "@merrymen/core";
import { useT } from "@/lib/i18n";

type V4Grant = Pick<StoredGrant, "grantFeatures" | "v4AdapterAddress">;

/** The old unrestricted router grant and the constrained adapter are different permissions. */
export function V4PermissionLine({ grant, configuredAdapter }: { grant: V4Grant; configuredAdapter?: string }) {
  const t = useT();
  const adapter = grantV4Adapter(grant);
  const legacy = grantHasV4(grant);
  const settingsMismatch = adapter && configuredAdapter && adapter.toLowerCase() !== configuredAdapter.toLowerCase();
  return (
    <li>
      <b>Uniswap v4</b> —{" "}
      {legacy && (
        <span style={{ color: "var(--red)" }}>
          {t("common.v4LegacyPre")}<b>{t("common.v4Resign")}</b>{t("common.v4LegacyPost")}
        </span>
      )}
      {legacy && adapter && " "}
      {adapter ? (
        <>
          {t("common.v4SealedPre")}<code style={{ overflowWrap: "anywhere" }}>{adapter}</code>{t("common.v4SealedPost")}
          {settingsMismatch && (
            <>{" "}{t("common.v4Mismatch")}</>
          )}
        </>
      ) : legacy ? null : configuredAdapter ? (
        <>
          {t("common.v4SavedPre")}<b>{t("common.v4Resign")}</b>{t("common.v4SavedPost")}
        </>
      ) : (
        <>
          {t("common.v4Missing")}
        </>
      )}
    </li>
  );
}
