import { decodeCatalogWire } from '@forgeax/engine-pack';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build, preview } from 'vite';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { audioImporter } from '../../dist/audio-importer.mjs';
import { audioLoader } from '../../dist/index.mjs';
const root = fileURLToPath(new URL('../../../..', import.meta.url));
const output = resolve(root, 'artifacts/audio-stream');
const outDir = resolve(output, 'build-delivery');
await mkdir(outDir, { recursive: true });
const entry = resolve(output, 'build-entry.mjs'); await writeFile(entry, 'export const ready = true;\n');
await build({ configFile: false, root, plugins: [pluginPack({ roots: [resolve(output, 'sources')], importers: [audioImporter], ddc: { projectDdcRoot: resolve(output, 'build-ddc') } })],
  build: { outDir, emptyOutDir: true, rollupOptions: { input: entry } } });
const server = await preview({ configFile: false, root, build: { outDir }, preview: { port: 5297, strictPort: true } });
const base = 'http://localhost:5297';
const catalog = decodeCatalogWire(JSON.parse(await readFile(resolve(outDir, 'pack-index.json'), 'utf8'))).unwrap();
const registry = new AssetRegistry({}, undefined, [audioLoader]);
registry.configurePackIndex(`${base}/pack-index.json`);
const nativeFetch = globalThis.fetch; const requests = [];
globalThis.fetch = async (input, init) => { const response = await nativeFetch(input, init); requests.push({ url: String(input), range: init?.headers?.Range, status: response.status }); return response; };
const report = { requests, catalog, streams: [] };
try {
  for (const minutes of [10,60]) {
    const guid = `aaaaaaaa-aaaa-4aaa-8aaa-${String(minutes).padStart(12,'0')}`;
    const before = requests.length;
    const loaded = await registry.loadByGuid(registry.parseGuid(guid));
    if (!loaded.ok || loaded.value.kind !== 'audio' || !loaded.value.stream) throw loaded.ok ? new Error('stream lost in build') : loaded.error;
    const stream = loaded.value.stream;
    if (requests.slice(before).some(row => row.url === stream.url)) throw new Error('GUID read the full artifact');
    const at = Math.floor(stream.hashes.length * 0.7), start = stream.dataOffset + at * stream.chunkFrames * stream.channels * 2;
    const end = start + stream.chunkFrames * stream.channels * 2 - 1;
    const response = await fetch(stream.url, { headers: { Range: `bytes=${start}-${end}` } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (response.status !== 206 || bytes.length !== 192000 || digest !== stream.hashes[at]) throw new Error('production Range/digest mismatch');
    report.streams.push({ minutes, guid, url: stream.url, rangeBytes: bytes.length, response: response.status, digest, guidReads: requests.slice(before,-1) });
  }
  await writeFile(resolve(output, 'build-delivery.json'), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report.streams));
} finally { globalThis.fetch = nativeFetch; registry.invalidateAll(); await new Promise(resolve=>server.httpServer.close(resolve)); }
