import { describe, expect, it } from 'vitest';
import { footprint, pinPlacement, placeTransform } from '../../src/rotation.ts';
import type { Component, PartDef } from '../../src/types.ts';

// A 40 × 20 part whose pin 'L' is on the left edge, and 'T' on the top edge, at the part's middle
const part = { type: 'x', name: 'x', category: 'x', w: 40, h: 20, pins: [
  { id: 'L', label: 'L', x: 0, y: 10, dir: 'l' },
  { id: 'T', label: 'T', x: 20, y: 0, dir: 't' },
], props: {} } as unknown as PartDef;
const at = (rot?: number): Component => ({ id: 'p', type: 'x', x: 100, y: 200, props: {}, ...(rot ? { rot } : {}) });

describe('turning a part', () => {
  it('leaves an upright part where it was drawn', () => {
    expect(pinPlacement(part, at(), part.pins[0])).toEqual({ x: 100, y: 210, dir: 'l' });
    expect(pinPlacement(part, at(), part.pins[1])).toEqual({ x: 120, y: 200, dir: 't' });
  });

  it('turns clockwise on screen: the left pin goes to the top, its wire leaving upward', () => {
    const p = pinPlacement(part, at(90), part.pins[0]);
    expect(p.x).toBeCloseTo(120, 9); expect(p.y).toBeCloseTo(190, 9); expect(p.dir).toBe('t');
  });

  it('a half turn puts the left pin on the right, and a full turn is the identity', () => {
    const p = pinPlacement(part, at(180), part.pins[0]);
    expect(p.x).toBeCloseTo(140, 9); expect(p.y).toBeCloseTo(210, 9); expect(p.dir).toBe('r');
    expect(pinPlacement(part, at(270), part.pins[0]).dir).toBe('b');
  });

  it('a quarter turn swaps the footprint, and the drawing gets the same turn about the middle', () => {
    expect(footprint(part, 90)).toEqual({ w: 20, h: 40 });
    expect(footprint(part, 180)).toEqual({ w: 40, h: 20 });
    expect(placeTransform(part, at(90))).toBe('translate(100 200) rotate(90 20 10)');
    expect(placeTransform(part, at())).toBe('translate(100 200)');
  });
});
