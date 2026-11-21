import { describe, expect, it } from 'vitest';
import { normalizeProject, encodeShare, decodeShare } from '../../src/project.ts';
import { partsList, inoFile } from '../../src/build-real.ts';
import { DEFS } from '../../src/components.js';
import { EXAMPLES } from '../../src/examples.js';

const X = '"><img src=x onerror=alert(1)>';
const base = { name: 'p', code: 'void setup(){}\nvoid loop(){}' };

describe('normalizeProject (untrusted input)', () => {
  it('keeps every example intact', () => {
    for (const ex of EXAMPLES) {
      const p = { name: ex.name, code: ex.code, components: ex.components, wires: ex.wires.map((w, i) => ({ id: 'w' + (i + 1), ...w })) };
      const n = normalizeProject(structuredClone(p), DEFS);
      expect(n.components.length).toBe(p.components.length);
      expect(n.wires.length).toBe(p.wires.length);
      // every property must survive validation (an unlisted resistor value would silently become 220 Ω)
      for (const c of p.components) {
        const got = n.components.find((x) => x.id === c.id)!;
        for (const [k, v] of Object.entries(c.props)) expect([ex.key, c.id, k, got.props[k]]).toEqual([ex.key, c.id, k, v]);
      }
    }
  });

  it('drops components with unsafe or duplicate ids and unknown types', () => {
    const n = normalizeProject({ ...base, components: [
      { id: 'esp', type: 'esp32', x: 0, y: 0 }, { id: X, type: 'led' }, { id: 'a', type: 'led' }, { id: 'a', type: 'led' },
      { id: 'b', type: 'nope' }, { id: 'c', type: 'toString' }, { id: 'd', type: '__proto__' },
    ] }, DEFS);
    expect(n.components.map((c) => c.id)).toEqual(['esp', 'a']);
  });

  it('coerces props by control type', () => {
    const n = normalizeProject({ ...base, components: [
      { id: 'p', type: 'pot', props: { value: X } }, { id: 'q', type: 'pot', props: { value: 7 } },
      { id: 'l', type: 'led', props: { color: X } }, { id: 'm', type: 'led', props: { color: 'blue' } },
      { id: 'r', type: 'resistor', props: { ohms: '4700' } }, { id: 'v', type: 'pir', props: { motion: 'yes', extra: X } },
    ] }, DEFS);
    const props = Object.fromEntries(n.components.map((c) => [c.id, c.props]));
    expect(props.p).toEqual({ value: 0.5 });
    expect(props.q).toEqual({ value: 1 });
    expect(props.l).toEqual({ color: 'red' });
    expect(props.m).toEqual({ color: 'blue' });
    expect(props.r).toEqual({ ohms: 4700 });
    expect(props.v).toEqual({ motion: false });
  });

  it('coerces positions to integers', () => {
    const n = normalizeProject({ ...base, components: [{ id: 'a', type: 'led', x: X, y: '12.6' }] }, DEFS);
    expect(n.components.find((c) => c.id === 'a')).toMatchObject({ x: 0, y: 13 });
  });

  it('validates wires against real pins, including GND.L, V+ and +', () => {
    const n = normalizeProject({ ...base, components: [
      { id: 'esp', type: 'esp32' }, { id: 's', type: 'servo' }, { id: 'bz', type: 'buzzer' },
    ], wires: [
      { id: X, from: 'esp:GND.L', to: 's:GND', color: X },
      { id: 'w2', from: 'esp:3V3', to: 's:V+', color: '#ff0000' },
      { id: 'w3', from: 'esp:D4', to: 'bz:+' },
      { id: 'w4', from: 'esp:D4', to: 'bz:nope' },
      { id: 'w5', from: 'esp:D4', to: 'esp:D4' },
      { id: 'w2', from: 'esp:D5', to: 'bz:-' },
    ] }, DEFS);
    expect(n.wires.map((w) => `${w.id} ${w.from} ${w.to} ${w.color ?? ''}`)).toEqual([
      'w1 esp:GND.L s:GND ', 'w2 esp:3V3 s:V+ #ff0000', 'w3 esp:D4 bz:+ ', 'w4 esp:D5 bz:- ',
    ]);
  });

  it('adds an ESP32 when missing and caps name/code length', () => {
    const n = normalizeProject({ name: 'x'.repeat(500), code: 7 }, DEFS);
    expect(n.components[0].type).toBe('esp32');
    expect(n.name.length).toBe(120);
    expect(n.code).toBe('');
  });

  it('treats non-objects as empty projects', () => {
    for (const v of [null, 42, 'str', [], undefined]) expect(normalizeProject(v, DEFS).components).toHaveLength(1);
  });
});

