import Link from "next/link";
import { LogoMark } from "@/components/Logo";

/**
 * The sticky top bar.
 *
 * It carries the brand only below 860, where the rail is gone and there would
 * otherwise be nothing on screen saying what this site is — which matters most
 * for exactly the visitor who arrived from a link somebody pasted in a chat.
 * Above 860 the rail already says it, so the mark is hidden rather than
 * repeated.
 */
export function PageHeader({
  title,
  sub,
  right,
}: {
  title: string;
  sub?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <header className="mm-header">
      <div className="mm-wrap mm-header-in">
        <Link href="/" className="mm-header-mark" aria-label="merrymen">
          <LogoMark size={20} />
        </Link>
        <div className="mm-header-txt">
          <h1>{title}</h1>
          {sub ? <p>{sub}</p> : null}
        </div>
        {right ? <div className="mm-header-right">{right}</div> : null}
      </div>
    </header>
  );
}
