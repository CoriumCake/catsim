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

test('Arduino Uno runs its Blink sketch', async ({ page }) => {
  await loadExample(page, 'uno-blink');
  expect(await page.evaluate(() => window.CatSim.App.boards().map((b: { type: string }) => b.type))).toEqual(['uno']);
  await expect(page.locator('#boardTabs')).toBeHidden(); // one board: no board tabs
  await startSim(page);
  await expect.poll(() => serial(page), { timeout: 5000 }).toMatch(/Uno blink started\s+tick\s+tock/);
  await expect.poll(async () => (await partState(page, 'led'))[0].b, { timeout: 3000 }).toBeGreaterThan(0.5);
});

test('add an Arduino Uno next to the ESP32 and run both', async ({ page }) => {
  await loadExample(page, 'blink');
  await page.click('#addPart'); // Parts tab
  await page.click('#paletteList .part[data-type="uno"]');
  await expect(page.locator('#boardTabs .board-tab.active')).toHaveText('uno · sketch');
  await startSim(page);
  await expect.poll(() => page.evaluate(() => window.CatSim.App.sim.boardState('uno')?.out?.[13] !== undefined), { timeout: 5000 }).toBe(true); // template blinks pin 13
  await page.click('#boardTabs [data-board="esp"]');
  await expect.poll(() => serial(page), { timeout: 5000 }).toContain('ESP32 blink started'); // the ESP32's terminal
});

test('an Arduino Uno runs the sketch typed in the editor', async ({ page }) => {
  await loadExample(page, 'uno-button');
  await startSim(page);
  await expect.poll(() => partState(page, 'led').then((s) => s[0].b)).toBeLessThan(0.05);
  await page.evaluate(() => window.CatSim.App.sim.setPressed('btn1', true));
  await expect.poll(() => serial(page), { timeout: 5000 }).toContain('pressed');
  await expect.poll(() => partState(page, 'led').then((s) => s[0].b)).toBeGreaterThan(0.5); // 5 V through 220 Ω
});

