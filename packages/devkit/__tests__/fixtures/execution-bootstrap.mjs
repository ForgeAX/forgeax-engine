import { scenePublicationFenceFromCatalog } from '@forgeax/engine/assets-runtime';
import { Update, defineSystem } from '@forgeax/engine/ecs';
import { meshAttributeWindow } from '@forgeax/engine/geometry';
import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import {
  AssetGuid,
  definePackageId,
  projectScriptablePackSceneComponents,
} from '@forgeax/engine/pack/source';
import { pick, pickTriangle } from '@forgeax/engine/picking';
import { createToolApiPlugin, inspectPluginFiber, startPluginAsset } from '@forgeax/engine/plugin';
import {
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
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
const replacementId = '01900000-0000-7000-8000-000000000993';
const guid = (key, owner = instanceId) => AssetGuid.format(AssetGuid.derive(definePackageId(owner), key));

export default async function bootstrap(data) {
  const sceneGroup = __FORGEAX_TEST_SCENE_GROUP__
    ? await import('./runtime-pack-scene-group.mjs')
    : undefined;
  const measureReplacement = data.replacementMemoryChannel !== undefined;
  const taskBackings = [];
  const gpuBuffers = [];
  const memoryPort = measureReplacement ? new BroadcastChannel(data.replacementMemoryChannel) : undefined;
  if (memoryPort) memoryPort.onmessage = ({ data }) => {
    if (data.kind === 'allocate' || data.kind === 'destroy') gpuBuffers.push(data);
    else taskBackings.push(data);
  };
  let renderWorker;
  let measuredAssets;
  const transfers = [];
  const reservations = new Map();
  const drawTraffic = { frames: 0, assetTransfers: [] };
  const frameTimings = { submitted: [], completed: [] };
  function observeRenderTransport(worker) {
    const send = worker.postMessage.bind(worker);
    worker.postMessage = (message, transfer) => {
      if (message.kind === 'mesh-reserve') {
        reservations.set(message.requestId, { requestedMs: performance.now() });
      }
      if (message.kind === 'draw' && Array.isArray(transfer)) {
        drawTraffic.frames++;
        const buffers = [...new Set(transfer.filter((value) =>
          value instanceof ArrayBuffer && value !== message.publication.record,
        ))];
        const before = buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
        send(message, transfer);
        if (before > 0) drawTraffic.assetTransfers.push({
          frameId: message.frameId,
          before,
          after: buffers.reduce((total, buffer) => total + buffer.byteLength, 0),
        });
        return;
      }
      if (message.kind !== 'mesh-prepare' || !Array.isArray(transfer)) {
        send(message, transfer);
        return;
      }
      const buffers = [...new Set(transfer.filter((value) => value instanceof ArrayBuffer))];
      const bytes = () => buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
      const before = bytes();
      const engine = measuredAssets.meshCpuResidency(message.input.meshHandle).unwrap();
      const reservation = reservations.get(message.requestId);
      reservations.delete(message.requestId);
      const sentMs = performance.now();
      send(message, transfer);
      transfers.push({ requestId: message.requestId, before, after: bytes(), sentMs, engine, reservation });
    };
    worker.addEventListener('message', ({ data }) => {
      if (data.kind === 'mesh-reserved') {
        const reservation = reservations.get(data.requestId);
        if (reservation && data.result.ok) reservation.confirmedMs = performance.now();
        else reservations.delete(data.requestId);
      }
      if (data.kind === 'submitted' || data.kind === 'completed') {
        const { frameId, deviceGeneration, renderSubmitToCompleteMs } = data.frame;
        frameTimings[data.kind].push({
          frameId, deviceGeneration, observedMs: performance.now(), renderSubmitToCompleteMs,
        });
      }
      if (data.kind !== 'mesh-ready' || !data.result.ok) return;
      const sent = transfers.find((row) => row.requestId === data.requestId);
      if (sent) sent.acceptedMs = performance.now();
    });
  }
  if (data.splitRender) {
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (options?.name !== 'forgeax-render') return;
        renderWorker = this;
        if (measureReplacement) observeRenderTransport(this);
      }
    };
  }
  // Consumer Engine capabilities arrive before any agent program, including
  // the geometry module needed by a subsequent offline generation.
  await import('@forgeax/engine/geometry');
  const lifetime = new AbortController();
  const options = {
    ...(await createRuntimePackOptions(
      'worker-browser',
      createRuntimePackDeliveryClient(data.channel, lifetime.signal),
    )),
    ...(measureReplacement ? {} : { cache: new Map() }),
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
      ...(sceneGroup === undefined ? [] : [sceneGroup.physicsPlugin]),
      createToolApiPlugin(),
      {
        name: 'runtime-pack-worker-consumer',
        inject: [
          'world',
          'assets',
          'levels',
          'runtimePacks',
          'pluginPrograms',
          'toolApi',
          'executionBootstrapHost',
          ...(sceneGroup === undefined ? [] : ['physics']),
        ],
        apply(ctx) {
          const world = ctx.world;
          const runtime = ctx.runtimePacks;
          const port = ctx.executionBootstrapHost.port;
          if (measureReplacement) measuredAssets = ctx.assets;
          let root;
          let generatedLevel;
          let installed;
          let visual;
          let visualEntity;
          let replacement;
          const camera = world
            .spawn(
              { component: Transform, data: { pos: [0, 0, 9] } },
              {
                component: Camera,
                data: {
                  ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }),
                  ...(sceneGroup === undefined ? {} : {
                    antialias: ANTIALIAS_NONE, bloom: BLOOM_DISABLED, tonemap: 0,
                  }),
                },
              },
            )
            .unwrap();
          const light = world
            .spawn(
              { component: Transform, data: {} },
              {
                component: DirectionalLight,
                data: { castShadow: sceneGroup === undefined, intensity: 3, direction: [-0.5, -1, -0.3], color: [1, 1, 1] },
              },
            )
            .unwrap();
          const unrelated = world
            .spawn({ component: Transform, data: { pos: [12, 3, 1] } })
            .unwrap();
          let gameTicks = 0;
          let lastMeasuredTick;
          let tickGaps;
          const game = defineSystem({
            name: 'unrelated-gameplay',
            queries: [],
            fn() {
              gameTicks++;
              if (tickGaps !== undefined) {
                const now = performance.now();
                if (lastMeasuredTick !== undefined) tickGaps.push(now - lastMeasuredTick);
                lastMeasuredTick = now;
              }
            },
          });
          ctx.effect(() => {
            world.addSystem(Update, game).unwrap();
            return () => world.removeSystem(Update, game).unwrap();
          });
          if (!data.splitRender) ctx.effect(() =>
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
                : ctx.assets.read(world.get(member, MeshFilter).unwrap().assetHandle).unwrap();
            const positions = mesh && meshAttributeWindow(mesh, 'position');
            const xs = positions && Array.from({ length: positions.count }, (_, index) =>
              positions.data[positions.offset + index * positions.stride],
            );
            return {
              world: world.identity,
              gameTicks,
              unrelated: Array.from(world.get(unrelated, Transform).unwrap().pos),
              width: xs && Math.max(...xs) - Math.min(...xs),
              typed:
                mesh &&
                positions?.data instanceof Float32Array &&
                ArrayBuffer.isView(mesh.indices),
              frames,
              renderer: renderer?.state(),
              refs: world.sharedRefs._liveCount(),
              packs: runtime.producer.inspect().packs.length,
              programs: ctx.pluginPrograms.programs.size,
              builds: globalThis.workerBuilds ?? 0,
              pluginTicks: globalThis.workerPluginTicks ?? 0,
              pluginActive: globalThis.workerPluginActive ?? 0,
            };
          };
          const inspectVisual = () => {
            const assets = ctx.assets;
            const residency = assets.meshCpuResidency(visual).unwrap();
            const read = residency.mode === 'render' ? assets.read(visual) : undefined;
            return {
              handle: visual,
              revision: assets.revision(visual).unwrap(),
              guid: assets.guidOf(visual),
              read: read === undefined || read.ok ? 'available' : read.error.code,
              residency,
            };
          };
          const group = sceneGroup?.runtimePackSceneGroup(
            ctx,
            async (replacement = false) => {
              const owner = replacement ? replacementId : instanceId;
              const handles = (await ctx.assets.loadMany(
                [guid('box', owner), guid('peer', owner)], 'mesh',
              )).unwrap();
              return {
                handles,
                publications: handles.map((handle) => ctx.assets.source(handle).unwrap()?.publication),
              };
            },
            () => renderWorker,
          );
          const commands = {
            ...group?.commands,
            inspect,
            async requestGeneratedLevel(target) {
              generatedLevel ??= ctx.levels.create({ scene: guid('scene') }).unwrap();
              return (await generatedLevel.request(target).unwrap().done).unwrap();
            },
            async catalogRows() {
              return (await ctx.assets.enumerateCatalog()).unwrap();
            },
            sources(language, execution = 'engine', meshMiB = 0) {
              const imports = Object.fromEntries(
                (sceneGroup === undefined
                  ? ['geometry', 'pack/source', 'render', 'scene', 'plugin', 'ecs']
                  : ['geometry']).map((path) => {
                  const key = `@forgeax/engine/${path}`;
                  return [key, options.imports[key].identity];
                }),
              );
              const build = `build.${language}`,
                behavior = `behavior.${language}`,
                executor = `executor.${language}`;
              const typed = language === 'ts' ? ': any' : '';
              if (sceneGroup !== undefined) {
                const modules = {
                  [build]: `import { createBoxGeometry } from '@forgeax/engine/geometry';
                    export async function build({ values, task }${typed}) {
                      if (globalThis.name !== 'forgeax-task' || !task)
                        throw new Error('Scene group generation must run in the Task Worker');
                      await task.yield();
                      const mesh = () => createBoxGeometry(values.width, 2, 2).unwrap();
                      return { ok: true, value: { box: mesh(), peer: mesh() } };
                    }`,
                };
                return { build: { entry: build, export: 'build', imports, modules } };
              }
              const modules = {
                [build]: `import { createBoxGeometry, interleavedMesh } from '@forgeax/engine/geometry';
                import { AssetGuid } from '@forgeax/engine/pack/source';
                export async function build({ packageId, values, task }${typed}) {
                  const inTaskWorker = globalThis.name === 'forgeax-task';
                  if (inTaskWorker !== ${execution === 'task-worker'} || !!task !== inTaskWorker)
                    throw new Error('Runtime Pack generator executed in the wrong realm');
                  if (task) await task.yield();
                  globalThis.workerBuilds = (globalThis.workerBuilds ?? 0) + 1;
                  let box = createBoxGeometry(values.width, 2, 2).unwrap();
                  if (${meshMiB} > 0) {
                    box = interleavedMesh(box);
                    const wordsPerVertex = box.vertices.length / 24;
                    const rows = Math.floor(${meshMiB} * 1024 * 1024 / (4 * wordsPerVertex));
                    const vertices = new Float32Array(rows * wordsPerVertex);
                    vertices.set(box.vertices);
                    box = { ...box, vertices };
                  }
                  if (values.pause) {
                    const gate = new BroadcastChannel(${JSON.stringify(`${data.channel}-mesh-allocated`)});
                    try {
                      gate.postMessage(box.vertices.byteLength);
                      while (!task.aborted) await new Promise((done) => setTimeout(done, 10));
                    } finally {
                      gate.close();
                    }
                    throw new Error('fixture observed task cancellation');
                  }
                  return { ok: true, value: {
                    box,
                    scene: { kind: 'scene', entities: { box: { components: { Transform: { pos: [0, 0, 0] }, MeshFilter: { assetHandle: AssetGuid.format(AssetGuid.derive(packageId, 'box')) }, MeshRenderer: {} } } } },
                    behavior: { kind: 'plugin', module: { specifier: './${behavior}' }, toolContract: { schemaVersion: '1.0.0', commands: [{ id: 'worker.generated', title: 'Generated', summary: '', realm: 'engine', executor: values.broken ? './missing.js' : './${executor}', exportName: 'run' }] } }
                  } };
                }`,
                [behavior]: `import { Update, defineSystem } from '@forgeax/engine/ecs';
                import { registerAssetTools } from '@forgeax/engine/plugin';
                import { state } from './shared.js';
                globalThis.workerPluginEvaluated = true;
                export default { inject: ['world', 'toolApi'], apply(ctx${typed}) {
                  ctx.effect(() => registerAssetTools(ctx));
                  ctx.effect(() => {
                    state.active++; globalThis.workerPluginActive = state.active;
                    const system = defineSystem({ name: 'generated-runtime-behavior', queries: [], fn() { globalThis.workerPluginTicks = (globalThis.workerPluginTicks ?? 0) + 1; } });
                    ctx.world.addSystem(Update, system).unwrap();
                    return () => { ctx.world.removeSystem(Update, system).unwrap(); state.active--; globalThis.workerPluginActive = state.active; };
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
            async admit(programs, language, execution = 'engine') {
              (
                await runtime.producer.admit({
                  source: {
                    schemaVersion: '2.0.0',
                    kind: 'scriptable-pack-source',
                    source: `build.${language}`,
                    packageId: generatorId,
                    program: 'build',
                    runtime: {
                      dependencies: [],
                      ...(execution === 'task-worker' ? { execution } : {}),
                    },
                    parameters: [
                      { name: 'width', type: 'f32', default: 2, minimum: 1, maximum: 5 },
                      { name: 'broken', type: 'bool', default: false },
                      { name: 'pause', type: 'bool', default: false },
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
            async taskPressure(width) {
              const trace = globalThis.runtimePackTaskPressure;
              if (!trace?.pool || trace.pool.mode !== 'worker')
                throw new Error('Expected the execution realm to own a live Task Worker pool');
              const response = await fetch(data.pressureUrl);
              if (!response.ok) throw new Error('KTX2 pressure fixture unavailable');
              const encoded = new Uint8Array(await response.arrayBuffer());
              const transcode = async () => {
                const data = encoded.slice();
                const result = await trace.pool.submit(
                  'ktx2.transcode', { encoding: 'ktx2', data, target: 'rgba8unorm' },
                  { transfer: [data.buffer] },
                ).result;
                if (!result.ok) throw result.error;
                const { width, height, format, levels, data: pixels } = result.value;
                return { width, height, format, levels: levels.length, bytes: pixels.byteLength };
              };
              await transcode();
              const rows = [];
              trace.rows = rows;
              this.startTickSample();
              try {
                const textures = Array.from({ length: 8 }, transcode);
                const [generated, transcoded] = await Promise.all([
                  this.generate(width), Promise.all(textures),
                ]);
                return {
                  generated, transcoded, rows, tickGaps: this.finishTickSample(),
                  encodedBytes: encoded.byteLength,
                };
              } finally {
                trace.rows = undefined;
              }
            },
            async cancelBuildAfterMesh() {
              const before = JSON.stringify(runtime.producer.rows());
              const gate = new BroadcastChannel(`${data.channel}-mesh-allocated`);
              const controller = new AbortController();
              let deadline;
              const allocated = new Promise((resolve, reject) => {
                gate.onmessage = (event) => resolve(event.data);
                deadline = setTimeout(() => reject(new Error('Task Worker allocation timed out')), 30000);
              });
              const building = runtime.producer.generate({
                schemaVersion: '3.0.0', packageId: instanceId, parent: generatorId,
                values: { width: 3, broken: false, pause: true },
              }, controller.signal);
              try {
                const bytes = await Promise.race([
                  allocated,
                  building.then(() => { throw new Error('generation settled before cancellation'); }),
                ]);
                controller.abort();
                const stopped = await building;
                return {
                  bytes,
                  code: stopped.ok ? 'published' : stopped.error.code,
                  previousPublication: JSON.stringify(runtime.producer.rows()) === before,
                };
              } finally {
                controller.abort();
                clearTimeout(deadline);
                gate.close();
              }
            },
            async failTaskProgram() {
              const before = JSON.stringify(runtime.producer.rows());
              const packageId = '01900000-0000-7000-8000-000000000993';
              const instance = '01900000-0000-7000-8000-000000000994';
              const program = 'worker-failed-build';
              const artifact = preparePackProgram({
                entry: 'failure.js', export: 'build',
                modules: {
                  'failure.js': `
                    if (globalThis.name !== 'forgeax-task')
                      throw new Error('fixture evaluated generator module outside its Task Worker');
                    throw new Error('fixture worker module evaluation failed');
                    export function build() {}
                  `,
                },
              }).unwrap();
              (await runtime.producer.admit({
                source: {
                  schemaVersion: '2.0.0', kind: 'scriptable-pack-source',
                  source: 'failure.js', packageId, program,
                  runtime: { dependencies: [], execution: 'task-worker' },
                  parameters: [{ name: 'width', type: 'f32', default: 2, minimum: 1, maximum: 5 }],
                },
                programs: { [program]: { artifact } },
              })).unwrap();
              try {
                const result = await runtime.producer.generate({
                  schemaVersion: '3.0.0', packageId: instance, parent: packageId, values: { width: 2 },
                });
                return {
                  code: result.ok ? 'published' : result.error.code,
                  cause: result.ok ? undefined : result.error.detail.cause?.message,
                  previousPublication: JSON.stringify(runtime.producer.rows()) === before,
                };
              } finally {
                runtime.producer.withdraw(packageId);
              }
            },
            async mountVisual(usage = 'render') {
              const assets = ctx.assets;
              visual = (await assets.load(guid('box'), 'mesh', usage === 'render' ? { usage } : {})).unwrap();
              visualEntity = world.spawn(
                { component: Transform, data: {} },
                { component: MeshFilter, data: { assetHandle: visual } },
                { component: MeshRenderer, data: {} },
              ).unwrap();
              return inspectVisual();
            },
            beginReplacementMeasurement() {
              const trace = globalThis.runtimePackTaskPressure;
              if (trace === undefined) throw new Error('Expected Task Worker transport observation');
              trace.rows = [];
              transfers.length = 0;
              reservations.clear();
              drawTraffic.frames = 0;
              drawTraffic.assetTransfers.length = 0;
              frameTimings.submitted.length = 0;
              frameTimings.completed.length = 0;
            },
            markReplacementFrameWindow() {
              return {
                observedMs: performance.now(),
                submitted: frameTimings.submitted.length,
                completed: frameTimings.completed.length,
              };
            },
            readReplacementFrameTimings() {
              return frameTimings;
            },
            readTaskBackings() {
              return taskBackings;
            },
            readDrawTraffic() {
              return drawTraffic;
            },
            readGpuBuffers() {
              return gpuBuffers;
            },
            async generateReplacement() {
              const result = await runtime.producer.generate({
                schemaVersion: '3.0.0', packageId: replacementId, parent: generatorId,
                values: { width: 4, broken: false },
              });
              return result.ok ? { ok: true } : { ok: false, error: result.error };
            },
            async stageReplacement(usage) {
              const assets = ctx.assets;
              const loadStartedMs = performance.now();
              replacement = (await assets.load(guid('box', replacementId), 'mesh',
                usage === 'render' ? { usage } : {},
              )).unwrap();
              return {
                loadStartedMs,
                loadCompletedMs: performance.now(),
                old: assets.meshCpuResidency(visual).unwrap(),
                next: assets.meshCpuResidency(replacement).unwrap(),
                sourceDecoded: [instanceId, replacementId].map((id) =>
                  assets.inspectSource()?.ready.includes(guid('box', id)),
                ),
                task: globalThis.runtimePackTaskPressure.rows,
                transfers,
              };
            },
            commitStagedReplacement() {
              if (replacement === undefined) throw new Error('Expected a prepared replacement');
              world.set(visualEntity, MeshFilter, { assetHandle: replacement }).unwrap();
              ctx.assets.release(visual).unwrap();
              runtime.producer.withdraw(instanceId);
              if (!ctx.assets.unload(guid('box')).unwrap())
                throw new Error('The replaced Mesh still has a runtime holder');
              visual = replacement;
              replacement = undefined;
              return inspectVisual();
            },
            startTickSample() {
              tickGaps = [];
              lastMeasuredTick = undefined;
            },
            finishTickSample() {
              const rawMs = tickGaps;
              const sorted = [...rawMs].sort((a, b) => a - b);
              const percentile = (fraction) => sorted[Math.ceil(sorted.length * fraction) - 1];
              tickGaps = undefined;
              return {
                samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95),
                p99: percentile(0.99), max: sorted.at(-1), rawMs,
              };
            },
            meshSourceReady(useReplacement = false) {
              const owner = useReplacement ? replacementId : instanceId;
              return ctx.assets.inspectSource()?.ready.includes(guid('box', owner));
            },
            inspectVisual,
            terminateRender() {
              const lost = renderWorker;
              if (lost === undefined) throw new Error('the fixture must own the live Render Worker');
              lost.terminate();
              // The browser does not emit an error for an owner-initiated termination.
              lost.dispatchEvent(new ErrorEvent('error', { message: 'fixture terminated Render Worker' }));
            },
            visualEntity() { return visualEntity; },
            pickVisual() {
              const result = pickTriangle(world, camera, 192, 192, 384, 384);
              return {
                status: result.status,
                reason: result.reason,
                boundsHit: pick(world, camera, 192, 192, 384, 384) !== undefined,
              };
            },
            async readVisual() {
              const assets = ctx.assets;
              const full = (await assets.load(guid('box'), 'mesh')).unwrap();
              const mesh = assets.read(visual).unwrap();
              const result = {
                handle: full,
                revision: assets.revision(full).unwrap(),
                typed: mesh.vertices instanceof Float32Array && ArrayBuffer.isView(mesh.indices),
              };
              assets.release(full).unwrap();
              return result;
            },
            async reloadVisual() {
              const assets = ctx.assets;
              (await assets.reload(visual, { conflict: 'reject' })).unwrap();
              const mesh = assets.read(visual).unwrap();
              return {
                ...inspectVisual(),
                width: mesh.aabb[3] - mesh.aabb[0],
              };
            },
            async replace() {
              const assets = ctx.assets;
              const fence = scenePublicationFenceFromCatalog(
                (await assets.enumerateCatalog()).unwrap(),
                guid('scene'),
              ).unwrap();
              const grant = (await assets.load(guid('scene'), 'scene')).unwrap();
              (await assets.reload(grant, { conflict: 'overwrite' })).unwrap();
              let next;
              try {
                next = assets
                  .instantiateWithPublicationFence(grant, world, undefined, fence)
                  .unwrap();
              } finally {
                assets.release(grant).unwrap();
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
            memoryPort?.close();
            port.onmessage = null;
            group?.dispose();
            if (root !== undefined) worldDespawnScene(world, root).unwrap();
            if (visualEntity !== undefined) world.despawn(visualEntity).unwrap();
            if (visual !== undefined) ctx.assets.release(visual).unwrap();
            if (replacement !== undefined) ctx.assets.release(replacement).unwrap();
            for (const entity of [camera, light, unrelated]) world.despawn(entity).unwrap();
          };
        },
      },
    ],
  };
}
