import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine/types';
import { pluginPack } from '@forgeax/engine/vite-plugin-pack';
import { defineFeature } from '../../lab/feature';

const RUNTIME_ID = 'virtual:forgeax/pack-runtime';
const TRANSPORT_ID = 'virtual:forgeax/pack-runtime-transport';

function call(hook: unknown, ...args: unknown[]): unknown {
  const fn =
    typeof hook === 'function' ? hook : (hook as { handler?: unknown } | undefined)?.handler;
  return typeof fn === 'function' ? Reflect.apply(fn, undefined, args) : undefined;
}

function virtualSource(command: 'build' | 'serve', withBinding: boolean) {
  const plugin = pluginPack(
    withBinding
      ? { runtimeBinding: createStandaloneRuntimeAssetBinding('feature-lab-binding') }
      : {},
  );
  call(plugin.configResolved, { base: '/', command });
  return {
    resolved: call(plugin.resolveId, RUNTIME_ID),
    unrelated: call(plugin.resolveId, 'feature-lab-unrelated'),
    source: String(call(plugin.load, RUNTIME_ID)),
  };
}

export default defineFeature({
  title: 'Runtime binding SSOT',
  catalog: 'Runtime binding SSOT',
  kind: 'headless',
  summary:
    'The Pack runtime virtual module carries one scope/generation binding plus lazy import transport in dev, none in build.',
  expect:
    'Dev emits the scoped binding and transport import; build emits the same binding with no transport; unbound build is explicitly empty.',
  run(checks) {
    const binding = createStandaloneRuntimeAssetBinding('feature-lab-binding');
    checks.equal(
      'binding owns scope, generation and scoped catalog URL',
      [binding.scopeId, binding.generation, binding.catalogUrl.endsWith('/catalog.json')],
      ['feature-lab-binding', 1, true],
    );

    const dev = virtualSource('serve', true);
    checks.equal('virtual id resolves to itself', dev.resolved, RUNTIME_ID);
    checks.equal('unrelated ids are left to Vite', dev.unrelated ?? null, null);
    checks.ok(
      'dev module embeds the scope binding',
      dev.source.includes('"scopeId":"feature-lab-binding"') &&
        dev.source.includes('"generation":1'),
    );
    checks.ok(
      'dev module lazily imports the shared transport',
      dev.source.includes(`from '${TRANSPORT_ID}'`) &&
        dev.source.includes('createRuntimeAssetImportTransport'),
    );

    const build = virtualSource('build', true);
    checks.ok(
      'build keeps the same binding',
      build.source.includes('"scopeId":"feature-lab-binding"'),
    );
    checks.ok(
      'build has no dev transport',
      !build.source.includes(TRANSPORT_ID) &&
        build.source.includes('createRuntimeAssetImportTransport() { return undefined; }'),
    );

    const bare = virtualSource('build', false);
    checks.ok(
      'unbound build is explicitly empty, not a fallback',
      bare.source.includes('export const runtimeBinding = undefined'),
    );
  },
});
