import { assembleRuntimePacks, createAssetRuntimeAssembly } from '@forgeax/engine/app';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine/assets-runtime';
import { createWorldContext, World } from '@forgeax/engine/ecs';
import { prepareRuntimePackContent } from '@forgeax/engine/import';
import { preparePackProgram } from '@forgeax/engine/pack/runtime';
import { AssetGuid, definePackageId } from '@forgeax/engine/pack/source';
import { createToolApiPlugin, startNativePlugin, startPluginAsset } from '@forgeax/engine/plugin';
import { ShaderRegistry } from '@forgeax/engine/shader';
import { createRuntimePackOptions } from './runtime-packs';

export async function runTools(delivery, saved) {
  const context = await createWorldContext(new World(), []);
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const assembly = createAssetRuntimeAssembly(assets, {
    catalogSource: createCatalogSource({ entries: [] }),
  }).unwrap();
  context.provide('assets', assets);
  context.provide('pluginPrograms', {
    sessionId: 'tools',
    contextId: 'engine',
    sessionGeneration: 1,
    target: 'engine',
    definitions: new Map(),
    programs: new Map(),
    tools: new Map(),
  });
  const options = await createRuntimePackOptions('inline-tools', delivery);
  const runtime = assembleRuntimePacks(context, assembly, options);
  const packageId = '01900000-0000-7000-8000-000000000993';
  const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'plugin'));
  try {
    if (saved) (await runtime.producer.restore(saved)).unwrap();
    else {
      const modules = {
        'plugin.js': `import { registerAssetTools } from '@forgeax/engine/plugin';
          import { state } from './shared.js';
          globalThis.inlinePluginEvaluated = true;
          export default { inject: ['toolApi'], apply(ctx) {
            ctx.effect(() => { state.active++; return () => { state.active--; }; });
            ctx.effect(() => registerAssetTools(ctx));
          } };`,
        'executor.js': `import { state } from './shared.js'; globalThis.inlineExecutorEvaluated = true;
          export const run = (args) => ({ value: args.value + 1, active: state.active });`,
        'shared.js': 'export const state = { active: 0 };',
      };
      const select = (entry, name) => ({
        artifact: preparePackProgram({
          entry,
          export: name,
          modules,
          imports: {
            '@forgeax/engine/plugin': options.imports['@forgeax/engine/plugin'].identity,
          },
        }).unwrap(),
      });
      const content = (
        await prepareRuntimePackContent(
          packageId,
          {
            plugin: {
              kind: 'plugin',
              module: { specifier: './plugin.js' },
              toolContract: {
                schemaVersion: '1.0.0',
                commands: [
                  {
                    id: 'browser.inline',
                    title: 'Inline',
                    summary: '',
                    realm: 'engine',
                    executor: './executor.js',
                    exportName: 'run',
                  },
                ],
              },
            },
          },
          {
            programs: {
              plugin: select('plugin.js', 'default'),
              executor: select('executor.js', 'run'),
            },
          },
        )
      ).unwrap();
      (await runtime.producer.admit(content)).unwrap();
    }
    (await assets.readPluginDefinition(guid)).unwrap();
    const lazyAdmission =
      globalThis.inlinePluginEvaluated !== true && globalThis.inlineExecutorEvaluated !== true;
    (await startNativePlugin(context, createToolApiPlugin())).unwrap();
    const fiber = (await startPluginAsset(context, guid)).unwrap();
    const lazyExecutor = globalThis.inlineExecutorEvaluated !== true;
    const terminal = await context.toolApi.run('browser.inline', { value: 41 }).terminal;
    const snapshot = runtime.producer.snapshot();
    runtime.producer.withdraw(packageId);
    const pinned = await context.toolApi.run('browser.inline', { value: 7 }).terminal;
    await fiber.dispose();
    const retired = await context.toolApi.run('browser.inline', { value: 0 }).terminal;
    return {
      lazyAdmission,
      lazyExecutor,
      terminal: terminal.result,
      pinned: pinned.result,
      retired: retired.outcome,
      snapshot,
    };
  } finally {
    await context.fiber.dispose();
    assembly.dispose();
  }
}
