import { createBoxGeometry } from '@forgeax/engine-geometry';
import { editorAssistance, MeshFilter } from '@forgeax/engine-render';
import type { ExecutionBootstrapEntry } from '../src/execution/bootstrap-entry';
import baseEntry from './render-worker-bootstrap';

/** The ordinary built-in Feature uses the same fixed asset closure in either render realm. */
const entry: ExecutionBootstrapEntry = async () => {
  const NativeWorker = globalThis.Worker;
  let base: Awaited<ReturnType<typeof baseEntry>>;
  try {
    base = await baseEntry(1);
  } finally {
    if (typeof document !== 'undefined') globalThis.Worker = NativeWorker;
  }
  return {
    ...base,
    plugins: [
      ...(base.plugins ?? []),
      {
        name: 'editor-assistance-worker-fixture',
        inject: ['world', 'assets', 'executionBootstrapHost'],
        apply(ctx) {
          const assets = ctx.assets;
          if (!assets) throw new Error('The source asset owner is required');
          let entity;
          for (const row of ctx.world.query({ with: [MeshFilter] }).unwrap()) {
            entity = row.entity;
            break;
          }
          if (entity === undefined) throw new Error('The authored source mesh is required');
          const count = ctx.world.inspect().entityCount;
          const state = editorAssistance(ctx.world),
            owner = {};
          const mesh = assets.create(createBoxGeometry(1.5, 1.5, 1.5).unwrap()).unwrap();
          state.configure({ enabled: true, depth: 'always' }).unwrap();
          state
            .contribute(owner, [
              {
                kind: 'mesh',
                mesh,
                transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1.2, 0, 2, 1]),
                color: [1, 0, 0, 1],
                depth: 'always',
                action: { kind: 'entity', entity },
              },
            ])
            .unwrap();
          assets.release(mesh).unwrap();
          if (ctx.world.inspect().entityCount !== count)
            throw new Error('Editor helpers must not add source entities');
          ctx.executionBootstrapHost.port?.postMessage({
            kind: 'editor-source',
            entity,
            worldIdentity: ctx.world.identity,
            count: ctx.world.inspect().entityCount,
          });
          return () => {
            state.release(owner);
            state.configure({ enabled: false }).unwrap();
          };
        },
      },
    ],
  };
};
export default entry;
