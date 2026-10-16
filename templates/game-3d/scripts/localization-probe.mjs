import { resolve } from 'node:path';

/** Real mounted template UI, including offline native action delivery. */
export async function probeLocalization(page, artifactDir, { offline = false } = {}) {
  const host = page.locator('#game-ui > [data-ui-asset]');
  const title = host.locator('[data-ui-part="guide-title"]');
  await title.waitFor();
  const result = { samples: [], screenshots: [], requests: [] };
  const request = (req) => { if (/i18n|locale|translation/i.test(req.url())) result.requests.push(req.url()); };
  page.on('request', request);
  try {
    await page.screenshot({ path: resolve(artifactDir, 'localization-en.png') });
    await host.locator('.guide').screenshot({ path: resolve(artifactDir, 'localization-en-ui.png') });
    result.screenshots.push('localization-en.png', 'localization-en-ui.png');
    if (offline) await page.context().setOffline(true);
    await host.locator('[data-ui-action="language-fr"]').click();
    await page.waitForFunction(() => document.querySelector('#game-ui > [data-ui-asset]')?.shadowRoot?.querySelector('[data-ui-part="guide-title"]')?.textContent === 'Prototype 3C');
    const french = await title.textContent();
    await page.screenshot({ path: resolve(artifactDir, 'localization-fr.png') });
    await host.locator('.guide').screenshot({ path: resolve(artifactDir, 'localization-fr-ui.png') });
    result.screenshots.push('localization-fr.png', 'localization-fr-ui.png');
    // Measure the real action + all subscribed DOM writes, excluding protocol/automation latency.
    result.samples = await host.evaluate((element) => {
      const samples = [];
      for (let n = 0; n < 120; n++) {
        const started = performance.now();
        element.shadowRoot.querySelector(`[data-ui-action="language-${n % 2 ? 'en' : 'fr'}"]`).click();
        samples.push(performance.now() - started);
      }
      return samples;
    });
    if (await title.textContent() !== '3C starter') throw new Error('English switch did not update the mounted UI');
    const sorted = [...result.samples].sort((a, b) => a - b);
    result.switchMs = { median: sorted[60], p95: sorted[114], max: sorted.at(-1) };
    result.french = french;
    result.english = await title.textContent();
    result.viewport = page.viewportSize();
    result.offline = offline;
    if (result.requests.length) throw new Error(`Localization unexpectedly fetched resources: ${JSON.stringify(result.requests)}`);
    return result;
  } finally {
    page.off('request', request);
    if (offline) await page.context().setOffline(false);
  }
}
