import { redirect } from "next/navigation";

/** Renamed to /leaderboard. The old URL has been shared; keep it working. */
export default function ScoreboardRedirect() {
  redirect("/leaderboard");
}
