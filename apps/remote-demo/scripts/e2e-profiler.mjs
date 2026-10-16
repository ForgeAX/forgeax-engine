#!/usr/bin/env node
import { createSmokePlatform } from '../../../scripts/smoke-platform.mjs';
// Real remote profiler journey: introspect -> eval -> artifact -> offline model.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const WORKSPACE_ROOT = resolve(APP_DIR, '..', '..');

const evidence = [];
let failures = 0;

function record(name, ok, detail = {}) {
  evidence.push({ case: name, ok, ...detail });
  if (!ok) failures += 1;
}

async function main() {
  const profilerMod = await import(resolve(WORKSPACE_ROOT, 'packages/profiler/dist/index.mjs'));
  const appMod = await import(resolve(WORKSPACE_ROOT, 'packages/app/dist/index.mjs'));
  const ecsMod = await import(resolve(WORKSPACE_ROOT, 'packages/ecs/dist/index.mjs'));
  const remoteMod = await import(resolve(WORKSPACE_ROOT, 'packages/remote/dist/server.mjs'));
  const clientMod = await import(resolve(WORKSPACE_ROOT, 'packages/types/dist/inspector-client.mjs'));
  const { buildProfileModel, createProfiler } = profilerMod;
  const { createApp } = appMod;
  const { World } = ecsMod;
  const { startServer } = remoteMod;
  const { defaultConnect } = clientMod;

  const disabledServer = await startServer({ port: 0, host: '127.0.0.1', world: {} });
  if (!disabledServer.ok) throw disabledServer.error;
  const disabledClientResult = await defaultConnect(
    `ws://127.0.0.1:${disabledServer.value.port}/inspector`,
  );
  if (!disabledClientResult.ok) throw disabledClientResult.error;
  const disabledClient = disabledClientResult.value;
  try {
    const doc = await requestIntrospect(disabledServer.value.port);
    const rootAbsent = doc.roots?.profiler === undefined;
    const hint = doc.capabilities?.profiler;
    record('root-not-enabled', rootAbsent && hint?.code === 'profiler-not-enabled', { hint });
    const notEnabled = await disabledClient.eval(
      "typeof profiler === 'undefined' ? { ok: false, error: { code: 'profiler-not-enabled', expected: 'an opted-in profiler root', hint: 'Pass profiler to createApp.', detail: { enabled: false } } } : null",
    );
    record('not-enabled-result', notEnabled?.error?.code === 'profiler-not-enabled', {
      result: notEnabled,
    });
    const methods = doc.methods?.map((method) => method.name);
    record('method-roster-disabled', JSON.stringify(methods) === JSON.stringify(['eval', 'introspect']), {
      methods,
    });
  } finally {
    await disabledClient.dispose();
    await disabledServer.value.close();
  }

  const profiler = createProfiler();
  const world = new World();
  let scheduledFrame;
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    scheduledFrame = callback;
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {
    scheduledFrame = undefined;
  };
  const renderer = {
    backend: 'webgpu',
    ready: Promise.resolve({ ok: true, value: undefined }),
    draw: () => ({ ok: true, value: undefined }),
    onError: () => () => {},
    onLost: () => () => {},
    dispose: () => {},
  };
  const appResult = await createApp({ platform: createSmokePlatform({ width: 1, height: 1 }),  renderer, world, profiler });
  if (!appResult.ok) throw appResult.error;
  const app = appResult.value;
  const server = await startServer({ port: 0, host: '127.0.0.1', world, renderer, profiler });
  if (!server.ok) throw server.error;
  const clientResult = await defaultConnect(`ws://127.0.0.1:${server.value.port}/inspector`);
  if (!clientResult.ok) throw clientResult.error;
  const client = clientResult.value;
  const driveHostFrames = (count) => {
    for (let index = 0; index < count; index += 1) {
      const frame = scheduledFrame;
      scheduledFrame = undefined;
      if (frame === undefined) throw new Error('createApp did not schedule the requested host frame');
      frame((index + 1) * 16);
    }
  };
  try {
    const doc = await requestIntrospect(server.value.port);
    record('root-enabled', doc.roots?.profiler?.capability === 'cpu-profile-v1', {
      root: doc.roots?.profiler,
    });
    const methods = doc.methods?.map((method) => method.name);
    record('method-roster-enabled', JSON.stringify(methods) === JSON.stringify(['eval', 'introspect']), {
      methods,
    });

    const started = await client.eval('profiler.startCapture({ frameLimit: 1, eventLimit: 32 })');
    record('eval-start-capture', started?.ok === true, { result: started });

    const appStarted = app.start();
    record('host-starts-capture', appStarted.ok === true, { result: appStarted });
    driveHostFrames(1);

    const artifact = await client.eval('profiler.latestCapture()');
    const hostFrameCount = artifact?.records?.filter((record) => record.source === 'app').length;
    record('host-completes-capture', artifact?.completeness?.status === 'complete', {
      status: artifact?.completeness?.status,
      frameCount: hostFrameCount,
    });
    const model = buildProfileModel(artifact);
    record(
      'artifact-offline-model',
      model.ok === true && model.value.summary.captureId === artifact?.captureId,
      {
        captureId: artifact?.captureId,
        status: artifact?.completeness?.status,
        model: model.ok ? model.value.summary : model.error,
      },
    );

    const overflowStart = await client.eval(
      'profiler.startCapture({ frameLimit: 1, eventLimit: 1 })',
    );
    driveHostFrames(1);
    const overflowArtifact = await client.eval('profiler.latestCapture()');
    const overflowModel = buildProfileModel(overflowArtifact);
    record(
      'overflow-state-preserved',
      overflowStart?.ok === true &&
        overflowArtifact?.completeness?.status === 'overflow' && overflowModel.ok === true,
      { status: overflowArtifact?.completeness?.status, model: overflowModel },
    );

    const partialStart = await client.eval(
      'profiler.startCapture({ frameLimit: 2, eventLimit: 8 })',
    );
    driveHostFrames(1);
    app.stop();
    const partialArtifact = await client.eval('profiler.latestCapture()');
    const partialModel = buildProfileModel(partialArtifact);
    record(
      'partial-state-preserved',
      partialStart?.ok === true &&
        partialArtifact?.completeness?.status === 'partial' && partialModel.ok === true,
      { start: partialStart, status: partialArtifact?.completeness?.status, model: partialModel },
    );
  } finally {
    app.stop();
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCaf;
    await client.dispose();
    await server.value.close();
  }

  const summary = {
    feature: 'feat-20260803-engine-performance-profiler',
    milestone: 'M3',
    casesTotal: evidence.length,
    casesPassed: evidence.length - failures,
    casesFailed: failures,
    cases: evidence,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (failures > 0) process.exit(1);
}

async function requestIntrospect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/inspector`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  try {
    return await new Promise((resolve, reject) => {
      const onMessage = (raw) => {
        ws.off('message', onMessage);
        try {
          const response = JSON.parse(raw.toString());
          if (response.error) reject(response.error);
          else resolve(response.result);
        } catch (error) {
          reject(error);
        }
      };
      ws.on('message', onMessage);
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'introspect', id: 1 }));
    });
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  process.stderr.write(`e2e-profiler: ${error?.stack ?? String(error)}\n`);
  process.exit(2);
});
