import { test, expect, type Page } from '@playwright/test';
import { collectErrors } from './helpers';

// Two parts on an empty board, the 3D view open. Positions are diagram px.
async function setupBoard(page: Page) {
  await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.waitForFunction(() => window.CatSim?.App?.project);
  await page.evaluate(() => {
    const A = window.CatSim.App;
    A.project.components = [
      { id: 'esp32', type: 'esp32', x: 300, y: 80, props: {} },
      { id: 'led1', type: 'led', x: 520, y: 200, props: { color: 'red' } },
      { id: 'r1', type: 'resistor', x: 620, y: 300, props: { ohms: 220 } },
    ];
    A.project.wires = []; A.changed(); A.canvas.fit();
  });
  await page.click('#view3d');
  await page.locator('canvas.view3d').waitFor({ state: 'visible' });
  await page.waitForFunction(() => window.CatSim.App.view3d.active && !window.CatSim.App.view3d.dirty);
}

/** Screen position of a point on a 3D part (diagram x, height, diagram y). */
const screenAt = (page: Page, x: number, h: number, y: number) =>
  page.evaluate(([px, ph, py]) => window.CatSim.App.view3d.screenPoint(px, ph, py), [x, h, y]);
/** Screen position of a pin's top, in the 3D view. */
const pinAt = (page: Page, ref: string) =>
  page.evaluate((r) => {
    const V = window.CatSim.App.view3d, at = window.CatSim.App.canvas.pinPos(r);
    const q = V.pinTop(at); return V.screenPoint(q.x, q.y, q.z);
  }, ref);

test('3D: click one pin, then another, to wire two parts', async ({ page }) => {
  const errors = await collectErrors(page);
  await setupBoard(page);
  const a = await pinAt(page, 'led1:A'), k = await pinAt(page, 'r1:1');
  await page.mouse.click(a.x, a.y);
  await expect.poll(() => page.evaluate(() => window.CatSim.App.canvas.wireStart)).toBe('led1:A');
  await page.mouse.click(k.x, k.y);
  await expect.poll(() => page.evaluate(() => window.CatSim.App.project.wires.map((w: { from: string; to: string }) => [w.from, w.to]))).toEqual([['led1:A', 'r1:1']]);
  expect(errors).toEqual([]);
});

test('3D: drag a part along the board, without the camera orbiting', async ({ page }) => {
  const errors = await collectErrors(page);
  await setupBoard(page);
  const grab = await screenAt(page, 535, 12, 228);
  const cam = await page.evaluate(() => window.CatSim.App.view3d.camera.position.toArray());
  await page.mouse.move(grab.x, grab.y); await page.mouse.down();
  await page.mouse.move(grab.x + 30, grab.y + 10, { steps: 6 }); await page.mouse.move(grab.x + 60, grab.y + 20, { steps: 6 });
  await page.mouse.up();
  const after = await page.evaluate(() => { const c = window.CatSim.App.project.components.find((x: { id: string }) => x.id === 'led1'); return { x: c.x, y: c.y, sel: window.CatSim.App.canvas.sel }; });
  expect(after.x).not.toBe(520); expect(after.x % 5).toBe(0); expect(after.y % 5).toBe(0);
  expect(after.sel).toEqual({ kind: 'comp', id: 'led1' });
  expect(await page.evaluate(() => window.CatSim.App.view3d.camera.position.toArray())).toEqual(cam);
  expect(errors).toEqual([]);
});

test('3D: R turns the selected part', async ({ page }) => {
  await setupBoard(page);
  const p = await screenAt(page, 535, 12, 228);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => page.evaluate(() => window.CatSim.App.canvas.sel?.id)).toBe('led1');
  await page.keyboard.press('r');
  await expect.poll(() => page.evaluate(() => window.CatSim.App.project.components.find((x: { id: string }) => x.id === 'led1').rot)).toBe(90);
});

test('3D: a part added from the palette lands where the camera looks', async ({ page }) => {
  await setupBoard(page);
  const id = await page.evaluate(() => {
    const A = window.CatSim.App; const t = A.view3d.controls.target;
    A.addComponent('led');
    const c = A.project.components[A.project.components.length - 1];
    return { dx: Math.abs(c.x - t.x), dy: Math.abs(c.y - t.z), id: c.id };
  });
  expect(id.dx).toBeLessThan(120); expect(id.dy).toBeLessThan(120);
});

test('3D: wires follow a part while it is dragged, not only after it is dropped', async ({ page }) => {
  await setupBoard(page);
  await page.evaluate(() => { const A = window.CatSim.App; A.project.wires = [{ id: 'w1', from: 'led1:A', to: 'r1:1' }]; A.changed(); });
  await page.waitForFunction(() => window.CatSim.App.view3d.active && !window.CatSim.App.view3d.dirty);
  const grab = await screenAt(page, 535, 12, 228);
  await page.mouse.move(grab.x, grab.y); await page.mouse.down();
  await page.mouse.move(grab.x + 60, grab.y + 40, { steps: 8 });
  await page.waitForTimeout(150); // a few frames, mouse still down
  const gap = await page.evaluate(() => {
    const V = window.CatSim.App.view3d;
    const target = V.root.children.find((o: { userData: { pinRef?: string } }) => o.userData.pinRef === 'led1:A');
    const q = V.pinTop(window.CatSim.App.canvas.pinPos('led1:A'));
    return { moved: V.drag?.moved === true, d: Math.hypot(target.position.x - q.x, target.position.z - q.z) };
  });
  await page.mouse.up();
  expect(gap.moved).toBe(true);
  expect(gap.d).toBeLessThan(0.5);
});
