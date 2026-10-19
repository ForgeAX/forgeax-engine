import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { AssetGuid, PackageId, parsePackSourceJson } from '@forgeax/engine-pack/source';
import { GameProjectSchema } from '@forgeax/engine-project';
import ts from 'typescript';
import { build } from 'vite';
import { discoverPluginAssets, pluginAssetClosure } from '../build/plugin-assets.js';
import { pluginProgramSource, pluginRuntimeProjection } from '../build/plugin-programs.js';
import { isFilesystemPathWithin } from '../filesystem-path.js';
import { commandError } from '../project.js';
import { projectToolProjection } from '../tools/project-tools.js';
import type { CommandResult, ProjectCommandOptions } from '../types.js';

export interface PluginMigrationOptions extends ProjectCommandOptions {
  /** A new project directory. The original project is never partially edited. */
  readonly output: string;
}
interface Entry {
  readonly id: string;
  readonly name: string;
  readonly realm?: 'engine' | 'host' | 'build' | 'frontend';
  readonly config?: unknown;
  readonly disabled?: boolean;
  readonly group?: boolean;
  readonly inject?: readonly string[];
}
function invalid(path: string, reason: string): never {
  throw {
    code: 'plugin-migration-rewrite-required',
    expected: 'static project entries and native composition',
    hint: 'rewrite the reported dynamic behavior before rerunning migration',
    detail: { path, reason },
  };
}
function entries(value: unknown, path: string): Entry[] {
  if (!Array.isArray(value)) invalid(path, 'plugins/group config must be an array');
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      invalid(`${path}[${index}]`, 'expected an entry');
    const entry = raw as Entry;
    if (
      typeof entry.id !== 'string' ||
      !entry.id ||
      typeof entry.name !== 'string' ||
      !entry.name ||
      (entry.realm !== undefined &&
        !['engine', 'host', 'build', 'frontend'].includes(entry.realm)) ||
      (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') ||
      (entry.group !== undefined && typeof entry.group !== 'boolean') ||
      (entry.inject !== undefined &&
        (!Array.isArray(entry.inject) || entry.inject.some((key) => typeof key !== 'string')))
    )
      invalid(path, 'invalid static entry');
    if (
      Object.keys(entry).some(
        (key) => !['id', 'name', 'realm', 'config', 'disabled', 'group', 'inject'].includes(key),
      )
    )
      invalid(path, 'entry has custom lifecycle or scope controls');
    return entry;
  });
}

