import { readdir, readFile } from 'node:fs/promises';
import * as facade from '@forgeax/engine/three';
import {
  EventDispatcher,
  Group,
  Object3D,
  PerspectiveCamera,
  Vector3,
} from '@forgeax/engine/three';
import { OrbitControls } from '@forgeax/engine/three/addons/controls/OrbitControls.js';
import { GLTFLoader } from '@forgeax/engine/three/addons/loaders/GLTFLoader.js';
import * as tsl from '@forgeax/engine/three/tsl';
import * as upstream from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';

it('ships one constructor family across the public facade, controls and loader', async () => {
  const controls = new OrbitControls(new PerspectiveCamera());
  expect(controls).toBeInstanceOf(EventDispatcher);
  expect(controls.target).toBeInstanceOf(Vector3);
  const result = await new GLTFLoader().parseAsync(
    JSON.stringify({
      asset: { version: '2.0' },
      nodes: [{ name: 'imported-node' }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    }),
    '',
  );
  expect(result.scene).toBeInstanceOf(Group);
  expect(result.scene.children[0]).toBeInstanceOf(Object3D);
});

it('preserves every pinned upstream CPU export', () => {
  expect(Object.keys(upstream).filter((name) => !(name in facade))).toEqual([]);
});

it('keeps upstream GPU renderers out of all emitted JavaScript chunks', async () => {
  const directory = new URL('../../dist/', import.meta.url);
  const maps = (await readdir(directory, { recursive: true })).filter((name) =>
    name.endsWith('.mjs.map'),
  );
  expect(maps.length).toBeGreaterThan(1);
  const sources: string[] = [];
  for (const name of maps)
    sources.push(...JSON.parse(await readFile(new URL(name, directory), 'utf8')).sources);
  for (const source of sources)
    expect(source).not.toMatch(/three\/.*(?:WebGLRenderer|WebGPURenderer|NodeBuilder)\./);
});

it('keeps the public build compiler outside the player import closure', async () => {
  const pending = [new URL('../../dist/index.mjs', import.meta.url)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const module = pending.pop();
    if (module === undefined || visited.has(module.href)) continue;
    visited.add(module.href);
    const source = await readFile(module, 'utf8');
    expect(source).not.toMatch(/@forgeax\/engine-shader-compiler|from\s*['"]node:/);
    for (const match of source.matchAll(
      /(?:from\s*|import\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+\.mjs)\1/g,
    )) {
      const specifier = match[2];
      if (specifier !== undefined) pending.push(new URL(specifier, module));
    }
  }
  expect(visited.size).toBeGreaterThan(2);
  expect(await readFile(new URL('../../dist/build/index.mjs', import.meta.url), 'utf8')).toContain(
    '@forgeax/engine-shader-compiler',
  );
});

it('shares original TSL functions and node constructors through the public subpath', () => {
  expect(Object.keys(tsl).sort()).toEqual(Object.keys(facade.TSL).sort());
  const rootEntries = new Map(Object.entries(facade.TSL));
  for (const [name, value] of Object.entries(tsl)) expect(value, name).toBe(rootEntries.get(name));
  expect(tsl.uniform(new facade.Color('red'))).toBeInstanceOf(facade.UniformNode);
  const texture = new facade.Texture();
  expect(tsl.texture(texture)).toBeInstanceOf(facade.TextureNode);
  texture.dispose();
});

it('keeps the TSL authoring subpath independent of native runtime packages and cooked programs', async () => {
  const pending = [new URL('../../dist/tsl.mjs', import.meta.url)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const module = pending.pop();
    if (module === undefined || visited.has(module.href)) continue;
    visited.add(module.href);
    expect(module.pathname).not.toMatch(/\/(?:materials|physical)\.mjs$/);
    const source = await readFile(module, 'utf8');
    expect(source).not.toMatch(/@forgeax\/engine-|from\s*['"]node:/);
    for (const match of source.matchAll(
      /(?:from\s*|import\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+\.mjs)\1/g,
    )) {
      const specifier = match[2];
      if (specifier !== undefined) pending.push(new URL(specifier, module));
    }
  }
  expect(visited.size).toBeGreaterThan(1);
});

it('keeps every focused CPU addon independent of the native renderer and cooked programs', async () => {
  const { exports: entries } = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  for (const [name, target] of Object.entries(entries)) {
    if (!name.startsWith('./addons/')) continue;
    const entry = target as { import: string };
    const pending = [new URL(`../../${entry.import}`, import.meta.url)],
      visited = new Set<string>();
    while (pending.length > 0) {
      const module = pending.pop();
      if (module === undefined || visited.has(module.href)) continue;
      visited.add(module.href);
      expect(module.pathname).not.toMatch(/\/(?:materials|physical)\.mjs$/);
      const source = await readFile(module, 'utf8');
      expect(source, name).not.toMatch(/@forgeax\/engine-|from\s*['"]node:/);
      for (const match of source.matchAll(
        /(?:from\s*|import\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+\.mjs)\1/g,
      ))
        if (match[2] !== undefined) pending.push(new URL(match[2], module));
    }
  }
});
