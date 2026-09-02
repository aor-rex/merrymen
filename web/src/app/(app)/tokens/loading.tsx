import { PageSkeleton } from "@/components/shell/PageSkeleton";

/**
 * The launchpad: cards, not a stat strip.
 *
 * Without a loading.tsx the App Router does two things, and the second is the
 * one that hurts: it renders the route with no Suspense boundary, so a click
 * produces no pixels until the server answers — and it REFUSES TO PREFETCH the
 * route at all, because there is no boundary to prefetch up to.
 */
export default function Loading() {
  return <PageSkeleton lines={4} strip={0} />;
}
