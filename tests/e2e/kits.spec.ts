import { test, expect, type Page } from '@playwright/test';
import { collectErrors, partState, runSketch, serial } from './helpers.ts';

// The SmartGrip kits are added from the Parts list, as a user does, onto a project with one board.
async function projectWith(page: Page, boardType: string) {
  await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.waitForFunction(() => window.CatSim?.App?.project);
  await page.evaluate((type) => {
    const A = window.CatSim.App;
    A.load({ name: 'kits', code: 'void setup() {}\nvoid loop() { delay(100); }\n', components: [{ id: type === 'esp32c3' ? 'c3' : 'esp', type, x: 300, y: 200, props: type === 'esp32c3' ? { power: 'usb' } : {} }], wires: [] });
  }, boardType);
  await page.click('.tab[data-tab="partsPane"]');
}
const addKit = (page: Page, key: string) => page.click(`#paletteList .part[data-kit="${key}"]`);
const wires = (page: Page) => page.evaluate(() => window.CatSim.App.project.wires.map((w: { from: string; to: string }) => [w.from, w.to].sort().join(' — ')).sort());
const rpm = async (page: Page) => Math.abs((await partState(page, 'vibmotor'))[0].rpm);
/** The motor's supply is cut: the buzz stops within a moment. */
const stops = (page: Page) => expect.poll(() => rpm(page), { timeout: 3000 }).toBeLessThan(100);
const last = async (page: Page, name: string) => { const m = [...(await serial(page)).matchAll(new RegExp(`${name}:(-?\\d+)`, 'g'))]; return m.length ? +m[m.length - 1][1] : -1; };

let errors: string[] = [];
test.beforeEach(async ({ page }) => { errors = await collectErrors(page); });
test.afterEach(() => { expect(errors).toEqual([]); });

test('kit 1 alone: the three FSRs read on GPIO0, GPIO1 and GPIO3 of a USB-powered board', async ({ page }) => {
  await projectWith(page, 'esp32c3');
  await addKit(page, 'sg_sensors');
  expect(await page.evaluate(() => window.CatSim.App.project.components.length)).toBe(7);
  await runSketch(page, `void setup() { Serial.begin(115200); }
void loop() { Serial.print("a:"); Serial.print(analogRead(0)); Serial.print(" b:"); Serial.print(analogRead(1)); Serial.print(" c:"); Serial.println(analogRead(3)); delay(100); }`);
  await expect.poll(() => last(page, 'c'), { timeout: 5000 }).toBeGreaterThanOrEqual(0);
  for (const n of ['a', 'b', 'c']) expect(await last(page, n)).toBeLessThan(100);
  for (const [finger, name] of [['finger1', 'a'], ['finger2', 'b'], ['finger3', 'c']]) {
    await page.evaluate((f) => window.CatSim.App.sim.setPressed(f, true), finger);
    await expect.poll(() => last(page, name), { timeout: 5000 }).toBeGreaterThan(3000);
    await page.evaluate((f) => window.CatSim.App.sim.setPressed(f, false), finger);
    await expect.poll(() => last(page, name), { timeout: 5000 }).toBeLessThan(100);
  }
});

test('kit 2 alone: GPIO4–6 light the RGB LED, GPIO7 reads the CAL button, GPIO10 runs the motor', async ({ page }) => {
  await projectWith(page, 'esp32c3');
  await addKit(page, 'sg_outputs');
  await runSketch(page, `void setup() { Serial.begin(115200); pinMode(4, OUTPUT); pinMode(5, OUTPUT); pinMode(6, OUTPUT); pinMode(10, OUTPUT); pinMode(7, INPUT_PULLUP);
  digitalWrite(4, HIGH); digitalWrite(5, HIGH); digitalWrite(6, HIGH); }
void loop() { int b = digitalRead(7); Serial.print("btn:"); Serial.println(b);
  digitalWrite(4, b == LOW ? LOW : HIGH); digitalWrite(5, b == LOW ? HIGH : LOW); digitalWrite(10, b == LOW ? HIGH : LOW); delay(50); }`);
  // button up: green on, red off, motor still
  await expect.poll(() => last(page, 'btn'), { timeout: 5000 }).toBe(1);
  await expect.poll(async () => (await partState(page, 'rgb_led'))[0].g, { timeout: 5000 }).toBeGreaterThan(0.3);
  await expect.poll(async () => (await partState(page, 'rgb_led'))[0].r, { timeout: 5000 }).toBeLessThan(0.1); // red fades out after its flash at power-up
  expect(Math.abs((await partState(page, 'vibmotor'))[0].rpm)).toBeLessThan(100);
  // button down: red on, green off, motor spins
  await page.evaluate(() => window.CatSim.App.sim.setPressed('calBtn', true));
  await expect.poll(() => last(page, 'btn'), { timeout: 5000 }).toBe(0);
  await expect.poll(async () => (await partState(page, 'rgb_led'))[0].r, { timeout: 5000 }).toBeGreaterThan(0.3);
  await expect.poll(async () => (await partState(page, 'rgb_led'))[0].g, { timeout: 5000 }).toBeLessThan(0.1);
  await expect.poll(async () => Math.abs((await partState(page, 'vibmotor'))[0].rpm), { timeout: 5000 }).toBeGreaterThan(3000);
  await page.evaluate(() => window.CatSim.App.sim.setPressed('calBtn', false));
  await stops(page);
});

