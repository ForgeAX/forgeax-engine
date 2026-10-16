// apps/remote-demo — remote eval demo (feat-20260629-inspector-two-layer-model M5).
//
// createApp auto-wires app.remote in dev mode (dynamic import +
// OS-assigned ephemeral port). No Registry / wireDefaultInspectors /
// startConsoleServer manual assembly — the engine now makes remote
// eval zero-cost present.
//
// AI-user-facing recipe to try after `pnpm --filter @forgeax/remote-demo dev`:
//
//   import { defaultConnect } from '@forgeax/engine-types/inspector-client';
//   const c = await defaultConnect('ws://localhost:<port>/inspector');
//   if (!c.ok) throw c.error;
//   // Discover handles through the World-owned row iterator:
//   const ecs = await c.value.eval(
//     "const q = world.query({}); if (!q.ok) throw q.error; Array.from(q.value, row => row.entity)"
//   );
//   // Read Transform position:
//   const pos = await c.value.eval(
//     "world.get(<handle>, (await _import('@forgeax/engine-runtime')).Transform)"
//   );
//   // Mutation (eval full-access, zero interception):
//   await c.value.eval(
//     "world.set(<handle>, (await _import('@forgeax/engine-runtime')).Transform, { pos: [5, 0, 0]})"
//   );

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import type { CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { createProfiler } from '@forgeax/engine-profiler';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { populateDemoWorld } from '../../shared/src/populate-demo-world';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('remote-demo: missing <canvas id="app"> in index.html');
bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError)
    console.error('[remote-demo] EngineEnvironmentError:', err.reason);
  else console.error('[remote-demo] bootstrap error:', err);
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    { profiler: createProfiler() },
    { ...forgeaxBundlerAdapter() },
  );
  if (!appRes.ok) {
    reportBootstrapError(appRes.error);
    return;
  }
  const app = appRes.value;

  // Populate the engine-owned World with the 3-entity demo scene (cube +
  // camera + directional light). Must happen after createApp because
  // createApp creates its own World internally.
  populateDemoWorld(app.world);

  // app.remote is auto-wired by createApp in dev mode — zero manual assembly.
  // When present, app.remote.port is the OS-assigned ephemeral port, and
  // app.remote.close() tears down the WS server.
  if (app.remote) {
    console.warn(`[remote-demo] remote eval server on ws://localhost:${app.remote.port}/inspector`);
    console.warn(
      '[remote-demo] connect: defaultConnect("ws://localhost:' +
        `${app.remote.port}/inspector") — then client.eval(script)`,
    );
    console.warn('[remote-demo] handle discovery recipe:');
    console.warn(
      '[remote-demo]   const q = world.query({}); if (!q.ok) throw q.error; ' +
        'Array.from(q.value, row => row.entity)',
    );
  } else {
    console.warn(
      '[remote-demo] app.remote not available (production build or headless without opt-in)',
    );
  }

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[remote-demo] app.start failed:', startRes.error);
    return;
  }

  console.warn(
    `[remote-demo] state=${app.renderer.inspect().state} app.remote=${
      app.remote ? `ws:${app.remote.port}` : 'none'
    }`,
  );
}

function reportBootstrapError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[remote-demo] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[remote-demo] ${err.code}: ${err.hint}`);
}
