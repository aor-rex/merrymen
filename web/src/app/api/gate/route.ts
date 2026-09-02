/**
 * Take the password and, if it is right, set the cookie that opens the door.
 *
 * A POST rather than a link with a query string: a password in a URL is in the
 * browser's history, in the referer of every outbound request, and in whatever
 * logs sit in front of this service. The cookie is httpOnly so no script on the
 * page can read it back out.
 */
import { NextResponse } from "next/server";
import { GATE_COOKIE, gatePassword, sameSecret } from "@/lib/site-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A month. Long enough that nobody is typing it twice a day. */
const MAX_AGE = 60 * 60 * 24 * 30;

export async function POST(req: Request) {
  const expected = gatePassword();
  // No password configured means no gate; nothing to open, and refusing here
  // would strand a deployment whose owner had just turned it off.
  if (!expected) return NextResponse.redirect(new URL("/", req.url), 303);

  let given = "";
  try {
    const form = await req.formData();
    const v = form.get("password");
    given = typeof v === "string" ? v : "";
  } catch {
    /* an unreadable body is simply a wrong answer */
  }

  if (!sameSecret(given, expected)) {
    // The password is never echoed back into the URL, so a shoulder-surfer and
    // the server log see the same thing: that someone got it wrong.
    return NextResponse.redirect(new URL("/gate?again=1", req.url), 303);
  }

  const res = NextResponse.redirect(new URL("/", req.url), 303);
  res.cookies.set(GATE_COOKIE, expected, {
    httpOnly: true,
    sameSite: "lax",
    // Set on any https origin. Left off for plain http so a local check of the
    // gate does not silently fail to store the cookie.
    secure: new URL(req.url).protocol === "https:",
    path: "/",
    maxAge: MAX_AGE,
  });
  return res;
}
