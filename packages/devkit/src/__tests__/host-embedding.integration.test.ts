// @perf-budget-skip: real Chromium enforces the generated host response policy.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

it('embeds an Engine document across ports without losing cross-origin isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-host-embedding-'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const servers: ReturnType<typeof createServer>[] = [];
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'package.json'), '{"name":"embedding-fixture","type":"module"}');
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({
        id: 'embedding-fixture',
        name: 'Embedding fixture',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    );
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw new Error(JSON.stringify(facts.error));
    const config = await createViteConfig(facts.value, 'serve');
    const listen = async (html: string) => {
      const server = createServer((_request, response) => {
        response.writeHead(200, { ...config.server?.headers, 'Content-Type': 'text/html' });
        response.end(html);
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('HTTP address missing');
      return `http://127.0.0.1:${address.port}`;
    };
    const childUrl = await listen('<body>embedded target</body>');
    const parentUrl = await listen(
      `<iframe allow="cross-origin-isolated" src="${childUrl}"></iframe>`,
    );
    const executablePath = ['/opt/google/chrome-beta/chrome', chromium.executablePath()].find(
      existsSync,
    );
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      chromiumSandbox: true,
    });
    const page = await browser.newPage();
    const failures: string[] = [];
    page.on('requestfailed', (request) => failures.push(request.failure()?.errorText ?? 'unknown'));
    await page.goto(parentUrl);
    expect(failures).toEqual([]);
    expect(page.frames()).toHaveLength(2);
    expect(
      await page
        .frames()[1]
        ?.evaluate(() => ({ text: document.body.innerText, isolated: crossOriginIsolated })),
    ).toEqual({ text: 'embedded target', isolated: true });
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  } finally {
    await browser?.close();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
