// @perf-budget-skip: actual DOM propagation of generated startup receipts; no GPU qualification.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { hostStartupDocument, hostStartupScript } from '../host/startup-source.js';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

it('keeps the ordinary guide inert while keyboard users enter slow Reload and fatal recovery', async () => {
  const template = new URL('../../../../templates/game-3d/assets/', import.meta.url);
  const [html, css, localization, bundled] = await Promise.all([
    readFile(new URL('guide.ui.html', template), 'utf8'),
    readFile(new URL('guide.ui.css', template), 'utf8'),
    readFile(new URL('guide.ui.i18n.json', template), 'utf8'),
    build({
      configFile: false,
      logLevel: 'error',
      build: {
        write: false,
        lib: {
          entry: fileURLToPath(new URL('ui/guide-controller.ts', template)),
          formats: ['iife'],
          name: 'fixtureGuideController',
        },
      },
    }),
  ]);
  const output = Array.isArray(bundled) ? bundled[0] : bundled;
  if (!output || !('output' in output))
    throw new Error('Expected the ordinary guide browser bundle');
  const program = output.output.find((entry) => entry.type === 'chunk');
  if (!program || program.type !== 'chunk') throw new Error('Expected the guide controller chunk');
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
    const page = await browser.newPage({ viewport: { width: 600, height: 400 }, hasTouch: true });
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    const open = async (title: string) => {
      await page.evaluate(() => Reflect.get(globalThis, '__cleanupStartupGuide')?.());
      await page.goto('about:blank');
      await page.setContent(hostStartupDocument(title));
      await page.addScriptTag({
        content: `
        const state = globalThis.__startupKeyboard = { inputEnabled: false, reloads: 0, copied: '' };
        const host = { document, events: window, surface: () => document.querySelector('#app'),
          now: () => performance.now(), visible: () => true, reducedMotion: false,
          clipboard: { writeText: text => { state.copied = text; } },
          reload: () => { state.reloads += 1; } };
        globalThis.__testStartup = ${hostStartupScript(true, 'host')};
        globalThis.__testStartup.bindInput(enabled => { state.inputEnabled = enabled; });
      `,
      });
      await page.addScriptTag({ content: program.code });
      await page.evaluate(
        async (asset) => {
          const channel = new MessageChannel();
          const guide = await Reflect.get(globalThis, 'fixtureGuideController').createGuideUi(
            asset,
            {
              uiRoot: document.querySelector('#game-ui'),
              port: channel.port1,
              controlMode: { read: () => 'touch', subscribe: () => () => {} },
            },
          );
          Reflect.set(globalThis, '__ordinaryGuide', guide);
          Reflect.set(globalThis, '__cleanupStartupGuide', () => {
            Reflect.get(globalThis, '__testStartup').destroy();
            guide.dispose();
            channel.port1.close();
            channel.port2.close();
          });
        },
        { guid: 'startup-keyboard-guide', html, css, localization: JSON.parse(localization) },
      );
      expect(await page.locator('#game-ui').evaluate((node) => (node as HTMLElement).inert)).toBe(
        true,
      );
    };
    await open('Game startup');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
    await page.clock.runFor(15000);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('forgeax-loading-reload');
    const evidence = fileURLToPath(
      new URL('../../../../artifacts/ui-startup-recovery/', import.meta.url),
    );
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: resolve(evidence, '01-slow-keyboard-reload.png') });
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => Reflect.get(globalThis, '__startupKeyboard').reloads)).toBe(1);

    await open('Game recovery');
    await page.evaluate(() => {
      const startup = Reflect.get(globalThis, '__testStartup');
      startup.bindSession('startup-failed');
      startup.prepare();
      startup.fail({
        code: 'plugin-startup-failed',
        message: 'Scene preparation rejected',
        cause: {
          code: 'asset-read-failed',
          detail: { lines: 'missing scene dependency\n'.repeat(40) },
        },
      });
      startup.fail({ code: 'cleanup-failed', message: 'secondary failure' });
    });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('forgeax-fatal-reload');
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('forgeax-fatal-details');
    const diagnostics = page.locator('#forgeax-fatal-diagnostics');
    const copy = page.locator('#forgeax-fatal-copy');
    const details = page.locator('#forgeax-fatal-details');
    expect(
      await diagnostics.evaluate((node) => node.getBoundingClientRect().height),
    ).toBeGreaterThan(0);
    expect(await copy.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(0);
    expect(await page.locator('#forgeax-fatal details, #forgeax-fatal summary').count()).toBe(0);
    expect(await details.textContent()).toContain('plugin-startup-failed');
    expect(await details.textContent()).not.toContain('secondary failure');
    expect(await details.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    await details.hover();
    await page.mouse.wheel(0, 90);
    await page.clock.runFor(100);
    await expect.poll(() => details.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('forgeax-fatal-copy');
    await page.keyboard.press('Enter');
    await expect
      .poll(() => page.locator('#forgeax-fatal-copy-status').textContent())
      .toBe('Diagnostics copied.');
    expect(
      await page.evaluate(() => Reflect.get(globalThis, '__startupKeyboard').copied),
    ).toContain('plugin-startup-failed');
    await page.screenshot({ path: resolve(evidence, '02-fatal-diagnostics-reload.png') });
    await page.locator('#forgeax-fatal-reload').tap();
    expect(await page.evaluate(() => Reflect.get(globalThis, '__startupKeyboard').reloads)).toBe(1);

    await open('Recovered game');
    await page.evaluate(() => {
      const startup = Reflect.get(globalThis, '__testStartup');
      startup.bindSession('startup-recovered');
      startup.prepare();
      const pending = {
        worldIdentity: 'startup-recovered',
        deviceGeneration: 2,
        frameId: 1,
        presentation: 'pending',
      };
      startup.submitted(pending);
      startup.enter(pending);
      startup.enter({ ...pending, presentation: 'ready' });
    });
    expect(
      await page.evaluate(() => Reflect.get(globalThis, '__startupKeyboard').inputEnabled),
    ).toBe(false);
    await page.evaluate(() => {
      const startup = Reflect.get(globalThis, '__testStartup');
      const ready = {
        worldIdentity: 'startup-recovered',
        deviceGeneration: 2,
        frameId: 2,
        presentation: 'ready',
      };
      startup.submitted(ready);
      startup.enter(ready);
    });
    // The first ready frame admits input; the 150 ms fade is presentation only.
    expect(
      await page.evaluate(() => Reflect.get(globalThis, '__startupKeyboard').inputEnabled),
    ).toBe(true);
    expect(await page.locator('#game-ui').evaluate((node) => (node as HTMLElement).inert)).toBe(
      false,
    );
    await page.clock.runFor(150);
    expect(
      await page.evaluate(() => Reflect.get(globalThis, '__startupKeyboard').inputEnabled),
    ).toBe(true);
    expect(await page.locator('#game-ui').evaluate((node) => (node as HTMLElement).inert)).toBe(
      false,
    );
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(
        () => Reflect.get(globalThis, '__ordinaryGuide').host.shadowRoot.activeElement !== null,
      ),
    ).toBe(true);
    const toggle = page.locator('[data-ui-part="vase-toggle"]');
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    await toggle.focus();
    await page.keyboard.press('Enter');
    expect(await toggle.getAttribute('aria-expanded')).toBe('true');
    await page.evaluate(() => Reflect.get(globalThis, '__cleanupStartupGuide')());
  } finally {
    await browser.close();
  }
});

