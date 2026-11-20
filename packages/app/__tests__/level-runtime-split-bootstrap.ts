import physics3d from '@forgeax/engine-physics-rapier3d';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';
import { installLevelFixture, levelFixtureError } from './level-runtime.fixture';

const entry: ExecutionBootstrapEntry = (source) => ({
  plugins: [
    physics3d,
    {
      name: 'split-Level-source',
      inject: ['world', 'assets', 'physics', 'executionBootstrapHost'],
      apply(ctx) {
        const { world, assets, physics, executionBootstrapHost } = ctx;
        const port = executionBootstrapHost.port;
        const owner = executionBootstrapHost.levelCandidates;
        const { rootGuid, firstLevel } = source as { rootGuid: string; firstLevel?: boolean };
        if (port === undefined || owner === undefined)
          throw Error('Missing split Level owner or diagnostics port');
        const fixture = installLevelFixture(world, assets, physics, owner, rootGuid, firstLevel);
        port.onmessage = async ({ data }: MessageEvent<{ id: number; kind: string }>) => {
          try {
            port.postMessage({ id: data.id, ...await fixture.request(data.kind) });
          } catch (cause) {
            port.postMessage({ id: data.id, error: levelFixtureError(cause) });
          }
        };
        return () => {
          port.onmessage = null;
          fixture.dispose();
        };
      },
    },
  ],
});

export default entry;
