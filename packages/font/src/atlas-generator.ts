import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FontError } from '@forgeax/engine-types';
import type { BakeAtlas, MsdfGenerator } from './atlas-font-data.js';
import { NodeWorkerAdapter } from './node-worker-adapter.js';

/** Default charset baked into the atlas (printable ASCII). */
const DEFAULT_CHARSET = (() => {
  let s = '';
  for (let c = 0x20; c <= 0x7e; c++) s += String.fromCharCode(c);
  return s;
})();

const DEFAULT_TEXTURE_SIZE = 1024;
const DEFAULT_FIELD_RANGE = 4;
const DEFAULT_FONT_SIZE = 48;

/** Both producers acquire, use and release one generator through this owner. */
export async function generateFontAtlas(
  ttf: Uint8Array,
  generatorFactory: () => Promise<MsdfGenerator> = realGeneratorFactory,
): Promise<BakeAtlas> {
  let atlas: BakeAtlas;
  let generator: MsdfGenerator | undefined;
  try {
    generator = await generatorFactory();
    atlas = await generator.generateAtlas(ttf);
  } catch (e) {
    throw new FontError({
      code: 'bake-failed',
      expected: '@zappar/msdf-generator to produce an MSDF atlas',
      hint: 'the MSDF generator threw -- a Web Worker + wasm host is required (a plain Node process reports "Worker is not defined"); run the bake in a Worker-capable environment',
      detail: { cause: e instanceof Error ? e.message : String(e) },
    });
  } finally {
    if (generator !== undefined) {
      await generator.dispose().catch(() => undefined);
    }
  }

  return atlas;
}

async function realGeneratorFactory(): Promise<MsdfGenerator> {
  const mod = await import('@zappar/msdf-generator');

  const wasmModuleUrl = import.meta.resolve('@zappar/msdf-generator/msdfgen_wasm.wasm');
  const wasmBytes = await readFile(new URL(wasmModuleUrl));
  const wasmUrl = `data:application/octet-stream;base64,${Buffer.from(wasmBytes).toString('base64')}`;
  const nodeGlobal = globalThis as unknown as { Worker?: typeof NodeWorkerAdapter };
  const previousWorker = nodeGlobal.Worker;
  const msdf = new mod.MSDF({
    workerUrl: fileURLToPath(new URL('./node-msdf-worker.mjs', import.meta.url)),
    wasmUrl,
  });
  try {
    let initialized: Promise<void>;
    nodeGlobal.Worker = NodeWorkerAdapter;
    try {
      initialized = msdf.initialize();
    } finally {
      if (previousWorker === undefined) {
        delete nodeGlobal.Worker;
      } else {
        nodeGlobal.Worker = previousWorker;
      }
    }
    await initialized;
  } catch (cause) {
    await msdf.dispose().catch(() => undefined);
    throw cause;
  }
  return {
    async generateAtlas(ttf: Uint8Array): Promise<BakeAtlas> {
      const a = await msdf.generateAtlas({
        font: ttf,
        charset: DEFAULT_CHARSET,
        textureSize: [DEFAULT_TEXTURE_SIZE, DEFAULT_TEXTURE_SIZE],
        fieldRange: DEFAULT_FIELD_RANGE,
        fontSize: DEFAULT_FONT_SIZE,
      });
      return {
        texture: {
          width: a.texture.width,
          height: a.texture.height,
          data: new Uint8Array(a.texture.data),
        },
        glyphs: a.glyphs.map((g) => ({
          unicode: g.unicode,
          advance: g.advance,
          xoffset: g.xoffset,
          yoffset: g.yoffset,
          atlasPosition: [g.atlasPosition[0], g.atlasPosition[1]],
          atlasSize: [g.atlasSize[0], g.atlasSize[1]],
        })),
        metrics: { lineHeight: a.metrics.lineHeight, ascender: a.metrics.ascender },
        textureSize: [a.textureSize[0], a.textureSize[1]],
        fieldRange: a.fieldRange,
      };
    },
    async dispose(): Promise<void> {
      await msdf.dispose();
    },
  };
}
