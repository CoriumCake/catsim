import { expect, test } from '@playwright/test';
import { collectErrors, runSketch, serial } from './helpers.ts';

const X = (n: number) => `"><img src=x onerror="window.__pwned=${n}">`;

test('a crafted share link cannot inject markup', async ({ page }) => {
  const errors = await collectErrors(page);
  const evil = {
    name: '</title><img src=x onerror=window.__pwned=0>', code: 'void setup(){}\nvoid loop(){}',
    components: [
      { id: 'esp', type: 'esp32', x: 300, y: 80, props: {} },
      { id: 'pot1', type: 'pot', x: X(5), y: 300, props: { value: X(3) } },
      { id: X(2), type: 'led', x: 100, y: 100, props: {} },
      { id: 'led2', type: 'led', x: 100, y: 200, props: { color: X(6) } },
    ],
    wires: [
      { id: X(1), from: 'esp:D2', to: 'led2:A', color: X(4) },
      { id: 'w9', from: 'esp:GND.L', to: 'led2:C', color: '#ff00ff' },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(evil));
  const legacyHash = '#p=' + encodeURIComponent(Buffer.from(bytes).toString('base64'));
  await page.goto('/' + legacyHash);
  await page.waitForFunction(() => window.CatSim?.App?.project);
  await page.evaluate(() => {
    const A = window.CatSim.App;
    A.canvas.select({ kind: 'comp', id: 'pot1' });
    A.canvas.select({ kind: 'wire', id: A.project.wires[0].id });
  });
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => ({
    pwned: window.__pwned,
    ids: window.CatSim.App.project.components.map((c: { id: string }) => c.id),
    wires: window.CatSim.App.project.wires.map((w: { id: string; color?: string }) => `${w.id}:${w.color ?? ''}`),
    imgs: document.querySelectorAll('img').length,
  }));
  expect(st.pwned).toBeUndefined();
  expect(st.imgs).toBe(0);
  expect(st.ids).toEqual(['esp', 'pot1', 'led2']);
  expect(st.wires).toEqual(['w1:', 'w9:#ff00ff']);
  expect(errors).toEqual([]);
});

test('sketches run isolated in a worker; forged messages render as text', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.CatSim?.App?.project);
  await runSketch(page, `void setup() {
  Serial.begin(115200);
  Serial.println(self.document ? "HAS-DOC" : "no-doc");
  Serial.println(self.localStorage ? "HAS-LS" : "no-ls");
  self.postMessage({ type: "log", msg: "<img src=x onerror=window.__pwned=9>", level: "error\\" onmouseover=x" });
  self.postMessage({ type: "snap", t: "boom", mode: { "2": "<b>" }, lcd: { buf: [["<img>"]] } });
}
void loop() { delay(100); }`);
  await expect.poll(() => serial(page)).toContain('no-ls');
  expect(await serial(page)).toContain('no-doc');
  await expect(page.locator('#consoleOut')).toContainText('<img src=x onerror=window.__pwned=9>');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.locator('#consoleOut img').count()).toBe(0);
});

test('the CSP blocks injected inline scripts, while the worker can still compile sketches', async ({ page, request }) => {
  const res = await request.get('/');
  expect(res.headers()['content-security-policy']).toContain("script-src 'self'");
  await page.goto('/');
  await page.waitForFunction(() => window.CatSim?.App?.project);
  // An injected inline script (what an HTML-injection bug would produce) must not run.
  const violation = page.waitForEvent('console', (m) => /Content Security Policy/i.test(m.text()));
  await page.evaluate(() => { const el = document.createElement('script'); el.textContent = 'window.__pwned = "inline"'; document.head.append(el); });
  await violation;
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await runSketch(page, 'void setup() { Serial.begin(9600); Serial.print("compiled"); }\nvoid loop() { delay(100); }');
  await expect.poll(() => serial(page)).toContain('compiled');
});
