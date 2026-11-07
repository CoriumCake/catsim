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
  await expect.poll(async () => (await partState(page, 'led'))[0].b).toBeGreaterThan(0.3); // real LED current, not just on/off
  await page.evaluate((i) => window.CatSim.App.sim.setPressed(i, false), id);
  await expect.poll(async () => (await partState(page, 'led'))[0].b).toBeLessThan(0.05);
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
  await expect.poll(async () => (await partState(page, 'led')).some((s: { b: number }) => s.b > 0.3)).toBe(true);
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
  await expect.poll(async () => (await partState(page, 'led'))[0].b).toBeGreaterThan(0.3); // real LED current, not just on/off
  await page.mouse.up();
  await expect.poll(async () => (await partState(page, 'led'))[0].b).toBeLessThan(0.05);
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

test('scope shows the PWM square wave and the LED forward voltage', async ({ page }) => {
  await loadExample(page, 'pot');
  await page.click('.tab[data-tab="scopePane"]');
  const pick = async (ch: number, re: RegExp) => {
    const v = await page.locator(`select[data-ch="${ch}"] option`).evaluateAll((os, src) => (os as HTMLOptionElement[]).find((o) => new RegExp(src).test(o.textContent || ''))?.value, re.source);
    await page.selectOption(`select[data-ch="${ch}"]`, v!);
  };
  await pick(0, /^D25/);
  await pick(1, /led1\.A/);
  await startSim(page);
  await expect(page.locator('.scope-meas')).toContainText('kHz', { timeout: 5000 });
  const meas = await page.locator('.scope-meas').innerText();
  expect(meas).toMatch(/CH1 max 3\.\d+ V · min 0\.00 V/);
  const f = +(meas.match(/CH1 .*?(\d+\.\d+) kHz/)?.[1] ?? 0); // measured from crossings in the window
  expect(f).toBeGreaterThan(4.95); expect(f).toBeLessThan(5.05);
  const vf = +(meas.match(/CH2 max (\d\.\d+) V/)?.[1] ?? 0);
  expect(vf).toBeGreaterThan(1.8); expect(vf).toBeLessThan(2.05); // red LED forward voltage
});

test('NPN transistor switches a blue LED from 5 V', async ({ page }) => {
  await loadExample(page, 'transistor'); await startSim(page);
  await expect.poll(async () => (await partState(page, 'led'))[0].b, { timeout: 3000 }).toBeGreaterThan(0.8);
  await expect.poll(async () => (await partState(page, 'npn'))[0].on).toBe(1);
  await expect.poll(async () => (await partState(page, 'led'))[0].b, { timeout: 3000 }).toBeLessThan(0.05);
});

test('op-amp night light reacts to the light level', async ({ page }) => {
  await loadExample(page, 'nightlight'); await startSim(page);
  await expect.poll(async () => (await partState(page, 'led'))[0].b, { timeout: 3000 }).toBeGreaterThan(0.5);
  await page.evaluate(() => { const A = window.CatSim.App; A.project.components.find((x: { id: string }) => x.id === 'ldr1').props.light = 0.95; A.sim.syncProject(); });
  await expect.poll(async () => (await partState(page, 'led'))[0].b, { timeout: 3000 }).toBeLessThan(0.05);
});

test('an LED without a resistor burns out and the console explains why', async ({ page }) => {
  errors.length = 0;
  await loadExample(page, 'noresistor'); await startSim(page);
  await expect.poll(async () => (await partState(page, 'led')).map((s: { burnt?: boolean }) => !!s.burnt), { timeout: 4000 }).toEqual([true, false]);
  await expect(page.locator('#consoleOut')).toContainText('led1 burned out');
  await expect(page.locator('.cs-comp[data-id="led1"]')).toContainText('burnt');
});

test('74HC595 walks a light across 8 LEDs', async ({ page }) => {
  await loadExample(page, 'shiftreg'); await startSim(page);
  // the brightest LED moves along the row (neighbours may still be fading out)
  const brightest = async () => {
    const b = (await partState(page, 'led')).map((s: { b: number }) => s.b);
    return b.indexOf(Math.max(...b));
  };
  const seen = new Set<number>();
  await expect.poll(async () => { seen.add(await brightest()); return seen.size; }, { timeout: 10_000 }).toBeGreaterThanOrEqual(4);
});

test('555 timer blinks at the frequency its R and C set', async ({ page }) => {
  await loadExample(page, 'timer555'); await startSim(page);
  await expect.poll(() => serial(page), { timeout: 8000 }).toMatch(/period \d+ ms/);
  const ms = [...(await serial(page)).matchAll(/period (\d+) ms/g)].map((m) => +m[1]);
  const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
  const expected = 1000 / (1.44 / ((10_000 + 2 * 47_000) * 10e-6)); // ≈ 722 ms
  expect(Math.abs(avg - expected) / expected).toBeLessThan(0.05);
});

