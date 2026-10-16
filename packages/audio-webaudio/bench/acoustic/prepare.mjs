import { mkdir, readFile, writeFile, symlink, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../../../../artifacts/roi22-acoustics/sources/', import.meta.url));
// This package-owned benchmark is not a workspace app. Link the built public
// facade for source-checkout runs; extracted SDK consumers already install it.
const facade = fileURLToPath(new URL('../../../../node_modules/@forgeax/engine', import.meta.url));
const source = fileURLToPath(new URL('../../../../packages/engine', import.meta.url));
if (process.env.FORGEAX_AUDIO_SDK_ROOT) {
  const sdk = JSON.parse(await readFile(resolve(process.env.FORGEAX_AUDIO_SDK_ROOT, 'sdk-manifest.json'), 'utf8'));
  const require = createRequire(import.meta.url);
  const engine = JSON.parse(await readFile(require.resolve('@forgeax/engine/package.json'), 'utf8'));
  if (engine.version !== sdk.sdkVersion) throw new Error('installed Engine/SDK version mismatch');
  console.log(`[acoustic] installed SDK ${sdk.sdkVersion} Engine ${sdk.engineCommit}`);
} else {
  try { await symlink(source, facade, 'dir'); } catch (error) {
    if (error.code !== 'EEXIST' || await realpath(facade) !== await realpath(source)) throw error;
  }
}
await mkdir(directory, { recursive: true });
const samples = 48000 * 3, bytes = Buffer.alloc(44 + samples * 4);
bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
for (let frame = 0; frame < samples; frame++) for (let channel = 0; channel < 2; channel++) {
  const silent = frame >= 72000 && frame < 86400;
  const value = silent ? 0 : 0.1 * Math.sin(2 * Math.PI * (channel ? 660 : 440) * frame / 48000) + (frame % 12000 === 0 ? 0.3 : 0);
  bytes.writeInt16LE(Math.round(32767 * value), 44 + frame * 4 + channel * 2);
}
await writeFile(`${directory}/tone.wav`, bytes);
await writeFile(`${directory}/tone.wav.meta.json`, JSON.stringify({schemaVersion:'1.0.0',kind:'external-asset-package',importer:'audio',
  importSettings:{playback:'buffer'},subAssets:[{sourceKey:'audio:audio',guid:'01a11253-2200-7000-8000-000000000001',kind:'audio',sourceIndex:0}]}));
console.log(directory);
