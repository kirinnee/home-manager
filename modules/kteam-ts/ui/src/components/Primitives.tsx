// TIER 1 — item 4. COMPLETE REPLACEMENT for `ui/src/components/Primitives.tsx`.
//
// Tiny shadcn-style primitives — hand-rolled, no CLI.
//
// EVERY silhouette now comes from a structural class in index.css, which reads
// role tokens from themes.css. That is the whole point of this file: `Button`
// used to hardcode `h-7 px-2.5 text-xs rounded-md` and `border-accent-border`,
// which meant a theme could recolour it but never reshape it. Now Neo gets a
// 32px square block with a 4px offset shadow that depresses when pressed,
// Mission gets a 26px notched mono-caps control, Ember gets a 30px roomy
// rounded one and High Contrast gets a 34px permanently-outlined one — and this
// file does not know which, because it never branches on theme.
//
// `data-variant` / `data-tone` carry ROLE + STATE only. There is no theme
// conditional anywhere in this file, and there must never be one.
//
// Because Button/Badge/Card/Textarea are used by ~20 components, changing these
// four propagates the new design language across most of the app for free.

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
  return (
    <button
      ref={ref}
      // `outline` is the default and needs no data-variant: `.kt-btn`'s own
      // resting style IS the outline variant.
      data-variant={variant === 'outline' ? undefined : variant}
      className={cn('kt-btn', size === 'sm' && 'kt-btn--sm', className)}
      {...rest}
    />
  );
});

// ---------- Badge ----------
interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'ok' | 'warn' | 'err' | 'pend' | 'accent';
}
export function Badge({ className, tone = 'pend', ...rest }: BadgeProps) {
  // The tone→colour map moved into `.kt-badge[data-tone=…]` so that Ember can
  // make badges pills and Neo can make them hard-edged blocks without this
  // component growing a geometry opinion.
  return <span data-tone={tone} className={cn('kt-badge', className)} {...rest} />;
}

// ---------- Card ----------
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  // NOT `.kt-panel--clipped`: clipping is opt-in per contract R1, because a
  // clipped panel also clips descendant popovers and focus rings.
  return <div className={cn('kt-panel', className)} {...rest} />;
}

/** Panel header row — the divider treatment is themed (hairline in Mission, 2px
 *  in Neo/Contrast, a paper seam in Ember). */
export function PanelHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('kt-panel__header', className)} {...rest} />;
}

/** Panel body — owns the themed padding, which is 10px in Studio and 16px in
 *  Ember. Density is a design statement, not a preference. */
export function PanelBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('kt-panel__body', className)} {...rest} />;
}

// ---------- Textarea (compose-friendly) ----------
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  // `.kt-input` sizes its text from `--text-input`, which themes.css composes as
  // max(theme value, --input-font-floor). On a phone that can never resolve
  // below 16px, so iOS never focus-zooms and the viewport meta does not need
  // `maximum-scale` (which would have broken pinch-zoom, WCAG 1.4.4).
  //
  // No `focus:outline-none` here: nero's audit found that pattern made the
  // translucent ring the ONLY focus indicator, measured 1.5-2.9:1 in all ten
  // themes. `:focus-visible` in index.css draws the real tokenised ring.
  return <textarea ref={ref} className={cn('kt-input', 'resize-y', className)} {...rest} />;
});

/** A shared "quiet label" for table headers, group headings and section titles.
 *  Ember resolves this to small caps; Mission to 0.14em mono caps; Neo to 800
 *  caps — none of which this component knows about. */
export function Label({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('kt-label', className)} {...rest} />;
}

// ---------- ButtonGroup helper for header actions ----------
export function ActionGroup({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-wrap items-center gap-sm', className)} {...rest} />;
}
