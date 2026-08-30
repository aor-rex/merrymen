import { NextResponse } from "next/server";
import { resolveLogo, safeHost } from "@/lib/coin-image";

/**
 * A launched token's logo, fetched server-side and streamed back.
 *
 * THIS PROXY IS NOT A CONVENIENCE. ipfs.io, dweb.link and nftstorage.link all
 * return HTTP 403 to a real browser User-Agent — 0 of 25 images loaded in two
 * independent runs — while returning 100% at 200–300ms to a server. A card
 * with `<img src="https://ipfs.io/ipfs/…">` is an empty square on every phone,
 * and it would have looked like a styling problem rather than a blocked
 * request.
 *
 * It also fixes three things a hotlink cannot:
 *   - the payload. p90 is 454KB and the largest sampled logo is 1.49MB, which
 *     is absurd for a 44px square on a phone;
 *   - the host list. Logos point at fifteen different domains, so hotlinking
 *     hands an attacker-chosen URL straight to the reader's browser;
 *   - caching. A logo never changes, so one fetch serves every viewer forever.
 *
 * WHAT IT WILL NOT FETCH lives in lib/coin-image.ts, where it can be tested:
 * nothing that is not https after resolution, and no private or loopback host,
 * so this cannot be turned into a probe of the deploy's own network. Here it
 * additionally caps the response size, caps the time, and returns only bodies
 * the origin itself labelled `image/*`.
 */

export const revalidate = 86_400;

/** A logo is a square on a phone. Anything past this is somebody's mistake. */
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 6_000;

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("uri");
  if (!raw) return new NextResponse("missing uri", { status: 400 });

  for (const candidate of resolveLogo(raw).slice(0, 3)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || !safeHost(url)) continue;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
      if (!res.ok) continue;
      const type = res.headers.get("content-type") ?? "";
      // Only images. A gateway that answers a CID with HTML — an error page, or
      // anything else — must not be streamed back as though it were a logo.
      if (!type.startsWith("image/")) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) continue;
      return new NextResponse(buf, {
        headers: {
          "Content-Type": type,
          // A logo never changes, so this is cacheable for as long as anyone
          // will keep it. Immutable because the URI IS the identity.
          "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
        },
      });
    } catch {
      /* try the next gateway */
    } finally {
      clearTimeout(timer);
    }
  }
  // 404 rather than a placeholder image: the card can decide what an absent
  // logo looks like, and a served placeholder would cache as though it were one.
  return new NextResponse("no image", { status: 404 });
}
