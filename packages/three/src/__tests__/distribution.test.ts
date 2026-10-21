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
import * as upstream from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';

it('ships one constructor family across the public facade and both addons', async () => {
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
