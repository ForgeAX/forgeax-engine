import { vec3 } from '../../packages/math/dist/index.mjs';
import physics3d, { RapierPhysicsWorld3D } from '../../packages/physics-rapier3d/dist/index.mjs';
import {
  installBenchmarkWorld,
  registerBenchmarkVocabulary,
  sourceFacts,
} from './level-streaming-world.mjs';

export default function splitLevelBenchmark(input) {
  return {
    plugins: [
      physics3d,
      {
        name: 'split-level-benchmark',
        inject: ['world', 'assets', 'physics', 'executionBootstrapHost'],
        apply({ world, assets, physics, executionBootstrapHost }) {
          const { port, levelCandidates } = executionBootstrapHost;
          if (
            !(physics instanceof RapierPhysicsWorld3D) ||
            port === undefined ||
            levelCandidates === undefined
          )
            throw Error('The benchmark requires the real Engine Worker Level and Rapier owners');
          registerBenchmarkVocabulary(world);
          const probe = installBenchmarkWorld(world, input.profile, input.traceLogic);
          const levels = new Map();
          let scene;
          let next = 0;
          const inspect = (id) => {
            const status = levels.get(id)?.inspect();
            if (status === undefined) throw Error(`Unknown Level ${id}`);
            if (status.failure !== undefined) throw status.failure;
            if (status.cleanupFailure !== undefined) throw status.cleanupFailure;
            return {
              phase: status.phase,
              current: status.current,
              render: status.render?.phase,
              members: status.members,
              waiting: status.pending !== undefined,
              renderSelection: status.renderSelection,
            };
          };
          const raycast = () => physics.raycast(vec3.create(0, 10, 0), vec3.create(0, -1, 0), 20);
          const dispatch = async ({ kind, id, ids, target }) => {
            switch (kind) {
              case 'load':
                scene = (await assets.load(input.rootGuid, 'scene')).unwrap();
                return;
              case 'logic-timing':
                return probe.logicTiming();
              case 'read':
                return {
                  updates: probe.updates(),
                  fixedSteps: probe.fixedSteps(),
                  levelWork: levelCandidates.inspect().costs,
                  bodies: physics.getBodyCount(),
                  levels: ids.map(inspect),
                  hit: raycast()?.entity,
                };
              case 'create': {
                const id = ++next;
                levels.set(id, levelCandidates.create(scene).unwrap());
                return id;
              }
              case 'target':
                levels.get(id).target(target).unwrap();
                return;
              case 'facts':
                return sourceFacts(world, levels.get(id), input.profile, input.producer);
              case 'retired':
                for (const id of ids) {
                  if (inspect(id).phase !== 'retired') throw Error(`Level ${id} still owns rows`);
                  levels.delete(id);
                }
                return physics.getBodyCount();
              case 'release':
                if (levels.size !== 0) throw Error('The benchmark still owns Levels');
                assets.release(scene).unwrap();
                scene = undefined;
                return;
              default:
                throw Error(`Unknown Level benchmark request ${kind}`);
            }
          };
          port.onmessage = async ({ data: { request, ...operation } }) => {
            try {
              port.postMessage({ request, value: await dispatch(operation) });
            } catch (cause) {
              port.postMessage({ request, error: serializeError(cause) });
            }
          };
          return () => {
            port.onmessage = null;
          };
        },
      },
    ],
  };
}

function serializeError(error, depth = 0) {
  return {
    name: error?.name,
    message: error?.message ?? String(error),
    stack: error?.stack,
    code: error?.code,
    ...(error?.cause === undefined || depth >= 6
      ? {}
      : { cause: serializeError(error.cause, depth + 1) }),
  };
}
