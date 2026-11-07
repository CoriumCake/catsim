import { describe, expect, it } from 'vitest';
import { DEFS, PALETTE } from '../../src/components.js';

// components.js is plain JS, so enforce the PartDef schema (src/types.ts) here.
describe('part definitions', () => {
  for (const [key, d] of Object.entries(DEFS)) {
    describe(key, () => {
      it('has the required fields', () => {
        expect(d.type).toBe(key);
        expect(typeof d.name).toBe('string');
        expect(d.w).toBeGreaterThan(0);
        expect(d.h).toBeGreaterThan(0);
        expect(typeof d.render).toBe('function');
      });
      it('has unique pins with valid directions', () => {
        const ids = d.pins.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const p of d.pins) {
          expect(typeof p.id).toBe('string');
          expect(['l', 'r', 't', 'b']).toContain(p.dir);
          expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(d.w);
          expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(d.h);
        }
      });
      it('only controls props that exist, with valid defaults', () => {
        for (const ct of d.controls || []) {
          expect(Object.keys(d.props)).toContain(ct.key);
          const v = d.props[ct.key];
          if (ct.type === 'range') { expect(v).toBeGreaterThanOrEqual(ct.min); expect(v).toBeLessThanOrEqual(ct.max); }
          if (ct.type === 'select') expect(ct.options.map(String)).toContain(String(v));
          if (ct.type === 'toggle') expect(typeof v).toBe('boolean');
        }
      });
      it('renders without a running simulator', () => {
        const c = { id: 'x', type: key, x: 0, y: 0, props: { ...d.props } };
        expect(typeof d.render(c, {})).toBe('string');
      });
    });
  }
  it('lists every non-board part in the palette', () => {
    const listed = PALETTE.flatMap((g) => g.types);
    for (const [key, d] of Object.entries(DEFS)) if (!d.fixed) expect(listed).toContain(key);
  });
});
