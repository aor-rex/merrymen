import { redirect } from "next/navigation";

/**
 * The console became one tab.
 *
 * /app is what every existing bookmark and the installed PWA point at, so it
 * keeps working and lands where the console's content now lives.
 */
export default function AppRedirect() {
  redirect("/you");
}
