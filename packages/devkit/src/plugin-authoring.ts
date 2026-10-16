import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { AssetGuid, parsePackSourceJson } from '@forgeax/engine-pack/source';
import { GameProjectSchema, PluginRealmSchema } from '@forgeax/engine-project';
import { discoverPluginAssets } from './build/plugin-assets.js';
import { commandError, readProjectFacts } from './project.js';
import type {
  CommandResult,
  PluginCreateOptions,
  PluginInspectOptions,
  PluginRootOptions,
} from './types.js';

export async function pluginCreateCommand(
  options: PluginCreateOptions,
): Promise<CommandResult<unknown>> {
  try {
    const facts = await readProjectFacts(options.root);
    if (!facts.ok) return facts;
    const path = resolve(facts.value.root, options.path);
    const localPath = relative(facts.value.root, path);
    const scriptable = path.endsWith('.pack.ts');
    if (
      (!scriptable && !path.endsWith('.pack.json')) ||
      localPath === '..' ||
      localPath.startsWith('../') ||
      isAbsolute(localPath)
    ) {
      throw new TypeError('plugin source path must be a project-local .pack.ts or .pack.json file');
    }
    const inline = options.module === undefined;
    if (inline && !scriptable)
      throw new TypeError(
        '.pack.json requires a module; use .pack.ts to create a same-file plugin',
      );
    if (inline && options.export === 'default')
      throw new TypeError('the default export of .pack.ts is the Pack; use a named plugin export');
    const packageId = options.packageId ?? randomUUID();
    const sourceKey = options.sourceKey ?? 'plugin/main';
    const payload = {
      module: {
        specifier: options.module ?? `./${basename(path)}`,
        ...(inline
          ? { export: options.export ?? 'plugin' }
          : options.export === undefined
            ? {}
            : { export: options.export }),
      },
      ...(options.config === undefined ? {} : { config: options.config }),
    };
    const pack = {
      schemaVersion: '3.0.0',
      packageId,
      assets: {
        [sourceKey]: {
          kind: 'plugin',
          payload,
        },
      },
    };
    const parsed = parsePackSourceJson(pack);
    if (!parsed.ok) throw parsed.error;
    const guid = AssetGuid.format(AssetGuid.derive(parsed.value.packageId, sourceKey));
    // JSON object keys must retain data semantics when emitted as TypeScript.
    const outputs = JSON.stringify(
      { [sourceKey]: { kind: 'plugin', ...payload } },
      null,
      2,
    ).replace(/^(\s*)"__proto__":/gm, '$1["__proto__"]:');
    const source = scriptable
      ? `import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
${
  inline
    ? `import type { Plugin } from '@forgeax/engine/plugin';

const plugin: Plugin = {
  apply(ctx) {
    ctx.effect(() => {
      // Install this behavior's systems, services, or listeners here.
      return () => {
        // Release the contributions owned by this installation.
      };
    });
  },
};
export { plugin as ${JSON.stringify(options.export ?? 'plugin')} };

`
    : ''
}export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId(${JSON.stringify(packageId)}),
  build: () => ok(${outputs}),
});
`
      : `${JSON.stringify(pack, null, 2)}\n`;
    if (!options.dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source, { flag: 'wx' });
    }
    return { ok: true, value: { path, guid, source, dryRun: options.dryRun === true } };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'plugin-asset-create-failed') };
  }
}

export async function pluginInspectCommand(
  options: PluginInspectOptions = {},
): Promise<CommandResult<unknown>> {
  try {
    const facts = await readProjectFacts(options.root);
    if (!facts.ok) return facts;
    const inventory = await discoverPluginAssets(facts.value);
    return {
      ok: true,
      value: {
        roots: facts.value.roots,
        deferred: inventory.deferred,
        assets: [...inventory.assets.values()]
          .filter((record) => !options.guid || record.definition.guid === options.guid)
          .map((record) => ({
            ...record.definition,
            sourcePath: record.sourcePath,
            sourceKey: record.sourceKey,
            refs: record.refs,
            lifecycle: 'definition',
            execution: 'not-observed',
          })),
      },
    };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'plugin-asset-inspect-failed') };
  }
}

/** Replaces one root reference. Configuration remains in its owning Pack. */
export async function pluginRootCommand(
  options: PluginRootOptions,
): Promise<CommandResult<unknown>> {
  const root = resolve(options.root ?? process.cwd());
  const path = resolve(root, 'forge.json');
  const lock = `${path}.lock`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  let locked = false;
  try {
    if (!PluginRealmSchema.safeParse(options.realm).success)
      throw new TypeError('invalid root realm');
    const raw = await readFile(path, 'utf8');
    const manifest = GameProjectSchema.parse(JSON.parse(raw));
    if (options.guid !== null) {
      if (!AssetGuid.parse(options.guid).ok)
        throw new TypeError('root requires a canonical GUID or null');
      const facts = await readProjectFacts(root);
      if (!facts.ok) return facts;
      const inventory = await discoverPluginAssets(facts.value);
      if (!inventory.assets.has(options.guid))
        throw new TypeError(`plugin definition ${options.guid} not found`);
      manifest.roots[options.realm] = options.guid;
    } else delete manifest.roots[options.realm];
    if (!options.dryRun) {
      await mkdir(lock);
      locked = true;
      if ((await readFile(path, 'utf8')) !== raw)
        throw new Error('project changed during root validation');
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
      await rename(temporary, path);
    }
    return { ok: true, value: { manifest, dryRun: options.dryRun === true } };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'plugin-root-update-failed') };
  } finally {
    await rm(temporary, { force: true });
    if (locked) await rm(lock, { recursive: true });
  }
}
