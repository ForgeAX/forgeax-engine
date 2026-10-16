import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { it } from 'vitest';

const selector = 'packages/devkit/src/__tests__/view-inline-preview-diagnostic.integration.test.ts';
const execute = promisify(execFile);

it.skipIf(process.env.FOCUS_SELECTOR !== selector)(
  'observes the original inline-preview native GPU completion without changing capture bounds',
  async () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const evidence = resolve(root, 'artifacts/ci-focus/view-inline-preview');
    await mkdir(evidence, { recursive: true });
    const env = {
      ...process.env,
      FORGEAX_SKIP_HARNESS_SYNC: '1',
      FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1',
      FORGEAX_VIEW_ADDITIONAL_PAGES: '["rhi-debug","profiler"]',
    };
    const script = resolve(
      root,
      `tools/view/scripts/.inline-preview-diagnostic-${process.pid}.mjs`,
    );
    let created = false;
    try {
      for (const args of [
        ['tools/view-plugins/integration/build.mjs'],
        ['scripts/forgeax/prepare-shader-release-inputs.mjs', '--build', '--profile', 'base-ssao'],
      ]) {
        const result = await execute(process.execPath, args, {
          cwd: root,
          env,
          timeout: 900_000,
          maxBuffer: 64 * 1024 * 1024,
        });
        // biome-ignore lint/suspicious/noConsole: preserve exact external build diagnostics.
        console.info(result.stdout, result.stderr);
      }
      const original = await readFile(
        resolve(root, 'tools/view/scripts/verify-engine-plugin-boundary.mjs'),
        'utf8',
      );
      const anchor =
        "  await page.addInitScript(() => { try { localStorage.setItem('forgeax.view.locale', 'en'); } catch {} });";
      if (original.split(anchor).length !== 2)
        throw new Error('Original View init seam changed; do not run a weakened substitute');
      const observer = await readFile(
        resolve(import.meta.dirname, 'fixtures/inline-preview-gpu-observer.mjs'),
        'utf8',
      );
      const observed = `${anchor}\n  await page.addInitScript({ content: ${JSON.stringify(observer)} });\n  page.on('console', message => { if (message.text().startsWith('[inline-preview-gpu]')) console.error(message.text()); });`;
      // Keep the original probe, all frames, assertions and ten-second capture bound.
      // Only diagnostics and their existing screenshot destination are adapted.
      await writeFile(
        script,
        original
          .replace(anchor, observed)
          .replaceAll(
            "'/tmp/view-plugin-boundary-failed.png'",
            JSON.stringify(resolve(evidence, 'failed.png')),
          ),
        { flag: 'wx' },
      );
      created = true;
      const result = await execute(process.execPath, [script], {
        cwd: root,
        env,
        timeout: 900_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      await writeFile(resolve(evidence, 'original-probe.log'), result.stdout + result.stderr);
      // biome-ignore lint/suspicious/noConsole: preserve the original external runtime probe.
      console.info(result.stdout, result.stderr);
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      await writeFile(
        resolve(evidence, 'failure.log'),
        (failure.stdout ?? '') + (failure.stderr ?? ''),
      );
      console.error(failure.stdout, failure.stderr);
      throw error;
    } finally {
      if (created) await rm(script, { force: true });
    }
  },
  2_000_000,
);
