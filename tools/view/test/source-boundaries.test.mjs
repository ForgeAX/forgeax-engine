import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import { build } from 'esbuild';
import { checkArchitecture, parseImports } from '../scripts/check-architecture.mjs';

const root = resolve(import.meta.dirname, '..');
const core = '@forgeax/view-workspace-core';
const components = '@forgeax/view-components';
const viewer = '@forgeax/view-viewer';
const display = '@forgeax/view-plugin-display';
const scene = '@forgeax/view-plugin-scene';

function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'view-architecture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const put = (file, content) => {
    const target = resolve(directory, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  };
  const manifests = new Map();
  for (const [path, name, dependencies] of [
    ['', '@forgeax/view', { [viewer]: '*', [display]: '*' }],
    ['packages/view-workspace-core/', core, {}],
    ['packages/view-components/', components, {}],
    ['packages/viewer/', viewer, { [core]: '*', [components]: '*', [display]: '*' }],
    ['packages/view-plugin-display/', display, { [core]: '*' }],
    ['packages/view-plugin-scene/', scene, { [core]: '*' }],
  ]) {
    const manifest = { name, dependencies, exports: { '.': './src/index.ts', './identity': './src/identity.ts' } };
    manifests.set(name, { path, manifest });
    put(`${path}package.json`, manifest);
    put(`${path}src/index.ts`, 'export const value = 1;');
    put(`${path}src/identity.ts`, 'export const id = "fixture";');
  }
  put('packages/viewer/src/catalog-shared.ts', `export * from '${display}/identity';`);
  put('packages/viewer/src/host/index.ts', 'export const host = true;');
  return { directory, put, manifest(name, change) {
    const { path, manifest } = manifests.get(name);
    change(manifest);
    put(`${path}package.json`, manifest);
  } };
}

it('checks every owned source layer in the repository', () => {
  const result = checkArchitecture(root);
  assert.ok(result.files > 200);
  assert.deepEqual(result.errors, []);
});

it('parses static, dynamic, type-only, CommonJS and CSS import edges', () => {
  assert.deepEqual(parseImports('fixture.ts', `
    import type { A } from 'a';
    export { B } from 'b';
    const value = import('c');
    type T = import('d').T;
    const other = require('e');
    import F = require('f');
    require.resolve('g');
    import(variable);
  `).imports.map(item => item.specifier), ['a', 'b', 'c', 'd', 'e', 'f', 'g', undefined]);
  assert.deepEqual(parseImports('fixture.css', `/* @import 'ignored'; */
    @import 'a.css'; @import url("b.css"); @import url(c.css);
  `).imports.map(item => item.specifier), ['a.css', 'b.css', 'c.css']);
});

it('shares a dependency-free workspace scene classifier without sibling imports', t => {
  const f = fixture(t);
  f.manifest(core, m => { m.exports['./scene-entity-classification'] = './src/scene-entity-classification.ts'; });
  f.put('packages/view-workspace-core/src/scene-entity-classification.ts', 'export const classifySceneEntity = () => "entity";');
  for (const suffix of ['inspector', 'scene-tree']) {
    f.put(`packages/view-plugin-${suffix}/package.json`, { name: `@forgeax/view-plugin-${suffix}`, dependencies: { [core]: '*' }, exports: { '.': './src/index.ts' } });
    f.put(`packages/view-plugin-${suffix}/src/index.ts`, `import { classifySceneEntity } from '${core}/scene-entity-classification';`);
  }
  assert.deepEqual(checkArchitecture(f.directory).errors, []);
  f.put('packages/view-plugin-inspector/src/index.ts', `import '${scene}/identity';`);
  assert(checkArchitecture(f.directory).errors.some(error => error.rule === 'dependency-direction'));
  f.put('packages/view-plugin-inspector/src/index.ts', `import '${core}/scene-entity-classification';`);
  f.put('packages/view-workspace-core/src/scene-entity-classification.ts', `export * from '${scene}';`);
  assert(checkArchitecture(f.directory).errors.some(error => error.rule === 'scene-classification-purity'));
});

