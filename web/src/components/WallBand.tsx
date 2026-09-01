"use client";

import { useMemo } from "react";
import { useLivingCanvas } from "@/components/useLivingCanvas";
import type { WallTape } from "@/lib/read-wall-tape";

/**
 * THE WALL.
 *
 * Every intent this ledger recorded in the last 24 hours flies at a wall of dim
 * amber from the left. Almost all of them stop, pile up and glow; the rare one
 * that gets through goes white and leaves. The pile's silhouette is a sideways
 * histogram of which rule turns the most things back — a real chart that
 * happens to be the hero.
 *
 * IT IS DRAWN FROM `trades`, NOT INVENTED. The tape is the day's real rows in
 * their real time distribution, so a quiet night is a sparse stretch and a busy
 * hour is a burst. Nothing is topped up to make the picture denser.
 *
 * WHY THIS AND NOT SOMETHING PRETTIER. merrymen is a boundary — agents are
 * refused constantly and visibly, and one live agent is sitting on 1,225
 * refusals and zero fills. The product already shipped that fact as a button
 * that fires malicious intents through the policy code to watch them bounce,
 * and then rendered the result as a list of grey rows. This draws it.
 *
 * WHAT IT REFUSES TO BE. Full-bleed, fixed, parallaxed, cursor-reactive,
 * always drifting. That is Embers with better taste — moving pixels behind the
 * one thing this product exists to let you read. It is a fixed-height figure in
 * normal flow, ABOVE the reading column. It scrolls away and does not come back.
 */

/** CSS px per cell, everywhere. The buffer really is this coarse. */
const CELL = 4;

/** The ramp, as RGB triples. Index 5 is `through`, and means only that. */
const RAMP: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [58, 22, 0],
  [122, 46, 0],
  [199, 122, 11],
  [251, 191, 36],
  [255, 255, 255],
];

/** 4x4 ordered Bayer, for the pile's continuous heat. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const PLAY_MS = 14_000;
const RELEASE_MS = 10_000;
const FLIGHT_MS = 1_600;

interface Plan {
  cols: number;
  rows: number;
  wallX: number;
  laneCount: number;
  /** Release offset in seconds, index-aligned with tape.cells. */
  release: Float32Array;
  /** Final pile depth per lane, for the still render. */
  depth: Int32Array;
}

