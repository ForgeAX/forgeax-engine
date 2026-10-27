// @perf-budget-skip: generated Host DOM/layout contract; no GPU qualification.
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { hostStartupDocument, hostStartupScript } from '../host/startup-source.js';

it('shows English version and completed-frame diagnostics without intercepting game input', async () => {
  const executablePath = [
    process.env.FORGEAX_BROWSER_EXECUTABLE,
    '/opt/google/chrome-beta/chrome',
    chromium.executablePath(),
  ].find((path): path is string => path !== undefined && existsSync(path));
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setContent(
      hostStartupDocument('Game', undefined, {
        game: '123456abcdef',
        engine: 'abcdef123456',
      }),
    );
    await page.addScriptTag({
      content: `
      const startup = ${hostStartupScript()};
      startup.bindSession('game');
      startup.prepare();
      const canvas = document.querySelector('#app');
      const detail = { frameId: 1, deviceGeneration: 1, presentation: 'ready', worldIdentity: 'game' };
      canvas.dispatchEvent(new CustomEvent('forgeax:frame-submitted', { detail }));
      canvas.dispatchEvent(new CustomEvent('forgeax:frame-completed', { detail }));
    `,
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 720 });
      const hud = page.locator('#forgeax-status');
      await hud.waitFor({ state: 'visible' });
      expect(await hud.textContent()).toMatch(/^Game 123456abcdef \| Engine abcdef123456 \| FPS /);
      const layout = await hud.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          left: bounds.left,
          bottom: innerHeight - bounds.bottom,
          right: bounds.right,
          border: style.borderTopWidth,
          background: style.backgroundColor,
          font: style.fontSize,
          opacity: style.opacity,
          input: document.elementFromPoint(bounds.left + 1, bounds.top + 1)?.id,
        };
      });
      expect(layout).toMatchObject({
        left: 10,
        bottom: 8,
        border: '0px',
        background: 'rgba(0, 0, 0, 0)',
        font: '10px',
        opacity: '0.5',
        input: 'app',
      });
      expect(layout.right).toBeLessThanOrEqual(width - 10);
    }
  } finally {
    await browser.close();
  }
});
