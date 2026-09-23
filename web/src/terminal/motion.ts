/**
 * WHICH WAY A FIGURE JUST MOVED — for the flip a price or a balance plays when
 * it changes.
 *
 * Only a change between two READINGS is a move. A figure drawn for the first
 * time did not move, and neither did one that went from a number to unknown or
 * back: `null` is a read that failed or has not happened, and animating it as a
 * rise or a fall would be the screen asserting a price change nobody measured.
 */
import { useState } from "react";

export type Trend = "up" | "down" | null;

const reading = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

export function trendOf(prev: number | null | undefined, next: number | null | undefined): Trend {
  if (!reading(prev) || !reading(next) || prev === next) return null;
  return next > prev ? "up" : "down";
}

/**
 * The direction of the LAST change this component saw, or null until it has
 * seen one. Remembered from the previous render rather than an effect, so the
 * flip plays in the same frame the new figure is drawn in.
 */
export function useTrend(value: number | null): Trend {
  const [seen, setSeen] = useState<{ value: number | null; trend: Trend }>({ value, trend: null });
  if (!Object.is(seen.value, value)) {
    const trend = trendOf(seen.value, value);
    setSeen({ value, trend });
    return trend;
  }
  return seen.trend;
}
