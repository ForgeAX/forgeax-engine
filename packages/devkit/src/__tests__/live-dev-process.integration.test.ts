// @perf-budget-skip: real Node owner and project-child startup/exit integration gate.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { readLiveProjectInputs } from '../live-project-inputs.js';
import { allocateLoopbackPort } from '../tools/browser-host.js';

it.each([
  'embedded',
  'detached',
] as const)('keeps process ownership at the %s caller after project startup fails', async (mode) => {
  // An invalid project exercises the real child startup and stop paths without a browser.
  const root = await mkdtemp(join(tmpdir(), 'forgeax-live-process-'));
  const port = await allocateLoopbackPort();
  const cli = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
  const library = new URL('../../dist/index.mjs', import.meta.url).href;
  const entry = join(root, 'consumer.mjs');
  await writeFile(
    entry,
    `import { runLiveDevDaemon } from ${JSON.stringify(library)};
if (process.argv.includes('--__forgeax-live-project')) {
  console.error('consumer-entry-relaunched');
  process.exit(44);
}
await runLiveDevDaemon(${JSON.stringify(root)}, ${port});
await new Promise(resolve => setTimeout(resolve, 30));
console.log('consumer-still-alive');
`,
  );
  const initialInputs = process.env.FORGEAX_LIVE_PROCESS_EVIDENCE_DIR
    ? await readLiveProjectInputs(root)
    : undefined;
  const child = spawn(
    process.execPath,
    mode === 'embedded' ? [entry] : [cli, '--__forgeax-live-daemon', root, String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const startedAt = Date.now();
  const observations: unknown[] = [];
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const exited = once(child, 'exit');
  const deadline = Date.now() + 10_000;
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 12_000);
  try {
    let phase: string | undefined;
    while (phase !== 'failed' && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`, {
          headers: { connection: 'close' },
          signal: AbortSignal.timeout(500),
        });
        const status = (await response.json()) as { value?: { phase?: string } };
        phase = status.value?.phase;
        if (process.env.FORGEAX_LIVE_PROCESS_EVIDENCE_DIR)
          observations.push({ elapsedMs: Date.now() - startedAt, status });
      } catch {
        // The owner may still be opening its control endpoint.
      }
      if (phase !== 'failed') await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const projectStartupLog = await readFile(join(root, '.forgeax/dev.log'), 'utf8').catch(
      (error: unknown) => String(error),
    );
    expect(phase, `${output}\n${projectStartupLog}`).toBe('failed');
    const response = await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { connection: 'close' },
      signal: AbortSignal.timeout(1_000),
    });
    expect(await response.json()).toMatchObject({ ok: true, value: { phase: 'stopped' } });
    expect(await exited, output).toEqual([0, null]);
    if (mode === 'embedded') expect(output).toContain('consumer-still-alive');
    const projectLog = await readFile(join(root, '.forgeax/dev.log'), 'utf8');
    expect(projectLog).not.toContain('consumer-entry-relaunched');
    expect(projectLog).toContain('live project: loading DevKit host');
    expect(projectLog).toContain('project-manifest-unreadable');
    expect(projectLog.match(/live project: loading DevKit host/g)?.length).toBe(1);
  } finally {
    clearTimeout(watchdog);
    const evidence = process.env.FORGEAX_LIVE_PROCESS_EVIDENCE_DIR;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      const projectLog = await readFile(join(root, '.forgeax/dev.log'), 'utf8').catch(
        (error: unknown) => String(error),
      );
      await writeFile(
        join(evidence, `${mode}-${child.pid}.json`),
        JSON.stringify(
          {
            mode,
            root,
            pid: child.pid,
            elapsedMs: Date.now() - startedAt,
            initialInputs,
            finalInputs: await readLiveProjectInputs(root).catch(String),
            rootEntries: await readdir(root),
            observations,
            output,
            projectLog,
            exitCode: child.exitCode,
            signalCode: child.signalCode,
          },
          null,
          2,
        ),
      );
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