const mutations = [
  ['foundation reverse dependency', 'dependency-direction', f => f.put('packages/view-workspace-core/src/index.ts', `export * from '${display}';`)],
  ['declared Viewer dependency', 'dependency-direction', f => {
    f.manifest(display, m => { m.dependencies[viewer] = '*'; });
    f.put('packages/view-plugin-display/src/index.ts', `import '${viewer}';`);
  }],
  ['declared sibling dependency', 'dependency-direction', f => {
    f.manifest(display, m => { m.dependencies[scene] = '*'; });
    f.put('packages/view-plugin-display/src/index.ts', `import '${scene}';`);
  }],
  ['unknown package layer', 'package-layer', f => {
    f.put('packages/misc/package.json', { name: '@forgeax/misc' });
    f.put('packages/misc/src/index.ts', 'export const value = 1;');
  }],
  ['unused peer dependency', 'dependency-direction', f => f.manifest(core, m => { m.peerDependencies = { [components]: '*' }; })],
  ['unused development dependency', 'dependency-direction', f => f.manifest(core, m => { m.devDependencies = { [display]: '*' }; })],
  ['JavaScript product source', 'typescript-source', f => f.put('src/hidden.mjs', 'export const hidden = true;')],
  ['Engine app runtime in core', 'dependency-direction', f => f.put('packages/view-workspace-core/src/index.ts', "import '@forgeax/engine/app';")],
  ['React core', 'dependency-direction', f => f.put('packages/view-workspace-core/src/index.ts', "import 'react/jsx-runtime';")],
  ['Engine runtime in core', 'dependency-direction', f => f.put('packages/view-workspace-core/src/index.ts', "import '@forgeax/engine';")],
  ['undeclared external alias', 'undeclared-dependency', f => f.put('packages/view-workspace-core/src/index.ts', "import 'hidden-feature';")],
  ['core UI source', 'no-ui-source', f => f.put('packages/view-workspace-core/src/Panel.tsx', 'export const panel = <div />;')],
  ['workspace-aware components', 'dependency-direction', f => f.put('packages/view-components/src/index.ts', `import '${core}';`)],
  ['Engine-aware components', 'dependency-direction', f => f.put('packages/view-components/src/index.ts', "import '@forgeax/engine';")],
  ['aggregate back import', 'dependency-direction', f => f.put('packages/view-plugin-display/src/index.ts', "import '@forgeax/view';")],
  ['root aggregate self import', 'dependency-direction', f => f.put('src/platform/feature.ts', "import '@forgeax/view';")],
  ['private package subpath', 'private-import', f => f.put('packages/view-plugin-display/src/index.ts', `import '${core}/src/index.ts';`)],
  ['undeclared dependency', 'undeclared-dependency', f => f.put('packages/view-plugin-display/src/index.ts', `import '${components}';`)],
  ['relative package traversal', 'relative-boundary', f => f.put('packages/view-plugin-display/src/index.ts', "import '../../view-workspace-core/src/index.ts';")],
  ['root traversal', 'relative-boundary', f => f.put('src/index.ts', "export * from '../packages/view-workspace-core/src/index.ts';")],
  ['missing relative module', 'unresolved-import', f => f.put('packages/view-plugin-display/src/index.ts', "import './missing.mjs';")],
  ['computed import', 'computed-import', f => f.put('packages/view-plugin-display/src/index.ts', 'import(target);')],
  ['computed require', 'computed-import', f => f.put('packages/view-plugin-display/src/index.ts', 'require(target);')],
  ['package alias', 'package-alias', f => f.manifest(core, m => { m.imports = { '#feature': display }; })],
  ['URL import', 'import-alias', f => f.put('packages/view-plugin-display/src/index.ts', "import 'file:///hidden.mjs';")],
  ['npm alias', 'package-alias', f => f.manifest(core, m => { m.dependencies.hidden = `npm:${display}@*`; })],
  ['export escapes source', 'package-export', f => f.manifest(core, m => { m.exports['./escape'] = '../view-plugin-display/src/index.ts'; })],
  ['wildcard public export', 'package-export', f => f.manifest(core, m => { m.exports['./*'] = './src/index.ts'; })],
  ['source symlink', 'source-symlink', f => symlinkSync('../../view-plugin-display/src/index.ts', resolve(f.directory, 'packages/view-workspace-core/src/hidden.ts'))],
  ['Host through innocent re-export', 'host-isolation', f => {
    f.put('packages/viewer/src/host/index.ts', "import '../helper.ts';");
    f.put('packages/viewer/src/helper.ts', `export * from '${display}';`);
  }],
  ['Host self-package export', 'host-isolation', f => {
    f.manifest(viewer, m => { m.exports['./panel'] = './src/panel.tsx'; });
    f.put('packages/viewer/src/panel.tsx', 'export const panel = <div />;');
    f.put('packages/viewer/src/host/index.ts', `import '${viewer}/panel';`);
  }],
  ['Host domain Engine module', 'host-isolation', f => f.put('packages/viewer/src/host/index.ts', "import '@forgeax/engine';")],
  ['catalog identity pulls implementation', 'metadata-only', f => f.put('packages/view-plugin-display/src/identity.ts', "export * from './index.ts';")],
  ['catalog conditional export pulls implementation', 'metadata-only', f => f.manifest(display, m => {
    m.exports['./identity'] = { node: './src/identity.ts', browser: './src/index.ts' };
  })],
  ['root platform feature import', 'root-composition', f => f.put('src/platform/feature.ts', `import '${display}';`)],
  ['root platform aggregate detour', 'root-composition', f => {
    f.put('src/platform/feature.ts', "import '../index.ts';");
    f.put('src/index.ts', `export * from '${display}';`);
  }],
  ['root platform exported Viewer detour', 'root-composition', f => {
    f.put('src/platform/feature.ts', `import '${viewer}';`);
    f.put('packages/viewer/src/index.ts', `export * from '${display}';`);
  }],
  ['CSS crosses packages', 'relative-boundary', f => f.put('packages/view-components/src/hidden.css', '@import url(../../viewer/src/style.css);')],
  ['syntax errors fail closed', 'source-syntax', f => f.put('src/broken.ts', 'import { from;')],
];