test('Uno Fade shows ~490 Hz PWM on the scope', async ({ page }) => {
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

test('the bottom panel folds away and comes back; unread terminal output is flagged', async ({ page }) => {
  const stageH = () => page.locator('#stage').evaluate((e) => e.getBoundingClientRect().height);
  const open = await stageH();
  await page.click('#btnDock');
  await expect(page.locator('#bottom')).toHaveClass(/collapsed/);
  expect(await stageH()).toBeGreaterThan(open + 100); // the canvas gets the space
  await loadExample(page, 'blink'); await startSim(page);
  await expect(page.locator('.tab[data-tab="serialPane"]')).toHaveClass(/unseen/);
  await page.click('.tab[data-tab="serialPane"]'); // reopens on that tab
  await expect(page.locator('#bottom')).not.toHaveClass(/collapsed/);
  await expect(page.locator('.tab[data-tab="serialPane"]')).not.toHaveClass(/unseen/);
  await page.click('.tab[data-tab="serialPane"]'); // clicking the open tab folds it again
  await expect(page.locator('#bottom')).toHaveClass(/collapsed/);
});

test('the edit card opens next to the selected part (a lone board only offers its power setting)', async ({ page }) => {
  await loadExample(page, 'pot');
  await page.waitForTimeout(300); // let the view settle after fitting
  for (const id of ['r1', 'pot1']) {
    await page.evaluate((i) => window.CatSim.App.canvas.select({ kind: 'comp', id: i }), id);
    await page.waitForTimeout(100);
    const part = await page.locator(`.cs-comp[data-id="${id}"] .cs-body`).boundingBox();
    const card = await page.locator('#props').boundingBox();
    expect(Math.abs((card!.x + card!.width / 2) - (part!.x + part!.width / 2))).toBeLessThan(40); // centred on it
    const gapAbove = part!.y - (card!.y + card!.height), gapBelow = card!.y - (part!.y + part!.height);
    expect(Math.max(gapAbove, gapBelow)).toBeGreaterThanOrEqual(0); // touching, never covering it
  }
  await page.evaluate(() => window.CatSim.App.canvas.select({ kind: 'comp', id: 'esp' }));
  await expect(page.locator('#props')).toContainText('Powered by');
  await expect(page.locator('#props [data-act="delete"]')).toHaveCount(0);
});

test('on a short canvas the edit card moves beside the part instead of covering it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await loadExample(page, 'button');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.CatSim.App.canvas.select({ kind: 'comp', id: 'btn1' }));
  await page.waitForTimeout(100);
  const part = (await page.locator('.cs-comp[data-id="btn1"] .cs-body').boundingBox())!;
  const card = (await page.locator('#props').boundingBox())!;
  const ox = Math.min(part.x + part.width, card.x + card.width) - Math.max(part.x, card.x);
  const oy = Math.min(part.y + part.height, card.y + card.height) - Math.max(part.y, card.y);
  expect(ox <= 0 || oy <= 0).toBe(true); // the button stays clickable
});

test('while running, the edit card shows only live inputs, and none for parts without them', async ({ page }) => {
  await loadExample(page, 'pot'); await startSim(page);
  await page.evaluate(() => window.CatSim.App.canvas.select({ kind: 'comp', id: 'r1' }));
  await expect(page.locator('#props')).toBeHidden(); // a resistor has nothing to change mid-run
  await page.evaluate(() => window.CatSim.App.canvas.select({ kind: 'comp', id: 'pot1' }));
  await expect(page.locator('#props input[data-key="value"]')).toBeVisible(); // the knob still turns
  await expect(page.locator('#props [data-act="delete"]')).toHaveCount(0);
  await page.click('#btnRun'); // stopping closes the card instead of reopening it in full
  await expect(page.locator('#props')).toBeHidden();
  await page.evaluate(() => window.CatSim.App.canvas.select({ kind: 'comp', id: 'pot1' }));
  await expect(page.locator('#props [data-act="delete"]')).toBeVisible(); // clicking it again shows the full card
});

test('Tidy wires routes every wire at right angles and is saved with the project', async ({ page }) => {
  await loadExample(page, 'relay');
  await page.click('#btnTidy');
  await expect(page.locator('#btnTidy')).toHaveAttribute('aria-pressed', 'true');
  const ds = await page.locator('.cs-wire-line').evaluateAll((ps) => ps.map((p) => p.getAttribute('d') || ''));
  expect(ds.length).toBe(14);
  expect(ds.every((d) => !/ C/.test(d))).toBe(true); // no Bezier curves left
  expect(await page.evaluate(() => window.CatSim.App.project.wireStyle)).toBe('tidy');
  await page.click('#btnTidy');
  expect(await page.evaluate(() => window.CatSim.App.project.wireStyle)).toBeUndefined();
});

test('two ESP32s: each runs its own sketch and they talk over a wire', async ({ page }) => {
  await loadExample(page, 'two-esp32');
  await expect(page.locator('#boardTabs .board-tab')).toHaveText(['esp · sketch', 'esp2 · sketch']);
  await startSim(page);
  await page.evaluate(() => window.CatSim.App.sim.setPressed('btn1', true));
  await expect.poll(async () => (await partState(page, 'led'))[0].b, { timeout: 4000 }).toBeGreaterThan(0.5);
  await expect.poll(() => serial(page)).toContain('sending HIGH'); // esp's terminal
  await page.click('#boardTabs [data-board="esp2"]');
  await expect.poll(() => serial(page)).toContain('received HIGH: LED on'); // esp2's own terminal
  expect(await page.evaluate(() => window.CatSim.App.editor.get())).toContain('Board "esp2"');
  await expect(page.locator('#consoleOut')).not.toContainText('floating');
});

test('add a second board from Parts, give it its own sketch, and delete it again', async ({ page }) => {
  await loadExample(page, 'blink');
  await page.click('#addPart');
  await page.click('#paletteList .part[data-type="esp32"]');
  await expect(page.locator('#boardTabs .board-tab')).toHaveText(['esp · sketch', 'esp2 · sketch']);
  await expect(page.locator('#boardTabs .board-tab.active')).toHaveText('esp2 · sketch');
  expect(await page.evaluate(() => window.CatSim.App.editor.get())).toContain('runs its own sketch');
  await page.click('#boardTabs [data-board="esp"]');
  expect(await page.evaluate(() => window.CatSim.App.editor.get())).toContain('Blink');
  // a lone board can't be deleted; one of two can
  await page.evaluate(() => window.CatSim.App.canvas.select({ kind: 'comp', id: 'esp2' }));
  await page.click('#props [data-act="delete"]');
  await expect(page.locator('#boardTabs')).toBeHidden();
  expect(await page.evaluate(() => window.CatSim.App.project.components.filter((c: { type: string }) => c.type === 'esp32').length)).toBe(1);
  await page.evaluate(() => window.CatSim.App.canvas.select({ kind: 'comp', id: 'esp' }));
  await expect(page.locator('#props [data-act="delete"]')).toHaveCount(0); // the last board can't be deleted
});

test('a buzzer is muted from its own card; the toolbar has no global sound button', async ({ page }) => {
  await loadExample(page, 'alarm');
  await expect(page.locator('#btnMute')).toHaveCount(0);
  const muted = () => page.evaluate(() => window.CatSim.App.project.components.find((x: { type: string }) => x.type === 'buzzer').props.muted);
  await page.evaluate(() => window.CatSim.App.canvas.select({ kind: 'comp', id: 'bz1' }));
  const box = page.locator('#props input[data-key="muted"]');
  await expect(box).not.toBeChecked();
  await box.check();
  expect(await muted()).toBe(true);
  await box.uncheck();
  expect(await muted()).toBe(false);
});

test('muting a buzzer stops its sound while the simulation keeps running', async ({ page }) => {
  await loadExample(page, 'alarm'); await startSim(page);
  await page.evaluate(() => { const A = window.CatSim.App; A.project.components.find((x: { type: string }) => x.type === 'pir').props.motion = true; A.sim.syncProject(); });
  const playing = () => page.evaluate(() => window.CatSim.Audio.osc.has('bz1'));
  // asserts on the oscillator, not audible output: headless Chrome may keep the AudioContext suspended
  test.skip(!(await page.evaluate(() => !!window.CatSim.Audio.ctx)), 'no Web Audio in this browser');
  await expect.poll(playing).toBe(true);
  await page.evaluate(() => window.CatSim.App.canvas.select({ kind: 'comp', id: 'bz1' }));
  await page.locator('#props input[data-key="muted"]').check();
  await expect.poll(playing).toBe(false);
  expect((await partState(page, 'buzzer')).some((st: { f: number }) => st.f > 0)).toBe(true); // still driven, just silent
  await page.locator('#props input[data-key="muted"]').uncheck();
  await expect.poll(playing).toBe(true);
});

// ---------- library parts ----------
/** Page coordinates of a point inside a part (its own 2D coordinates). */
const partPoint = (page: import('@playwright/test').Page, id: string, x: number, y: number) => page.evaluate(([i, px, py]) => {
  const g = document.querySelector(`.cs-comp[data-id="${i}"]`) as SVGGraphicsElement;
  const p = new DOMPoint(px as number, py as number).matrixTransform(g.getScreenCTM()!);
  return { x: p.x, y: p.y };
}, [id, x, y] as const);

test('keypad lock: clicking the keypad keys in the 2D view unlocks it', async ({ page }) => {
  await loadExample(page, 'keypad'); await startSim(page);
  await expect.poll(() => serial(page)).toContain('Enter the code');
  for (const [r, k] of [[0, 0], [0, 1], [0, 2], [1, 0], [3, 2]]) { // 1 2 3 4 #
    const p = await partPoint(page, 'keypad1', 9 + k * 33 + 15, 9 + r * 33 + 15);
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
  }
  await expect.poll(() => serial(page), { timeout: 5000 }).toContain('1234# unlocked');
  await expect.poll(async () => (await partState(page, 'servo'))[0].angle).toBe(90);
});

test('IR remote: clicking key 1 toggles the first LED and prints the NEC code', async ({ page }) => {
  await loadExample(page, 'irremote'); await startSim(page);
  const p = await partPoint(page, 'remote1', 8 + 10, 26 + 4 * 24 + 10); // key "1"
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
  await expect.poll(() => serial(page), { timeout: 5000 }).toContain('Command=0xC');
  await expect.poll(async () => (await partState(page, 'led'))[0].b).toBeGreaterThan(0.3);
});

test('library parts show live state: OLED pixels, LED ring colors, TM1637 digits, stepper angle', async ({ page }) => {
  await loadExample(page, 'oled'); await startSim(page);
  await expect.poll(() => page.evaluate(() => (document.querySelector('.cs-comp[data-id="oled1"] path[d^="M"]:not([stroke])')?.getAttribute('d') ?? '').length), { timeout: 5000 }).toBeGreaterThan(100);
  await loadExample(page, 'neopixel'); await startSim(page);
  await expect.poll(async () => ((await partState(page, 'ws2812_ring'))[0].rgb ?? []).filter((c: number) => c > 0).length, { timeout: 5000 }).toBe(16);
  await loadExample(page, 'clock'); await startSim(page);
  await expect.poll(async () => (await partState(page, 'tm1637'))[0].d?.segs.some((s: number) => s > 0), { timeout: 5000 }).toBe(true);
  await loadExample(page, 'stepper'); await startSim(page);
  await expect.poll(async () => (await partState(page, 'stepper'))[0].angle, { timeout: 5000 }).toBeGreaterThan(20);
});

test('Preferences survive Stop and Start (saved data is kept by the page)', async ({ page }) => {
  await loadExample(page, 'prefs'); await startSim(page);
  await expect.poll(() => serial(page)).toContain('Boot #1');
  await page.click('#btnRun'); await startSim(page);
  await expect.poll(() => serial(page), { timeout: 5000 }).toContain('Boot #2');
});

test('wiring problems pop up as alerts that point at the part', async ({ page }) => {
  await loadExample(page, 'blink');
  // turn the LED around
  await page.evaluate(() => { const A = window.CatSim.App; for (const w of A.project.wires) { w.from = w.from.replace('led1:A', 'led1:X').replace('led1:C', 'led1:A').replace('led1:X', 'led1:C'); w.to = w.to.replace('led1:A', 'led1:X').replace('led1:C', 'led1:A').replace('led1:X', 'led1:C'); } A.changed(); });
  await startSim(page);
  const alert = page.locator('#alerts .alert', { hasText: 'led1 is the wrong way round' });
  await expect(alert).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.cs-comp[data-id="led1"]')).toHaveClass(/cs-flag/);
  await alert.click();
  await expect(page.locator('#consolePane')).toHaveClass(/active/);
  await expect(page.locator('#consoleOut')).toContainText('wrong way round');
});

test('pressure glove: battery-powered ESP32-C3, FSR press turns the RGB LED red and buzzes; the plotter graphs the fingers', async ({ page }) => {
  await loadExample(page, 'glove'); await startSim(page);
  await expect.poll(() => serial(page), { timeout: 5000 }).toContain('calibrated');
  await page.evaluate(() => window.CatSim.App.sim.setPressed('f2', true)); // a firm 10 N press
  await expect.poll(async () => (await partState(page, 'rgb_led'))[0].r, { timeout: 5000 }).toBeGreaterThan(0.3);
  await expect.poll(async () => Math.abs((await partState(page, 'vibmotor'))[0].rpm), { timeout: 5000 }).toBeGreaterThan(3000);
  await page.click('.tab[data-tab="plotPane"]');
  await expect(page.locator('#plotLegend span')).toHaveCount(3);
  await expect(page.locator('#plotLegend')).toContainText('f2');
  await page.evaluate(() => window.CatSim.App.sim.setPressed('f2', false));
});

test('the ON/OFF slide switch cuts the battery: the board shows "no power" and restarts when switched on', async ({ page }) => {
  await loadExample(page, 'glove'); await startSim(page);
  await expect.poll(() => serial(page), { timeout: 5000 }).toContain('calibrated');
  const flip = async () => {
    const p = await page.evaluate(() => { const g = document.querySelector('.cs-comp[data-id="sw1"]') as SVGGraphicsElement; const r = g.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.click(p.x, p.y);
  };
  await flip();
  await expect.poll(async () => (await partState(page, 'esp32c3'))[0].off, { timeout: 5000 }).toBe(true);
  await flip();
  await expect.poll(async () => (await partState(page, 'esp32c3'))[0].off, { timeout: 5000 }).toBe(false);
  await expect.poll(async () => (await serial(page)).match(/calibrated/g)?.length ?? 0, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
});

test('every part in the Parts palette can be added, simulated and shown in 3D', async ({ page }) => {
  test.setTimeout(90_000);
  await loadExample(page, 'blink');
  await page.click('#addPart');
  const types = await page.locator('#paletteList .part').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.type!));
  const boards = await page.evaluate(() => Object.keys(window.CatSim.DEFS).filter((t) => window.CatSim.DEFS[t].board));
  for (const t of types) if (!boards.includes(t)) await page.click(`#paletteList .part[data-type="${t}"]`);
  const placed = await page.evaluate(() => window.CatSim.App.project.components.map((c: { type: string }) => c.type));
  for (const t of types.filter((x) => !boards.includes(x))) expect(placed, t).toContain(t);
  await startSim(page);
  await expect.poll(() => serial(page), { timeout: 5000 }).toContain('ESP32 blink started');
  await page.click('#view3d'); await page.locator('canvas.view3d').waitFor({ state: 'visible' });
  await page.waitForTimeout(1500);
  await page.click('#view2d');
});

test('a part dropped onto the breadboard snaps into the holes and works without wires to its legs', async ({ page }) => {
  await loadExample(page, 'breadboard');
  // drag the LED off the board: the circuit breaks
  const moveBy = async (id: string, dx: number, dy: number) => {
    const b = (await page.locator(`.cs-comp[data-id="${id}"] .cs-body`).boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + 6); await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx / 2, b.y + 6 + dy / 2, { steps: 4 }); await page.mouse.move(b.x + b.width / 2 + dx, b.y + 6 + dy, { steps: 4 }); await page.mouse.up();
  };
  const ledPos = () => page.evaluate(() => { const c = window.CatSim.App.project.components.find((x: { id: string }) => x.id === 'led1'); return [c.x, c.y]; });
  const [x0, y0] = await ledPos();
  const k = await page.evaluate(() => window.CatSim.App.canvas.view.k);
  await moveBy('led1', 0, -160 * k);
  await startSim(page);
  await page.waitForTimeout(1200);
  expect(Math.max(...(await Promise.all([0, 1, 2, 3].map(async () => { await page.waitForTimeout(150); return (await partState(page, 'led'))[0].b; }))))).toBeLessThan(0.05);
  await page.click('#btnRun');
  // put it back, slightly off: it snaps to the same holes and the LED blinks again
  await moveBy('led1', 3 * k, 163 * k);
  expect(await ledPos()).toEqual([x0, y0]);
  await startSim(page);
  await expect.poll(async () => (await partState(page, 'led'))[0].b, { timeout: 5000 }).toBeGreaterThan(0.3);
});

test('the sketch downloads as an .ino for the Arduino IDE, with the board and wiring noted', async ({ page }) => {
  await loadExample(page, 'glove');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnIno')]);
  expect(dl.suggestedFilename()).toMatch(/\.ino$/);
  const text = (await (await import('node:fs/promises')).readFile((await dl.path())!, 'utf8'));
  expect(text).toContain('Board: ESP32-C3 Super Mini');
  expect(text).toContain('c3:IO0');
  expect(text).toContain('void setup()');
});

test('the parallel 16×2 LCD shows the sketch text in the app', async ({ page }) => {
  await loadExample(page, 'uno-lcd'); await startSim(page);
  await expect(page.locator('.cs-comp[data-id="lcd1"] text.cs-lcd').first()).toHaveText(/hello, world!/, { timeout: 5000 });
  const st = await partState(page, 'lcd_parallel');
  expect(st[0].d).toMatchObject({ kind: 'lcd', backlight: true });
});

test('every part prints a readable name next to each of its pins (for children, not just on hover)', async ({ page }) => {
  test.setTimeout(90_000);
  await loadExample(page, 'blink');
  const types = await page.evaluate(() => Object.keys(window.CatSim.DEFS).filter((t) => !window.CatSim.DEFS[t].board && t !== 'breadboard'));
  await page.evaluate((ts) => { const A = window.CatSim.App; A.project.components = A.project.components.filter((c: { type: string }) => c.type === 'esp32'); ts.forEach((t: string, i: number) => A.addComponent(t, 40 + (i % 8) * 170, 380 + Math.floor(i / 8) * 260)); A.canvas.renderAll(); }, types);
  const missing = await page.evaluate(() => {
    const A = window.CatSim.App, D = window.CatSim.DEFS, out: string[] = [];
    for (const c of A.project.components) {
      const d = D[c.type]; if (!d || d.board || d.dip || d.noPinHeaders || d.pinLabels === false) continue;
      const g = document.querySelector(`.cs-comp[data-id="${c.id}"] .cs-pin-labels`);
      const n = g ? g.querySelectorAll('text.cs-pin-lbl').length : 0;
      if (n !== d.pins.length) out.push(`${c.type}: ${n}/${d.pins.length}`);
    }
    return out;
  });
  expect(missing).toEqual([]);
  const sample = await page.locator('.cs-comp[data-id] .cs-pin-labels text.cs-pin-lbl').first().evaluate((t) => getComputedStyle(t).fontSize);
  expect(parseFloat(sample)).toBeGreaterThanOrEqual(8);
});
