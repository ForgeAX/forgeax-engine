import { createApp } from '@forgeax/engine/app/browser';
import {
  createCatalogSource,
  resolveAssetHandle,
  scenePublicationFenceFromCatalog,
} from '@forgeax/engine/assets-runtime';
import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import {
  AssetGuid,
  definePackageId,
  projectScriptablePackSceneComponents,
} from '@forgeax/engine/pack/source';
import {
  createToolApiPlugin,
  inspectPluginFiber,
  startNativePlugin,
  startPluginAsset,
} from '@forgeax/engine/plugin';
import { MeshFilter } from '@forgeax/engine/render';
import { rhi } from '@forgeax/engine/rhi-null';
import { Transform, worldDespawnScene } from '@forgeax/engine/scene';
import { createRuntimePackOptions, prepareRuntimePackDelivery } from './runtime-packs';

const generatorId = '01900000-0000-7000-8000-000000000981';
const instanceId = '01900000-0000-7000-8000-000000000982';
const guid = (key) => AssetGuid.format(AssetGuid.derive(definePackageId(instanceId), key));
const manifest = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    schemaVersion: '4.0.0',
    receipts: [],
    fragments: [],
    sources: {},
    entries: [],
    materialShaders: [],
  }),
)}`;
let app;
let runtime;
let options;
let root;
let installed;

export async function open() {
  // Offline recovery assumes the consumer has received its Engine capabilities.
  // Geometry is otherwise needed only by the new program, after disconnection.
  await import('@forgeax/engine/geometry');
  options = { ...(await createRuntimePackOptions('app-browser')), cache: new Map() };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  document.body.append(canvas);
  app = (
    await createApp(
      canvas,
      {
        rhi,
        plugins: [createToolApiPlugin()],
        assetCatalog: createCatalogSource({ entries: [] }),
        runtimePacks: options,
        pluginPrograms: {
          sessionId: 'app-browser',
          contextId: 'main',
          sessionGeneration: 1,
          target: 'engine',
          definitions: new Map(),
          programs: new Map(),
          tools: new Map(),
        },
      },
      { shaderManifestUrl: manifest },
    )
  ).unwrap();
  runtime = app.pluginContext.get('runtimePacks');
  if (!runtime || app.assets !== app.pluginContext.assets) throw new Error('App provider missing');
  (
    await startNativePlugin(app.pluginContext, {
      name: 'scene-consumer',
      apply(ctx) {
        ctx.effect(() => () => {
          if (root !== undefined) worldDespawnScene(app.world, root).unwrap();
          root = undefined;
          canvas.remove();
        });
      },
    })
  ).unwrap();
  return {
    packs: runtime.producer.inspect().packs.length,
    programs: app.pluginContext.pluginPrograms.programs.size,
  };
}

// Source is supplied only after App startup, like an agent response. JS stays
// in the browser; the test host converts TS through the real DevKit boundary.
export function sources(language) {
  const build = `build.${language}`;
  const behavior = `behavior.${language}`;
  const executor = `executor.${language}`;
  const imports = Object.fromEntries(
    ['geometry', 'pack/source', 'render', 'scene', 'plugin'].map((path) => {
      const specifier = `@forgeax/engine/${path}`;
      return [specifier, options.imports[specifier].identity];
    }),
  );
  const modules = {
    [build]: `import { createBoxGeometry } from '@forgeax/engine/geometry';
      import { AssetGuid } from '@forgeax/engine/pack/source';
      export function build({ packageId, values }${language === 'ts' ? ': { packageId: any; values: { width: number; broken: boolean } }' : ''}) {
        globalThis.appBuildCalls = (globalThis.appBuildCalls ?? 0) + 1;
        return { ok: true, value: {
          box: createBoxGeometry(values.width, 2, 3).unwrap(),
          scene: { kind: 'scene', entities: { box: { components: {
            Transform: { pos: [2, 0, 0] },
            MeshFilter: { assetHandle: AssetGuid.format(AssetGuid.derive(packageId, 'box')) }
          } } } },
          behavior: { kind: 'plugin', module: { specifier: './${behavior}' },
            toolContract: { schemaVersion: '1.0.0', commands: [{ id: 'app.generated', title: 'Generated', summary: '', realm: 'engine', executor: values.broken ? './missing.js' : './${executor}', exportName: 'run' }] } }
        } };
      }`,
    [executor]: `import { state } from './shared.js';
      globalThis.appExecutorEvaluated = true;
      export const run = (args${language === 'ts' ? ': { value: number }' : ''}) => ({ value: args.value + 1, active: state.active });`,
    'shared.js': 'export const state = { active: 0 };',
    [behavior]: `import { registerAssetTools } from '@forgeax/engine/plugin';
      import { state } from './shared.js';
      import { Transform } from '@forgeax/engine/scene';
      import { MeshFilter } from '@forgeax/engine/render';
      globalThis.appPluginEvaluated = true;
      export default { inject: ['world', 'toolApi'], apply(ctx${language === 'ts' ? ': any' : ''}) {
        const members = [...ctx.world.query({ read: [Transform, MeshFilter] }).unwrap()].length;
        ctx.effect(() => registerAssetTools(ctx));
        ctx.effect(() => {
          state.active++;
          const marker = ctx.world.spawn({ component: Transform, data: { pos: [9, 0, 0] } }).unwrap();
          ctx.world.insertResource('generated-app-plugin', { members, marker });
          return () => { state.active--; ctx.world.despawn(marker).unwrap(); ctx.world.removeResource('generated-app-plugin'); };
        });
      } };`,
  };
  return {
    build: { entry: build, export: 'build', imports, modules },
    behavior: { entry: behavior, export: 'default', imports, modules },
    executor: { entry: executor, export: 'run', imports, modules },
  };
}

export function prepareJs(input) {
  return Object.fromEntries(
    Object.entries(input).map(([key, source]) => [
      key,
      { artifact: preparePackProgram(source).unwrap() },
    ]),
  );
}

export async function admit(programs, language) {
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
        sceneComponents: projectScriptablePackSceneComponents([Transform, MeshFilter]),
      },
      programs,
    })
  ).unwrap();
}

export async function generate(width, broken = false) {
  return runtime.producer.generate({
    schemaVersion: '3.0.0',
    packageId: instanceId,
    parent: generatorId,
    values: { width, broken },
  });
}

export async function replace() {
  const assets = app.assets;
  const rows = (await assets.enumerateCatalog()).unwrap();
  const fence = scenePublicationFenceFromCatalog(rows, guid('scene')).unwrap();
  const scene = (await assets.loadByGuid(assets.parseGuid(guid('scene')))).unwrap();
  const grant = app.world.allocSharedRef('SceneAsset', scene);
  let next;
  try {
    next = assets.instantiateWithPublicationFence(grant, app.world, undefined, fence).unwrap();
  } finally {
    app.world.sharedRefs.release(grant).unwrap();
  }
  if (root !== undefined) worldDespawnScene(app.world, root).unwrap();
  root = next;
  return inspect();
}

export function inspect() {
  const world = app.world;
  const member = [...world.iterDescendants(root)].find((entity) =>
    world.hasComponent(entity, MeshFilter),
  );
  const mesh = resolveAssetHandle(
    world,
    world.get(member, MeshFilter).unwrap().assetHandle,
  ).unwrap();
  const xs = Array.from(mesh.attributes.position).filter((_, index) => index % 3 === 0);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    position: Array.from(world.get(member, Transform).unwrap().pos),
    positions: Array.from(mesh.attributes.position),
    indices: Array.from(mesh.indices),
    typed: mesh.attributes.position instanceof Float32Array && ArrayBuffer.isView(mesh.indices),
    refs: world.sharedRefs._liveCount(),
    rows: runtime.producer.rows(),
  };
}

export async function install() {
  (await app.assets.readPluginDefinition(guid('behavior'))).unwrap();
  const lazy = globalThis.appPluginEvaluated !== true;
  installed = (await startPluginAsset(app.pluginContext, guid('behavior'))).unwrap();
  return {
    lazy,
    lazyExecutor: globalThis.appExecutorEvaluated !== true,
    members: app.world.getResource('generated-app-plugin').members,
  };
}

export const tool = async () =>
  await app.pluginContext.toolApi.run('app.generated', { value: 41 }).terminal;
export const buildCalls = () => globalThis.appBuildCalls ?? 0;
export async function sibling() {
  const packageId = '01900000-0000-7000-8000-000000000983';
  (
    await runtime.producer.generate({
      schemaVersion: '3.0.0',
      packageId,
      parent: generatorId,
      values: { width: 3 },
    })
  ).unwrap();
  const programs = app.pluginContext.pluginPrograms;
  const siblingGuid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'behavior'));
  const both = programs.definitions.has(guid('behavior')) && programs.definitions.has(siblingGuid);
  runtime.producer.withdraw(packageId);
  const remaining = app.pluginContext.pluginPrograms;
  return {
    both,
    original: remaining.definitions.has(guid('behavior')),
    removed: !remaining.definitions.has(siblingGuid),
    programs: [...remaining.programs.keys()].sort(),
  };
}
export async function withdraw() {
  runtime.producer.withdraw(generatorId);
  return {
    programs: app.pluginContext.pluginPrograms.programs.size,
    definitions: app.pluginContext.pluginPrograms.definitions.size,
    tool: await tool(),
  };
}
export const snapshot = () => runtime.producer.snapshot();
export const restore = async (saved) => (await runtime.producer.restore(saved)).unwrap();
export const prepareDelivery = prepareRuntimePackDelivery;

export async function close() {
  const world = app.world;
  const marker = world.getResource('generated-app-plugin')?.marker;
  (await app.dispose()).unwrap();
  return {
    effectRemoved: !world.hasResource('generated-app-plugin'),
    markerRemoved: marker === undefined || !world.hasComponent(marker, Transform),
    refs: world.sharedRefs._liveCount(),
    catalogDetached: !app.assets.hasCatalogSource,
    programs: app.pluginContext.pluginPrograms?.programs.size ?? 0,
    renderer: app.renderer.state(),
    plugin: installed && inspectPluginFiber(installed).state,
  };
}
