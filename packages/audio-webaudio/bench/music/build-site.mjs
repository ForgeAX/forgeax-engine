import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { executionWorkerEntries } from '@forgeax/engine/devkit/plugin-build';
import { pluginPack } from '@forgeax/engine/vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine/vite-plugin-shader';
import { audioImporter } from '@forgeax/engine/audio-webaudio/audio-importer';
import { createMusicFixtureShaderManifest } from './shader-manifest.mjs';

// Ordinary author files and public build plugins; no workspace aliases or Git state.
export async function buildMusicSite({root,authorRoot,kernelEntry,site}) {
  const fixtures=resolve(root,'artifacts/roi-23/fixtures');
  const publicDir=resolve(root,'artifacts/roi-23/authored-public');
  const scores=resolve(publicDir,'scores');
  await mkdir(fixtures,{recursive:true});
  await mkdir(scores,{recursive:true});
  // Saved project configuration is ordinary JSON, with ordinary clip GUIDs.
  // Keep it outside the audio import roots: this is author data, not a new asset kind.
  for (const [base,count] of [[2300,1],[2300,4],[2300,16],[2400,4],[2500,4],[2510,4]]) {
    const score={bpm:base>=2500?137:120,beatsPerBar:4,loopBeats:4,
      stems:Array.from({length:count},(_,stem)=>({
        clip:`aaaaaaaa-aaaa-4aaa-8aaa-${String(stem+base).padStart(12,'0')}`,
        ...(base>=2500?{offsetSeconds:base===2510?(stem+1)*6400/48000:(stem+1)/8}:{})
      }))};
    await writeFile(resolve(scores,`${score.stems[0].clip}-${count}.json`),JSON.stringify(score,null,2)+'\n');
  }
for (let stem = 0; stem < 16; stem++) {
  const rate = 48000, frames = rate * 2;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let beat = 0; beat < 4; beat++) bytes.writeInt16LE(Math.round((stem + 1) / 64 * 32767), 44 + (beat * rate / 2 + stem * 32) * 2);
  const name = `stem-${stem}.wav`;
  await writeFile(resolve(fixtures, name), bytes);
  await writeFile(resolve(fixtures, `${name}.meta.json`), JSON.stringify({ schemaVersion: '1.0.0', kind: 'external-asset-package', importer: 'audio', importSettings: { playback: 'buffer' },
    subAssets: [{ sourceKey: 'audio:audio', guid: `aaaaaaaa-aaaa-4aaa-8aaa-${String(stem + 2300).padStart(12, '0')}`, kind: 'audio', sourceIndex: 0 }] }));
}
// Ordinary authored offset/resampling fixtures; native PCM remains the oracle.
for (const commonPhase of [false,true]) for (let stem=0;stem<4;stem++) {
  const rate=48000, offset=commonPhase?(stem+1)*6400/rate:(stem+1)/8;
  const frames=Math.ceil((offset+240/137+0.1+stem/10)*rate);
  const bytes=Buffer.alloc(44+frames*2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length-8,4); bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);
  bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*2,40);
  const marker=Math.round(offset*rate)+128+stem*(commonPhase?160:128);
  bytes.writeInt16LE(Math.round((stem+1)/16*32767),44+marker*2);
  const name=`resampled-${commonPhase?'common':'fractional'}-${stem}.wav`;
  await writeFile(resolve(fixtures,name),bytes);
  await writeFile(resolve(fixtures,`${name}.meta.json`),JSON.stringify({schemaVersion:'1.0.0',kind:'external-asset-package',importer:'audio',importSettings:{playback:'buffer'},
    subAssets:[{sourceKey:'audio:audio',guid:`aaaaaaaa-aaaa-4aaa-8aaa-${String(stem+(commonPhase?2510:2500)).padStart(12,'0')}`,kind:'audio',sourceIndex:0}]}));
}
// Four audible layers are ordinary authored source WAVs, separate from timing markers.
for (let stem = 0; stem < 4; stem++) {
  const rate = 48000, frames = rate * 2;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let sample = 0; sample < frames; sample++) {
    const time = sample / rate, beatTime = time % 0.5, stepTime = time % 0.25;
    let value;
    if (stem === 0) value = 0.2 * Math.exp(-beatTime * 24) * Math.sin(2 * Math.PI * (55 * beatTime + 45 / 25 * (1 - Math.exp(-beatTime * 25))));
    else if (stem === 1) value = 0.12 * Math.sin(2 * Math.PI * 55 * time) * Math.sin(Math.PI * beatTime / 0.5) ** 2;
    else if (stem === 2) value = [220, 261.625565, 329.627557].reduce((sum, hz) => sum + Math.sin(2 * Math.PI * hz * time), 0) / 3 * 0.09 * Math.sin(Math.PI * time / 2) ** 2;
    else { const hz = [440, 523.25113, 659.255114, 880, 659.255114, 523.25113, 440, 329.627557][Math.floor(time * 4)]; value = 0.1 * Math.sin(2 * Math.PI * hz * stepTime) * Math.sin(Math.PI * stepTime / 0.25) ** 2; }
    bytes.writeInt16LE(Math.round(value * 32767), 44 + sample * 2);
  }
  const name = `musical-layer-${stem}.wav`;
  await writeFile(resolve(fixtures, name), bytes);
  await writeFile(resolve(fixtures, `${name}.meta.json`), JSON.stringify({ schemaVersion: '1.0.0', kind: 'external-asset-package', importer: 'audio', importSettings: { playback: 'buffer' },
    subAssets: [{ sourceKey: 'audio:audio', guid: `aaaaaaaa-aaaa-4aaa-8aaa-${String(stem + 2400).padStart(12, '0')}`, kind: 'audio', sourceIndex: 0 }] }));
}
await build({ configFile: false, root: authorRoot, publicDir,
  define: { 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': JSON.stringify(process.env.FORGEAX_MUSIC_RHI_DEBUG === '1' ? '1' : '0') },
  plugins: [executionWorkerEntries(), pluginPack({ roots: [fixtures], importers: [audioImporter], ddc: { projectDdcRoot: resolve(root, 'artifacts/roi-23/ddc') } }),
    forgeaxShader({ engineEntries: { pointShadows: true, hdrpSsao: true } })],
  build: { target:'esnext', assetsInlineLimit:0, outDir: site, emptyOutDir: true,
    rollupOptions:{preserveEntrySignatures:'strict',input:{
      index:resolve(authorRoot,'index.html'),
      'music-bootstrap':resolve(authorRoot,'app-bootstrap.ts'),
      'music-kernel':kernelEntry,
    },output:{entryFileNames:'assets/[name].js'}} } });
const publication = JSON.parse(await readFile(resolve(site, 'shaders/manifest.json'), 'utf8'));
await writeFile(
  resolve(site, 'shaders/music-manifest.json'),
  JSON.stringify(createMusicFixtureShaderManifest(publication)),
);
}
