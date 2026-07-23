import { Link } from '../lib/router';
import { ThemeToggle } from './ThemeToggle';

export interface Crumb {
  label: string;
  to?: string;
}

export function AppBar({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-[var(--bar-bg)] backdrop-blur">
      <div className="mx-auto flex max-w-[1180px] items-center justify-between px-4 py-2.5">
        <nav className="flex items-center gap-1.5 text-sm">
          <Link to="/" className="font-semibold tracking-tight text-fg hover:text-accent">
            kloop
          </Link>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5">
              <span className="text-faint">/</span>
              {c.to ? (
                <Link to={c.to} className="text-fg-soft hover:text-accent">
                  {c.label}
                </Link>
              ) : (
                <span className="text-fg-soft">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-1.5">
          <Link
            to="/config"
            className="rounded-md border border-border bg-surface px-2.5 py-1 text-[13px] text-fg-soft hover:border-accent-border hover:text-accent"
          >
            Config
          </Link>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
