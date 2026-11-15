/* Kits: groups of parts that wire themselves to an ESP32-C3 and to each other. Whatever the order they are
 * added in, the three SmartGrip kits must end up as the same circuit the example loads. */
import { describe, expect, it } from 'vitest';
import { KITS, addKit, kitCircuit, kitPresent, linkKits } from '../../src/kits.js';
import { DEFS } from '../../src/components.js';
import { normalizeProject } from '../../src/project.ts';

type Wire = { id?: string; from: string; to: string; color?: string };
type Project = { components: Array<{ id: string; type: string; x: number; y: number; props: Record<string, unknown> }>; wires: Wire[] };
const board = (id = 'c3') => ({ id, type: 'esp32c3', x: 0, y: 0, props: { power: 'usb' } });
const wireSet = (ws: Wire[]) => ws.map((w) => [w.from, w.to].sort().join(' — ')).sort();
const whole = kitCircuit(0, 0);
const keys = KITS.map((k) => k.key);
const orders = keys.flatMap((a) => keys.filter((b) => b !== a).map((b) => [a, b, keys.find((c) => c !== a && c !== b)!]));

describe('kits', () => {
  it('every kit part is a real part and every kit wire ends on a real pin', () => {
    for (const k of KITS) for (const p of k.parts) expect(DEFS[p.type], `${k.key}: ${p.type}`).toBeTruthy();
    const loaded = normalizeProject({ name: 'x', code: '', components: structuredClone(whole.components), wires: whole.wires.map((w: Wire, i: number) => ({ id: 'w' + i, ...w })) }, DEFS);
    expect(loaded.components).toHaveLength(whole.components.length);
    expect(loaded.wires).toHaveLength(whole.wires.length); // a wire to a pin that doesn't exist is dropped on load
    expect(new Set(whole.components.map((c: { id: string }) => c.id)).size).toBe(whole.components.length);
  });

  it.each(orders)('added in the order %s, %s, %s they make the whole circuit', (...order) => {
    const p: Project = { components: [board()], wires: [] };
    for (const k of order) addKit(p, k, { x: 0, y: 0 });
    expect(wireSet(p.wires)).toEqual(wireSet(whole.wires));
    expect(p.components.map((c) => c.id).sort()).toEqual(whole.components.map((c: { id: string }) => c.id).sort());
    expect(p.components[0].props.power).toBe('pins'); // fed by the regulator, not by USB
    expect(new Set(p.wires.map((w) => w.id)).size).toBe(p.wires.length);
  });

  it('a kit on its own is wired to the board; the board stays on USB until the power kit arrives', () => {
    const p: Project = { components: [board('myboard')], wires: [] };
    const r = addKit(p, 'sg_sensors', { x: 0, y: 0 });
    expect(r).toMatchObject({ parts: 6, wires: 12, board: 'myboard' });
    expect(wireSet(p.wires)).toContain('finger2:2 — myboard:IO1');
    expect(p.components[0].props.power).toBe('usb');
  });

  it('with no ESP32-C3 the kits wire only among themselves, and finish when the board is added', () => {
    const p: Project = { components: [{ id: 'esp', type: 'esp32', x: 0, y: 0, props: {} }], wires: [] };
    for (const k of keys) expect(addKit(p, k, { x: 100, y: 100 }).board).toBeNull();
    expect(p.wires.every((w) => !/^(esp|c3):/.test(w.from) && !/^(esp|c3):/.test(w.to))).toBe(true);
    expect(p.wires.length).toBeGreaterThan(0);
    p.components.push(board());
    linkKits(p);
    expect(wireSet(p.wires)).toEqual(wireSet(whole.wires));
  });

  it('adding a kit twice changes nothing; deleted parts and wires come back', () => {
    const p: Project = { components: [board()], wires: [] };
    addKit(p, 'sg_outputs', { x: 0, y: 0 });
    const before = structuredClone(p);
    expect(addKit(p, 'sg_outputs', { x: 0, y: 0 })).toMatchObject({ parts: 0, wires: 0 });
    expect(p).toEqual(before);
    p.components = p.components.filter((c) => c.id !== 'vib'); p.wires = p.wires.filter((w) => !/vib:/.test(w.from + w.to));
    expect(kitPresent(p, 'sg_outputs')).toBe(KITS[1].parts.length - 1);
    addKit(p, 'sg_outputs', { x: 0, y: 0 });
    expect(wireSet(p.wires)).toEqual(wireSet(before.wires));
  });

  it('a part of the user\'s own with a kit id is left alone', () => {
    const p: Project = { components: [board(), { id: 'vib', type: 'led', x: 5, y: 5, props: { color: 'red' } }], wires: [] };
    addKit(p, 'sg_outputs', { x: 0, y: 0 });
    expect(p.components.filter((c) => c.id === 'vib')).toEqual([{ id: 'vib', type: 'led', x: 5, y: 5, props: { color: 'red' } }]);
    expect(p.wires.some((w) => /vib:/.test(w.from + w.to))).toBe(false);
  });
});
