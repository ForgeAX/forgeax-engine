// @perf-budget-skip: intentional real Chromium hit-test gate for generated host pointer ownership.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

function browserExecutable(): string | undefined {
  const candidates = [
    process.env.FORGEAX_BROWSER_EXECUTABLE,
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/opt/google/chrome-beta/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    typeof chromium.executablePath === 'function' ? chromium.executablePath() : undefined,
  ];
  return candidates.find(
    (candidate): candidate is string => candidate !== undefined && existsSync(candidate),
  );
}

describe('generated host pointer ownership', () => {
  it('lets transparent HUD fall through while explicit menu controls keep clicks', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-pointer-events-'));
    await mkdir(resolve(root, 'assets'));
    try {
      await Promise.all([
        writeFile(
          resolve(root, 'forge.json'),
          `${JSON.stringify({
            id: 'pointer-events-game',
            name: 'Pointer Events Game',
            schemaVersion: '3.0.0',
            roots: {},
          })}\n`,
        ),
        writeFile(resolve(root, 'package.json'), '{"name":"pointer-events-game"}\n'),
        writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
      ]);
      const facts = await readProjectFacts(root);
      expect(facts.ok).toBe(true);
      if (!facts.ok) return;
      await createViteConfig(facts.value, 'build');
      const generatedHtml = await readFile(resolve(root, '.forgeax/generated/index.html'), 'utf8');
      const style = generatedHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1];
      expect(style).toBeDefined();
      if (style === undefined) return;

      const executablePath = browserExecutable();
      const browser = await chromium.launch({
        headless: true,
        ...(executablePath === undefined ? {} : { executablePath }),
        args: ['--force-color-profile=srgb', '--force-device-scale-factor=1'],
        chromiumSandbox: true,
      });
      const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
      try {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setContent(
          generatedHtml.replace(/<script type="module"[^>]*>[\s\S]*?<\/script>/g, ''),
        );
        expect(
          await page.evaluate(() => {
            const event = new KeyboardEvent('keydown', { key: 'w', cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
          }),
        ).toBe(true);
        expect(errors).toEqual([]);
        await page.setContent(
          `<!doctype html><html><head><style>${style}</style><style>
            #hud { position: absolute; inset: 0; pointer-events: none; }
            #menu { position: absolute; left: 20px; top: 20px; width: 160px; height: 80px; display: none; pointer-events: auto; }
            #menu.open { display: block; }
            #menu button { position: absolute; left: 20px; top: 20px; width: 100px; height: 36px; pointer-events: auto; }
          </style></head><body>
            <div id="app-shell"><canvas id="app"></canvas><div id="game-ui">
              <div id="hud"></div><div id="menu"><button id="menu-button">Buy</button></div>
            </div></div>
          </body></html>`,
          { waitUntil: 'load' },
        );
        await page.evaluate(() => {
          const counts = { canvas: 0, menu: 0 };
          (globalThis as typeof globalThis & { __pointerCounts?: typeof counts }).__pointerCounts =
            counts;
          document.querySelector('#app')?.addEventListener('click', () => counts.canvas++);
          document.querySelector('#menu-button')?.addEventListener('click', () => counts.menu++);
        });

        const transparentHud = await page.evaluate(() => ({
          hit: document.elementFromPoint(320, 180)?.id,
          pointerEvents: getComputedStyle(document.querySelector('#hud') as Element).pointerEvents,
        }));
        expect(transparentHud).toEqual({ hit: 'app', pointerEvents: 'none' });
        await page.mouse.click(320, 180);
        expect(
          await page.evaluate(
            () =>
              (
                globalThis as typeof globalThis & {
                  __pointerCounts?: { canvas: number; menu: number };
                }
              ).__pointerCounts,
          ),
        ).toEqual({
          canvas: 1,
          menu: 0,
        });

        await page.locator('#menu').evaluate((menu) => menu.classList.add('open'));
        const menuHit = await page.evaluate(() => document.elementFromPoint(90, 60)?.id);
        expect(menuHit).toBe('menu-button');
        await page.mouse.click(90, 60);
        expect(
          await page.evaluate(
            () =>
              (
                globalThis as typeof globalThis & {
                  __pointerCounts?: { canvas: number; menu: number };
                }
              ).__pointerCounts,
          ),
        ).toEqual({
          canvas: 1,
          menu: 1,
        });

        await page.locator('#menu').evaluate((menu) => menu.classList.remove('open'));
        expect(await page.evaluate(() => document.elementFromPoint(320, 180)?.id)).toBe('app');
        await page.mouse.click(320, 180);
        expect(
          await page.evaluate(
            () =>
              (
                globalThis as typeof globalThis & {
                  __pointerCounts?: { canvas: number; menu: number };
                }
              ).__pointerCounts,
          ),
        ).toEqual({
          canvas: 2,
          menu: 1,
        });
      } finally {
        await page.close();
        await browser.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
