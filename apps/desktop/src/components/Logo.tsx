/* The OpenFusion mark: two thin rings — the frontier engine and the open
 * models — intersecting; their shared lens is the only filled shape, in
 * accent. The mark diagrams the product (two model worlds, one shared
 * working surface), so it earns its place instead of decorating it.
 *
 * Inline SVG on purpose: the strict local-only CSP rules out asset CDNs,
 * and drawing on currentColor + var(--accent) means the mark re-inks
 * itself for dark mode with no second asset.
 *
 * Geometry: rings r=5.6 centered at x=7.6 / x=12.4 (d=4.8), so the lens
 * runs between the intersection points (10, 10±√(5.6²−2.4²)) = (10, 10±5.06).
 */
export function FusionMark({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
      <path d="M10 4.94A5.6 5.6 0 0 1 10 15.06 5.6 5.6 0 0 1 10 4.94Z" fill="var(--accent)" />
      <circle cx="7.6" cy="10" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12.4" cy="10" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
