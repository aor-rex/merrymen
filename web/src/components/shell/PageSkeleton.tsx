import { AppShell } from "@/components/shell/AppShell";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/shell.css";
import "@/styles/feed.css";

/**
 * WHAT A NAVIGATION LOOKS LIKE BEFORE THE SERVER ANSWERS.
 *
 * Both rebuilt pages are force-dynamic, and there was no loading boundary
 * anywhere under app/ — so clicking a link did nothing at all until the server
 * came back. Measured on the dev server that is 120-490ms typically and several
 * seconds on a spike, and for the whole of it the previous page just sat there.
 * The router had rendered, the shell had not changed, and the product felt
 * broken rather than busy.
 *
 * A loading.tsx turns the route into a Suspense boundary, so the new page's
 * frame paints on the click and the content streams into it.
 *
 * IT RENDERS THE SHELL ITSELF, and that is not optional. AppShell is mounted by
 * each PAGE rather than by the layout, so a skeleton without it would blank the
 * rail, the tape and the tab bar for the duration — swapping a slow paint for a
 * flickering one, which is worse.
 *
 * The skeleton's blocks are sized to the real thing. A placeholder that does not
 * match what replaces it produces a jolt on arrival, and a jolt reads as slower
 * than the wait it was meant to hide.
 */
export function PageSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <AppShell>
      <div className="mm-wrap" aria-busy="true" aria-live="polite">
        <span className="mm-sr">Loading</span>

        {/* The header block: a title and its subline. */}
        <div className="mm-skel-head">
          <i className="t" />
          <i className="s" />
        </div>

        {/* Four figures, the shape both rebuilt pages open with. */}
        <div className="mm-skel-strip">
          {[0, 1, 2, 3].map((i) => (
            <i key={i} />
          ))}
        </div>

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
    </AppShell>
  );
}
