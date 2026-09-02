import { PageSkeleton } from "@/components/shell/PageSkeleton";

/**
 * Streamed on the click, so the route paints before the server answers.
 * See PageSkeleton for why it renders the shell itself.
 */
export default function Loading() {
  return <PageSkeleton />;
}
