/**
 * Take the password and, if it is right, set the cookie that opens the door.
 *
 * A POST rather than a link with a query string: a password in a URL is in the
 * browser's history, in the referer of every outbound request, and in whatever
 * logs sit in front of this service. The cookie is httpOnly so no script on the
 * page can read it back out.
 *
 * EVERY REDIRECT HERE IS RELATIVE, and that is not a style choice. This service
 * is started with `next start -H 0.0.0.0`, so inside a route handler `req.url`
 * is the INTERNAL listen address — building a redirect from it sent the visitor
 * to https://0.0.0.0:8080/, which is a dead host. Caught by asking the deployed
 * site for it.
 *
 * The obvious repair is to reconstruct the public origin from x-forwarded-host,
 * and that is worse: the header is attacker-supplied, so a redirect built from
 * it is an open redirect wearing a helmet. HTTP has allowed a relative Location
 * since forever and every browser resolves it against the address the visitor
 * actually used, which is the one thing here nobody can forge.
 */
import { NextResponse } from "next/server";
import { GATE_COOKIE, gatePassword, sameSecret } from "@/lib/site-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A month. Long enough that nobody is typing it twice a day. */
const MAX_AGE = 60 * 60 * 24 * 30;

/** 303, so the browser follows with GET and a refresh cannot re-post. */
const seeOther = (path: string) =>
  new NextResponse(null, { status: 303, headers: { Location: path } });

export async function POST(req: Request) {
  const expected = gatePassword();
  // No password configured means no gate; nothing to open, and refusing here
  // would strand a deployment whose owner had just turned it off.
  if (!expected) return seeOther("/");

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
    return seeOther("/gate?again=1");
  }

  const res = seeOther("/");
  res.cookies.set(GATE_COOKIE, expected, {
    httpOnly: true,
    sameSite: "lax",
    // Behind Railway's proxy the inbound request is plain http, so deciding
    // this from the request would never set Secure on a site that is HTTPS to
    // every actual visitor. It follows the deployment instead.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
  return res;
}
