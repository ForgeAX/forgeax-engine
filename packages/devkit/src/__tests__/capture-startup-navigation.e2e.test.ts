// @perf-budget-skip: real Chromium navigation during capture startup.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createBrowserCapture } from '../software-capture.js';

it('reobserves the new document when startup adapter inspection races a reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-capture-navigation-'));
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><canvas width="64" height="64"></canvas><script>
      const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
      ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = '#ffee44'; ctx.fillRect(8, 8, 48, 48);
      let frame = 0;
      function tick() { document.documentElement.dataset.forgeaxFrameSubmitted = String(++frame); requestAnimationFrame(tick); }
      requestAnimationFrame(tick);
      const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
      navigator.gpu.requestAdapter = async (...args) => {
        if (!sessionStorage.getItem('startupReload')) {
          sessionStorage.setItem('startupReload', '1');
          location.reload();
          await new Promise(() => {});
        }
        return requestAdapter(...args);
      };
    </script>`);
  });
  const browser = createBrowserCapture(root);
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({ schemaVersion: '3.0.0', id: 'navigation', name: 'Navigation', roots: {} }),
    );
    await writeFile(join(root, 'package.json'), '{"name":"navigation","type":"module"}');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('port unavailable');
    const session = await browser.open({
      serverUrl: `http://127.0.0.1:${address.port}/`,
      backend: 'software',
      headless: true,
      width: 64,
      height: 64,
    });
    expect(await session.page.evaluate(() => sessionStorage.getItem('startupReload'))).toBe('1');
    expect(session.report().backend).toBe('software');
    expect(session.report().pageErrors).toEqual([]);
    expect(session.report().consoleErrors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