/** Deliberately recognizes the finite static Group form, never guesses dynamic composition. */
export function migrateStaticGroups(source: string, path: string): string {
  if (!/\b(?:definePluginGroup|usePlugin)\b/.test(source)) return source;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: { start: number; end: number; text: string }[] = [];
  const groupNames = new Set<string>(),
    useNames = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !['@forgeax/engine/plugin', '@forgeax/engine-plugin'].includes(statement.moduleSpecifier.text)
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const keep = bindings.elements.filter((element) => {
      const name = (element.propertyName ?? element.name).text;
      if (name === 'definePluginGroup') {
        groupNames.add(element.name.text);
        return false;
      }
      if (name === 'usePlugin') {
        useNames.add(element.name.text);
        return false;
      }
      return true;
    });
    if (keep.length !== bindings.elements.length)
      edits.push({
        start: statement.getStart(file),
        end: statement.end,
        text: keep.length
          ? `import { ${keep.map((item) => item.getText(file)).join(', ')} } from ${statement.moduleSpecifier.getText(file)};`
          : '',
      });
  }
  let converted = 0;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      groupNames.has(node.expression.text)
    ) {
      const options = node.arguments[0];
      if (node.arguments.length !== 1 || !options || !ts.isObjectLiteralExpression(options))
        invalid(path, 'dynamic Group options');
      const fields = new Map<string, ts.Expression>();
      for (const property of options.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name))
          invalid(path, 'dynamic Group properties');
        fields.set(property.name.text, property.initializer);
      }
      if ([...fields.keys()].some((key) => !['name', 'children'].includes(key)))
        invalid(path, 'Group hooks or service controls need native source ownership');
      const children = fields.get('children');
      if (
        !children ||
        !ts.isArrowFunction(children) ||
        children.parameters.length ||
        !ts.isArrayLiteralExpression(children.body)
      )
        invalid(path, 'dynamic children or captured configuration');
      const calls = children.body.elements.map((child) => {
        if (
          !ts.isCallExpression(child) ||
          !ts.isIdentifier(child.expression) ||
          !useNames.has(child.expression.text) ||
          child.arguments.length < 1 ||
          child.arguments.length > 3 ||
          child.arguments[0] === undefined ||
          !ts.isIdentifier(child.arguments[0])
        )
          invalid(path, 'child must name a native plugin');
        const config = child.arguments[1];
        if (config && !isStaticValue(config))
          invalid(path, 'child configuration captures executable state');
        const options = child.arguments[2];
        if (
          options &&
          (!ts.isObjectLiteralExpression(options) ||
            options.properties.some(
              (item) => !ts.isPropertyAssignment(item) || item.name.getText(file) !== 'key',
            ))
        )
          invalid(path, 'child has update/scope controls');
        return `ctx.plugin(${child.arguments[0].getText(file)}${config ? `, ${config.getText(file)}` : ''});`;
      });
      edits.push({
        start: node.getStart(file),
        end: node.end,
        text: `{ ${fields.has('name') ? `name: ${fields.get('name')?.getText(file)}, ` : ''}apply(ctx: import('@forgeax/engine/plugin').Context) { ${calls.join(' ')} } }`,
      });
      converted++;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!converted) invalid(path, 'Group helpers could not be statically migrated');
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}
function isStaticValue(node: ts.Expression): boolean {
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
      node.kind,
    ) ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  )
    return true;
  if (ts.isArrayLiteralExpression(node))
    return node.elements.every((element) => isStaticValue(element));
  if (ts.isObjectLiteralExpression(node))
    return node.properties.every(
      (item) =>
        ts.isPropertyAssignment(item) &&
        !ts.isComputedPropertyName(item.name) &&
        isStaticValue(item.initializer),
    );
  return ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand);
}

