type BrandMarkProps = {
  className?: string;
  title?: string;
};

/**
 * The ASCEND "A" mark — a stylized ascending glyph: long left ramp rising to
 * a rounded apex, flat top, stepped right foot. Solid silhouette, no counter.
 * Drawn in currentColor so it inherits text color (white on the dark UI).
 *
 * The same path is mirrored in src/app/icon.svg for the favicon; keep them
 * in sync if the geometry changes.
 */
export function BrandMark({ className, title = "ASCEND" }: BrandMarkProps) {
  return (
    <svg
      viewBox="0 0 420 240"
      className={className}
      fill="currentColor"
      role="img"
      aria-label={title}
    >
      <path d="M6 234 L211 17.6 Q222 6 238 6 L326 6 L326 130 L406 130 L406 234 Z" />
    </svg>
  );
}
