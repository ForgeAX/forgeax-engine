import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import {
  nativeModuleIdentity,
  nativeModuleKey,
  resolveNativeModuleKey,
} from '../build/native-module-identity.js';

it('hashes and restores declared npm dependencies whose names also identify Node builtins', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-native-builtin-name-'));
  try {
    const owner = resolve(root, 'node_modules/owner');
    const dependency = resolve(owner, 'node_modules/punycode');
    await mkdir(dependency, { recursive: true });
    await writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({
        name: 'project',
        version: '1.0.0',
        dependencies: { owner: '1.0.0' },
      }),
    );
    await writeFile(
      resolve(owner, 'package.json'),
      JSON.stringify({
        name: 'owner',
        version: '1.0.0',
        dependencies: { punycode: '1.0.0' },
      }),
    );
    await writeFile(resolve(owner, 'index.cjs'), "module.exports = require('punycode/');");
    await writeFile(
      resolve(dependency, 'package.json'),
      JSON.stringify({
        name: 'punycode',
        version: '1.0.0',
        main: 'index.cjs',
        exports: { '.': './index.cjs' },
      }),
    );
    const entry = resolve(dependency, 'index.cjs');
    await writeFile(entry, 'module.exports = 1;');
    expect(createRequire(resolve(owner, 'package.json')).resolve.paths('punycode')).toBeNull();
    const ownerUrl = pathToFileURL(resolve(owner, 'index.cjs')).href;
    const first = await nativeModuleIdentity(ownerUrl);
    const url = pathToFileURL(await realpath(entry)).href;
    const key = await nativeModuleKey(root, url);
    expect(await resolveNativeModuleKey(root, key)).toBe(url);
    await writeFile(entry, 'module.exports = 2;');
    expect(await nativeModuleIdentity(ownerUrl)).not.toBe(first);
    await rm(dependency, { recursive: true });
    await expect(nativeModuleIdentity(ownerUrl)).rejects.toThrow('owner -> punycode');
    await expect(resolveNativeModuleKey(root, key)).rejects.toThrow('punycode');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('retains nested binary identity across a type-only ESM package boundary', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-native-nested-bytes-'));
  try {
    const moduleRoot = resolve(root, 'dist');
    const assetRoot = resolve(root, 'assets/room');
    await mkdir(moduleRoot, { recursive: true });
    await mkdir(assetRoot, { recursive: true });
    await writeFile(resolve(root, 'package.json'), '{"name":"room-owner","version":"1.0.0"}');
    await writeFile(resolve(moduleRoot, 'package.json'), '{"type":"module"}');
    const entry = resolve(moduleRoot, 'index.mjs');
    await writeFile(entry, 'export default 1;');
    const asset = resolve(assetRoot, 'impulse.bin');
    await writeFile(asset, new Uint8Array([0, 1, 255]));
    const url = pathToFileURL(entry).href;
    const original = await nativeModuleIdentity(url);
    await writeFile(asset, new Uint8Array([0, 2, 255]));
    expect(await nativeModuleIdentity(url)).not.toBe(original);
    await writeFile(asset, new Uint8Array([0, 1, 255]));
    expect(await nativeModuleIdentity(url)).toBe(original);
    await rename(asset, resolve(assetRoot, 'other.bin'));
    expect(await nativeModuleIdentity(url)).not.toBe(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
