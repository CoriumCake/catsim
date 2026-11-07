/** Escape text for use inside HTML/SVG markup and double-quoted attributes. */
export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
