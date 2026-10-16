import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptRoot, '..');
const engineRoot = resolve(packageRoot, '../..');
const privateSource = resolve(
  engineRoot,
  'forgeax-engine-assets/demo-assets/template-game-default/sky.hdr',
);
const packageKitRoot = resolve(packageRoot, 'assets/canonical-kit');
const configuredOutput = process.env.FORGEAX_CANONICAL_KIT_OUTPUT;
const defaultOutput =
  configuredOutput === undefined ? packageKitRoot : resolve(configuredOutput);
const publicSource = resolve(packageKitRoot, 'sky.hdr');
const defaultMeta = resolve(packageKitRoot, 'sky.hdr.meta.json');
const generatedSource = 'forgeax-generated://canonical-kit/sky.hdr';
const sdkSourceKey = 'forgeax-sdk://resources/preview-canonical-kit/sky.hdr';
const publicDistributionMarker = resolve(engineRoot, '.forgeax-public-distribution');
const defaultSource =
  !existsSync(publicDistributionMarker) && existsSync(privateSource)
    ? privateSource
    : existsSync(publicSource)
      ? publicSource
      : generatedSource;

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function generatedHdr() {
  const header = Buffer.from(
    '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n',
    'ascii',
  );
  // The engine HDR decoder intentionally accepts Radiance's new-RLE form only
  // and requires the scanline width to be at least eight pixels. Emit one
  // neutral 8-pixel scanline using one run per channel instead of the old
  // one-pixel placeholder (which was never a valid new-RLE scanline).
  return Buffer.concat([
    header,
    Buffer.from([
      0x02,
      0x02,
      0x00,
      0x08,
      0x88,
      0x80,
      0x88,
      0x80,
      0x88,
      0x80,
      0x88,
      0x80,
    ]),
  ]);
}

async function readSource(sourcePath) {
  return sourcePath === generatedSource ? generatedHdr() : readFile(sourcePath);
}

function sourceKey(sourcePath) {
  if (sourcePath === generatedSource) return generatedSource;
  if (sourcePath === publicSource || process.env.FORGEAX_SDK_BUILD === '1') return sdkSourceKey;
  return 'forgeax-engine-assets/demo-assets/template-game-default/sky.hdr';
}

export async function buildCanonicalKit({
  sourcePath = defaultSource,
  metaPath = defaultMeta,
  outputRoot = defaultOutput,
} = {}) {
  const [source, metaBytes] = await Promise.all([readSource(sourcePath), readFile(metaPath)]);
  const meta = JSON.parse(metaBytes.toString('utf8'));
  const sourceDigest = digest(source);
  const metaDigest = digest(metaBytes);
  const guid = meta.guid ?? meta.subAssets?.[0]?.guid;
  if (typeof guid !== 'string' || guid.length === 0) {
    throw new Error('canonical kit source Meta must provide a GUID');
  }
  const recipe = {
    schemaVersion: '1.0.0',
    rig: 'handle-sphere',
    environment: 'engine-canonical',
    skybox: 'engine-canonical',
    skylight: 'engine-canonical',
    directionalLight: 'engine-canonical',
    stage: 'neutral-material-checker-unlit',
    camera: 'bounds-derived',
  };
  const recipeDigest = digest(Buffer.from(stableJson(recipe)));
  const receipt = {
    schemaVersion: '1.0.0',
    producer: 'packages/preview/scripts/build-canonical-kit.mjs',
    source: {
      sourceKey: sourceKey(sourcePath),
      guid,
      digest: sourceDigest,
      metaDigest,
    },
    recipe: { digest: recipeDigest, value: recipe },
    cooked: {
      importer: 'image',
      kind: 'equirect',
      sourceDigest,
      metaDigest,
    },
    package: { name: '@forgeax/engine-preview', root: 'assets/canonical-kit' },
    transport: {
      dev: 'pluginPack',
      build: 'pluginPack',
      sdk: 'files/assets/canonical-kit',
      source: 'sky.hdr',
      meta: 'sky.hdr.meta.json',
    },
  };
  await mkdir(outputRoot, { recursive: true });
  await Promise.all([
    writeFile(resolve(outputRoot, 'sky.hdr'), source),
    writeFile(resolve(outputRoot, 'sky.hdr.meta.json'), metaBytes),
    writeFile(resolve(outputRoot, 'cook-receipt.json'), stableJson(receipt)),
  ]);
  await Promise.all(
    ['preview-kit.payload.json', 'preview-kit.pack.json', 'catalog.json'].map((name) =>
      rm(resolve(outputRoot, name), { force: true }),
    ),
  );
  return { sourceDigest, metaDigest, recipeDigest, guid };
}

export async function publishCanonicalKit(sourceRoot, outputRoot) {
  const files = ['sky.hdr', 'sky.hdr.meta.json', 'cook-receipt.json'];
  for (const file of files) {
    const staged = resolve(sourceRoot, file);
    if (!existsSync(staged))
      throw new Error(`canonical kit producer did not stage ${file}: ${staged}`);
  }
  await mkdir(outputRoot, { recursive: true });
  await Promise.all(files.map((file) => copyFile(resolve(sourceRoot, file), resolve(outputRoot, file))));
}

if (
  process.argv[1] !== undefined &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await buildCanonicalKit({
    ...(process.argv[2] === undefined ? {} : { sourcePath: resolve(process.argv[2]) }),
    ...(process.argv[3] === undefined ? {} : { metaPath: resolve(process.argv[3]) }),
    ...(process.argv[4] === undefined ? {} : { outputRoot: resolve(process.argv[4]) }),
  });
}
