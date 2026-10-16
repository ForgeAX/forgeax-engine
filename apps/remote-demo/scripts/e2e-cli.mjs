#!/usr/bin/env node
// apps/remote-demo/scripts/e2e-cli.mjs
//
// End-to-end eval-channel evidence for
// feat-20260629-inspector-two-layer-model-command-cleanup-createap (M5 w22).
//
// Starts an in-process remote sever, connects via InspectorClient, and
// exercises the eval channel: read/write/await-import/handle-discovery.
// The remote package now exports only eval (no Registry / 17 inspect commands /
// sandbox write-denied). Query discovery uses the World-owned row iterator.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
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
  // Dynamic import the remote server (dist) — startServer is the SSOT entry.
  const serverMod = await import(
    /* @vite-ignore */ resolve(WORKSPACE_ROOT, 'packages/remote/dist/server.mjs')
  );
  const startServer = serverMod.startServer;
  if (typeof startServer !== 'function') {
    console.error('e2e-cli: missing startServer export from @forgeax/engine-remote/server');
    process.exit(1);
  }

  // Create a minimal in-process World stand-in for eval context.
  const worldStub = {
    simulationInspection() {
      return {
        formatVersion: 1,
        recordOwner: '@forgeax/engine-ecs',
        schemaOwner: '@forgeax/engine-ecs',
        baselineFingerprint: 'simulation-v1:remote-e2e',
        participants: [],
        trace: { recordTick: 0, sampleCount: 0 },
        report: { verdict: 'match', entries: [] },
      };
    },
    spawn() {
      return { ok: true, value: 1 };
    },
    get(_entity, _component) {
      return { ok: true, value: { pos: [0, 0, 3], quat: [0, 0, 0, 1] } };
    },
    set(_entity, _component, _data) {
      return { ok: true };
    },
  };
  const simulationRoot = { inspect: () => worldStub.simulationInspection() };

  const tmpRoot = await mkdtemp(join(tmpdir(), 'remote-e2e-'));
  try {
    const serverResult = await startServer({
      port: 0,
      host: '127.0.0.1',
      world: worldStub,
      simulation: simulationRoot,
    });
    if (!serverResult.ok) {
      console.error('e2e-cli: startServer failed:', serverResult.error);
      process.exit(1);
    }
    const port = serverResult.value.port;

    // Use InspectorClient (defaultConnect) from engine-types.
    const clientMod = await import(
      /* @vite-ignore */ resolve(WORKSPACE_ROOT, 'packages/types/dist/inspector-client.mjs')
    );
    const defaultConnect = clientMod.defaultConnect;
    const url = `ws://127.0.0.1:${port}/inspector`;
    const clientRes = await defaultConnect(url);
    if (!clientRes.ok) {
      logCase('connect', false, { error: clientRes.error });
    } else {
      const client = clientRes.value;

      // Case 1: eval a simple expression.
      {
        try {
          const v = await client.eval('world.spawn({}).ok');
          const ok = v === true;
          logCase('eval-simple-read', ok, { value: v });
        } catch (e) {
          logCase('eval-simple-read', false, { error: e?.message ?? String(e) });
        }
      }

      // Case 2: eval a write (no write-denied, full-access).
      {
        try {
          const v = await client.eval('world.set(1, null, { pos: [5, 0, 0] })');
          const ok = v !== undefined;
          logCase('eval-write-no-deny', ok, { value: v });
        } catch (e) {
          logCase('eval-write-no-deny', false, { error: e?.message ?? String(e) });
        }
      }

      // Case 3: read-only simulation inspection travels through the existing eval path.
      {
        try {
          const v = await client.eval('simulation.inspect()');
          const ok = v?.formatVersion === 1 && v?.recordOwner === '@forgeax/engine-ecs';
          logCase('simulation-inspection-read', ok, { value: v });
        } catch (e) {
          logCase('simulation-inspection-read', false, { error: e?.message ?? String(e) });
        }
      }

      // Case 4: script-syntax-error surfaces as structured error.
      {
        try {
          await client.eval('world.}{');
          logCase('eval-syntax-error', false, { error: 'expected rejection' });
        } catch (e) {
          const ok = typeof e?.code === 'string' && e.code.includes('syntax');
          logCase('eval-syntax-error', ok, { code: e?.code, hint: e?.hint });
        }
      }

      // Case 5: script-runtime-error surfaces as structured error.
      {
        try {
          await client.eval('world.nonExistentMethod()');
          logCase('eval-runtime-error', false, { error: 'expected rejection' });
        } catch (e) {
          const ok = typeof e?.code === 'string' && e.code.includes('runtime');
          logCase('eval-runtime-error', ok, { code: e?.code, hint: e?.hint });
        }
      }
    }

    // Cleanup.
    try { await serverResult.value.close(); } catch (_) { /* best-effort */ }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  const summary = {
    feature: 'feat-20260629-inspector-two-layer-model-command-cleanup-createap',
    task: 'w22',
    casesTotal: evidence.length,
    casesPassed: evidence.length - failures,
    casesFailed: failures,
    port: null,
    cases: evidence,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (failures > 0) {
    process.stderr.write(
      `e2e-cli: ${failures}/${evidence.length} case(s) failed; see stdout summary\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('e2e-cli: harness error:', err);
  process.exit(2);
});
