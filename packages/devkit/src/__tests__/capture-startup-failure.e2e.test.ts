// @perf-budget-skip: real browser capture of the generated failure surface; no GPU qualification.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context, startNativePlugin } from '@forgeax/engine-plugin';
import { expect, it } from 'vitest';
import { hostStartupDocument, hostStartupScript } from '../host/startup-source.js';
import { createBrowserCapture } from '../software-capture.js';

it.each([
  'before-frame',
  'after-frame',
] as const)('rejects native startup failure %s without browser errors', async (timing) => {
  const context = new Context();
  const failed = await startNativePlugin(context, {
    name: 'project-root',
    apply(ctx) {
      ctx.plugin({
        name: 'gomoku/ui',
        apply() {
          throw new Error('Call initialize() before using vag-platform-sdk');
        },
      });
    },
  });
  expect(failed.ok).toBe(false);
  if (failed.ok) throw new Error('Expected native plugin startup failure');
  const failure = JSON.stringify(failed.error, (_key, value) =>
    value instanceof Error ? { message: value.message, cause: value.cause } : value,
  );
  const root = await mkdtemp(join(tmpdir(), 'forgeax-capture-startup-failure-'));
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      hostStartupDocument('Capture failure').replace(
        '</body>',
        `<script>
      ${hostStartupScript(false)};
      const canvas = document.querySelector('#app');
      canvas.width = 128; canvas.height = 128;
      const draw = canvas.getContext('2d');
      draw.fillStyle = '#123456'; draw.fillRect(0, 0, 128, 128);
      draw.fillStyle = '#ffee44'; draw.fillRect(16, 16, 96, 96);
      globalThis.triggerFailure = () => globalThis.__forgeaxStartup.fail(${failure});
      ${
        timing === 'after-frame'
          ? "document.documentElement.dataset.forgeaxFrameSubmitted = '1';"
          : 'globalThis.triggerFailure();'
      }
    </script></body>`,
      ),
    );
  });
  const browser = createBrowserCapture(root);
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'capture-failure',
        name: 'Capture failure',
        roots: {},
      }),
    );
    await writeFile(join(root, 'package.json'), '{"name":"capture-failure","type":"module"}');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('port unavailable');
    const session = await browser.open({
      serverUrl: `http://127.0.0.1:${address.port}/`,
      backend: 'software',
      headless: true,
      width: 640,
      height: 480,
      requireUi: timing === 'before-frame',
    });
    if (timing === 'after-frame') {
      expect((await session.capture(undefined, { timeoutMs: 5000 })).ok).toBe(true);
      await session.page.evaluate(() => Reflect.get(globalThis, 'triggerFailure')());
    }
    expect(await session.page.locator('#forgeax-fatal').isVisible()).toBe(true);
    expect(session.report().pageErrors).toEqual([]);
    expect(session.report().consoleErrors).toEqual([]);
    const evidence = resolve(import.meta.dirname, '../../../../artifacts/capture-startup-failure');
    await mkdir(evidence, { recursive: true });
    await expect(
      session.capture('unreachable-checkpoint', {
        timeoutMs: 5000,
        output: join(evidence, `${timing}.png`),
      }),
    ).rejects.toMatchObject({
      code: 'software-capture-runtime-failed',
    });
    await expect(
      session.capture(undefined, {
        purpose: 'observe',
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({ code: 'software-capture-runtime-failed' });
    expect(session.report().ok).toBe(false);
    expect(session.report().captures.at(-1)?.runtime).toMatchObject({
      fatalError: expect.stringContaining('Call initialize() before using vag-platform-sdk'),
    });
    await writeFile(join(evidence, `${timing}.json`), JSON.stringify(session.report(), null, 2));
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