test('Arduino Uno runs real compiled firmware (Blink)', async ({ page }) => {
  await loadExample(page, 'uno-blink');
  await expect(page.locator('#boardSelect')).toHaveValue('uno');
  await expect(page.locator('#btnFirmware')).toBeVisible();
  await startSim(page);
  await expect.poll(() => serial(page), { timeout: 5000 }).toMatch(/Uno blink started\s+tick\s+tock/);
  await expect.poll(async () => (await partState(page, 'led'))[0].b, { timeout: 3000 }).toBeGreaterThan(0.5);
});

test('switch to the Uno, upload a .hex and run it', async ({ page }) => {
  await page.selectOption('#boardSelect', 'uno');
  await expect(page.locator('#unoBanner')).toContainText('Upload .hex');
  await page.click('#btnRun');
  await expect(page.locator('#consoleOut')).toContainText('runs compiled firmware'); // no firmware yet
  const hex = (await import('node:fs')).readFileSync(new URL('../../src/firmware/uno-blink.hex', import.meta.url), 'utf8');
  await page.locator('#firmwareFile').setInputFiles({ name: 'blink.hex', mimeType: 'text/plain', buffer: Buffer.from(hex) });
  await expect(page.locator('#unoBanner')).toContainText('blink.hex');
  await startSim(page);
  await expect.poll(() => serial(page), { timeout: 5000 }).toContain('tick');
  // corrupted firmware is refused with a line number
  await page.click('#btnRun');
  await page.locator('#firmwareFile').setInputFiles({ name: 'bad.hex', mimeType: 'text/plain', buffer: Buffer.from(hex.replace(/^(:10.{36})../m, '$1FF')) });
  await expect(page.locator('#consoleOut')).toContainText('bad checksum');
});

test('Uno Fade shows ~490 Hz hardware PWM on the scope', async ({ page }) => {
  await loadExample(page, 'uno-fade');
  await page.click('.tab[data-tab="scopePane"]');
  const v = await page.locator('select[data-ch="0"] option').evaluateAll((os) => (os as HTMLOptionElement[]).find((o) => /^D9/.test(o.textContent || ''))?.value);
  await page.selectOption('select[data-ch="0"]', v!);
  await page.selectOption('select[data-ctl="tdiv"]', '0.001');
  await startSim(page);
  await expect(page.locator('.scope-meas')).toContainText('Hz', { timeout: 5000 });
  const f = +((await page.locator('.scope-meas').innerText()).match(/(\d+\.\d) Hz/)?.[1] ?? 0);
  expect(f).toBeGreaterThan(480); expect(f).toBeLessThan(500);
});

test('DC motor spins up under PWM through a MOSFET', async ({ page }) => {
  await loadExample(page, 'motor'); await startSim(page);
  await expect.poll(() => page.evaluate(() => window.CatSim.App.sim.analog?.mech?.motors?.mot1?.[0] ?? 0), { timeout: 8000 }).toBeGreaterThan(500);
  await expect(page.locator('#consoleOut')).not.toContainText('spike'); // the flyback diode is fitted
});

test('relay alternates its NO and NC contacts', async ({ page }) => {
  await loadExample(page, 'relay'); await startSim(page);
  const state = () => page.evaluate(() => { const a = window.CatSim.App.sim.analog; return a ? `${a.mech.relays.k1}${a.leds.led1 > 0.3 ? 'G' : ''}${a.leds.led2 > 0.3 ? 'R' : ''}` : ''; });
  // sample fast: the relay flips every second, so default 1 s poll intervals can alias onto one phase
  await expect.poll(state, { timeout: 6000, intervals: [100] }).toBe('1G');
  await expect.poll(state, { timeout: 6000, intervals: [100] }).toBe('0R');
});

test('a pasted SPICE model is validated and applied from the part panel', async ({ page }) => {
  await loadExample(page, 'motor');
  await page.evaluate(() => window.CatSim.App.canvas.select({ kind: 'comp', id: 'd1' }));
  await page.locator('#props details.spice summary').click();
  await page.fill('[data-spice="spice"]', '.model BAD D(IS=oops)');
  await page.click('[data-spice-apply="spice"]');
  await expect(page.locator('[data-spice-status="spice"]')).toContainText('Not valid: line 1: bad value for IS');
  await page.fill('[data-spice="spice"]', '* datasheet model\n.model MYD D(IS=2.5n N=1.75 RS=0.5)');
  await page.click('[data-spice-apply="spice"]');
  await expect(page.locator('[data-spice-status="spice"]')).toContainText('Found .model myd (D)');
  expect(await page.evaluate(() => window.CatSim.App.project.components.find((c: { id: string }) => c.id === 'd1').props.spice)).toContain('MYD');
});

test('the sidebar can be hidden with the hamburger button and comes back (remembered, Ctrl+B)', async ({ page }) => {
  await expect(page.locator('.topbar #btnRun')).toBeVisible(); // run controls live in the top bar
  await page.click('#btnSide');
  await expect(page.locator('#side')).toBeHidden();
  await expect(page.locator('#btnSide')).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await page.waitForFunction(() => window.CatSim?.App?.project);
  await expect(page.locator('#side')).toBeHidden();
  await page.keyboard.press('Control+b');
  await expect(page.locator('#side')).toBeVisible();
});
