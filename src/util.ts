/** Escape text for use inside HTML/SVG markup and double-quoted attributes. */
export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

/** "220 Ω", "4.7 kΩ", "1 MΩ" */
export const fmtOhms = (o: number): string => (o >= 1e6 ? `${+(o / 1e6).toFixed(1)} MΩ` : o >= 1e3 ? `${+(o / 1e3).toFixed(1)} kΩ` : `${Math.round(o)} Ω`);
