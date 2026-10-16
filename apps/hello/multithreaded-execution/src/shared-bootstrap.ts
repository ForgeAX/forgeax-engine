import type { ExecutionBootstrapEntry, ExecutionBootstrapValue } from '@forgeax/engine-app';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { createExecutionKernel, ExecutionParticle } from './shared-kernel';

const PARTICLE_COUNT = 65_536;
let shouldFault = new URL(import.meta.url).searchParams.get('fault') === '1';

function telemetryRequested(data: ExecutionBootstrapValue | undefined): boolean {
  if (data === undefined || data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  return (data as { readonly [key: string]: ExecutionBootstrapValue }).telemetry === true;
}

const bootstrap: ExecutionBootstrapEntry = (data) => ({
  plugins: [
    {
      name: 'multithreaded-execution',
      inject: ['world', 'executionBootstrapHost'],
      apply(ctx): void {
        const world = ctx.world;
        const port = ctx.executionBootstrapHost.port;
        const telemetry = telemetryRequested(data) && port !== undefined;
        const faultRequested = shouldFault;
        const normalKernelUrl = new URL(
          '/assets/shared-kernel.js',
          globalThis.location.href,
        ).href;
        const faultKernelUrl = new URL('/assets/fault-kernel.js', globalThis.location.href).href;
        let faultArmed = faultRequested && !telemetry;
        const post = (message: Record<string, unknown>): void => {
          port?.postMessage({ ...message, worldIdentity: world.identity });
        };

        if (telemetry) {
          const registerNamedCleanup = (name: string): void => {
            post({ kind: 'cleanup-registered', name });
            ctx.effect(() => () => post({ kind: 'cleanup', name }), `demo/${name}`);
          };
          registerNamedCleanup('input-observer');
          registerNamedCleanup('render-session');
          ctx.effect(() => {
            const system = {
              name: 'execution-host-input-observer',
              before: ['execution-particle-kernel'],
              after: ['input-frame-start-scan'],
              queries: [],
              fn(currentWorld: World) {
                const snapshot = currentWorld.getResource<InputSnapshot>(
                  INPUT_SNAPSHOT_RESOURCE_KEY,
                );
                const keyMDown = snapshot.keyboard.downCode('KeyM');
                const mousePrimaryDown = snapshot.mouse.button(0);
                post({
                  kind: 'update',
                  keyMDown,
                  mousePrimaryDown,
                  keyMJustPressed: snapshot.keyboard.justPressedCode('KeyM'),
                });
                if (faultRequested && !faultArmed && (keyMDown || mousePrimaryDown)) {
                  const replaced = currentWorld.replaceSystem(
                    currentWorld.scheduleToken('Update'),
                    'execution-particle-kernel',
                    createExecutionKernel(faultKernelUrl),
                  );
                  if (!replaced.ok) throw replaced.error;
                  faultArmed = true;
                  shouldFault = false;
                  post({ kind: 'fault-armed' });
                }
              },
            };
            world.addSystem(world.scheduleToken('Update'), system).unwrap();
            return () => {
              world.removeSystem(world.scheduleToken('Update'), system.name);
            };
          }, 'demo/input-observer');
        }

        const spawned: EntityHandle[] = [];
        ctx.effect(() => () => {
          world.removeSystem(world.scheduleToken('Update'), 'execution-particle-kernel');
          for (const entity of spawned.reverse()) world.despawn(entity);
        }, 'demo/execution-world');
        if (telemetry) {
          const material = world.allocSharedRef(
            'MaterialAsset',
            Materials.unlit([0.1, 0.7, 0.95, 1]),
          );
          spawned.push(
            world
              .spawn(
                { component: Transform, data: { pos: [0, 0, 0], scale: [1, 1, 1] } },
                { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
                { component: MeshRenderer, data: { materials: [material] } },
              )
              .unwrap(),
          );
          spawned.push(
            world
              .spawn(
                { component: Transform, data: { pos: [0, 0, 5] } },
                { component: Camera, data: { fov: 60, aspect: 16 / 9 } },
              )
              .unwrap(),
          );
          spawned.push(
            world
              .spawn({
                component: DirectionalLight,
                data: { direction: [-0.4, -0.7, -1], color: [1, 1, 1], intensity: 1.2 },
              })
              .unwrap(),
          );
        }

        for (let index = 0; index < PARTICLE_COUNT; index += 1) {
          spawned.push(
            world
              .spawn({
                component: ExecutionParticle,
                data: {
                  x: index / PARTICLE_COUNT,
                  y: (PARTICLE_COUNT - index) / PARTICLE_COUNT,
                },
              })
              .unwrap(),
          );
        }
        const kernel = createExecutionKernel(faultArmed ? faultKernelUrl : normalKernelUrl);
        world.addSystem(world.scheduleToken('Update'), kernel).unwrap();
        if (!faultRequested || faultArmed) shouldFault = false;
      },
    },
  ],
});

export default bootstrap;