it.each([
  'Enter',
  'Space',
])('shows runtime failure and reloads with %s after entering gameplay', async (key) => {
  const executablePath = [
    process.env.FORGEAX_BROWSER_EXECUTABLE,
    '/opt/google/chrome-beta/chrome',
    chromium.executablePath(),
  ].find((path): path is string => path !== undefined && existsSync(path));
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath === undefined ? {} : { executablePath }),
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(hostStartupDocument('Runtime failure'));
    await page.addScriptTag({
      content: `
        const state = globalThis.__testState = { inputEnabled: false, gameKeys: 0, reloads: 0 };
        const host = { document, events: window, surface: () => document.querySelector('#app'),
          now: () => performance.now(), visible: () => true, reducedMotion: true,
          reload: () => { state.reloads += 1; } };
        const startup = globalThis.__testStartup = ${hostStartupScript(true, 'host')};
        startup.bindInput(enabled => { state.inputEnabled = enabled; });
        startup.bindSession('world-runtime');
        startup.prepare();
        const frame = { frameId: 1, deviceGeneration: 0, worldIdentity: 'world-runtime', presentation: 'ready' };
        startup.submitted(frame);
        startup.enter(frame);
        window.addEventListener('keydown', () => { state.gameKeys += 1; });
      `,
    });
    await page.waitForFunction(() => Reflect.get(globalThis, '__testState').inputEnabled);
    await page.keyboard.press('a');
    await page.evaluate(() => {
      const startup = Reflect.get(globalThis, '__testStartup');
      const error = { code: 'device-operation-failed', message: 'Surface Texture destroyed' };
      startup.fail(error, { fault: error });
      startup.fail({ code: 'render-system-no-camera', message: 'cleanup secondary failure' });
      const stale = {
        frameId: 2,
        deviceGeneration: 0,
        worldIdentity: 'world-runtime',
        presentation: 'ready',
      };
      startup.submitted(stale);
      startup.enter(stale);
    });
    const fatal = page.locator('#forgeax-fatal');
    await expect.poll(() => fatal.isVisible()).toBe(true);
    expect(await page.locator('#forgeax-fatal-details').textContent()).toContain(
      'Surface Texture destroyed',
    );
    expect(await page.locator('#forgeax-fatal-details').textContent()).not.toContain(
      'cleanup secondary failure',
    );
    expect(
      await page.evaluate(() => {
        const event = new KeyboardEvent('keydown', { key: 'w', bubbles: true, cancelable: true });
        document.querySelector('#app')?.dispatchEvent(event);
        return { ...Reflect.get(globalThis, '__testState'), blocked: event.defaultPrevented };
      }),
    ).toEqual({ inputEnabled: false, gameKeys: 1, reloads: 0, blocked: true });
    expect(
      await page
        .locator('#forgeax-fatal-reload')
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page.keyboard.press(key);
    expect(await page.evaluate(() => Reflect.get(globalThis, '__testState'))).toEqual({
      inputEnabled: false,
      gameKeys: 1,
      reloads: 1,
    });
    await page
      .locator('#forgeax-fatal-reload')
      .evaluate((node) => (node as HTMLButtonElement).click());
    expect(await page.evaluate(() => Reflect.get(globalThis, '__testState').reloads)).toBe(1);
  } finally {
    await browser.close();
  }
});

