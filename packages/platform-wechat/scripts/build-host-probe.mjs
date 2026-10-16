#!/usr/bin/env node
// This is a host contract fixture producer, not a DevKit game target.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'tsup';

const { values } = parseArgs({ options: {
  appid: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('build-host-probe.mjs --appid wx<16 hex characters> --out <new directory>');
  process.exit(0);
}
if (!/^wx[0-9a-f]{16}$/.test(values.appid ?? '') || !values.out) {
  throw new Error('provide a valid local Mini Game AppID and a new output directory');
}
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(values.out);
await mkdir(output); // Refuse to overwrite an existing project or artifact.
await build({
  entry: { game: resolve(packageRoot, '__tests__/native-host-probe.ts') },
  format: ['iife'], platform: 'neutral', target: 'es2020',
  outDir: output, clean: false, dts: false, sourcemap: false,
  noExternal: [/^@forgeax\//], config: false,
});
await rename(resolve(output, 'game.global.js'), resolve(output, 'game.js'));
await writeFile(resolve(output, 'game.json'), JSON.stringify({
  deviceOrientation: 'portrait', showStatusBar: false,
}, null, 2) + '\n');
await writeFile(resolve(output, 'project.config.json'), JSON.stringify({
  appid: values.appid, compileType: 'game', projectname: 'ForgeaX Host Contract',
  setting: { es6: false, minified: false }, libVersion: 'latest',
}, null, 2) + '\n', { mode: 0o600 });
const bytes = await readFile(resolve(output, 'game.js'));
console.log(JSON.stringify({ kind: 'host-contract-fixture', output,
  gameJsSha256: createHash('sha256').update(bytes).digest('hex'), gameJsBytes: bytes.length,
}));
