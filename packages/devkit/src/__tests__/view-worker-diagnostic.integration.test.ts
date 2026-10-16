import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { LiveDevStatus } from '../live-dev.js';
import type { UnifiedCliResult } from '../unified-cli.js';

const selector = 'packages/devkit/src/__tests__/view-worker-diagnostic.integration.test.ts';
// Explicit CI Focus diagnosis only. This is not a substitute for any acceptance gate.
it.skipIf(process.env.FOCUS_SELECTOR !== selector)(
  'compares the actual split-worker game in both browser placements',
  async () => {
    // Detached owner entrypoints are published .mjs files, so exercise the built
    // library just as the independent View and SDK consumers do.
    const { runUnifiedCli } = await import(new URL('../../dist/index.mjs', import.meta.url).href);
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const output = resolve(root, 'artifacts/ci-focus/view-worker-diagnostic');
    await mkdir(output, { recursive: true });
    const envBefore = {
      lightweight: process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT,
      width: process.env.FORGEAX_BROWSER_CI_VIEWPORT_WIDTH,
      height: process.env.FORGEAX_BROWSER_CI_VIEWPORT_HEIGHT,
    };
    // Preserve the failing run's full 1280x720 extent in both placements.
    process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT = '1';
    process.env.FORGEAX_BROWSER_CI_VIEWPORT_WIDTH = '1280';
    process.env.FORGEAX_BROWSER_CI_VIEWPORT_HEIGHT = '720';
    const results: unknown[] = [];
    try {
      for (const headless of [true, false]) {
        const game = await mkdtemp(resolve(tmpdir(), 'forgeax-view-worker-diagnostic-'));
        const label = headless ? 'headless' : 'headed';
        const caseRoot = resolve(output, label);
        await mkdir(caseRoot, { recursive: true });
        const cli = (args: string[]) => runUnifiedCli([...args, '--root', game, '--json']);
        const samples: { elapsedMs: number; status: UnifiedCliResult }[] = [];
        const startedAt = performance.now();
        try {
          await mkdir(resolve(game, 'node_modules/@forgeax'), { recursive: true });
          await symlink(
            resolve(root, 'packages/engine'),
            resolve(game, 'node_modules/@forgeax/engine'),
          );
          await writeFile(
            resolve(game, 'package.json'),
            JSON.stringify({
              name: 'worker-diagnostic',
              type: 'module',
              dependencies: { '@forgeax/engine': '*' },
            }),
          );
          await cp(resolve(root, 'templates/game-3d/assets'), resolve(game, 'assets'), {
            recursive: true,
          });
          await cp(resolve(root, 'templates/game-3d/forge.json'), resolve(game, 'forge.json'));
          expect((await cli(['project', 'engine', 'use-local', root])).ok).toBe(true);
          const started = await cli([
            'dev',
            'start',
            '--headless',
            String(headless),
            '--rhi-capture',
            'true',
          ]);
          if (!started.ok) {
            results.push({ label, started, status: await cli(['dev', 'status']) });
          }
          expect(started.ok, JSON.stringify(started)).toBe(true);
          const windowStart = performance.now();
          while (performance.now() - windowStart < 120_000) {
            samples.push({
              elapsedMs: performance.now() - windowStart,
              status: await cli(['dev', 'status']),
            });
            await new Promise((done) => setTimeout(done, 2_000));
          }
          const screenshot = await cli([
            'dev',
            'capture',
            '--output',
            resolve(caseRoot, 'game.png'),
          ]);
          const tape = await cli([
            'rhi',
            'capture',
            '--output',
            resolve(caseRoot, 'frame.rhitape'),
          ]);
          const summary = tape.ok
            ? await cli(['rhi', 'summary', '--artifact', resolve(caseRoot, 'frame.rhitape')])
            : undefined;
          const screenshotReport = await readFile(resolve(caseRoot, 'game.png.json'), 'utf8')
            .then(JSON.parse)
            .catch(() => undefined);
          results.push({
            label,
            viewport: { width: 1280, height: 720 },
            totalMs: performance.now() - startedAt,
            started,
            samples,
            screenshot,
            screenshotReport,
            tape,
            summary,
          });
          process.stdout.write(
            `${JSON.stringify({
              diagnostic: 'view-worker',
              label,
              samples: [samples[0], samples.at(-1)].map((sample) => ({
                elapsedMs: sample?.elapsedMs,
                execution: (sample?.status.value as LiveDevStatus | undefined)?.execution,
              })),
              screenshotOk: screenshot.ok,
              captureOk: tape.ok,
            })}\n`,
          );
        } finally {
          await cli(['dev', 'stop']);
          await writeFile(
            resolve(output, 'observations.json'),
            JSON.stringify(
              {
                diagnosticOnly: true,
                platform: process.platform,
                results,
                pendingSamples: samples,
              },
              null,
              2,
            ),
          );
          await rm(game, { recursive: true, force: true });
        }
      }
    } finally {
      for (const [key, value] of Object.entries({
        FORGEAX_BROWSER_CI_LIGHTWEIGHT: envBefore.lightweight,
        FORGEAX_BROWSER_CI_VIEWPORT_WIDTH: envBefore.width,
        FORGEAX_BROWSER_CI_VIEWPORT_HEIGHT: envBefore.height,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
  1_200_000,
);
