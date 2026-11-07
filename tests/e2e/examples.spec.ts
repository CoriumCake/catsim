import { expect, test } from '@playwright/test';
import { collectErrors, loadExample, partState, runSketch, serial, startSim } from './helpers.ts';

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = await collectErrors(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.waitForFunction(() => window.CatSim?.App?.project);
});
test.afterEach(() => { expect(errors).toEqual([]); });

test('blink toggles the LED', async ({ page }) => {
  await loadExample(page, 'blink'); await startSim(page);
  const seen = new Set<string>();
  await expect.poll(async () => { seen.add(JSON.stringify(await partState(page, 'led'))); return seen.size; }, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
});

test('button press lights the LED and release turns it off', async ({ page }) => {
  await loadExample(page, 'button'); await startSim(page);
  const id = await page.evaluate(() => window.CatSim.App.project.components.find((c: { type: string }) => c.type === 'button').id);
  await page.evaluate((i) => window.CatSim.App.sim.setPressed(i, true), id);
  await expect.poll(async () => (await partState(page, 'led'))[0].b).toBe(1);
  await page.evaluate((i) => window.CatSim.App.sim.setPressed(i, false), id);
  await expect.poll(async () => (await partState(page, 'led'))[0].b).toBe(0);
});

test('potentiometer dims the LED with PWM', async ({ page }) => {
  await loadExample(page, 'pot'); await startSim(page);
  await expect.poll(async () => (await partState(page, 'led'))[0].b).toBeGreaterThan(0);
  const b = (await partState(page, 'led'))[0].b;
  expect(b).toBeLessThan(1);
});

test('weather station writes to the LCD', async ({ page }) => {
  await loadExample(page, 'weather'); await startSim(page);
  await expect.poll(() => page.evaluate(() => window.CatSim.App.sim.lcd?.buf.map((r: string[]) => r.join('')).join('|') ?? ''), { timeout: 5000 }).toMatch(/Temp/);
});

test('MQTT: dashboard publish switches the LED', async ({ page }) => {
  await loadExample(page, 'mqtt'); await startSim(page);
  await expect.poll(() => page.evaluate(() => window.CatSim.App.sim.mqtt.connected), { timeout: 8000 }).toBe(true);
  await page.click('.tab[data-tab="iotPane"]');
  await page.fill('#mqttTopic', 'catsim/esp32/led');
  await page.fill('#mqttPayload', 'ON');
  await page.locator('#mqttForm').evaluate((f: HTMLFormElement) => f.requestSubmit());
  await expect.poll(async () => (await partState(page, 'led')).some((s: { b: number }) => s.b === 1)).toBe(true);
});

test('alarm: PIR motion makes the buzzer sound', async ({ page }) => {
  await loadExample(page, 'alarm'); await startSim(page);
  await page.evaluate(() => { const A = window.CatSim.App; A.project.components.find((x: { type: string }) => x.type === 'pir').props.motion = true; A.sim.syncProject(); });
  await expect.poll(async () => (await partState(page, 'buzzer')).some((s: { f: number }) => s.f > 0)).toBe(true);
});

test('serial input reaches the sketch', async ({ page }) => {
  await runSketch(page, `void setup() { Serial.begin(9600); }
void loop() {
  if (Serial.available()) { String s = Serial.readStringUntil('\\n'); Serial.println("got:" + s); }
  delay(10);
}`);
  await page.waitForFunction(() => window.CatSim.App.sim.running);
  await page.fill('#serialInput', 'hello');
  await page.press('#serialInput', 'Enter');
  await expect.poll(() => serial(page)).toContain('got:hello');
});

test('runtime errors link to the right line', async ({ page }) => {
  await runSketch(page, 'void setup() {\n  Serial.begin(9600);\n  notAFunction();\n}\nvoid loop() {}');
  await expect(page.locator('#consoleOut')).toContainText('line 3');
});

test('pause freezes the simulation clock and resume continues it', async ({ page }) => {
  await runSketch(page, 'void setup() {}\nvoid loop() { Serial.print("x"); delay(20); }');
  await page.waitForFunction(() => window.CatSim.App.sim.running);
  await page.waitForTimeout(200);
  await page.click('#btnPause');
  await page.waitForTimeout(150);
  const t1 = await page.locator('#simTime').textContent();
  const n1 = (await serial(page)).length;
  await page.waitForTimeout(400);
  expect(await page.locator('#simTime').textContent()).toBe(t1);
  expect((await serial(page)).length).toBeLessThanOrEqual(n1 + 1);
  await page.click('#btnPause');
  await expect.poll(async () => (await serial(page)).length).toBeGreaterThan(n1 + 2);
});

test('speed 10× runs simulated time faster than real time', async ({ page }) => {
  await page.selectOption('#simSpeed', '10');
  await runSketch(page, 'void setup() {}\nvoid loop() { delay(100); }');
  await page.waitForFunction(() => window.CatSim.App.sim.running);
  const real0 = Date.now(); const sim0 = await page.evaluate(() => window.CatSim.App.sim.millis());
  await page.waitForTimeout(500);
  const ratio = (await page.evaluate(() => window.CatSim.App.sim.millis()) - sim0) / (Date.now() - real0);
  expect(ratio).toBeGreaterThan(5);
});

test('stop during a long delay terminates the worker', async ({ page }) => {
  await runSketch(page, 'void setup() { delay(10000); }\nvoid loop() {}');
  await page.waitForFunction(() => window.CatSim.App.sim.running);
  await page.click('#btnRun');
  await expect.poll(() => page.evaluate(() => !window.CatSim.App.sim.running && !window.CatSim.App.sim.worker)).toBe(true);
});

test('share link round-trips a project', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await loadExample(page, 'weather');
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.click('#btnShare');
  // Share compresses the project asynchronously before writing to the clipboard.
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/#z=[A-Za-z0-9_-]+$/);
  const url = await page.evaluate(() => navigator.clipboard.readText());
  await page.goto(url);
  await page.waitForFunction(() => window.CatSim?.App?.project);
  expect(await page.evaluate(() => window.CatSim.App.project.name)).toContain('Weather');
});

test('3D view renders and a 3D button press works', async ({ page }) => {
  await loadExample(page, 'button');
  await page.click('#view3d');
  await page.locator('canvas.view3d').waitFor({ state: 'visible' });
  await startSim(page);
  await page.waitForTimeout(400);
  const pt = await page.evaluate(() => {
    const A = window.CatSim.App; const c = A.project.components.find((x: { type: string }) => x.type === 'button');
    return A.view3d.screenPoint(c.x + 22, 18, c.y + 22);
  });
  await page.mouse.move(pt.x, pt.y); await page.mouse.down();
  await expect.poll(async () => (await partState(page, 'led'))[0].b).toBe(1);
  await page.mouse.up();
  await expect.poll(async () => (await partState(page, 'led'))[0].b).toBe(0);
  expect(await page.locator('canvas.view3d').count()).toBe(1);
});

test('Ctrl+Enter in the editor starts the simulation (once)', async ({ page }) => {
  await loadExample(page, 'blink');
  await page.click('.cm-content');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.CatSim.App.sim.running)).toBe(true);
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.CatSim.App.sim.running)).toBe(false);
});
