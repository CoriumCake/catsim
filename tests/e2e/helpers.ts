import type { Page } from '@playwright/test';

// The page exposes window.CatSim = { App, DEFS } for debugging and tests.
type AnyApp = any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare global { interface Window { CatSim: { App: AnyApp; DEFS: AnyApp; Audio: AnyApp }; __pwned?: unknown } }

export async function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('dialog', (d) => { errors.push(`dialog: ${d.message()}`); void d.dismiss(); });
  return errors;
}

export async function loadExample(page: Page, key: string) {
  await page.selectOption('#exampleSelect', key);
  await page.waitForFunction((k) => window.CatSim.App.project.name.length > 0 && document.querySelector('#exampleSelect') !== null, key);
}

export async function startSim(page: Page) {
  await page.evaluate(() => { window.CatSim.App.stop(); window.CatSim.App.start(); });
  await page.waitForFunction(() => window.CatSim.App.sim.running);
}

export async function runSketch(page: Page, code: string) {
  await page.evaluate((c) => { const A = window.CatSim.App; A.stop(); A.editor.set(c); A.start(); }, code);
}

export function partState(page: Page, type: string) {
  return page.evaluate((t) => {
    const { App: A, DEFS } = window.CatSim;
    return A.project.components.filter((c: { type: string }) => c.type === t).map((c: unknown) => DEFS[t].state(c, A.sim));
  }, type);
}

export const serial = (page: Page) => page.locator('#serialOut').textContent().then((t) => t ?? '');
