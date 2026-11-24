import React from 'react';

type Props = {
  size?: number;
  className?: string;
  /** When set, the mark is announced to assistive tech with this label. */
  title?: string;
};

/**
 * RealtyDesk mark: a doorway inside a facade — the threshold a broker sells.
 * Drawn in three strokes so the boot screen can ink it in.
 */
export default function BrandMark({ size = 22, className = '', title }: Props) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="square"
      strokeLinejoin="miter"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d="M3.8 20.4V10.6a2.6 2.6 0 0 1 .95-2l6.45-5.35a1.25 1.25 0 0 1 1.6 0l6.45 5.35a2.6 2.6 0 0 1 .95 2v9.8" />
      <path d="M2.6 20.4h18.8" />
      <path d="M9.4 20.4v-4.3a2.6 2.6 0 0 1 5.2 0v4.3" />
    </svg>
  );
}
