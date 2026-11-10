import { expect, test } from '@playwright/test';
import { collectErrors, loadExample, partState, startSim } from './helpers.ts';

// A phone: 390 px wide, touch screen.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = await collectErrors(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.waitForFunction(() => window.CatSim?.App?.project);
});
test.afterEach(() => { expect(errors).toEqual([]); });

test('nothing is wider than the phone screen', async ({ page }) => {
  await loadExample(page, 'glove');
  await page.waitForTimeout(300);
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: window.innerWidth }));
  expect(widths.page).toBeLessThanOrEqual(widths.screen);
});

test('the Start button is on screen and runs the sketch', async ({ page }) => {
  await loadExample(page, 'blink');
  const b = await page.locator('#btnRun').boundingBox();
  expect(b).not.toBeNull();
  expect(b!.x).toBeGreaterThanOrEqual(0);
  expect(b!.x + b!.width).toBeLessThanOrEqual(390);
  await page.locator('#btnRun').tap();
  await expect.poll(() => page.evaluate(() => window.CatSim.App.sim.running), { timeout: 5000 }).toBe(true);
});

test('two fingers pinch to zoom the diagram in and out', async ({ page }) => {
  await loadExample(page, 'blink');
  await page.waitForTimeout(500); // the diagram fits itself to the screen just after loading
  const k = () => page.evaluate(() => window.CatSim.App.canvas.view.k);
  const pinch = (from: number, to: number) => page.evaluate(([f, t]) => {
    const svg = document.querySelector('#canvas') as SVGSVGElement; const r = svg.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const send = (type: string, id: number, dist: number) => svg.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: id, clientX: cx - dist / 2, clientY: cy, bubbles: true, isPrimary: id === 1, button: 0 }));
    const sendB = (type: string, dist: number) => svg.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 2, clientX: cx + dist / 2, clientY: cy, bubbles: true, button: 0 }));
    send('pointerdown', 1, f); sendB('pointerdown', f);
    for (let i = 1; i <= 10; i++) { const d = f + ((t - f) * i) / 10; send('pointermove', 1, d); sendB('pointermove', d); }
    window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 1, clientX: cx - t / 2, clientY: cy }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 2, clientX: cx + t / 2, clientY: cy }));
  }, [from, to] as const);
  const before = await k();
  await pinch(100, 200);
  const zoomedIn = await k();
  expect(zoomedIn).toBeGreaterThan(before * 1.5);
  await pinch(200, 60);
  expect(await k()).toBeLessThan(zoomedIn);
});

test('the 3D view opens on a phone', async ({ page }) => {
  await loadExample(page, 'glove');
  await page.locator('#view3d').tap();
  await expect(page.locator('canvas.view3d')).toBeVisible({ timeout: 15000 });
  await page.locator('#view2d').tap();
});

test('a battery-powered glove runs on a phone', async ({ page }) => {
  await loadExample(page, 'glove'); await startSim(page);
  await expect.poll(() => page.evaluate(() => document.querySelector('#serialOut')?.textContent ?? ''), { timeout: 5000 }).toContain('calibrated');
  expect((await partState(page, 'esp32c3'))[0].off).toBe(false);
});

test('the hamburger opens the sidebar at the top of the screen, without scrolling to the bottom', async ({ page }) => {
  await loadExample(page, 'blink');
  await expect(page.locator('#workspace .side')).toBeHidden();
  await page.locator('#btnSide').tap();
  const side = page.locator('#workspace .side');
  await expect(side).toBeVisible();
  const b = await side.boundingBox();
  expect(b!.y).toBeGreaterThanOrEqual(0);
  expect(b!.y + b!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator('#paletteList .part[data-type="led"]')).toBeVisible(); // Parts is what opens first
  await page.locator('#btnSide').tap(); // and the hamburger closes it again
  await expect(side).toBeHidden();
});

test('tapping a part in the Parts list adds it and brings the diagram into view', async ({ page }) => {
  await loadExample(page, 'blink');
  await page.locator('#btnSide').tap();
  await page.locator('.tabs .tab', { hasText: 'Parts' }).first().tap();
  const n0 = await page.evaluate(() => window.CatSim.App.project.components.length);
  await page.locator('#paletteList .part[data-type="led"]').tap();
  expect(await page.evaluate(() => window.CatSim.App.project.components.length)).toBe(n0 + 1);
  await expect(page.locator('#toast')).toContainText('Added LED');
  await expect(page.locator('#workspace .side')).toBeHidden(); // the sheet closes
  // the diagram (where the new part landed) is on screen, not scrolled away
  await expect.poll(async () => {
    const b = await page.locator('#stage').boundingBox();
    return b ? b.y < 400 && b.y + b.height > 100 : false;
  }, { timeout: 3000 }).toBe(true);
});

test('the sheet opens at half the screen; drag its handle up to fill the screen and down to collapse it', async ({ page }) => {
  await loadExample(page, 'blink');
  await page.locator('#btnSide').tap();
  const side = page.locator('#side'), handle = page.locator('#sheetHandle');
  await expect(side).toBeVisible();
  const h0 = (await side.boundingBox())!.height;
  expect(h0).toBeGreaterThan(844 * 0.45); expect(h0).toBeLessThan(844 * 0.55);
  const hb = (await handle.boundingBox())!;
  const drag = async (dy: number) => {
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + dy / 2, { steps: 5 });
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + dy, { steps: 5 });
    await page.mouse.up();
  };
  await drag(-400); // up
  const h1 = (await side.boundingBox())!.height;
  expect(h1).toBeGreaterThan(844 * 0.75); // fills the screen below the top bar, so the hamburger stays reachable
  const hb2 = (await handle.boundingBox())!;
  await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2); await page.mouse.down();
  await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2 + 600, { steps: 10 });
  await page.mouse.up(); // down, well past the bottom
  await expect(side).toBeHidden();
  await page.locator('#btnSide').tap();
  await expect(side).toBeVisible();
  expect(Math.round((await side.boundingBox())!.height)).toBeGreaterThan(844 * 0.45);
});

test('the run controls fit on one row at the top of a phone screen', async ({ page }) => {
  await loadExample(page, 'blink');
  const ids = ['#btnRun', '#btnRestart', '#btnPause', '#simSpeed', '#addPart', '#view3d'];
  const boxes = await Promise.all(ids.map((id) => page.locator(id).boundingBox()));
  const mid = boxes.map((b) => b!.y + b!.height / 2);
  expect(Math.max(...mid) - Math.min(...mid)).toBeLessThanOrEqual(4); // one row (the 2D/3D pair is a few px taller)
  for (const b of boxes) { expect(b!.x).toBeGreaterThanOrEqual(0); expect(b!.x + b!.width).toBeLessThanOrEqual(390); }
  await expect(page.locator('#simTime')).toBeHidden();
});
