import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

const { values } = parseArgs({
  options: {
    'engine-root': { type: 'string' },
    out: { type: 'string' },
    font: { type: 'string' },
    'font-license': { type: 'string' },
    backend: { type: 'string' },
    host: { type: 'string', default: 'browser' },
    appid: { type: 'string' },
    reference: { type: 'string' },
    scene: { type: 'string', default: 'benchmark' },
    help: { type: 'boolean' },
  },
});
const usage =
  'node build_ui_gpu_benchmark.mjs --engine-root PATH --out NEW_DIRECTORY --backend webgpu|wgpu-webgl2 [--font LICENSED_FONT --font-license LICENSE_FILE | --reference FROZEN_BROWSER_FIXTURE] [--host wechat --appid LOCAL_APPID] [--scene benchmark|gallery|settings]';
if (values.help) {
  console.log(usage);
  process.exit(0);
}
if (
  !values['engine-root'] ||
  !values.out ||
  (!values.reference && (!values.font || !values['font-license']))
)
  throw Error(usage);
if (!['webgpu', 'wgpu-webgl2'].includes(values.backend)) throw Error(usage);
if (!['browser', 'wechat'].includes(values.host)) throw Error(usage);
if (!['benchmark', 'gallery', 'settings'].includes(values.scene)) throw Error(usage);
if (values.scene !== 'benchmark' && values.backend !== 'wgpu-webgl2')
  throw Error('Interactive UI fixtures require --backend wgpu-webgl2');
const gallery = values.scene === 'gallery';
const interactive = values.scene !== 'benchmark';
const sceneName = values.scene === 'settings' ? 'Settings' : 'Gallery';
if (
  values.host === 'wechat' &&
  (values.backend !== 'wgpu-webgl2' || !/^wx[0-9a-f]{16}$/.test(values.appid ?? ''))
)
  throw Error('WeChat requires --backend wgpu-webgl2 and a local --appid wx...');
if (values.reference && (values.font || values['font-license']))
  throw Error('--reference retains its existing font and license; do not supply replacements');
const engine = resolve(values['engine-root']),
  out = resolve(values.out);
const scripts = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(scripts, '../fixtures/ui-gpu-benchmark');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = async (path) => {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: sha256(bytes) };
};
const reference = values.reference ? resolve(values.reference) : null;
let referenceInputs;
if (reference) {
  referenceInputs = JSON.parse(await readFile(join(reference, 'inputs.json'), 'utf8'));
  if (referenceInputs.backend !== values.backend || referenceInputs.host === 'wechat')
    throw Error('Reference must be a browser fixture using the same backend');
  if ((referenceInputs.scene ?? 'benchmark') !== values.scene)
    throw Error('Reference must retain the selected scene');
  for (const [name, expected] of Object.entries(referenceInputs.files)) {
    const actual = await identity(join(reference, name));
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      throw Error(`Reference artifact changed: ${name}`);
  }
  const expectedGlue = referenceInputs.kernel.outputs['ui-native.mjs'];
  if (
    (await identity(join(engine, 'packages/ui-blitz/pkg/ui-native.mjs'))).sha256 !==
    expectedGlue.sha256
  )
    throw Error('Current UI native glue does not match the frozen reference WASM');
  if (values.backend === 'wgpu-webgl2') {
    for (const name of ['wgpu_wasm_bg.wasm', 'wgpu_wasm.js', 'provenance.json']) {
      if (
        (await identity(join(engine, 'packages/wgpu-wasm/pkg', name))).sha256 !==
        referenceInputs.files[`pkg/${name}`].sha256
      )
        throw Error(`Current wgpu native input does not match the reference: ${name}`);
    }
  }
}
await (
  await import(pathToFileURL(join(engine, 'packages/ui-blitz/scripts/provenance.mjs')).href)
).verifyProvenance();
if (values.backend === 'wgpu-webgl2')
  await (
    await import(pathToFileURL(join(engine, 'packages/wgpu-wasm/scripts/provenance.mjs')).href)
  ).verifyProvenance();
await mkdir(out);
if (reference && !interactive)
  await copyFile(join(reference, 'startup.generated.js'), join(out, 'startup.generated.js'));
else if (!interactive) {
  const { hostStartupDocument, hostStartupScript } = await import(
    pathToFileURL(join(engine, 'packages/devkit/src/host/startup-source.ts')).href
  );
  await writeFile(
    join(out, 'startup.generated.js'),
    `export const startupDocument=${JSON.stringify(hostStartupDocument('3C starter'))};\nexport function createStartup(host){return ${hostStartupScript(true, 'host').trim()} }\n`,
  );
}
const wasmPath = reference
  ? join(reference, 'ui.wasm')
  : join(engine, 'packages/ui-blitz/pkg/ui_blitz_bg.wasm');
