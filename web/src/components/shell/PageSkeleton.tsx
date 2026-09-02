import "@/styles/feed.css";

/**
 * WHAT A NAVIGATION LOOKS LIKE BEFORE THE SERVER ANSWERS.
 *
 * Both rebuilt pages are force-dynamic, and there was no loading boundary
 * anywhere under app/ — so clicking a link did nothing at all until the render
 * came back, typically 120-490ms and several seconds on a spike. A loading.tsx
 * makes the route a Suspense boundary, so the frame paints on the click.
 *
 * IT NO LONGER RENDERS THE SHELL. It did, in its first version, because the
 * shell was mounted by each page and a skeleton without it blanked the rail and
 * the tab bar. That fix cost more than it saved: React unmounts the fallback
 * subtree and mounts the page subtree, so the shell mounted TWICE per
 * navigation and re-fired every effect in the ticker, the alerts and the search
 * both times. The shell lives in the route group's layout now, which persists
 * across navigations, so this is only what goes inside <main>.
 *
 * The blocks are sized to the real ones. A placeholder that does not match what
 * replaces it produces a jolt on arrival, and a jolt reads as slower than the
 * wait it was meant to hide.
 */
export function PageSkeleton({
  lines = 3,
  strip = 4,
}: {
  lines?: number;
  /**
   * How many figures the page opens with, or 0 for none.
   *
   * A fixed four matched the token page and nothing else, which is the jolt
   * this component exists to avoid: a placeholder that does not match what
   * replaces it reads as slower than the wait it was meant to hide.
   */
  strip?: number;
}) {
  return (
    <div className="mm-wrap" aria-busy="true" aria-live="polite">
      <span className="mm-sr">Loading</span>

      {/* The header block: a title and its subline. */}
      <div className="mm-skel-head">
        <i className="t" />
        <i className="s" />
      </div>

      {/* The figures this particular page opens with, when it opens with any. */}
      {strip > 0 && (
        <div className="mm-skel-strip">
          {Array.from({ length: strip }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      )}

      {/* Then a run of rows, whatever the page's list happens to be. */}
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="mm-skel">
          <i className="face" />
          <div>
            <i className="l" style={{ width: "42%" }} />
            <i className="l" style={{ width: "88%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
