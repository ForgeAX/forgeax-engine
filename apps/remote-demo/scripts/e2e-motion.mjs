#!/usr/bin/env node
import { Update } from '@forgeax/engine-ecs';
// apps/remote-demo/scripts/e2e-motion.mjs
//
// AC-13 end-to-end motion data assertion test
// (feat-20260629-inspector-two-layer-model-command-cleanup-createap M5 w25).
//
// Process-internal (no GPU, no browser) — creates a World with a moving
// entity, starts remote server, connects via InspectorClient, and verifies
// position changes frame-over-frame via client.eval.
//
// executeScript wraps scripts in new Function -> return eval(script),
// and awaits returned Promises. Use (async () => { ... })() pattern.
// _import() is the injected dynamic import alias.
//
// Handle discovery uses the World-owned row iterator.
//
// Pass verdict: position(N+1) != position(N) — entity truly moves.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const WORKSPACE_ROOT = resolve(APP_DIR, '..', '..');

const evidence = [];
let failures = 0;

function logCase(name, ok, detail) {
  evidence.push({ case: name, ok, ...detail });
  if (!ok) failures += 1;
}

async function main() {
  // Dynamic-import dist artefacts.
  const ecsDist = resolve(WORKSPACE_ROOT, 'packages/ecs/dist/index.mjs');
  const sceneDist = resolve(WORKSPACE_ROOT, 'packages/scene/dist/index.mjs');
  const serverDist = resolve(WORKSPACE_ROOT, 'packages/remote/dist/server.mjs');
  const clientDist = resolve(WORKSPACE_ROOT, 'packages/types/dist/inspector-client.mjs');

  const ecsMod = await import(/* @vite-ignore */ ecsDist);
  const sceneMod = await import(/* @vite-ignore */ sceneDist);
  const serverMod = await import(/* @vite-ignore */ serverDist);
  const clientMod = await import(/* @vite-ignore */ clientDist);

  const World = ecsMod.World;
  const Transform = sceneMod.Transform;
  const startServer = serverMod.startServer;
  const defaultConnect = clientMod.defaultConnect;

  if (typeof World !== 'function') {
    console.error('e2e-motion: World not found in ecs dist');
    process.exit(1);
  }
  if (typeof startServer !== 'function') {
    console.error('e2e-motion: startServer not found in remote dist');
    process.exit(1);
  }

  // 1. Build a minimal World with one moving entity.
  const world = new World();
  const eRes = world.spawn({
    component: Transform,
    data: {
      pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
  });
  if (!eRes.ok) {
    logCase('spawn-entity', false, { error: eRes.error?.code });
    report();
    return;
  }
  const entityHandle = eRes.value;
  logCase('spawn-entity', true, {});

  // Add a system that increments pos x each frame.
  world.addSystem(Update, {
    name: 'move-x',
    queries: [],
    fn: () => {
      const t = world.get(entityHandle, Transform);
      if (t.ok)
        world.set(entityHandle, Transform, {
          pos: [(t.value.pos[0] ?? 0) + 1, t.value.pos[1] ?? 0, t.value.pos[2] ?? 0],
        });
    },
  });

  // Advance 1 frame, verify pos x changed.
  world.update(1 / 60).unwrap();
  const afterOne = world.get(entityHandle, Transform);
  const pos1 = afterOne.ok ? afterOne.value.pos[0] : null;
  logCase('frame-advance-local', pos1 === 1, { px: pos1 });

  // 2. Start remote server.
  const serverResult = await startServer({
    port: 0,
    host: '127.0.0.1',
    world,
  });
  if (!serverResult.ok) {
    logCase('start-server', false, { error: serverResult.error?.code });
    report();
    return;
  }
  const port = serverResult.value.port;
  logCase('start-server', true, { port });

  // 3. Connect.
  const clientRes = await defaultConnect(`ws://127.0.0.1:${port}/inspector`);
  if (!clientRes.ok) {
    logCase('connect', false, { error: clientRes.error?.code });
    try { await serverResult.value.close(); } catch (_) { /* ignore */ }
    report();
    return;
  }
  const client = clientRes.value;
  logCase('connect', true, {});

  // 4. Handle discovery via eval — async IIFE + World-owned query.
  const discoverScript =
    "(async () => {" +
    "var dh; var q = world.query({}); " +
    "if (!q.ok) throw q.error; " +
    "for (var row of q.value) { dh = row.entity; break; }" +
    "return dh;" +
    "})()";
  let handle = null;
  try {
    handle = await client.eval(discoverScript);
  } catch (err) {
    logCase('handle-discovery', false, { error: err?.message ?? String(err) });
  }
  const handleOk = typeof handle === 'number' && handle >= 0;
  logCase('handle-discovery', handleOk, { handle });

  if (!handleOk) {
    report();
    try { await serverResult.value.close(); } catch (_) { /* ignore */ }
    return;
  }

  // 5. Read position at current frame.
  const readScriptTpl =
    "(async () => {" +
    "var m = await _import('@forgeax/engine-scene'); " +
    "var r = world.get(%%HANDLE%%, m.Transform); " +
    "return r.ok ? r.value.pos[0] : null;" +
    "})()";
  const readScript = readScriptTpl.replace('%%HANDLE%%', String(handle));

  let posN = null;
  try {
    posN = await client.eval(readScript);
  } catch (err) {
    logCase('read-pos-n', false, { error: err?.message ?? String(err) });
  }
  logCase('read-pos-n', posN !== null, { px: posN });

  // 6. Advance another frame.
  world.update(1 / 60).unwrap();

  // 7. Read position at frame N+1.
  let posN1 = null;
  try {
    posN1 = await client.eval(readScript);
  } catch (err) {
    logCase('read-pos-n1', false, { error: err?.message ?? String(err) });
  }
  logCase('read-pos-n1', posN1 !== null, { px: posN1 });

  // 8. AC-13 core assertion.
  const motionOk = typeof posN === 'number' && typeof posN1 === 'number' && posN1 !== posN;
  logCase('AC-13-position-delta', motionOk, {
    posN,
    posN1,
    delta: motionOk ? posN1 - posN : 'N/A',
  });

  // 9. Write via eval then read back (no write-denied).
  const writeScript =
    "(async () => {" +
    "var m = await _import('@forgeax/engine-scene'); " +
    "world.set(" + String(handle) + ", m.Transform, { pos: [99, 0, 0]}); " +
    "return 'ok';" +
    "})()";
  try {
    await client.eval(writeScript);
    const posAfter = await client.eval(readScript);
    logCase('eval-write-readback', posAfter === 99, { pos: [posAfter, 0, 0]});
  } catch (err) {
    logCase('eval-write-readback', false, { error: err?.message ?? String(err) });
  }

  // Cleanup.
  try { await serverResult.value.close(); } catch (_) { /* ignore */ }

  report();
}

function report() {
  const summary = {
    feature: 'feat-20260629-inspector-two-layer-model-command-cleanup-createap',
    task: 'w25',
    milestone: 'M5',
    casesTotal: evidence.length,
    casesPassed: evidence.length - failures,
    casesFailed: failures,
    cases: evidence,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

  const mc = evidence.find((c) => c.case === 'AC-13-position-delta');
  if (mc?.ok) {
    process.stdout.write('PASS: AC-13 position delta confirmed (entity moved)\n');
  } else {
    process.stdout.write('FAIL: AC-13 position delta not confirmed\n');
  }

  if (failures > 0) {
    process.stderr.write(`e2e-motion: ${failures}/${evidence.length} case(s) failed\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('e2e-motion: harness error:', err);
  process.exit(2);
});