export function WallBand({
  tape,
  still = false,
  size = "feed",
}: {
  tape: WallTape;
  /** Render the settled end state and never animate. */
  still?: boolean;
  size?: "feed" | "agent";
}) {
  // Reduced motion takes the still branch before any loop exists.
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const frozen = still || reduced;

  const plan = useMemo<Plan>(() => {
    const n = tape.cells.length;
    const release = new Float32Array(n);
    const span = Math.max(1, tape.to - tape.from);
    for (let i = 0; i < n; i++) {
      // The DISTRIBUTION IS THE DATA. Not a stagger — a sparse night is a
      // sparse stretch of tape and a busy hour arrives as a burst.
      release[i] = ((tape.cells[i]!.t - tape.from) / span) * (RELEASE_MS / 1000);
    }
    const laneCount = Math.max(1, tape.lanes.length);
    const depth = new Int32Array(laneCount);
    for (const c of tape.cells) if (c.fate === "turned") depth[c.lane] = (depth[c.lane] ?? 0) + 1;
    return { cols: 0, rows: 0, wallX: 0, laneCount, release, depth };
  }, [tape]);

  const ref = useLivingCanvas<HTMLCanvasElement>({
    // ONE BUFFER PIXEL PER CELL. At CELL = 4 a 888px column is a 222-wide
    // buffer — about 2% of the pixels — upscaled 4x on the GPU with
    // image-rendering: pixelated. The coarseness is not a compromise to
    // apologise for, it IS the dither, and it is why this costs nothing.
    scale: 1 / CELL,
    maxDpr: 1,
    fps: 24,
    draw: (ctx, cols, rows, t) => {
      const img = ctx.createImageData(cols, rows);
      const px = img.data;
      const put = (x: number, y: number, ramp: number) => {
        if (x < 0 || y < 0 || x >= cols || y >= rows) return;
        const c = RAMP[Math.max(0, Math.min(5, ramp))]!;
        const o = (y * cols + x) * 4;
        px[o] = c[0];
        px[o + 1] = c[1];
        px[o + 2] = c[2];
        px[o + 3] = 255;
      };

      const wallX = Math.round(cols * 0.72);
      const L = Math.min(plan.laneCount, Math.max(1, Math.floor(rows / 4)));

      // LANES FILL THE BAND. A fixed 4-row pitch is right at eight lanes and
      // absurd at two — it crammed the whole composition into the top seventh
      // of the canvas and left the rest black. The pitch is derived instead, so
      // a ledger that refuses things for two reasons and one that refuses them
      // for eight both use the whole height.
      const usable = rows - 2; // the base row, and one of air above it
      const pitch = Math.max(3, Math.floor(usable / L));
      const top = Math.max(0, Math.floor((usable - pitch * L) / 2));
      // The pile's thickness, and the strike's: most of the pitch, never less
      // than one, so the lanes stay separable.
      const thick = Math.max(1, Math.min(pitch - 1, Math.round(pitch * 0.55)));
      const laneTop = (n: number) => top + n * pitch + Math.floor((pitch - thick) / 2);
      const laneRow = (n: number) => laneTop(n) + Math.floor(thick / 2);

      // ── the base: the hour marks of the window ──────────────────────────
      for (let x = 0; x < cols; x++) put(x, rows - 1, 1);
      const tickEvery = Math.max(4, Math.round(wallX / 24));
      for (let x = 0; x < wallX; x += tickEvery) put(x, rows - 1, 2);

      // ── the wall: the only straight line in the composition ─────────────
      // Dashed, and never bright at rest.
      const strike = new Float32Array(L); // 0..1 flare per lane
      for (let y = 0; y < rows - 1; y++) if (y % 4 !== 3) put(wallX, y, 2);
      // Brighter where a lane actually meets it — the wall is only a wall
      // where something is hitting it.
      for (let lane = 0; lane < L; lane++)
        for (let dy = 0; dy < thick; dy++) put(wallX, laneTop(lane) + dy, 3);

      // ── the tape ─────────────────────────────────────────────────────────
      //
      // THE RESTING FRAME IS THE SETTLED DAY, NOT AN EMPTY STAGE.
      //
      // t is exactly 0 only on the one paint the harness makes before any loop
      // starts — which is also the ONLY paint a visitor gets if their tab was
      // in the background when the page loaded, or if they have asked for
      // reduced motion. Replaying from empty would show those people a blank
      // band and tell them the day was quiet. So the resting state is the end
      // state: the full pile, already there. The replay is what happens when
      // somebody is actually watching.
      const settled = frozen || t === 0;
      const now = settled ? Number.POSITIVE_INFINITY : (t * 1000) % PLAY_MS;
      const pile = new Int32Array(L);
      const flightSpeed = wallX / (FLIGHT_MS / 1000);

      for (let i = 0; i < tape.cells.length; i++) {
        const c = tape.cells[i]!;
        const lane = Math.min(c.lane, L - 1);
        const rel = plan.release[i]! * 1000;
        if (now < rel) continue;

        const age = (now - rel) / 1000;
        const x = age * flightSpeed;

        if (c.fate === "flight") {
          // IT LEFT AND NEVER SETTLED. Stops two columns short and stays
          // there, dashed — the same word the chips speak.
          const at = Math.min(Math.floor(x), wallX - 2);
          if ((at & 1) === 0) put(at, laneRow(lane), 3);
          continue;
        }

        if (x < wallX) {
          // In flight: a thin 1x1 mark on its lane's centre row.
          put(Math.floor(x), laneRow(lane), 3);
          continue;
        }

        if (c.fate === "turned") {
          const k = pile[lane]!;
          pile[lane] = k + 1;
          // The strike: the wall flares where something just hit it.
          const sinceHit = age - wallX / flightSpeed;
          if (sinceHit >= 0 && sinceHit < 0.25) strike[lane] = Math.max(strike[lane]!, 1 - sinceHit / 0.25);
          continue;
        }

        // Through. Hot message, cool broken channel.
        const past = x - wallX;
        const stopAt = cols - 6;
        const bx = Math.min(wallX + Math.floor(past), stopAt);
        const y = laneRow(lane);
        if (bx >= stopAt) {
          // A 3x3 box with an X, joined back to the wall by a dashed line.
          for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++) {
              const edge = dx === -1 || dx === 1 || dy === -1 || dy === 1;
              const cross = dx === dy || dx === -dy;
              if (edge || cross) put(stopAt + dx, y + dy, 5);
            }
          for (let cx = wallX + 1; cx < stopAt - 1; cx++) if ((cx & 3) < 2) put(cx, y, 2);
        } else {
          put(bx, y, 5);
        }
      }

      // ── the pile: grows leftward, newest at the growing edge ────────────
      for (let lane = 0; lane < L; lane++) {
        const P = settled ? (plan.depth[lane] ?? 0) : pile[lane]!;
        if (!P) continue;
        const y0 = laneTop(lane);
        // Capped at the wall's distance from the left so a huge lane cannot
        // run off the canvas — it saturates, which is the honest render of a
        // lane that turns back more than the band can draw.
        const drawn = Math.min(P, wallX - 1);
        for (let k = 0; k < drawn; k++) {
          const x = wallX - 1 - k;
          // HEAT IS RECENCY. The pile grows leftward, so the newest refusals
          // are its left edge — and that is what glows. The tail against the
          // wall, which has been there since this morning, cools to the ramp's
          // floor. It means the bright part of the picture is always the part
          // that just happened, which is the whole of what makes it alive
          // rather than a chart that happens to move.
          const inten = 2 + 2 * (k / Math.max(1, drawn));
          for (let dy = 0; dy < thick; dy++) {
            const y = y0 + dy;
            const frac = (inten % 1) * 16;
            const v = Math.floor(inten) + (frac > BAYER[y & 3]![x & 3]! ? 1 : 0);
            put(x, y, v);
          }
        }
      }

      // ── the strike, painted over the wall ────────────────────────────────
      for (let lane = 0; lane < L; lane++) {
        const s = strike[lane]!;
        if (s <= 0) continue;
        const v = 2 + Math.round(s * 3);
        for (let dy = 0; dy < thick; dy++) put(wallX, laneTop(lane) + dy, v);
      }

      ctx.putImageData(img, 0, 0);
    },
  });

  const empty = tape.source === "none" || tape.cells.length === 0;

  return (
    <figure className="mm-wall" data-size={size} aria-hidden={empty ? undefined : true}>
      <canvas ref={ref} className="mm-wall-canvas" />
      {empty && (
        <figcaption className="mm-wall-cap mono">
          {tape.source === "none"
            ? "couldn't read the ledger just now — this is what we don't know"
            : "nothing has been put to the wall in the last day"}
        </figcaption>
      )}
    </figure>
  );
}

/** The cell size, exported so the CSS height and the buffer cannot drift. */
export const WALL_CELL = CELL;