test('kit 3 alone: the battery powers the board through the charger, switch and regulator; the switch cuts it', async ({ page }) => {
  await projectWith(page, 'esp32c3');
  await addKit(page, 'sg_power');
  expect(await page.evaluate(() => window.CatSim.App.project.components.find((c: { id: string }) => c.id === 'c3').props.power)).toBe('pins');
  await runSketch(page, 'void setup() { Serial.begin(115200); Serial.println("boot"); }\nvoid loop() { delay(100); }');
  await expect.poll(() => serial(page), { timeout: 5000 }).toContain('boot');
  expect((await partState(page, 'esp32c3'))[0].off).toBe(false);
  await page.evaluate(() => { const A = window.CatSim.App; A.project.components.find((c: { id: string }) => c.id === 'onOff').props.on = false; A.sim.syncProject(); });
  await expect.poll(async () => (await partState(page, 'esp32c3'))[0].off, { timeout: 5000 }).toBe(true);
  await page.evaluate(() => { const A = window.CatSim.App; A.project.components.find((c: { id: string }) => c.id === 'onOff').props.on = true; A.sim.syncProject(); });
  await expect.poll(async () => (await partState(page, 'esp32c3'))[0].off, { timeout: 5000 }).toBe(false);
});

test('the three kits together are the SmartGrip example circuit, and its sketch runs on battery: press → red + buzz, CAL recalibrates', async ({ page }) => {
  await projectWith(page, 'esp32c3');
  for (const k of ['sg_power', 'sg_outputs', 'sg_sensors']) await addKit(page, k); // not the order they are listed in
  await expect(page.locator('#toast')).toContainText('SmartGrip is complete');
  const { code, exWires, exParts } = await page.evaluate(() => {
    const ex = window.CatSim.App.fromExample('glove');
    return { code: ex.code as string, exWires: ex.wires.map((w: { from: string; to: string }) => [w.from, w.to].sort().join(' — ')).sort(), exParts: ex.components.map((c: { id: string }) => c.id).sort() };
  });
  expect(await wires(page)).toEqual(exWires);
  expect(await page.evaluate(() => window.CatSim.App.project.components.map((c: { id: string }) => c.id).sort())).toEqual(exParts);

  await runSketch(page, code);
  await expect.poll(() => serial(page), { timeout: 5000 }).toContain('calibrated');
  expect((await partState(page, 'esp32c3'))[0].off).toBe(false);
  expect(Math.abs((await partState(page, 'vibmotor'))[0].rpm)).toBeLessThan(100);
  await page.evaluate(() => window.CatSim.App.sim.setPressed('finger3', true)); // a firm 10 N press
  await expect.poll(() => last(page, 'f3'), { timeout: 5000 }).toBeGreaterThan(3000);
  await expect.poll(async () => (await partState(page, 'rgb_led'))[0].r, { timeout: 5000 }).toBeGreaterThan(0.3);
  await expect.poll(async () => Math.abs((await partState(page, 'vibmotor'))[0].rpm), { timeout: 5000 }).toBeGreaterThan(3000);
  expect(await last(page, 'f1')).toBeLessThan(100);
  await page.evaluate(() => window.CatSim.App.sim.setPressed('finger3', false));
  await expect.poll(() => last(page, 'f3'), { timeout: 5000 }).toBeLessThan(100);
  await expect.poll(async () => (await partState(page, 'rgb_led'))[0].r, { timeout: 5000 }).toBeLessThan(0.1); // the LED goes dark again
  await stops(page);
  const before = ((await serial(page)).match(/calibrated/g) || []).length;
  await page.evaluate(() => window.CatSim.App.sim.setPressed('calBtn', true));
  await expect.poll(async () => ((await serial(page)).match(/calibrated/g) || []).length, { timeout: 5000 }).toBeGreaterThan(before);
  await page.evaluate(() => window.CatSim.App.sim.setPressed('calBtn', false));
});

test('kits added before the board wait for it: adding an ESP32-C3 wires them up', async ({ page }) => {
  await projectWith(page, 'esp32');
  await addKit(page, 'sg_sensors');
  await expect(page.locator('#toast')).toContainText('Add an ESP32-C3');
  expect((await wires(page)).some((w: string) => /esp:|c3:/.test(w))).toBe(false);
  await page.click('#paletteList .part[data-type="esp32c3"]');
  expect(await wires(page)).toContain('c3:IO1 — finger2:2');
  expect(await wires(page)).toHaveLength(12);
});

test('searching the Parts list finds the kits by name', async ({ page }) => {
  await projectWith(page, 'esp32c3');
  await page.fill('#paletteSearch', 'smartgrip');
  await expect(page.locator('#paletteList .part:visible')).toHaveCount(3);
  await page.fill('#paletteSearch', 'resistor');
  await expect(page.locator('#paletteList .part[data-kit]:visible')).toHaveCount(0);
});
