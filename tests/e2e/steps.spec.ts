import { test, expect } from '@playwright/test';
import { collectErrors, loadExample } from './helpers.ts';

test('build it yourself: the wires come out, each one ticks itself, and a clean run finishes the list', async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.waitForFunction(() => window.CatSim?.App?.project);
  await loadExample(page, 'blink');
  await page.click('.tab[data-tab="stepsPane"]');
  await expect(page.locator('#stepsBadge')).toBeHidden();
  await page.click('#stepsPane button[data-act="start"]');
  expect(await page.evaluate(() => window.CatSim.App.project.wires.length)).toBe(0);
  await expect(page.locator('#stepsBadge')).toHaveText('0/4');
  await expect(page.locator('#stepsPane .steps-list li')).toHaveCount(4);

  // a right wire ticks its step
  await page.evaluate(() => window.CatSim.App.addWire('esp:D23', 'r1:1'));
  await expect(page.locator('#stepsPane li.done')).toHaveText(['Wire esp pin D23 to r1 pin 1']);
  // a wire that skips the resistor is pointed out, and no step is ticked for it
  await page.evaluate(() => window.CatSim.App.addWire('esp:D23', 'led1:A'));
  await expect(page.locator('#stepsPane .steps-wrong')).toContainText('esp pin D23 to led1 pin A');
  await expect(page.locator('#stepsBadge')).toHaveText('1/4');
  await page.evaluate(() => { const A = window.CatSim.App; A.project.wires.pop(); A.changed(); });
  await expect(page.locator('#stepsPane .steps-wrong')).toHaveCount(0);

  // the build in progress survives a reload
  await page.waitForTimeout(400); await page.reload();
  await page.waitForFunction(() => window.CatSim?.App?.project);
  await expect(page.locator('#stepsBadge')).toHaveText('1/4');

  // the answer adds the two missing wires; the last step needs a clean run
  await page.click('.tab[data-tab="stepsPane"]');
  await page.click('#stepsPane button[data-act="answer"]');
  await expect(page.locator('#stepsBadge')).toHaveText('3/4');
  expect(await page.evaluate(() => window.CatSim.App.project.wires.length)).toBe(3);
  await page.click('#btnRun');
  await expect(page.locator('#stepsBadge')).toHaveText('4/4', { timeout: 15_000 });
  await expect(page.locator('#stepsPane .steps-head')).toHaveText('4 of 4 steps done: you built it!');

  // stopping the build leaves the finished circuit as an ordinary project
  await page.click('#stepsPane button[data-act="stop"]');
  await expect(page.locator('#stepsBadge')).toBeHidden();
  expect(await page.evaluate(() => [window.CatSim.App.project.wires.length, 'guide' in window.CatSim.App.project])).toEqual([3, false]);
  expect(errors).toEqual([]);
});

test('build it yourself: a run that raises a warning does not finish the list', async ({ page }) => {
  await page.goto('/'); await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.waitForFunction(() => window.CatSim?.App?.project);
  await loadExample(page, 'blink');
  // a 100 kΩ resistor starves the LED: the circuit is wired as asked, but the run warns
  await page.evaluate(() => { const A = window.CatSim.App; A.project.components.find((c: { id: string }) => c.id === 'r1').props.ohms = 100000; A.changed(); });
  await page.click('.tab[data-tab="stepsPane"]');
  await page.click('#stepsPane button[data-act="start"]');
  await page.click('#stepsPane button[data-act="answer"]');
  await page.click('#btnRun');
  await expect(page.locator('#alerts')).toContainText('barely lights', { timeout: 15_000 });
  await expect(page.locator('#alerts')).toContainText('The sum: (');
  await page.waitForTimeout(2500);
  await expect(page.locator('#stepsBadge')).toHaveText('3/4');
});
