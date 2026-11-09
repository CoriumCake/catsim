/* Parts plugged into a breadboard: a part's leg that sits on a hole (within half a hole pitch) is connected
 * to it, without a wire. Used by the logic nets, the analog circuit and the diagram. */
const R2 = 5 * 5; // capture radius² (half the 10-unit pitch)

/** [partPin, breadboardHole] pairs, e.g. ['led1:A', 'bb1:12c']. */
export function breadboardContacts(project, defs) {
  const boards = project.components.filter((c) => defs[c.type] && defs[c.type].type === 'breadboard');
  if (!boards.length) return [];
  const out = [];
  for (const bb of boards) {
    const db = defs[bb.type];
    for (const c of project.components) {
      const d = defs[c.type];
      if (!d || c === bb || d.board || d.type === 'breadboard') continue;
      if (c.x > bb.x + db.w || c.x + d.w < bb.x || c.y > bb.y + db.h || c.y + d.h < bb.y) continue; // not over it
      for (const p of d.pins) {
        const ax = c.x + p.x - bb.x, ay = c.y + p.y - bb.y;
        let best = null, bd = R2;
        for (const h of db.pins) { const dx = h.x - ax, dy = h.y - ay, q = dx * dx + dy * dy; if (q <= bd) { bd = q; best = h; } }
        if (best) out.push([`${c.id}:${p.id}`, `${bb.id}:${best.id}`]);
      }
    }
  }
  return out;
}

/** Where to move a part so that its legs land exactly on breadboard holes (null if it isn't over one). */
export function snapToBreadboard(project, defs, c) {
  const d = defs[c.type]; if (!d || d.board || d.type === 'breadboard' || !d.pins.length) return null;
  for (const bb of project.components) {
    const db = defs[bb.type]; if (!db || db.type !== 'breadboard') continue;
    for (const p of d.pins) {
      const ax = c.x + p.x - bb.x, ay = c.y + p.y - bb.y;
      let best = null, bd = 8 * 8;
      for (const h of db.pins) { const dx = h.x - ax, dy = h.y - ay, q = dx * dx + dy * dy; if (q <= bd) { bd = q; best = h; } }
      if (best) return { x: c.x + (best.x - ax), y: c.y + (best.y - ay) };
    }
  }
  return null;
}