const fontPath = reference ? join(reference, 'font.bin') : values.font;
const licensePath = reference ? join(reference, 'FONT-LICENSE.txt') : values['font-license'];
const galleryImage = gallery
  ? Buffer.from(
      (
        await readFile(
          join(engine, 'packages/ui-blitz/rust/test-assets/aspect-pattern.txt'),
          'utf8',
        )
      ).split(',')[1],
      'base64',
    )
  : undefined;
const workload = gallery
  ? {
      scene: 'composed-gallery',
      core: await identity(join(fixture, 'interactive.js')),
      sceneModule: await identity(join(fixture, 'gallery.js')),
      source: await identity(
        join(engine, 'packages/ui-blitz/src/__tests__/composed-gallery-fixture.ts'),
      ),
      image: { bytes: galleryImage.length, sha256: sha256(galleryImage) },
      uiWasm: await identity(wasmPath),
      font: await identity(fontPath),
    }
  : interactive
    ? {
        scene: 'controls-workflow',
        core: await identity(join(fixture, 'interactive.js')),
        sceneModule: await identity(join(fixture, 'settings.js')),
        source: await identity(
          join(engine, 'packages/ui-blitz/src/__tests__/controls-workflow-fixture.ts'),
        ),
        inventory: await identity(
          join(engine, 'packages/ui-blitz/src/__tests__/inventory-fixture.ts'),
        ),
        settingsController: await identity(
          join(engine, 'apps/game-capability-lab/assets/plugins/settings.ts'),
        ),
        settingsAsset: await identity(
          join(engine, 'apps/game-capability-lab/assets/ui/settings.pack.json'),
        ),
        uiWasm: await identity(wasmPath),
        font: await identity(fontPath),
      }
    : {
        width: 2532,
        height: 1170,
        pixelRatio: 3,
        core: await identity(join(fixture, 'benchmark.js')),
        guide: await identity(join(fixture, 'guide.js')),
        startup: await identity(join(out, 'startup.generated.js')),
        uiWasm: await identity(wasmPath),
        font: await identity(fontPath),
      };
const workloadIdentity = { sha256: sha256(JSON.stringify(workload)), ...workload };
if (
  referenceInputs &&
  JSON.stringify(workloadIdentity) !== JSON.stringify(referenceInputs.workloadIdentity)
)
  throw Error(
    'Current authored scene/controller or GPU runner differs from the frozen reference',
  );
