import physics3d, { RapierPhysicsWorld3D } from '@forgeax/engine-physics-rapier3d';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';
import { installLevelFixture, levelFixtureError } from './level-runtime.fixture';

import { installDerivedStreamingFixture } from './world-streaming-derived.fixture';

type Bootstrap = {
  rootGuid: string;
  firstLevel?: boolean;
  liveSkin?: boolean;
  runtimePacks?: { scopeId: string; baseUrl: string };
};

const entry: ExecutionBootstrapEntry = (source) => {
  const { rootGuid, firstLevel, liveSkin, runtimePacks } = source as Bootstrap;
  return {
  ...(runtimePacks === undefined ? {} : {
    runtimePacks,
    pluginPrograms: {
      sessionId: 'world-streaming-fixture', contextId: 'engine', sessionGeneration: 1, target: 'engine',
      definitions: new Map(), programs: new Map(), tools: new Map(),
    },
  }),

  plugins: [
    physics3d,
    {
      name: 'split-Level-source',
      inject: ['world', 'assets', 'physics', 'levels', 'executionBootstrapHost',
        ...(runtimePacks === undefined ? [] : ['runtimePacks'])],
      apply(ctx) {
        const { world, assets, physics, levels, executionBootstrapHost } = ctx;
        const port = executionBootstrapHost.port;
        if (port === undefined) throw Error('Missing split Level diagnostics port');
        const fixture = installLevelFixture(world, assets, physics, levels, rootGuid, firstLevel, liveSkin);
        const derived = runtimePacks !== undefined && ctx.runtimePacks && physics instanceof RapierPhysicsWorld3D
          ? installDerivedStreamingFixture(world, physics, levels, ctx.runtimePacks.producer) : undefined;
        const receive = async ({ data }: MessageEvent<{ id: number; kind: string }>) => {
          try {
            if (data.kind === 'poison-world') {
              const fault = world.withFrameArena(() => {
                throw Error('Injected failure in the World frame arena');
              });
              if (fault.ok || world.execution.health !== 'poisoned')
                throw Error('The World accepted the failed frame arena');
              port.postMessage({ id: data.id });
              return;
            }
            if (data.kind.startsWith('derived-') && derived !== undefined) {
              const result = derived.request(data.kind);
              if (result.derived.error !== undefined) throw result.derived.error;
              port.postMessage({ id: data.id, ...result });
            } else port.postMessage({ id: data.id, ...await fixture.request(data.kind) });
          } catch (cause) {
            port.postMessage({ id: data.id, error: levelFixtureError(cause) });
          }
        };
        port.addEventListener('message', receive);
        port.start();
        return () => {
          port.removeEventListener('message', receive);
          derived?.dispose();
          fixture.dispose();
        };
      },
    },
  ],
  };
};

export default entry;