for (const [name, rule, mutate] of mutations) {
  it(`rejects ${name}`, t => {
    const f = fixture(t);
    assert.deepEqual(checkArchitecture(f.directory).errors, [], 'fixture must start valid');
    mutate(f);
    const errors = checkArchitecture(f.directory).errors;
    assert.ok(errors.some(error => error.rule === rule), JSON.stringify(errors, null, 2));
  });
}

it('scopes the browser bundle exemption to one existing call site', () => {
  const file = 'packages/viewer/src/host/panel-bridge.ts';
  const source = readFileSync(resolve(root, file), 'utf8');
  const actual = parseImports(file, source).imports;
  assert.equal(actual.filter(item => item.bridge).length, 1);
  assert.equal(parseImports('src/copied.ts', source).imports.some(item => item.bridge), false);
  const changed = parseImports(file, source.replace("globalThis.__forgeaxViewPanelsUrl ?? '/panels.js'", 'otherUrl'));
  assert.equal(changed.imports.some(item => item.bridge), false);
  const second = parseImports(file, source.replace('return await import(', 'await import(target); return await import('));
  assert.equal(second.imports.filter(item => item.specifier === undefined && !item.bridge).length, 1);
});

it('the executable gate exits nonzero on violations and broken input', t => {
  const f = fixture(t);
  const run = directory => spawnSync(process.execPath, [resolve(root, 'scripts/check-architecture.mjs'), directory], { encoding: 'utf8' });
  assert.equal(run(f.directory).status, 0);
  f.put('packages/view-workspace-core/src/index.ts', "import 'react';");
  const failed = run(f.directory);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /view-workspace-core\/src\/index.ts:1 \[dependency-direction\]/);
  assert.equal(run(resolve(f.directory, 'missing')).status, 1);
});

it('bundles shared catalog metadata without frontend implementations or UI', async () => {
  const result = await build({
    absWorkingDir: root, entryPoints: ['packages/viewer/src/catalog-shared.ts'],
    bundle: true, write: false, metafile: true, format: 'esm', platform: 'neutral',
    external: ['@forgeax/engine*', 'node:*'],
  });
  for (const file of Object.keys(result.metafile.inputs)) {
    assert.doesNotMatch(file, /\/(?:frontend|presentation|play-presentation|workspace-shell)\.ts$|\/(?:ui|shell)\/|\.(?:tsx|css)$/, file);
  }
});

it('erases native owner type contracts from runtime closure while checking dependency direction', t => {
  const f = fixture(t);
  f.manifest(core, manifest => { manifest.devDependencies = { '@forgeax/engine': '*' }; });
  f.put('packages/view-workspace-core/src/index.ts', "import type { EngineWorkspaceTarget } from '@forgeax/engine/app'; export type Target = EngineWorkspaceTarget;");
  f.put('packages/viewer/src/host/index.ts', "import type { Display } from '@forgeax/view-plugin-display'; export type Target = Display;");
  assert.deepEqual(checkArchitecture(f.directory).errors, []);
  const imports = parseImports('fixture.ts', "import type { A } from 'a'; import { type B } from 'b'; export type { C } from 'c'; type D = import('d').D; import { type E, value } from 'e';").imports;
  // With verbatimModuleSyntax, inline type specifiers retain an empty runtime import.
  assert.deepEqual(imports.map(reference => Boolean(reference.typeOnly)), [true, false, true, true, false]);
  f.put('packages/view-workspace-core/src/index.ts', "import type { Display } from '@forgeax/view-plugin-display'; export type Target = Display;");
  assert.ok(checkArchitecture(f.directory).errors.some(error => error.rule === 'dependency-direction'));
});