it('enters the generated game after its canvas is replaced during startup', async (context) => {
  const started = performance.now();
  const stages: { stage: string; elapsedMs: number }[] = [];
  const record = (stage: string): void => {
    stages.push({ stage, elapsedMs: performance.now() - started });
  };
  context.onTestFailed(async () => {
    const evidence = resolve(import.meta.dirname, '../../../../artifacts/devkit-startup-canvas');
    await mkdir(evidence, { recursive: true });
    await writeFile(resolve(evidence, 'failed-stages.json'), JSON.stringify(stages, null, 2));
  });
  record('fixture-prepare');
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-startup-canvas-'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await mkdir(resolve(root, 'assets'));
    await Promise.all([
      writeFile(resolve(root, 'package.json'), '{"name":"startup-canvas"}'),
      writeFile(
        resolve(root, 'forge.json'),
        JSON.stringify({
          id: 'startup-canvas',
          name: 'Startup canvas',
          schemaVersion: '3.0.0',
          roots: {},
        }),
      ),
      writeFile(resolve(root, 'main.ts'), 'export {};'),
    ]);
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    record('vite-config-prepare');
    await createViteConfig(facts.value, 'build');
    record('html-read');
    const html = await readFile(resolve(root, '.forgeax/generated/index.html'), 'utf8');
    const executablePath = [
      process.env.FORGEAX_BROWSER_EXECUTABLE,
      '/opt/google/chrome-beta/chrome',
      chromium.executablePath(),
    ].find((path): path is string => path !== undefined && existsSync(path));
    record('browser-launch');
    browser = await chromium.launch({
      headless: true,
      ...(executablePath === undefined ? {} : { executablePath }),
      args: ['--disable-gpu', '--disable-software-rasterizer'],
      chromiumSandbox: true,
    });
    const page = await browser.newPage();
    record('hidden-document-bootstrap');
    // Stop can hide an adopted Play before its document arrives. Its generated
    // module entry must still initialize so the owner can acknowledge cleanup.
    const entry = `data:text/javascript,${encodeURIComponent('document.documentElement.dataset.entryImported = "true";')}`;
    await page.evaluate(
      (source) => {
        const frame = document.createElement('iframe');
        frame.id = 'preparing-play';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.style.visibility = 'hidden';
        document.body.append(frame);
        frame.srcdoc = source;
      },
      html.replace('./main.ts', entry),
    );
    await expect
      .poll(() =>
        page.frameLocator('#preparing-play').locator('html').getAttribute('data-entry-imported'),
      )
      .toBe('true');
    await page.locator('#preparing-play').evaluate((frame) => frame.remove());
    // Run the actual generated startup owner. Renderer/device qualification
    // remains in the unchanged generated-worker-game and browser/Dawn gates.
    record('startup-content');
    await page.setContent(html.replace(/<script type="module">[\s\S]*?<\/script>/g, ''));
    record('startup-receipts');
    const result = await page.evaluate(async () => {
      const startup = (
        globalThis as typeof globalThis & {
          __forgeaxStartup: {
            bindSession(session: string): void;
            prepare(): void;
            bindInput(callback: (enabled: boolean) => void): () => void;
          };
        }
      ).__forgeaxStartup;
      const retired = document.querySelector<HTMLCanvasElement>('#app');
      const loading = document.querySelector<HTMLElement>('#forgeax-loading');
      if (retired === null || loading === null)
        throw new Error('generated startup surface missing');
      let inputEnabled = false;
      startup.bindInput((enabled) => {
        inputEnabled = enabled;
      });
      startup.bindSession('world-1');
      startup.prepare();
      const emit = (
        target: HTMLCanvasElement,
        kind: string,
        frameId: number,
        presentation = 'ready',
      ) =>
        target.dispatchEvent(
          new CustomEvent(`forgeax:frame-${kind}`, {
            detail: { worldIdentity: 'world-1', deviceGeneration: 0, frameId, presentation },
          }),
        );
      emit(retired, 'submitted', 1);
      const current = retired.cloneNode(false) as HTMLCanvasElement;
      retired.replaceWith(current);
      emit(current, 'completed', 1);
      const unownedOldReceipt = loading.dataset.fading;
      emit(retired, 'submitted', 2);
      emit(retired, 'completed', 2, 'pending');
      emit(retired, 'completed', 2);
      const unrelated = document.createElement('canvas');
      document.body.append(unrelated);
      emit(unrelated, 'submitted', 2);
      emit(unrelated, 'completed', 2);
      const before = {
        display: loading.style.display,
        fading: loading.dataset.fading,
        inputEnabled,
      };
      emit(current, 'completed', 3);
      const unsubmitted = loading.dataset.fading;
      emit(current, 'submitted', 3);
      emit(current, 'completed', 3, 'pending');
      emit(current, 'completed', 3);
      const replayedPending = loading.dataset.fading;
      emit(current, 'submitted', 4);
      emit(current, 'completed', 4);
      const fading = loading.dataset.fading;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        before,
        unownedOldReceipt,
        unsubmitted,
        replayedPending,
        fading,
        display: loading.style.display,
        inputEnabled,
      };
    });
    expect(result).toEqual({
      before: { display: 'grid', fading: 'false', inputEnabled: false },
      unownedOldReceipt: 'false',
      unsubmitted: 'false',
      replayedPending: 'false',
      fading: 'true',
      display: 'none',
      inputEnabled: true,
    });
    const playPage = await browser.newPage();
    record('play-page');
    await playPage.route('http://forgeax.test/*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: html.replace(/<script type="module">[\s\S]*?<\/script>/g, ''),
      }),
    );
    record('play-navigation');
    await playPage.goto('http://forgeax.test/?forgeaxWorkspace=game');
    expect(await playPage.locator('#forgeax-loading').isVisible()).toBe(true);
    const playStartup = await playPage.evaluate(() => {
      const startup = (
        globalThis as typeof globalThis & {
          __forgeaxStartup: {
            bindSession(session: string): void;
            prepare(): void;
            bindInput(callback: (enabled: boolean) => void): () => void;
          };
        }
      ).__forgeaxStartup;
      let inputEnabled = true;
      startup.bindInput((enabled) => {
        inputEnabled = enabled;
      });
      startup.bindSession('play-world');
      startup.prepare();
      const canvas = document.querySelector('#app');
      if (canvas === null) throw new Error('Editor Play canvas missing');
      for (const kind of ['submitted', 'completed']) {
        canvas.dispatchEvent(
          new CustomEvent(`forgeax:frame-${kind}`, {
            detail: {
              worldIdentity: 'play-world',
              deviceGeneration: 0,
              frameId: 1,
              presentation: 'ready',
            },
          }),
        );
      }
      return {
        status: document.querySelector('#forgeax-loading-status')?.textContent,
        inputEnabled,
      };
    });
    // Editor Play admits input with its first ready frame while the overlay fades.
    expect(playStartup).toEqual({ status: 'Waiting for the first frame', inputEnabled: true });
    record('play-loading-retirement');
    await playPage.locator('#forgeax-loading').waitFor({ state: 'hidden' });
    expect(await playPage.locator('#forgeax-loading').getAttribute('aria-hidden')).toBe('true');
    await playPage.close();
    for (const readyBeforeFade of [false, true]) {
      record(`fade-clock:${readyBeforeFade}`);
      const fadingPage = await browser.newPage();
      await fadingPage.clock.install({ time: new Date('2026-10-05T00:00:00Z') });
      await fadingPage.clock.pauseAt(new Date('2026-10-05T00:01:00Z'));
      await fadingPage.setContent(html.replace(/<script type="module">[\s\S]*?<\/script>/g, ''));
      await fadingPage.evaluate((readyBefore) => {
        const startup = (
          globalThis as typeof globalThis & {
            __forgeaxStartup: {
              bindSession(session: string): void;
              prepare(): void;
              bindInput(callback: (enabled: boolean) => void): () => void;
            };
          }
        ).__forgeaxStartup;
        startup.bindInput((enabled) => {
          document.documentElement.dataset.testStartupInput = String(enabled);
        });
        startup.bindSession('world-1');
        startup.prepare();
        const oldCanvas = document.querySelector<HTMLCanvasElement>('#app');
        if (oldCanvas === null) throw new Error('startup canvas missing');
        const emit = (canvas: HTMLCanvasElement, frameId: number) => {
          for (const kind of ['submitted', 'completed'])
            canvas.dispatchEvent(
              new CustomEvent(`forgeax:frame-${kind}`, {
                detail: {
                  worldIdentity: 'world-1',
                  deviceGeneration: 0,
                  frameId,
                  presentation: 'ready',
                },
              }),
            );
        };
        emit(oldCanvas, 1);
        const replacement = oldCanvas.cloneNode(false) as HTMLCanvasElement;
        oldCanvas.replaceWith(replacement);
        if (readyBefore) emit(replacement, 2);
      }, readyBeforeFade);
      record(`fade-run:${readyBeforeFade}`);
      await fadingPage.clock.runFor(150);
      if (!readyBeforeFade) {
        expect(
          await fadingPage.evaluate(() => ({
            display: document.querySelector<HTMLElement>('#forgeax-loading')?.style.display,
            fading: document.querySelector<HTMLElement>('#forgeax-loading')?.dataset.fading,
            inputEnabled: document.documentElement.dataset.testStartupInput,
          })),
        ).toEqual({ display: 'grid', fading: 'false', inputEnabled: 'false' });
        await fadingPage.evaluate(() => {
          const canvas = document.querySelector('#app');
          if (canvas === null) throw new Error('replacement canvas missing');
          for (const kind of ['submitted', 'completed'])
            canvas.dispatchEvent(
              new CustomEvent(`forgeax:frame-${kind}`, {
                detail: {
                  worldIdentity: 'world-1',
                  deviceGeneration: 0,
                  frameId: 2,
                  presentation: 'ready',
                },
              }),
            );
        });
        await fadingPage.clock.runFor(150);
      }
      expect(
        await fadingPage.evaluate(() => ({
          display: document.querySelector<HTMLElement>('#forgeax-loading')?.style.display,
          inputEnabled: document.documentElement.dataset.testStartupInput,
        })),
      ).toEqual({ display: 'none', inputEnabled: 'true' });
      await fadingPage.close();
    }
  } finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
  }
});
