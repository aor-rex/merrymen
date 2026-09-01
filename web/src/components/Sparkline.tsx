/**
 * An equity shape, in SVG.
 *
 * SVG rather than the canvas Spark, deliberately: this renders on the server
 * with no useEffect, and a leaderboard is twenty of these at once. Twenty
 * canvases with twenty requestAnimationFrame loops is the wrong trade on a
 * phone. The canvas version keeps its place on the single hero chart, where the
 * draw-in is worth paying for.
 *
 * A FLAT SERIES IS NOT A BUG. An agent whose equity has not moved gets a
 * straight line through the middle, not a division by zero and not an empty
 * box — the same fix the canvas version carries.
 */
export function Sparkline({
  points,
  width = 84,
  height = 28,
  tone = "up",
}: {
  points: number[];
  width?: number;
  height?: number;
  tone?: "up" | "down" | "flat";
}) {
  if (points.length < 2) {
    return <svg width={width} height={height} aria-hidden className="mm-spark" />;
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1; // flat series: a straight line, not a divide by zero
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const d = points
    .map((p, i) => {
      const x = pad + (i / (points.length - 1)) * w;
      const y = pad + h - ((p - min) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  const stroke =
    tone === "up" ? "var(--mm-up)" : tone === "down" ? "var(--mm-down)" : "var(--mm-dim)";

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="mm-spark">
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