export async function pluginMigrateCommand(
  options: PluginMigrationOptions,
): Promise<CommandResult<unknown>> {
  const root = resolve(options.root ?? process.cwd()),
    output = resolve(options.output);
  let temporary: string | undefined;
  const lock = `${output}.migration.lock`;
  let locked = false;
  try {
    await mkdir(dirname(output), { recursive: true });
    await mkdir(lock);
    locked = true;
    if (isFilesystemPathWithin(root, output))
      invalid(output, 'output must be outside the original project');
    try {
      await lstat(output);
      invalid(output, 'output already exists');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    const legacy = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8'));
    if (
      legacy.schemaVersion !== '2.0.0' ||
      typeof legacy.id !== 'string' ||
      typeof legacy.name !== 'string' ||
      Object.keys(legacy).some(
        (key) => !['id', 'name', 'schemaVersion', 'plugins', 'defaultScene'].includes(key),
      )
    )
      invalid('forge.json', 'expected a strict schema 2.0 project');
    const namespace = PackageId.parse(randomUUID());
    if (!namespace.ok) throw namespace.error;
    const packageId = PackageId.format(namespace.value);
    const assetId = (key: string) => AssetGuid.format(AssetGuid.derive(namespace.value, key));
    const assets: Record<string, unknown> = {};
    const roots: Record<string, string> = {};
    const source: string[] = [
      "import { joinPluginFiber, mountPluginAsset, type Context } from '@forgeax/engine/plugin';",
      "export const compose = { inject: ['assets', 'pluginPrograms'], async apply(ctx: Context, config: { children: string[] }) { for (const guid of config.children) { const result = await mountPluginAsset(ctx, guid); if (!result.ok) throw result.error; } } };",
    ];
    const seen = new Set<string>();
    const top: Record<string, string[]> = { host: [], engine: [], build: [], frontend: [] };
    function convert(input: Entry, inherited: 'host' | 'engine' | 'build' | 'frontend'): string {
      if (seen.has(input.id)) invalid(input.id, 'duplicate entry ID');
      seen.add(input.id);
      const realm = input.realm ?? inherited,
        key = `plugin/${input.id}`;
      if (input.group) {
        if (input.inject?.length)
          invalid(input.id, 'group injection needs explicit native source composition');
        const children = entries(input.config, input.id);
        if (children.some((child) => child.realm && child.realm !== realm))
          invalid(input.id, 'cross-realm group');
        const references = children
          .map((child) => ({ child, guid: convert(child, realm) }))
          .filter(({ child }) => !child.disabled)
          .map(({ guid }) => ({ $asset: guid }));
        assets[key] = {
          kind: 'plugin',
          payload: {
            module: { specifier: './migration.ts', export: 'compose' },
            config: { children: references },
          },
        };
      } else {
        if (isAbsolute(input.name) || input.name.startsWith('..') || input.name.includes('\\'))
          invalid(input.id, 'entry module must be project-relative ./ or an npm specifier');
        const specifier = input.name.startsWith('./') ? `../../${input.name.slice(2)}` : input.name;
        if (input.inject?.length) {
          const name = `entry${source.length}`;
          source.push(
            `import ${name} from ${JSON.stringify(specifier)};\nexport const ${name}WithDependencies = { inject: ${JSON.stringify(input.inject)}, apply(ctx: Context, config: unknown) { ctx.plugin(${name}, config); } };`,
          );
          assets[key] = {
            kind: 'plugin',
            payload: {
              module: { specifier: './migration.ts', export: `${name}WithDependencies` },
              ...(input.config === undefined ? {} : { config: input.config }),
            },
          };
        } else
          assets[key] = {
            kind: 'plugin',
            payload: {
              module: { specifier },
              ...(input.config === undefined ? {} : { config: input.config }),
            },
          };
      }
      return assetId(key);
    }
    for (const entry of entries(legacy.plugins, 'plugins')) {
      const realm = entry.realm ?? 'engine';
      const guid = convert(entry, realm);
      if (!entry.disabled) {
        top[realm] ??= [];
        top[realm].push(guid);
      }
    }
    if (legacy.defaultScene !== undefined) {
      if (!AssetGuid.parse(legacy.defaultScene).ok) invalid('defaultScene', 'invalid scene GUID');
      source.push(`import { worldDespawnScene } from '@forgeax/engine/scene';
import type { SceneAsset } from '@forgeax/engine/types';
export const scene = { inject: ['assets', 'world', 'pluginPrograms'], async apply(ctx: Context, config: { scene: string; children: string[] }) {
  const assets = ctx.assets;
  if (!assets) throw new Error('scene requires assets');
  const loaded = await assets.loadByGuid<SceneAsset>(assets.parseGuid(config.scene)); if (!loaded.ok) throw loaded.error;
  await ctx.effect(async function* () {
    const handle = ctx.world.allocSharedRef('SceneAsset', loaded.value);
    yield () => ctx.world.sharedRefs.release(handle).unwrap();
    const root = assets.instantiate<SceneAsset>(handle, ctx.world).unwrap();
    yield () => worldDespawnScene(ctx.world, root).unwrap();
    ctx.provide('migratedScene', { root, asset: loaded.value });
    for (const guid of config.children) { const result = await mountPluginAsset(ctx, guid); if (!result.ok) throw result.error; yield joinPluginFiber(result.value); }
  });
} };`);
      assets['root/engine'] = {
        kind: 'plugin',
        payload: {
          module: { specifier: './migration.ts', export: 'scene' },
          config: {
            scene: { $asset: legacy.defaultScene },
            children: (top.engine ?? []).map((guid) => ({ $asset: guid })),
          },
        },
      };
      roots.engine = assetId('root/engine');
    }
    for (const [realm, children] of Object.entries(top)) {
      if (roots[realm] || !children.length) continue;
      assets[`root/${realm}`] = {
        kind: 'plugin',
        payload: {
          module: { specifier: './migration.ts', export: 'compose' },
          config: { children: children.map((guid) => ({ $asset: guid })) },
        },
      };
      roots[realm] = assetId(`root/${realm}`);
    }
    const manifest = GameProjectSchema.parse({
      id: legacy.id,
      name: legacy.name,
      schemaVersion: '3.0.0',
      roots,
    });
    const pack = { schemaVersion: '3.0.0', packageId, assets };
    parsePackSourceJson(pack).unwrap();
    await mkdir(dirname(output), { recursive: true });
    temporary = await mkdtemp(resolve(dirname(output), `.${basename(output)}-candidate-`));
    await cp(root, temporary, {
      recursive: true,
      filter: (path) =>
        !relative(root, path)
          .split(/[\\/]/)
          .some((part) =>
            ['.git', 'node_modules', '.forgeax', 'dist', '.worktrees'].includes(part),
          ),
    });
    const candidateRoot = temporary;
    async function migrateDirectory(path: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = resolve(path, entry.name);
        if (entry.isDirectory()) await migrateDirectory(file);
        else if (entry.name.endsWith('.ts')) {
          const code = await readFile(file, 'utf8');
          const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
          function check(node: ts.Node): void {
            if (
              ts.isPropertyAccessExpression(node) &&
              /^defaultScene(?:Root)?$/.test(node.name.text)
            )
              invalid(
                relative(candidateRoot, file),
                'move scene consumers from GameHost to the migratedScene service',
              );
            ts.forEachChild(node, check);
          }
          check(ast);
          const migrated = migrateStaticGroups(code, relative(candidateRoot, file));
          if (migrated !== code) await writeFile(file, migrated);
        }
      }
    }
    await migrateDirectory(temporary);
    await mkdir(resolve(temporary, 'assets/migrated'), { recursive: true });
    await writeFile(resolve(temporary, 'assets/migrated/migration.ts'), source.join('\n'));
    await writeFile(
      resolve(temporary, 'assets/migrated/plugins.pack.json'),
      `${JSON.stringify(pack, null, 2)}\n`,
    );
    await writeFile(resolve(temporary, 'forge.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const modules = resolve(root, 'node_modules');
    let linked = false;
    try {
      if ((await lstat(modules)).isDirectory() || (await lstat(modules)).isSymbolicLink()) {
        await symlink(modules, resolve(temporary, 'node_modules'), 'dir');
        linked = true;
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    const inventory = await discoverPluginAssets({ root: temporary, assetRoots: ['assets'] });
    const { tools } = await projectToolProjection(temporary, inventory);
    for (const [target, guid] of Object.entries(roots)) {
      const input = resolve(temporary, '.forgeax/migration', `${target}.ts`);
      await mkdir(dirname(input), { recursive: true });
      await writeFile(
        input,
        `${pluginProgramSource(
          pluginAssetClosure(inventory, guid),
          target as 'build' | 'host' | 'engine' | 'frontend',
          [],
          tools,
          temporary,
        )}\nexport const validation = createPrograms("migration", "candidate", 0);`,
      );
      await build({
        root: temporary,
        configFile: false,
        logLevel: 'silent',
        plugins: [pluginRuntimeProjection(temporary)],
        build: {
          write: false,
          ...(target === 'build' || target === 'host'
            ? { ssr: input }
            : { lib: { entry: input, formats: ['es'] as 'es'[], fileName: 'candidate' } }),
          target: 'esnext',
          minify: false,
        },
      });
    }
    await rm(resolve(temporary, '.forgeax'), { recursive: true, force: true });
    if (linked) await rm(resolve(temporary, 'node_modules'));
    await rename(temporary, output);
    temporary = undefined;
    return { ok: true, value: { output, manifest, definitions: Object.keys(assets).length } };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'plugin-migration-failed') };
  } finally {
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } finally {
      if (locked) await rm(lock, { recursive: true });
    }
  }
}
