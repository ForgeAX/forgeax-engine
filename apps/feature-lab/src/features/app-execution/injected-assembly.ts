import { createApp } from '@forgeax/engine/app';
import { FixedTime, FixedUpdate, Update, World } from '@forgeax/engine/ecs';
import { createBrowserPlatform } from '@forgeax/engine/platform-browser';
import type { Plugin } from '@forgeax/engine/plugin';
import { createRenderer } from '@forgeax/engine/runtime';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const until = async (pred: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const end = performance.now() + timeoutMs;
  while (!pred() && performance.now() < end) await wait(50);
};

export default defineFeature({
  title: 'Injected assembly (host-owned World/Renderer)',
  catalog: 'Injected assembly',
  kind: 'probe',
  summary:
    'createApp({ renderer, world, plugins }) drives a host-created Renderer and World on a second canvas without replacing their identity or time policy.',
  expect:
    'All checks pass: the assembled App returns the same World/Renderer, keeps fixedDeltaSeconds=1/120, runs the plugin, and submits frames.',
  setup({ world }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.6, 0.3, 0.9, 1] }), {
      pos: [0, 0.5, 0],
    });
    let memo: Promise<readonly { name: string; ok: boolean; detail?: string }[]> | undefined;
    return {
      checks() {
        memo ??= probe();
        return memo;
      },
    };
  },
});

async function probe() {
  const c = new CheckList();
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  canvas.style.cssText = 'position:fixed;right:8px;bottom:8px;width:96px;height:96px';
  document.body.appendChild(canvas);
  const rendered = await createRenderer(canvas);
  c.ok(
    'createRenderer ok',
    rendered.ok,
    rendered.ok ? undefined : String((rendered.error as { code?: string }).code),
  );
  if (!rendered.ok) return c.items;
  const renderer = rendered.value;
  const hostWorld = new World({ time: { fixedDeltaSeconds: 1 / 120, maxStepsPerUpdate: 8 } });
  let updates = 0;
  let fixedSeen = 0;
  hostWorld.addSystem(Update, {
    name: 'fl-injected-count',
    queries: [],
    fn: () => {
      updates += 1;
    },
  });
  hostWorld.addSystem(FixedUpdate, {
    name: 'fl-injected-fixed',
    queries: [],
    fn: (world) => {
      fixedSeen = world.getResource(FixedTime).delta;
    },
  });
  const events = { applied: 0, disposed: 0 };
  const plugin: Plugin = {
    name: 'fl-injected-plugin',
    apply(ctx) {
      events.applied += 1;
      ctx.effect(
        () => () => {
          events.disposed += 1;
        },
        'fl-injected-effect',
      );
    },
  } as Plugin;
  let submitted = 0;
  renderer.subscribe((event) => {
    if (event.kind === 'frame-submitted') submitted += 1;
  });
  const platform = createBrowserPlatform(canvas).unwrap();
  const assembled = await createApp({
    platform,
    renderer,
    world: hostWorld,
    plugins: [
      {
        name: 'browser-platform',
        apply(ctx) {
          ctx.effect(() => () => platform.dispose());
        },
      },
      plugin,
    ],
  });
  c.ok(
    'createApp({renderer, world}) ok',
    assembled.ok,
    assembled.ok ? undefined : assembled.error.code,
  );
  if (!assembled.ok) return c.items;
  const app = assembled.value;
  c.ok('same World identity', app.world === hostWorld);
  c.ok('same Renderer identity', app.renderer === renderer);
  c.equal('plugin applied once', events.applied, 1);
  c.ok('start ok', app.start().ok);
  await until(() => submitted >= 3 && updates >= 3);
  c.ok('injected loop submitted frames', submitted >= 3, `submitted=${submitted}`);
  c.ok('injected World updated', updates >= 3, `updates=${updates}`);
  c.near('host time policy kept (fixed delta 1/120)', fixedSeen, 1 / 120, 1e-9);
  const disposed = await app.dispose();
  c.ok('dispose ok', disposed.ok, disposed.ok ? undefined : disposed.error.code);
  c.equal('plugin effect disposed', events.disposed, 1);
  const frozen = updates;
  await wait(200);
  c.equal('no updates after dispose', updates, frozen);
  const after = hostWorld.update(1 / 60);
  c.ok('host World still usable by its owner', after.ok, after.ok ? undefined : after.error.code);
  canvas.remove();
  return c.items;
}
