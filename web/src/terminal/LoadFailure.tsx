"use client";
import { useEffect, useState } from "react";
import { failureCopy } from "./refresh-loop";

/**
 * THE SHELL'S ONE OUTAGE LINE — replacing a raw error message that never went
 * away.
 *
 * It counts down to the retry that is already booked (refresh-loop.ts), says
 * whether the figures on screen are the last ones read, and offers to try now.
 * It renders only while the loop is failing, and App unmounts it on the first
 * pass that succeeds.
 *
 * THE COUNTDOWN IS HIDDEN FROM SCREEN READERS on purpose. It changes every
 * second, and inside an alert that would be announced every second; the
 * sentence a listener needs does not change, so that is what they are given.
 */
export function LoadFailure({
  nextAt,
  lastOkAt,
  onRetry,
}: {
  nextAt: number;
  lastOkAt: number | null;
  onRetry: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const copy = failureCopy({ nextAt, lastOkAt, now });
  return (
    <div className="load-failure" role="alert">
      <span className="sr-only">
        Can&apos;t reach merrymen. Retrying automatically.{copy.stale ? ` ${copy.stale}` : ""}
      </span>
      <span aria-hidden="true">
        <strong>{copy.line}</strong>
        {copy.stale && <> {copy.stale}</>}
      </span>
      <button type="button" onClick={onRetry}>
        Retry now
      </button>
    </div>
  );
}
