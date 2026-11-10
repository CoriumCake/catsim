/* CatSim — where a part's pins are once it is turned. A part turns about the middle of its footprint,
 * clockwise on screen, in quarter turns (component.rot: 0, 90, 180 or 270 degrees; absent means 0).
 * Every place that needs a pin's position or direction goes through here, so the diagram, the wires,
 * the breadboard holes and the 3D view agree. */
import type { Component, PartDef, PinDef, PinDir } from './types.ts';

export const ROTATIONS = [0, 90, 180, 270];

/** Pins leave a part clockwise: right, bottom, left, top. */
const TURN: PinDir[] = ['r', 'b', 'l', 't'];

/** Footprint of a part at a given turn (a quarter turn swaps width and height). */
export function footprint(d: PartDef, rot = 0): { w: number; h: number } {
  return rot % 180 ? { w: d.h, h: d.w } : { w: d.w, h: d.h };
}

/** Where a pin sits in the diagram, and the way its wire leaves, for a part placed at c. */
export function pinPlacement(d: PartDef, c: Component, p: PinDef): { x: number; y: number; dir: PinDir } {
  const rot = c.rot || 0, k = (((rot / 90) % 4) + 4) % 4;
  const [cos, sin] = [[1, 0], [0, 1], [-1, 0], [0, -1]][k];
  const cx = d.w / 2, cy = d.h / 2, dx = p.x - cx, dy = p.y - cy;
  return {
    x: c.x + cx + dx * cos - dy * sin,
    y: c.y + cy + dx * sin + dy * cos,
    dir: TURN[(TURN.indexOf(p.dir) + k) % 4],
  };
}

/** SVG transform that puts a part's drawing (its body, pins and label) at its place and turn. */
export function placeTransform(d: PartDef, c: Component): string {
  return `translate(${c.x} ${c.y})${c.rot ? ` rotate(${c.rot} ${d.w / 2} ${d.h / 2})` : ''}`;
}
