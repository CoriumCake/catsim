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
