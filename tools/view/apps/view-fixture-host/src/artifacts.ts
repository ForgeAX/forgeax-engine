import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfiler } from '@forgeax/engine/profiler';

function requireOk(result: { ok: boolean; error?: unknown }, operation: string) {
  if (!result.ok) throw new Error(`Fixture ${operation} failed: ${JSON.stringify(result.error)}`);
}

function profileCapture() {
  let micros = 0;
  let frame = 0;
  let step = 300;
  const profiler = createProfiler({
    clock: { nowMicros: () => (micros += step) },
    phaseCatalog: { app: ['update', 'physics'], render: ['prepare', 'submit'] },
  });
  const started = profiler.startCapture({ frameLimit: 48, eventLimit: 240, detail: 'owner' });
  requireOk(started, 'profile start');
  if (!started.ok) throw new Error('Fixture profile did not start');
  const session = started.value;
  for (frame = 1; frame <= 48; frame += 1) {
    requireOk(session.beginFrame(frame), 'frame start');
    for (const [source, phase, duration] of [
      ['app', 'update', 750 + (frame % 8) * 90],
      ['app', 'physics', 420 + (frame % 5) * 55],
      ['render', 'prepare', 510 + (frame % 6) * 70],
      ['render', 'submit', 330 + (frame % 4) * 40],
    ] as const) {
      step = 20;
      requireOk(session.beginPhase(source, phase), 'phase start');
      step = duration;
      requireOk(session.endPhase(), 'phase end');
    }
    requireOk(session.endFrame(), 'frame end');
  }
  const capture = profiler.latestCapture();
  if (!capture) throw new Error('Fixture profile capture was not published');
  return capture;
}

export async function createFixtureArtifacts() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-view-fixture-'));
  try {
    const directory = join(root, 'fixture-artifacts');
    await mkdir(directory);
    const enginePackage = fileURLToPath(import.meta.resolve('@forgeax/engine/package.json'));
    const generator = resolve(dirname(enginePackage), '../../apps/rhi-debug-viewer/fixtures/generate-fixture.mjs');
    const generated = spawnSync(process.execPath, [generator, directory], { encoding: 'utf8' });
    if (generated.error || generated.status !== 0) {
      throw new Error(`Fixture RHI tape generation failed: ${generated.error ?? generated.stderr}`);
    }
    await writeFile(join(directory, 'cpu-capture.json'), JSON.stringify(profileCapture()));
    return { root, dispose: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
