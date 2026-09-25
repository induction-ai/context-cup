import { redirect } from "next/navigation";

/** For now, tau's board. This is where the aggregate leaderboard, across
 *  every benchmark, will go. */
export default function LeaderboardIndex() {
  redirect("/leaderboard/tau_banking");
}
