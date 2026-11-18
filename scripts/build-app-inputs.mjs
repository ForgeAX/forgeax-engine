#!/usr/bin/env node
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, loadConfigFromFile } from 'vite';

const packagesRoot = fileURLToPath(new URL('../packages/', import.meta.url));

/** Keep authored app/Shader imports; unused Engine JS is not a transfer product. */
export function consumerInputExternal(previous, packageRoot = packagesRoot) {
  const matches = (rule, id) => {
    if (Array.isArray(rule)) return rule.some((entry) => matches(entry, id));
    return typeof rule === 'string' ? rule === id : rule instanceof RegExp && rule.test(id);
  };
  return (id, importer, isResolved) => {
    const existing =
      typeof previous === 'function' ? previous(id, importer, isResolved) : matches(previous, id);
    if (existing) return existing;
    if (/\.(?:wgsl|glsl|json)(?:\?|$)/i.test(id)) return false;
    return (
      id === '@forgeax/engine' ||
      id.startsWith('@forgeax/engine-') ||
      id.startsWith('@forgeax/engine/') ||
      id.startsWith(`${resolve(packageRoot)}${sep}`)
    );
  };
}

async function pluginsIn(option) {
  const value = await option;
  if (!value) return [];
  return Array.isArray(value) ? (await Promise.all(value.map(pluginsIn))).flat() : [value];
}

export async function consumerInputConfig(config) {
  const plugins = await pluginsIn(config.plugins);
  // Program hosts seal and link emitted Engine facade chunks. That graph is
  // itself a producer input, so it must retain normal module resolution.
  if (
    plugins.some(
      (plugin) =>
        plugin.name === 'forgeax:execution-worker-entries' ||
        plugin.name === 'forgeax:plugin-programs',
    )
  )
    return config;
  // Preserve the app entry graph and every producer hook. Only the discarded
  // runtime bundle stops recursively bundling Engine and its Worker runtimes.
  return {
    ...config,
    build: {
      ...config.build,
      rollupOptions: {
        ...config.build?.rollupOptions,
        external: consumerInputExternal(config.build?.rollupOptions?.external),
      },
    },
    worker: {
      ...config.worker,
      rollupOptions: {
        ...config.worker?.rollupOptions,
        external: consumerInputExternal(config.worker?.rollupOptions?.external),
      },
    },
  };
}

async function main() {
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' });
  const config = loaded?.config ?? {};
  const selected = await consumerInputConfig(config);
  console.log(
    `[build-app-inputs] runtime-graph=${selected === config ? 'retained' : 'externalized'}`,
  );
  await build({ ...selected, configFile: false });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
