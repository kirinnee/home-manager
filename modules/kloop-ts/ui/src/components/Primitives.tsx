// Tiny shadcn-style primitives — hand-rolled, no CLI. The brief calls for
// shadcn/ui components + Tailwind; we import the same primitives vibe but
// keep them in-tree to avoid the shadcn CLI's interactive scaffold.

import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/utils';

// ---------- Button ----------
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'outline' | 'danger';
  size?: 'sm' | 'md';
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'outline', size = 'md', ...rest },
  ref,
) {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors';
  const sz = size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]';
  const v =
    variant === 'primary'
      ? 'bg-accent text-accent-fg border border-accent hover:opacity-90'
      : variant === 'danger'
        ? 'bg-surface text-err border border-err-border hover:bg-err-bg'
        : variant === 'ghost'
          ? 'bg-transparent text-fg-soft hover:bg-surface-2'
          : 'bg-surface text-fg-soft border border-border hover:border-accent-border hover:text-accent';
  return <button ref={ref} className={cn(base, sz, v, className)} {...rest} />;
});

// ---------- Badge ----------
interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'ok' | 'warn' | 'err' | 'pend' | 'accent';
}
export function Badge({ className, tone = 'pend', ...rest }: BadgeProps) {
  const map: Record<string, string> = {
    ok: 'bg-ok-bg text-ok border-ok-border',
    warn: 'bg-warn-bg text-warn border-warn-border',
    err: 'bg-err-bg text-err border-err-border',
    pend: 'bg-pend-bg text-pend border-pend-border',
    accent: 'bg-accent-soft text-accent border-accent-border',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded border',
        map[tone],
        className,
      )}
      {...rest}
    />
  );
}

// ---------- Card ----------
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-md border border-border bg-surface shadow-sm', className)} {...rest} />;
}

// ---------- Textarea (compose-friendly) ----------
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'w-full resize-y rounded-md border border-border bg-surface text-fg placeholder:text-muted focus:outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)]',
        className,
      )}
      {...rest}
    />
  );
});

// ---------- ButtonGroup helper for header actions ----------
export function ActionGroup({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-wrap items-center gap-1.5', className)} {...rest} />;
}
