import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import type { ResolvedConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { pluginPack } from '../plugin-pack';

const VIRTUAL_RUNTIME_ID = 'virtual:forgeax/pack-runtime';
const VIRTUAL_RUNTIME_TRANSPORT_ID = 'virtual:forgeax/pack-runtime-transport';

function virtualPlugin() {
  return pluginPack({
    runtimeBinding: createStandaloneRuntimeAssetBinding('virtual-test'),
  });
}

function configure(plugin: ReturnType<typeof pluginPack>, command: 'build' | 'serve', base = '/') {
  const hook = plugin.configResolved;
  const config = { base, command } as ResolvedConfig;
  const invoke = (candidate: unknown): void => {
    if (typeof candidate === 'function') Reflect.apply(candidate, undefined, [config]);
  };
  if (typeof hook === 'function') {
    invoke(hook);
  } else {
    invoke(hook?.handler);
  }
}

describe('Pack runtime virtual module', () => {
  it('resolves and emits the configured binding for development', () => {
    const plugin = virtualPlugin();
    configure(plugin, 'serve');
    const resolveId = plugin.resolveId as (source: string) => string | null;
    const load = plugin.load as (id: string) => string | null;
    expect(resolveId(VIRTUAL_RUNTIME_ID)).toBe(VIRTUAL_RUNTIME_ID);

    const source = load(VIRTUAL_RUNTIME_ID);
    expect(source).toContain(`from '${VIRTUAL_RUNTIME_TRANSPORT_ID}'`);
    expect(source).not.toContain("from '@forgeax/engine-runtime'");
    expect(resolveId(VIRTUAL_RUNTIME_TRANSPORT_ID)?.replaceAll('\\', '/')).toMatch(
      /packages\/runtime\/dist\/index\.mjs$|@forgeax\/engine-runtime\/dist\/index\.mjs$/,
    );
    expect(source).toContain('createRuntimeAssetImportTransport');
    expect(source).toContain('"scopeId":"virtual-test"');
    expect(source).toContain('"generation":1');
  });

  it('emits no dev transport in production', () => {
    const plugin = virtualPlugin();
    configure(plugin, 'build');
    const source = (plugin.load as (id: string) => string | null)(VIRTUAL_RUNTIME_ID);
    expect(source).toContain('"scopeId":"virtual-test"');
    expect(source).toContain('"catalogUrl":"/pack-index.json"');
    expect(source).toContain('createRuntimeAssetImportTransport() { return undefined; }');
    expect(source).not.toContain(VIRTUAL_RUNTIME_TRANSPORT_ID);
  });

  it('projects the emitted production catalog under the actual Vite base', () => {
    const plugin = virtualPlugin();
    configure(plugin, 'build', '/game/');
    const source = (plugin.load as (id: string) => string | null)(VIRTUAL_RUNTIME_ID);
    expect(source).toContain('"catalogUrl":"/game/pack-index.json"');
    expect(source).toContain('"scopeId":"virtual-test"');
    expect(source).toContain('"generation":1');
    expect(source).not.toContain(VIRTUAL_RUNTIME_TRANSPORT_ID);
  });

  it('keeps an unconfigured production binding explicitly empty', () => {
    const plugin = pluginPack();
    configure(plugin, 'build');
    const source = (plugin.load as (id: string) => string | null)(VIRTUAL_RUNTIME_ID);
    expect(source).toContain('export const runtimeBinding = undefined');
    expect(source).not.toContain(VIRTUAL_RUNTIME_TRANSPORT_ID);
  });

  it('leaves unrelated module resolution to Vite', () => {
    const plugin = virtualPlugin();
    const resolveId = plugin.resolveId as (source: string) => string | null;
    const load = plugin.load as (id: string) => string | null;
    expect(resolveId('some-other-module')).toBeNull();
    expect(load('some-other-module')).toBeNull();
  });
});