await writeFile(
  join(out, 'identity.generated.js'),
  `export const identity=${JSON.stringify(workloadIdentity)};\nexport const sceneName=${JSON.stringify(sceneName)};\n`,
);
const { build } = createRequire(
  await realpath(join(engine, 'node_modules/tsup/dist/index.js')),
)('esbuild');
const aliases = {
  '@probe/rhi-backend':
    values.backend === 'webgpu'
      ? 'packages/rhi-webgpu/src/index.ts'
      : 'packages/rhi-wgpu/src/index.ts',
  '@forgeax/engine-rhi-wgpu/wasm-runtime': 'packages/rhi-wgpu/src/wasm-browser.ts',
  '@forgeax/engine-wgpu-wasm': 'packages/wgpu-wasm/src/index.ts',
  '@probe/gpu-ui-raster': 'packages/render/src/assembly/gpu-ui-raster.ts',
  '@probe/ui-compositor': 'packages/render/src/assembly/ui-compositor.ts',
  '@probe/ui-blitz': 'packages/ui-blitz/src/index.ts',
  '@probe/ui-oracle': 'packages/ui-blitz/src/__tests__/gpu-parity-fixture.ts',
  '@probe/guide-fixture': 'packages/platform-wechat/__tests__/guide-ui-fixture.ts',
  '@probe/guide-html': 'templates/game-3d/assets/guide.ui.html',
  '@probe/guide-css': 'templates/game-3d/assets/guide.ui.css',
  '@probe/settings-scene': 'packages/ui-blitz/src/__tests__/controls-workflow-fixture.ts',
  '@probe/gallery-scene': 'packages/ui-blitz/src/__tests__/composed-gallery-fixture.ts',
  '@probe/gallery-image': 'packages/ui-blitz/rust/test-assets/aspect-pattern.txt',
  '@forgeax/engine/ui': 'packages/ui/src/index.ts',
  '@forgeax/engine/ui/localization': 'packages/ui/src/localization/index.ts',
  '@forgeax/engine-ui': 'packages/ui/src/index.ts',
  '@forgeax/engine-ui/authoring': 'packages/ui/src/authoring/index.ts',
};
if (values.host === 'wechat') {
  aliases['@forgeax/engine-rhi-wgpu/wasm-runtime'] = 'packages/rhi-wgpu/src/wasm-native.ts';
  aliases['@forgeax/engine/platform-wechat'] = 'packages/platform-wechat/src/index.ts';
  aliases['@forgeax/engine/platform-wechat/standards'] =
    'packages/platform-wechat/src/standards.ts';
  aliases['@forgeax/engine-platform'] = 'packages/platform/src/index.ts';
  aliases['@forgeax/engine/wgpu-wasm/native-host'] = 'packages/wgpu-wasm/src/native-host.ts';
}
const alias = Object.fromEntries(
  Object.entries(aliases).map(([name, path]) => [name, join(engine, path)]),
);
alias['@probe/startup'] = join(out, 'startup.generated.js');
if (interactive) alias['@probe/scene'] = join(fixture, `${values.scene}.js`);
alias['@probe/host'] = join(fixture, `${values.host}-host.js`);
alias['@probe/identity'] = join(out, 'identity.generated.js');
let nativeTemporary;
let nativeReceipt;
try {
  if (values.host === 'wechat') {
    nativeTemporary = await mkdtemp(join(tmpdir(), 'forgeax-ui-benchmark-'));
    const { buildNativeWgpu } = await import(
      pathToFileURL(join(engine, 'packages/wgpu-wasm/scripts/native-build.mjs')).href
    );
    const built = await buildNativeWgpu({ out: join(nativeTemporary, 'binding') });
    nativeReceipt = built.receipt;
    alias['@probe/native-wgpu'] = join(built.directory, 'wgpu-native.mjs');
    await mkdir(join(out, 'ui'));
  }
  const result = await build({
    absWorkingDir: engine,
    entryPoints: [join(fixture, `${interactive ? 'interactive-' : ''}${values.host}.js`)],
    outfile: join(out, values.host === 'wechat' ? 'ui/game.js' : 'browser.bundle.js'),
    bundle: true,
    format: values.host === 'wechat' ? 'iife' : 'esm',
    platform: values.host === 'wechat' ? 'neutral' : 'browser',
    mainFields: ['module', 'main'],
    conditions: values.host === 'wechat' ? ['forgeax-native', 'import', 'module'] : undefined,
    target: 'es2022',
    nodePaths: [join(engine, 'node_modules')],
    loader: { '.html': 'text', '.css': 'text', '.txt': 'text' },
    alias,
    metafile: true,
    plugins: [
      {
        name: 'authored-raw-source',
        setup(build) {
          build.onResolve({ filter: /\?inline$/ }, ({ path, importer }) => ({
            path: resolve(dirname(importer), path.slice(0, -7)),
            namespace: 'inline',
          }));
          build.onLoad({ filter: /.*/, namespace: 'inline' }, async ({ path }) => ({
            contents: await readFile(path),
            loader: 'dataurl',
          }));
          build.onResolve({ filter: /\?raw$/ }, ({ path, importer }) => ({
            path: resolve(dirname(importer), path.slice(0, -4)),
            namespace: 'raw',
          }));
          build.onLoad({ filter: /.*/, namespace: 'raw' }, async ({ path }) => ({
            contents: await readFile(path, 'utf8'),
            loader: 'text',
          }));
        },
      },
    ],
  });
  const hostFiles = [];
  const backendFiles = [];
  if (values.host === 'wechat') {
    for (const [source, target] of [
      [wasmPath, 'ui/ui.wasm.br'],
      [join(engine, 'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm'), 'ui/wgpu.wasm.br'],
    ]) {
      const bytes = await readFile(source);
      const compressed = brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
      });
      if (!brotliDecompressSync(compressed).equals(bytes))
        throw Error(`Compressed payload changed: ${target}`);
      await writeFile(join(out, target), compressed);
    }
    await copyFile(fontPath, join(out, 'ui/font.bin'));
    await copyFile(licensePath, join(out, 'ui/FONT-LICENSE.txt'));
    await writeFile(
      join(out, 'game.js'),
      interactive
        ? `globalThis.__forgeaxUi${sceneName}={read:()=>({phase:'subpackage-loading'})};\nwx.loadSubpackage({name:'ui',fail:error=>{globalThis.__forgeaxUi${sceneName}={read:()=>({phase:'failed',error})};console.error('FORGEAX_UI_${sceneName.toUpperCase()}_LOAD_FAILED',JSON.stringify(error));}});\n`
        : "globalThis.__forgeaxUiBenchmark={read:()=>({phase:'subpackage-loading'})};\nwx.loadSubpackage({name:'ui',fail:error=>{globalThis.__forgeaxUiBenchmark={read:()=>({phase:'failed',error})};console.error('FORGEAX_UI_BENCHMARK_LOAD_FAILED',JSON.stringify(error));}});\n",
    );
    await writeFile(
      join(out, 'game.json'),
      JSON.stringify(
        { deviceOrientation: 'landscape', subpackages: [{ name: 'ui', root: 'ui/' }] },
        null,
        2,
      ) + '\n',
    );
    await writeFile(
      join(out, 'project.config.json'),
      JSON.stringify(
        {
          appid: values.appid,
          compileType: 'game',
          projectname: interactive
            ? `ForgeAX GPU UI ${sceneName}`
            : 'ForgeAX Shared GPU UI Benchmark',
          libVersion: 'latest',
          setting: { es6: false, enhance: false, minified: false },
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    await writeFile(
      join(out, 'native.provenance.json'),
      JSON.stringify(nativeReceipt, null, 2) + '\n',
    );
    hostFiles.push(
      'game.js',
      'game.json',
      'project.config.json',
      'ui/game.js',
      'ui/ui.wasm.br',
      'ui/wgpu.wasm.br',
      'ui/font.bin',
      'ui/FONT-LICENSE.txt',
      'native.provenance.json',
    );
  } else {
    await copyFile(wasmPath, join(out, 'ui.wasm'));
    if (values.backend === 'wgpu-webgl2') {
      await mkdir(join(out, 'pkg'));
      for (const name of ['wgpu_wasm_bg.wasm', 'wgpu_wasm.js', 'provenance.json']) {
        await copyFile(join(engine, 'packages/wgpu-wasm/pkg', name), join(out, 'pkg', name));
        backendFiles.push(`pkg/${name}`);
      }
    }
    await copyFile(fontPath, join(out, 'font.bin'));
    await copyFile(licensePath, join(out, 'FONT-LICENSE.txt'));
    if (!interactive)
      await copyFile(join(scripts, 'run_ui_gpu_benchmark.mjs'), join(out, 'run.mjs'));
    await writeFile(
      join(out, 'index.html'),
      interactive
        ? `<!doctype html><meta charset="utf-8"><title>ForgeAX GPU UI ${sceneName}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#10243a}canvas{display:block}</style><canvas></canvas><script type="module" src="browser.bundle.js"></script>`
        : '<!doctype html><meta charset="utf-8"><title>ForgeAX GPU UI owner benchmark</title><style>html,body{margin:0;width:100%;height:100%;background:#263746}canvas{display:block;width:844px;height:390px}</style><canvas width="2532" height="1170"></canvas><script type="module" src="browser.bundle.js"></script>',
    );
    hostFiles.push(
      'browser.bundle.js',
      'ui.wasm',
      'font.bin',
      'FONT-LICENSE.txt',
      'index.html',
      ...(!interactive ? ['run.mjs'] : []),
    );
  }
  const files = {};
  for (const name of [
    ...hostFiles,
    ...backendFiles,
    ...(!interactive ? ['startup.generated.js'] : []),
    'identity.generated.js',
  ]) {
    const bytes = await readFile(join(out, name));
    files[name] = {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  await writeFile(
    join(out, 'inputs.json'),
    JSON.stringify(
      {
        kind: interactive ? `ui-gpu-${values.scene}` : 'ui-gpu-owner-benchmark',
        scene: values.scene,
        backend: values.backend,
        host: values.host,
        workloadIdentity,
        reference: reference
          ? {
              inputs: await identity(join(reference, 'inputs.json')),
              ...(!interactive ? { startup: workload.startup } : {}),
            }
          : null,
        scope: interactive
          ? 'Shared retained owner diagnostic through production GPU UI raster/compositor, native input and actual display/DPR. No 3D World or simulator/device acceptance from build alone.'
          : 'Actual startup/guide/controls; fixture messages, no 3D World or simulator/device acceptance.',
        ...(!interactive ? { width: 2532, height: 1170, pixelRatio: 3 } : {}),
        files,
        kernel:
          referenceInputs?.kernel ??
          JSON.parse(
            await readFile(join(engine, 'packages/ui-blitz/pkg/provenance.json'), 'utf8'),
          ),
        moduleInputs: Object.keys(result.metafile.inputs),
        moduleContent: await Promise.all(
          Object.keys(result.metafile.inputs).map(async (path) => ({
            path,
            bytesInOutput: Object.values(result.metafile.outputs).reduce(
              (total, output) => total + (output.inputs[path]?.bytesInOutput ?? 0),
              0,
            ),
            ...(await identity(
              /^(raw|inline):/.test(path)
                ? path.slice(path.indexOf(':') + 1)
                : resolve(engine, path),
            )),
          })),
        ),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ out, files }));
} finally {
  if (nativeTemporary) await rm(nativeTemporary, { recursive: true, force: true });
}