describe('several boards', () => {
  it('keeps every board and the programs of the extra ones; drops programs for unknown boards', () => {
    const n = normalizeProject({ code: 'first', components: [
      { id: 'esp', type: 'esp32' }, { id: 'esp2', type: 'esp32' }, { id: 'uno', type: 'uno' },
    ], programs: { esp2: { code: 'second' }, uno: { code: 'third' }, ghost: { code: 'x' }, esp: { code: 'ignored' } } }, DEFS);
    expect(n.components.map((c) => c.id)).toEqual(['esp', 'esp2', 'uno']);
    expect(n.code).toBe('first');
    expect(n.programs).toEqual({ esp2: { code: 'second' }, uno: { code: 'third' } });
  });
  it('keeps an Uno sketch', () => {
    const n = normalizeProject({ components: [{ id: 'esp', type: 'esp32' }, { id: 'uno', type: 'uno' }], programs: { uno: { code: 'void setup() {}\nvoid loop() {}' } } }, DEFS);
    expect(n.programs).toEqual({ uno: { code: 'void setup() {}\nvoid loop() {}' } });
  });
  it('drops compiled firmware from old projects (the Uno runs its sketch)', () => {
    const n = normalizeProject({ firmware: { name: 'a.hex', hex: ':00000001FF' }, components: [{ id: 'esp', type: 'esp32' }, { id: 'uno', type: 'uno' }], programs: { uno: { firmware: { name: 'x', hex: ':00000001FF' } } } }, DEFS);
    expect(n.programs).toEqual({ uno: {} });
  });
});

describe('share links', () => {
  const p = { name: 'Blink ⚡ ünïcode', code: 'void setup(){}\n'.repeat(200), components: [{ id: 'esp', type: 'esp32', x: 300, y: 80, props: {} }], wires: [] };

  it('round-trips through #z= and is compressed', async () => {
    const hash = await encodeShare(p);
    expect(hash).toMatch(/^#z=[A-Za-z0-9_-]+$/);
    expect(hash.length).toBeLessThan(JSON.stringify(p).length / 3);
    expect(await decodeShare(hash)).toEqual({ v: 1, ...p });
  });

  it('still reads legacy #p= links', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(p));
    const legacy = '#p=' + encodeURIComponent(btoa(String.fromCharCode(...bytes)));
    expect(await decodeShare(legacy)).toEqual(p);
  });

  it('rejects links from a newer version and garbage', async () => {
    const hash = await encodeShare(p);
    const newer = (await decodeShare(hash)) as Record<string, unknown>;
    expect(newer.v).toBe(1);
    await expect(decodeShare('#z=!!!')).resolves.toBeNull();
    await expect(decodeShare('#z=AAAA')).rejects.toThrow();
    expect(await decodeShare('#other')).toBeNull();
  });
});

describe('building it for real: the .ino export', () => {
  const blink = EXAMPLES.find((e) => e.key === 'blink')!;
  const project = { name: 'Blink', code: blink.code, components: blink.components, wires: blink.wires.map((w, i) => ({ id: 'w' + (i + 1), ...w })) };

  it('lists the parts to buy: board first, equal parts counted together, one jumper wire per wire', () => {
    expect(partsList(project, DEFS)).toEqual([
      { qty: 1, name: 'ESP32 DevKit V1' }, { qty: 1, name: 'Resistor, 220 Ω' }, { qty: 1, name: 'LED, green' }, { qty: 3, name: 'jumper wire' },
    ]);
    const three = { ...project, components: [...project.components,
      { id: 'r2', type: 'resistor', x: 0, y: 0, props: { ohms: 220 } }, { id: 'r3', type: 'resistor', x: 0, y: 0, props: { ohms: 10000 } }] };
    expect(partsList(three, DEFS).map((l) => `${l.qty} × ${l.name}`)).toEqual(['1 × ESP32 DevKit V1', '2 × Resistor, 220 Ω', '1 × LED, green', '1 × Resistor, 10 kΩ', '3 × jumper wire']);
  });
  it('every example gets a parts list that accounts for every part', () => {
    for (const ex of EXAMPLES) {
      const list = partsList({ name: ex.name, code: ex.code, components: ex.components, wires: ex.wires.map((w, i) => ({ id: 'w' + i, ...w })) }, DEFS);
      const parts = list.filter((l) => l.name !== 'jumper wire');
      expect([ex.key, parts.reduce((n, l) => n + l.qty, 0)]).toEqual([ex.key, ex.components.length]);
      for (const l of parts) expect(l.name).not.toMatch(/undefined|, $/);
    }
  });
  it('the sketch file carries the board, the parts, every wire (not only the board\'s) and then the code', () => {
    const ino = inoFile(project, 'esp', project.code, DEFS);
    expect(ino).toContain('// Board: ESP32 DevKit V1  (Tools → Board → ESP32 Dev Module)');
    expect(ino).toContain('// Parts to build it:\n//   1 × ESP32 DevKit V1\n//   1 × Resistor, 220 Ω\n//   1 × LED, green\n//   3 × jumper wire\n');
    expect(ino).toContain('//   r1:2  ->  led1:A\n'); // a wire between two parts, away from the board
    expect(ino.endsWith(project.code)).toBe(true);
    expect(ino.split('\n').filter((l) => l && !l.startsWith('//')).join('\n')).toBe(project.code.split('\n').filter((l) => l && !l.startsWith('//')).join('\n'));
  });
});
