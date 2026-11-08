import { describe, expect, it } from 'vitest';
import { RouteGrid, roundedPath, simplify, type Pt } from '../../src/router.ts';

const orthogonal = (pts: Pt[]) => pts.every((p, i) => i === 0 || p[0] === pts[i - 1][0] || p[1] === pts[i - 1][1]);
/** true if any segment passes through the inside of the rectangle */
const crosses = (pts: Pt[], r: { x: number; y: number; w: number; h: number }) => {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    for (let k = 0; k <= 20; k++) {
      const x = ax + ((bx - ax) * k) / 20, y = ay + ((by - ay) * k) / 20;
      if (x > r.x + 4 && x < r.x + r.w - 4 && y > r.y + 4 && y < r.y + r.h - 4) return true;
    }
  }
  return false;
};

describe('wire router', () => {
  it('routes at right angles around a part in the way', () => {
    const block = { x: 100, y: 0, w: 60, h: 100 };
    const g = new RouteGrid([block, { x: 0, y: 40, w: 20, h: 20 }, { x: 240, y: 40, w: 20, h: 20 }]);
    const pts = g.route({ x: 20, y: 50, dir: 'r' }, { x: 240, y: 50, dir: 'l' })!;
    expect(pts).not.toBeNull();
    expect(pts[0]).toEqual([20, 50]); expect(pts[pts.length - 1]).toEqual([240, 50]);
    expect(orthogonal(pts)).toBe(true);
    expect(crosses(pts, block)).toBe(false);
  });

  it('goes straight when nothing is in the way', () => {
    const g = new RouteGrid([{ x: 0, y: 40, w: 20, h: 20 }, { x: 200, y: 40, w: 20, h: 20 }]);
    expect(g.route({ x: 20, y: 50, dir: 'r' }, { x: 200, y: 50, dir: 'l' })).toEqual([[20, 50], [200, 50]]);
  });

  it('spreads parallel wires instead of stacking them', () => {
    const parts = [{ x: 0, y: 0, w: 20, h: 100 }, { x: 300, y: 0, w: 20, h: 100 }];
    const g = new RouteGrid(parts);
    const a = g.route({ x: 20, y: 40, dir: 'r' }, { x: 300, y: 60, dir: 'l' })!; g.occupy(a);
    const b = g.route({ x: 20, y: 60, dir: 'r' }, { x: 300, y: 40, dir: 'l' })!;
    const vertical = (pts: Pt[]) => pts.filter((p, i) => i > 0 && p[0] === pts[i - 1][0] && p[1] !== pts[i - 1][1]).map((p) => p[0]);
    expect(vertical(a)[0]).not.toBe(vertical(b)[0]); // their crossing legs use different tracks
  });

  it('simplifies collinear points and draws rounded corners', () => {
    expect(simplify([[0, 0], [10, 0], [20, 0], [20, 10], [20, 10]])).toEqual([[0, 0], [20, 0], [20, 10]]);
    expect(roundedPath([[0, 0], [20, 0], [20, 20]])).toMatch(/^M0 0 L14 0 Q20 0 20 6 L20 20$/);
  });
});
