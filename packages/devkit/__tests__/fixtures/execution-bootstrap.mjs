import {
  resolveAssetHandle,
  scenePublicationFenceFromCatalog,
} from '@forgeax/engine/assets-runtime';
import { Update } from '@forgeax/engine/ecs';
import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import {
  AssetGuid,
  definePackageId,
  projectScriptablePackSceneComponents,
} from '@forgeax/engine/pack/source';
import { createToolApiPlugin, inspectPluginFiber, startPluginAsset } from '@forgeax/engine/plugin';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine/render';
import { Transform, worldDespawnScene } from '@forgeax/engine/scene';
import { createRuntimePackDeliveryClient, createRuntimePackOptions } from './runtime-packs';

const generatorId = '01900000-0000-7000-8000-000000000991';
const instanceId = '01900000-0000-7000-8000-000000000992';
const guid = (key) => AssetGuid.format(AssetGuid.derive(definePackageId(instanceId), key));

export default async function bootstrap(data) {
  // Consumer Engine capabilities arrive before any agent program, including
  // the geometry module needed by a subsequent offline generation.
  await import('@forgeax/engine/geometry');
  const lifetime = new AbortController();
  const options = {
    ...(await createRuntimePackOptions(
      'worker-browser',
      createRuntimePackDeliveryClient(data.channel, lifetime.signal),
    )),
    cache: new Map(),
  };
  const frames = { submitted: 0, completed: 0, ready: 0, backends: [], errors: [] };
  let renderer;
  return {
    runtimePacks: options,
    pluginPrograms: {
      sessionId: 'worker-browser',
      contextId: 'engine',
      sessionGeneration: 1,
      target: 'engine',
      definitions: new Map(),
      programs: new Map(),
      tools: new Map(),
    },
    configureRenderer(value) {
      renderer = value;
    },
    plugins: [
      createToolApiPlugin(),
      {
        name: 'runtime-pack-worker-consumer',
        inject: [
          'world',
          'assets',
          'runtimePacks',
          'pluginPrograms',
          'toolApi',
          'executionBootstrapHost',
        ],
        apply(ctx) {
          const world = ctx.world;
          const runtime = ctx.runtimePacks;
          const port = ctx.executionBootstrapHost.port;
          let root;
          let installed;
          const camera = world
            .spawn(
              { component: Transform, data: { pos: [0, 0, 9] } },
              {
                component: Camera,
                data: perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }),
              },
            )
            .unwrap();
          const light = world
            .spawn(
              { component: Transform, data: {} },
              {
                component: DirectionalLight,
                data: { intensity: 3, direction: [-0.5, -1, -0.3], color: [1, 1, 1] },
              },
            )
            .unwrap();
          const unrelated = world
            .spawn({ component: Transform, data: { pos: [12, 3, 1] } })
            .unwrap();
          let gameTicks = 0;
          const game = {
            name: 'unrelated-gameplay',
            queries: [],
            fn() {
              gameTicks++;
            },
          };
          ctx.effect(() => {
            world.addSystem(Update, game).unwrap();
            return () => world.removeSystem(Update, game.name).unwrap();
          });
          ctx.effect(() =>
            renderer.subscribe((event) => {
              if (event.kind === 'error') frames.errors.push(event.error);
              if (event.kind !== 'frame-submitted') return;
              frames.submitted++;
              if (!frames.backends.includes(event.receipt.backendId))
                frames.backends.push(event.receipt.backendId);
              void event.receipt.completed.then((result) => {
                if (!result.ok) frames.errors.push(result.error);
                else {
                  frames.completed++;
                  if (event.receipt.presentation === 'ready') frames.ready++;
                }
              });
            }),
          );
          const inspect = () => {
            const member =
              root === undefined
                ? undefined
                : [...world.iterDescendants(root)].find((entity) =>
                    world.hasComponent(entity, MeshFilter),
                  );
            const mesh =
              member === undefined
                ? undefined
                : resolveAssetHandle(
                    world,
                    world.get(member, MeshFilter).unwrap().assetHandle,
                  ).unwrap();
            const xs =
              mesh && Array.from(mesh.attributes.position).filter((_, index) => index % 3 === 0);
            return {
              world: world.identity,
              gameTicks,
              unrelated: Array.from(world.get(unrelated, Transform).unwrap().pos),
              width: xs && Math.max(...xs) - Math.min(...xs),
              typed:
                mesh &&
                mesh.attributes.position instanceof Float32Array &&
                ArrayBuffer.isView(mesh.indices),
              frames,
              renderer: renderer.state(),
              refs: world.sharedRefs._liveCount(),
              packs: runtime.producer.inspect().packs.length,
              programs: ctx.pluginPrograms.programs.size,
              builds: globalThis.workerBuilds ?? 0,
              pluginTicks: globalThis.workerPluginTicks ?? 0,
              pluginActive: globalThis.workerPluginActive ?? 0,
            };
          };
          const commands = {
            inspect,
            sources(language) {
              const imports = Object.fromEntries(
                ['geometry', 'pack/source', 'render', 'scene', 'plugin', 'ecs'].map((path) => {
                  const key = `@forgeax/engine/${path}`;
                  return [key, options.imports[key].identity];
                }),
              );
              const build = `build.${language}`,
                behavior = `behavior.${language}`,
                executor = `executor.${language}`;
              const typed = language === 'ts' ? ': any' : '';
              const modules = {
                [build]: `import { createBoxGeometry } from '@forgeax/engine/geometry';
                import { AssetGuid } from '@forgeax/engine/pack/source';
                export function build({ packageId, values }${typed}) {
                  globalThis.workerBuilds = (globalThis.workerBuilds ?? 0) + 1;
                  return { ok: true, value: {
                    box: createBoxGeometry(values.width, 2, 2).unwrap(),
                    scene: { kind: 'scene', entities: { box: { components: { Transform: { pos: [0, 0, 0] }, MeshFilter: { assetHandle: AssetGuid.format(AssetGuid.derive(packageId, 'box')) }, MeshRenderer: {} } } } },
                    behavior: { kind: 'plugin', module: { specifier: './${behavior}' }, toolContract: { schemaVersion: '1.0.0', commands: [{ id: 'worker.generated', title: 'Generated', summary: '', realm: 'engine', executor: values.broken ? './missing.js' : './${executor}', exportName: 'run' }] } }
                  } };
                }`,
                [behavior]: `import { Update } from '@forgeax/engine/ecs';
                import { registerAssetTools } from '@forgeax/engine/plugin';
                import { state } from './shared.js';
                globalThis.workerPluginEvaluated = true;
                export default { inject: ['world', 'toolApi'], apply(ctx${typed}) {
                  ctx.effect(() => registerAssetTools(ctx));
                  ctx.effect(() => {
                    state.active++; globalThis.workerPluginActive = state.active;
                    const system = { name: 'generated-runtime-behavior', queries: [], fn() { globalThis.workerPluginTicks = (globalThis.workerPluginTicks ?? 0) + 1; } };
                    ctx.world.addSystem(Update, system).unwrap();
                    return () => { ctx.world.removeSystem(Update, system.name).unwrap(); state.active--; globalThis.workerPluginActive = state.active; };
                  });
                } };`,
                [executor]: `import { state } from './shared.js'; globalThis.workerExecutorEvaluated = true;
                export const run = (args${typed}) => ({ value: args.value + 1, active: state.active });`,
                'shared.js': 'export const state = { active: 0 };',
              };
              return {
                build: { entry: build, export: 'build', imports, modules },
                behavior: { entry: behavior, export: 'default', imports, modules },
                executor: { entry: executor, export: 'run', imports, modules },
              };
            },
            prepareJs(sources) {
              return Object.fromEntries(
                Object.entries(sources).map(([key, source]) => [
                  key,
                  { artifact: preparePackProgram(source).unwrap() },
                ]),
              );
            },
            async admit(programs, language) {
              (
                await runtime.producer.admit({
                  source: {
                    schemaVersion: '2.0.0',
                    kind: 'scriptable-pack-source',
                    source: `build.${language}`,
                    packageId: generatorId,
                    program: 'build',
                    runtime: { dependencies: [] },
                    parameters: [
                      { name: 'width', type: 'f32', default: 2, minimum: 1, maximum: 5 },
                      { name: 'broken', type: 'bool', default: false },
                    ],
                    sceneComponents: projectScriptablePackSceneComponents([
                      Transform,
                      MeshFilter,
                      MeshRenderer,
                    ]),
                  },
                  programs,
                })
              ).unwrap();
            },
            async generate(width, broken = false) {
              const result = await runtime.producer.generate({
                schemaVersion: '3.0.0',
                packageId: instanceId,
                parent: generatorId,
                values: { width, broken },
              });
              return result.ok ? { ok: true } : { ok: false, error: result.error };
            },
            async replace() {
              const assets = ctx.assets;
              const fence = scenePublicationFenceFromCatalog(
                (await assets.enumerateCatalog()).unwrap(),
                guid('scene'),
              ).unwrap();
              const scene = (await assets.loadByGuid(assets.parseGuid(guid('scene')))).unwrap();
              const grant = world.allocSharedRef('SceneAsset', scene);
              let next;
              try {
                next = assets
                  .instantiateWithPublicationFence(grant, world, undefined, fence)
                  .unwrap();
              } finally {
                world.sharedRefs.release(grant).unwrap();
              }
              if (root !== undefined) worldDespawnScene(world, root).unwrap();
              root = next;
              return inspect();
            },
            async install() {
              (await ctx.assets.readPluginDefinition(guid('behavior'))).unwrap();
              const lazy = globalThis.workerPluginEvaluated !== true;
              installed = (await startPluginAsset(ctx, guid('behavior'))).unwrap();
              return {
                lazy,
                lazyExecutor: globalThis.workerExecutorEvaluated !== true,
                active: globalThis.workerPluginActive,
              };
            },
            async tool() {
              return await ctx.toolApi.run('worker.generated', { value: 41 }).terminal;
            },
            async publication() {
              return {
                snapshot: runtime.producer.snapshot(),
                catalog: (await ctx.assets.enumerateCatalog()).unwrap(),
                programs: [...ctx.pluginPrograms.programs.keys()],
                definitions: [...ctx.pluginPrograms.definitions.keys()],
                tools: [...ctx.pluginPrograms.tools.keys()],
              };
            },
            snapshot() {
              return runtime.producer.snapshot();
            },
            async restore(saved) {
              (await runtime.producer.restore(saved)).unwrap();
            },
            withdraw() {
              runtime.producer.withdraw(generatorId);
              return inspect();
            },
            async disposePlugin() {
              await installed.dispose();
              return { state: inspectPluginFiber(installed).state, ...inspect() };
            },
          };
          port.onmessage = async (event) => {
            const { id, method, args } = event.data;
            try {
              port.postMessage({ id, value: await commands[method](...args) });
            } catch (error) {
              port.postMessage({
                id,
                error: JSON.parse(
                  JSON.stringify(error, (_key, value) =>
                    value instanceof Error
                      ? { ...value, message: value.message, stack: value.stack }
                      : value,
                  ),
                ),
              });
            }
          };
          port.start();
          return () => {
            lifetime.abort();
            port.onmessage = null;
            if (root !== undefined) worldDespawnScene(world, root).unwrap();
            for (const entity of [camera, light, unrelated]) world.despawn(entity).unwrap();
          };
        },
      },
    ],
  };
}
