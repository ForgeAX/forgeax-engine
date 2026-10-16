import { existsSync } from 'node:fs';

type PackPluginHooks = {
  readonly name?: string;
  readonly configResolved?: unknown;
  readonly resolveId?: unknown;
  readonly load?: unknown;
};

/**
 * App-shard builds intentionally omit the private binary asset submodule. Keep
 * Pack fail-fast when a configured root is present, while retaining the Pack
 * virtual runtime module when an unavailable external asset pack is omitted.
 */
export function optionalAssetPack<T>(roots: readonly string[], create: () => T): T[] {
  const plugin = create();
  if (roots.every((root) => existsSync(root))) return [plugin];

  // `asset-runtime-config` still imports the Pack-owned virtual binding in a
  // source-only app build. Keep only that pair of hooks; mounting the full Pack
  // plugin would correctly fail later on missing roots during build/serve.
  const hooks = plugin as T & PackPluginHooks;
  return [
    {
      name: `${hooks.name ?? 'forgeax:pack'}:runtime-only`,
      configResolved: hooks.configResolved,
      resolveId: hooks.resolveId,
      load: hooks.load,
    } as unknown as T,
  ];
}
