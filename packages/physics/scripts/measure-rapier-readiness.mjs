import { createSmokePlatform } from '../../../scripts/smoke-platform.mjs';
import { execFile } from 'node:child_process';
import { realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot =
  process.env.FORGEAX_MEASUREMENT_REPO_ROOT ?? resolve(dirname(scriptPath), '..', '..', '..');
const backendFacts = {
  'rapier-2d': {
    engineModule: 'packages/physics-rapier2d/dist/index.mjs',
    load: 'loadRapier2D',
    payload: 'packages/physics-rapier2d/node_modules/@dimforge/rapier2d-compat/dist/rapier.mjs',
  },
  'rapier-3d': {
    engineModule: 'packages/physics-rapier3d/dist/index.mjs',
    load: 'loadRapier3D',
    payload: 'packages/physics-rapier3d/pkg/rapier.mjs',
  },
};

function now() {
  return performance.now();
}

function duration(start) {
  return Number((now() - start).toFixed(3));
}

function rendererStub() {
  return {
    backend: 'webgpu',
    ready: Promise.resolve({ ok: true, value: undefined }),
    draw: () => ({ ok: true, value: undefined }),
    onError: () => () => {},
    onLost: () => () => {},
    assets: {},
    dispose: () => {},
  };
}

function structuredFailure(cause) {
  if (cause !== null && typeof cause === 'object') {
    return {
      name: cause.name ?? 'Error',
      message: cause.message ?? String(cause),
      code: cause.code ?? null,
      detail: cause.detail ?? null,
    };
  }
  return { name: typeof cause, message: String(cause), code: null, detail: null };
}

async function measureReadySample(backend, phase, index) {
  const facts = backendFacts[backend];
  const sampleStart = now();
  const stages = {};
  try {
    let stageStart = now();
    const backendModule = await import(pathToFileURL(resolve(repoRoot, facts.engineModule)).href);
    stages.backendImport = { durationMs: duration(stageStart), status: 'ready' };

    stageStart = now();
    const rapier = await backendModule[facts.load]();
    if (rapier instanceof Error || rapier?.code === 'wasm-load-failed') throw rapier;
    stages.wasmInit = { durationMs: duration(stageStart), status: 'ready' };

    const [{ createApp }, { World }, { physicsPlugin }] = await Promise.all([
      import(pathToFileURL(resolve(repoRoot, 'packages/app/dist/index.mjs')).href),
      import(pathToFileURL(resolve(repoRoot, 'packages/ecs/dist/index.mjs')).href),
      import(pathToFileURL(resolve(repoRoot, 'packages/physics/dist/index.mjs')).href),
    ]);
    const world = new World();
    stageStart = now();
    const appResult = await createApp({ platform: createSmokePlatform({ width: 1, height: 1 }),
      renderer: rendererStub(),
      world,
      plugins: [physicsPlugin(backend)],
    });
    stages.pluginActivation = {
      durationMs: duration(stageStart),
      status: appResult.ok ? 'ready' : 'failed',
    };
    if (!appResult.ok) throw appResult.error;
    if (!world.hasResource('PhysicsWorld')) {
      throw new Error('createApp resolved without PhysicsWorld');
    }
    await appResult.value.dispose();
    return {
      backend,
      phase,
      index,
      tReadyMs: duration(sampleStart),
      status: 'ready',
      stages,
    };
  } catch (cause) {
    return {
      backend,
      phase,
      index,
      tReadyMs: duration(sampleStart),
      status: 'failed',
      stages,
      failure: structuredFailure(cause),
    };
  }
}

async function payloadFact(backend) {
  const path = await realpath(resolve(repoRoot, backendFacts[backend].payload));
  const info = await stat(path);
  return {
    url: pathToFileURL(path).href,
    status: 'local-file-readable',
    bytes: info.size,
    format: 'embedded-wasm-module',
  };
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

function summarize(samples, backend, phase) {
  const selected = samples.filter(
    (sample) => sample.backend === backend && sample.phase === phase && sample.status === 'ready',
  );
  const summarizeValues = (values) => ({
    minMs: Math.min(...values),
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  });
  return {
    readySamples: selected.length,
    tReady: summarizeValues(selected.map((sample) => sample.tReadyMs)),
    stages: Object.fromEntries(
      ['backendImport', 'wasmInit', 'pluginActivation'].map((stage) => [
        stage,
        summarizeValues(selected.map((sample) => sample.stages[stage].durationMs)),
      ]),
    ),
  };
}

if (process.argv[2] === '--child') {
  const backend = process.argv[3];
  const index = Number(process.argv[4]);
  const sample = await measureReadySample(backend, 'cold', index);
  process.stdout.write(`${JSON.stringify(sample)}\n`);
} else {
  const outputOption = process.argv.indexOf('--output');
  const outputValue = outputOption < 0 ? undefined : process.argv[outputOption + 1];
  if (outputValue === undefined) {
    throw new Error('usage: measure-rapier-readiness.mjs --output <artifact.json>');
  }
  const outputPath = resolve(repoRoot, outputValue);
  const engineSha = (
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
  ).stdout.trim();
  const samples = [];
  const failures = [];
  for (const backend of Object.keys(backendFacts)) {
    for (let index = 0; index < 10; index++) {
      const wallStart = now();
      try {
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [scriptPath, '--child', backend, `${index}`],
          {
            cwd: resolve(repoRoot, 'packages/app'),
            env: { ...process.env, FORGEAX_MEASUREMENT_REPO_ROOT: repoRoot },
            maxBuffer: 1024 * 1024,
          },
        );
        const sample = JSON.parse(stdout.trim());
        sample.processWallMs = duration(wallStart);
        if (stderr.trim().length > 0) sample.stderr = stderr.trim();
        if (sample.status === 'ready') samples.push(sample);
        else failures.push(sample);
      } catch (cause) {
        failures.push({
          backend,
          phase: 'cold',
          index,
          status: 'failed',
          processWallMs: duration(wallStart),
          failure: structuredFailure(cause),
        });
      }
    }

    const preload = await measureReadySample(backend, 'prewarm', -1);
    if (preload.status !== 'ready') failures.push(preload);
    else {
      for (let index = 0; index < 10; index++) {
        const sample = await measureReadySample(backend, 'warm', index);
        if (sample.status === 'ready') samples.push(sample);
        else failures.push(sample);
      }
    }
  }

  const backends = {};
  for (const backend of Object.keys(backendFacts)) {
    backends[backend] = {
      payload: await payloadFact(backend),
      cold: summarize(samples, backend, 'cold'),
      warm: summarize(samples, backend, 'warm'),
    };
  }
  const artifact = {
    schemaVersion: '2.0.0',
    generatedAt: new Date().toISOString(),
    engineSha,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    devServer: {
      used: false,
      condition: 'Node ESM imports from built Engine packages and local backend payloads',
    },
    methodology: {
      cold: '10 independent Node processes per backend; each process cold-imports the Engine backend, initializes its WASM, and activates physicsPlugin through createApp',
      warm: '10 repeated samples per backend in one process after an uncounted successful prewarm; the loader and ESM modules remain ready',
      readySampleRule: 'Only samples whose createApp result is ok and whose World contains PhysicsWorld are counted; failures are retained separately',
    },
    backends,
    samples,
    failures,
    totals: {
      ready: samples.length,
      failed: failures.length,
      expectedReady: 40,
    },
    decision: {
      readinessThresholdMs: 12_000,
      timeoutOrLoadingBranchNeeded:
        failures.length > 0 || samples.some((sample) => sample.tReadyMs > 12_000),
      reason:
        failures.length === 0 && samples.every((sample) => sample.tReadyMs <= 12_000)
          ? 'All 40 required ready samples completed below 12 seconds; no timeout, fallback, retry, or loading branch is evidenced.'
          : 'At least one readiness failure or sample above 12 seconds requires owner review.',
    },
  };
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ outputPath, totals: artifact.totals, backends, decision: artifact.decision }, null, 2)}\n`,
  );
  if (samples.length !== 40 || failures.length !== 0) process.exitCode = 1;
}
