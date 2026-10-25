// @perf-budget-skip: real browser capture of the generated failure surface; no GPU qualification.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context, startNativePlugin } from '@forgeax/engine-plugin';
import { expect, it } from 'vitest';
import { createBrowserCapture } from '../browser-capture.js';
import { hostStartupDocument, hostStartupScript } from '../host/startup-source.js';
import { waitForFirstFrame } from '../live-dev.js';
import { waitForBrowserToolHost } from '../tools/browser-host.js';

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
          ? 'canvas.forgeaxFrameProgress = { submitted: { frameId: 1, deviceGeneration: 1 } };'
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
    const failureObservedAt = performance.now();
    await expect(waitForFirstFrame(session, 5000)).rejects.toMatchObject({
      code: 'live-startup-failed',
    });
    await expect(
      waitForBrowserToolHost(session.page, '__forgeaxToolHost', 3000),
    ).rejects.toMatchObject({ code: 'tool-preview-startup-failed' });
    expect(performance.now() - failureObservedAt).toBeLessThan(1000);
    const evidence = resolve(import.meta.dirname, '../../../../artifacts/capture-startup-failure');
    await mkdir(evidence, { recursive: true });
    // The startup failure page is a diagnostic: it never lands on the
    // explicitly requested deliverable path or in the project's artifacts/.
    const diagnostics = join(await realpath(root), '.forgeax', 'diag');
    await expect(
      session.capture('unreachable-checkpoint', {
        timeoutMs: 5000,
        output: join(evidence, `${timing}.png`),
      }),
    ).rejects.toMatchObject({
      code: 'browser-capture-runtime-failed',
      detail: { output: join(diagnostics, `${timing}.failure.png`) },
    });
    expect(existsSync(join(evidence, `${timing}.png`))).toBe(false);
    expect(existsSync(join(diagnostics, `${timing}.failure.png`))).toBe(true);
    const observed = await session.capture(undefined, { purpose: 'observe', timeoutMs: 5000 }).then(
      () => undefined,
      (error: unknown) => error as { code: string; detail: { output: string } },
    );
    expect(observed?.code).toBe('browser-capture-runtime-failed');
    expect(observed?.detail.output.startsWith(join(diagnostics, 'artifacts', 'playthrough'))).toBe(
      true,
    );
    expect(observed?.detail.output.endsWith('-capture.failure.png')).toBe(true);
    const artifacts = existsSync(join(root, 'artifacts'))
      ? await readdir(join(root, 'artifacts'), { recursive: true })
      : [];
    // Only the accepted pre-failure frame of the after-frame case is a deliverable.
    expect(artifacts.filter((path) => path.endsWith('.png'))).toHaveLength(
      timing === 'after-frame' ? 1 : 0,
    );
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
