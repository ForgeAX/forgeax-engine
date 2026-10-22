import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { targetProfileImporter } from '../apps/game-capability-lab/assets/plugins/target-profile-importer';
import { assetRoots as hdrAssetRoots } from '../apps/learn-render/5.advanced-lighting/6.hdr/vite.config';
import { assetRoots as bloomAssetRoots } from '../apps/learn-render/5.advanced-lighting/7.bloom/vite.config';
import { gameCapabilityAssetRoots } from '../apps/preview/src/template-asset-roots';
import { renderWorkerCommands } from '../packages/app/__tests__/render-worker.commands';
import { pcmRangeFixture } from '../packages/audio-webaudio/src/__tests__/support/pcm-range-fixture';
import { websocketListenerCommands } from '../packages/net-websocket/__tests__/support/ws-listener-commands';
import { diffuseGiCommands } from '../packages/render/src/__tests__/raytracing/diffuse-gi.commands';
import { rayPathCommands } from '../packages/render/src/__tests__/raytracing/path-tracer.commands';
import { sdfCardsCommands } from '../packages/render/src/__tests__/raytracing/sdf-cards.commands';
import { generatedLodCommands } from '../packages/runtime/src/__tests__/generated-lod.server';
import { materialPublicationCommands } from '../packages/runtime/src/__tests__/material-publication.commands';
import { vfxMeshLightingCommands } from '../packages/runtime/src/__tests__/vfx-mesh-lighting.commands';
import { createMaterialPackCooker } from '../packages/shader-compiler/src/index';
import { fixedFieldCommands } from '../packages/vfx-render/src/__tests__/force-fields-fixed-ticks.server';
import { nativeBindingCommands } from '../packages/wgpu-wasm/scripts/__tests__/native-binding.commands.mjs';
import { browserFixtureInputs } from '../scripts/ci/browser-fixture-inputs.mjs';
import browserLaunch from '../scripts/ci/browser-launch.json' with { type: 'json' };
import { browserProcessCacheDir } from '../scripts/ci/browser-process-cache.mjs';
import materialContractInventory from '../scripts/material-contract-inventory.json' with {
  type: 'json',
};
import { externalTextureMaterialFixture } from '../scripts/test/external-texture-material-fixture';
import { materialProgramFixture } from '../scripts/test/material-program-fixture';
import { weaponSpiritMaterialFixture } from '../scripts/test/weapon-spirit-material-fixture';
import { explicitBrowserFiles } from './browser-file-selection';
import { playwrightWithBackgroundPages } from './vitest-browser-provider';
import { createRenderSourceAliases } from './vitest-render-source-alias';
import { createRhiDebugSourceAliases } from './vitest-rhi-debug-source-alias';

// Keep the browser project independently loadable. The full workspace config
// discovers every unit and dawn project; browser CI only needs this project,
// and loading the rest makes Vite's dependency optimizer exceed the heavy
// runner heap before a browser test can start.
const rootDir = fileURLToPath(new URL('..', import.meta.url));
const evidenceSourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: rootDir,
  encoding: 'utf8',
}).trim();
const evidenceBuildId = `vitest-browser-${evidenceSourceSha.slice(0, 12)}`;
const templateAssetRoot = resolve(rootDir, 'apps/game-capability-lab/assets');
const templatePackRoots = gameCapabilityAssetRoots(templateAssetRoot);
const surfaceEvidencePackRoots = [
  resolve(rootDir, 'templates/game-3d/assets/materials.pack.ts'),
  resolve(rootDir, 'apps/preview/assets/surface-standard-evidence.pack.ts'),
  resolve(rootDir, 'apps/preview/assets/surface-water-splash-material.pack.json'),
  resolve(rootDir, 'apps/preview/assets/surface-water-splash.pack.json'),
];
const surfaceOnly =
  process.env.FORGEAX_BROWSER_SURFACE_ONLY === '1' || process.env.FORGEAX_SURFACE_ONLY === '1';
const submoduleJpegMetaPath = resolve(
  rootDir,
  'forgeax-engine-assets/demo-assets/hello-sprite/wood-container.jpg.meta.json',
);
const submoduleBgmMetaPath = resolve(
  rootDir,
  'forgeax-engine-assets/collectathon-audio/bgm-loop.wav.meta.json',
);
const submoduleFbxDir = resolve(rootDir, 'forgeax-engine-assets/vendor/fbx-test');
const submoduleGlbDir = resolve(rootDir, 'forgeax-engine-assets/khronos-gltf-samples/BoxTextured');
const submoduleDejavuFontMetaPath = resolve(
  rootDir,
  'forgeax-engine-assets/dejavu-fonts/DejaVuSansMono.ttf.meta.json',
);
const submoduleDejavuLegacyAtlasMetaPath = resolve(
  rootDir,
  'forgeax-engine-assets/dejavu-fonts/DejaVuSansMono.atlas.png.meta.json',
);
const submoduleDejavuLegacyPackPath = resolve(
  rootDir,
  'forgeax-engine-assets/dejavu-fonts/DejaVuSansMono.font.pack.json',
);
const submoduleSpriteAtlasDir = resolve(
  rootDir,
  'forgeax-engine-assets/demo-assets/hello-sprite-atlas',
);
const browserVendorMetaRoots = [
  'learn-opengl/textures/awesomeface.png.meta.json',
  'learn-opengl/textures/bricks2.jpg.meta.json',
  'learn-opengl/textures/bricks2_disp.jpg.meta.json',
  'learn-opengl/textures/bricks2_normal.jpg.meta.json',
  'learn-opengl/textures/brickwall.jpg.meta.json',
  'learn-opengl/textures/brickwall_normal.jpg.meta.json',
  'learn-opengl/textures/container.jpg.meta.json',
  'learn-opengl/textures/container2.png.meta.json',
  'learn-opengl/textures/container2_specular.png.meta.json',
  'learn-opengl/textures/grass.png.meta.json',
  'learn-opengl/textures/marble.jpg.meta.json',
  'learn-opengl/textures/metal.png.meta.json',
  'learn-opengl/textures/newport_loft.hdr.meta.json',
  'learn-opengl/textures/hdr/newport_loft.hdr.meta.json',
  'learn-opengl/textures/toy_box_diffuse.png.meta.json',
  'learn-opengl/textures/toy_box_disp.png.meta.json',
  'learn-opengl/textures/toy_box_normal.png.meta.json',
  'learn-opengl/textures/window.png.meta.json',
  'learn-opengl/textures/wood.png.meta.json',
  'learn-opengl/meshes/cube-mesh.stub.meta.json',
  'learn-opengl/objects/backpack/backpack.gltf.meta.json',
  'learn-opengl/objects/planet/mars.png.meta.json',
  'learn-opengl/objects/planet/planet.gltf.meta.json',
  'learn-opengl/objects/rock/rock.gltf.meta.json',
  'learn-opengl/objects/rock/rock.png.meta.json',
].map((relativePath) => resolve(rootDir, 'forgeax-engine-assets', relativePath));
const entityVisibilityBrowserTest =
  'apps/hello/entity-visibility/src/__tests__/visibility.browser.test.ts';
const producerReadiness =
  process.env.FORGEAX_BROWSER_PACK_READINESS === 'before-consume' ? 'before-consume' : 'on-demand';

const previewExternalRoots = [
  resolve(rootDir, 'forgeax-engine-assets/demo-assets/template-game-default/sky.hdr.meta.json'),
  resolve(rootDir, 'forgeax-engine-assets/sfx'),
  submoduleJpegMetaPath,
  submoduleBgmMetaPath,
  submoduleFbxDir,
  submoduleGlbDir,
  submoduleDejavuFontMetaPath,
  submoduleDejavuLegacyAtlasMetaPath,
  submoduleDejavuLegacyPackPath,
  submoduleSpriteAtlasDir,
];

export function createBrowserProject() {
  const runEntityVisibilityBrowserTest = process.env.FORGEAX_BROWSER_ENTITY_VISIBILITY === '1';
  // Vitest's Browser server calls globTestFiles without CLI filters when
  // constructing optimizer entries. Derive its include from the same explicit
  // file selection; broad/mixed selectors retain full discovery semantics.
  const include = explicitBrowserFiles(rootDir) ?? [
    '**/*.browser.test.ts',
    // This real-device contract runs on both Browser and native Dawn.
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts',
  ];
  const parityComparison = include.some(
    (file) => file.includes('*') || file.startsWith('apps/parity/color-lighting/'),
  );
  const fixtureSources = [
    ...include,
    ...(include.some((file) => file.startsWith('apps/preview/')) ? [templateAssetRoot] : []),
    ...(include.some((file) => file.startsWith('packages/runtime/src/__tests__/subsurface'))
      ? [resolve(rootDir, 'apps/hello/foliage-transmission/src')]
      : []),
  ];
  const materialPackages = browserFixtureInputs(
    rootDir,
    materialContractInventory.materialPackages,
    fixtureSources,
  ).map((file: string) => resolve(rootDir, file));
  // These owners either reuse their demo closure or author all assets through
  // the fixture Catalog or direct URLs. Unknown/broad/mixed selectors keep the full Catalog.
  const ownerPackRoots = new Map<string, readonly string[]>([
    [
      'apps/learn-render/5.advanced-lighting/6.hdr/src/__tests__/onerror-gate.browser.test.ts',
      hdrAssetRoots,
    ],
    [
      'apps/learn-render/5.advanced-lighting/7.bloom/src/__tests__/onerror-gate.browser.test.ts',
      bloomAssetRoots,
    ],
    ['packages/runtime/src/__tests__/vfx-mesh-lighting.browser.test.ts', []],
    ['packages/runtime/src/__tests__/vfx-mesh-lighting-publication.browser.test.ts', []],
    ['packages/runtime/src/__tests__/optional-pipeline-library.browser.test.ts', []],
    ['packages/render/src/__tests__/gpu-driven-stable-command-addresses.browser.test.ts', []],
    ['packages/render/src/record/__tests__/indirect-bundle-retirement.browser.test.ts', []],
    ['packages/app/__tests__/engine-worker-asset-loss.browser.test.ts', []],
    ['packages/ui-blitz/src/__tests__/browser-extension.browser.test.ts', []],
    ['packages/ui-blitz/src/__tests__/dom.browser.test.ts', []],
    ['packages/ui-blitz/src/__tests__/game-guide-keyboard.browser.test.ts', []],
    ['packages/ui-blitz/src/__tests__/range.browser.test.ts', []],
    ['packages/ui-blitz/src/__tests__/select.browser.test.ts', []],
    ['packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts', []],
  ]);
  const selectedPackRoots =
    include.length > 0 && include.every((file) => ownerPackRoots.has(file))
      ? [...new Set(include.flatMap((file) => ownerPackRoots.get(file) ?? []))]
      : undefined;
  const packRoots = surfaceOnly
    ? surfaceEvidencePackRoots
    : process.env.FORGEAX_BROWSER_PREVIEW_ONLY === '1'
      ? [...templatePackRoots, ...previewExternalRoots]
      : (selectedPackRoots ??
        browserFixtureInputs(
          rootDir,
          [
            resolve(rootDir, 'apps/learn-render/1.getting-started/4.textures/assets'),
            resolve(rootDir, 'apps/learn-render/1.getting-started/5.transformations/assets'),
            resolve(rootDir, 'apps/learn-render/1.getting-started/6.coordinate-systems/assets'),
            resolve(rootDir, 'apps/learn-render/1.getting-started/7.camera/assets'),
            resolve(rootDir, 'apps/learn-render/6.pbr/4.transmission-refraction/assets'),
            ...browserVendorMetaRoots,
            resolve(
              rootDir,
              'forgeax-engine-assets/khronos-gltf-samples/Sponza/Sponza.gltf.meta.json',
            ),
            ...templatePackRoots,
            ...surfaceEvidencePackRoots,
            ...previewExternalRoots,
          ],
          fixtureSources,
        ));
  const plugins = [
    pcmRangeFixture(),
    materialProgramFixture(),
    materialProgramFixture(true),
    materialProgramFixture(true, true),
    externalTextureMaterialFixture(),
    weaponSpiritMaterialFixture(),
    weaponSpiritMaterialFixture(true),
    forgeaxShader({ engineEntries: { pointShadows: true, hdrpSsao: true }, materialPackages }),
    pluginPack({
      runtimeBinding: createStandaloneRuntimeAssetBinding('browser-tests'),
      producerReadiness: surfaceOnly ? 'before-consume' : producerReadiness,
      roots: packRoots,
      importers: [
        imageImporter,
        gltfImporter,
        audioImporter,
        fbxImporter,
        fontImporter,
        targetProfileImporter(),
      ],
      cookers: [
        createParticleCodeNativeCookerFromRoots([
          templateAssetRoot,
          resolve(rootDir, 'apps/preview/assets'),
        ]),
        createMaterialPackCooker([
          resolve(rootDir, 'templates/game-3d/assets/shaders'),
          resolve(rootDir, 'apps/preview/assets'),
        ]),
      ],
    }),
  ];
  return {
    // A live Host or another selected roster must not replace this optimizer's files.
    cacheDir: resolve(browserProcessCacheDir(rootDir, process.pid), 'renderer'),
    // Resolve nested dependencies through their installed workspace owners.
    // Bare root names do not resolve in pnpm's isolated dependency graph.
    // Vitest adds its normal entries; the selected Parity source also exposes
    // the comparison imports before serialized Browser callbacks execute.
    optimizeDeps: {
      include: [
        // Vitest's browser command transport discovers ws after startup.
        // Preload it so optimization cannot invalidate running test imports.
        'ws',
        '@forgeax/engine-render > @forgeax/engine-rhi-debug > pako',
        '@forgeax/engine-render > @forgeax/engine-rhi-debug > @noble/hashes/blake3.js',
        ...(parityComparison ? ['ajv/dist/2020.js'] : []),
      ],
      entries: [
        ...(parityComparison
          ? ['apps/parity/color-lighting/src/compare/lighting-reference.ts']
          : []),
        // The complete guide loads its ordinary controller through a runtime URL.
        // Discover its dependencies before that import can reload a running test.
        ...(include.some((file) => file.includes('*') || file.startsWith('packages/ui-blitz/'))
          ? ['templates/game-3d/assets/ui/guide-controller.ts']
          : []),
      ],
    },
    resolve: {
      alias: [...createRenderSourceAliases(), ...createRhiDebugSourceAliases()],
    },
    // File-only discovery uses this project's actual include/exclude rules;
    // it must not initialize renderer or asset publications.
    plugins: process.argv.includes('list') && process.argv.includes('--filesOnly') ? [] : plugins,
    server: {
      // Loop state is not a browser source; test discovery exclusions do not filter Vite watches.
      watch: { ignored: ['**/.forgeax-harness/**'] },
      fs: { allow: [rootDir] },
      ...(process.env.FORGEAX_BROWSER_CROSS_ORIGIN_ISOLATED === '1'
        ? {
            headers: {
              'Cross-Origin-Opener-Policy': 'same-origin',
              'Cross-Origin-Embedder-Policy': 'require-corp',
            },
          }
        : {}),
    },
    define: {
      'import.meta.env.FORGEAX_RUNTIME_SCOPE_ID': JSON.stringify('browser-tests'),
      'import.meta.env.VITE_FORGEAX_EVIDENCE_SOURCE_SHA': JSON.stringify(evidenceSourceSha),
      'import.meta.env.VITE_FORGEAX_EVIDENCE_BUILD_ID': JSON.stringify(evidenceBuildId),
      // CI may shorten only the high-density browser carriers; keep the flag
      // explicit in the browser bundle instead of relying on a Node-only
      // process shim.
      'import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT': JSON.stringify(
        process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT ?? '0',
      ),
    },
    test: {
      name: 'browser',
      include,
      exclude: [
        // These owners publish native artifacts, never Browser source tests.
        'packages/wgpu-wasm/target/**',
        'packages/dawn-node/.native-build/**',
        '**/.forgeax-harness/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/artifacts/**',
        '**/.forgeax-harness/**',
        '**/.worktrees/**',
        '**/.forgeax-harness/**',
        '**/.claude/worktrees/**',
        ...(runEntityVisibilityBrowserTest ? [] : [entityVisibilityBrowserTest]),
      ],
      // Chromium's software WebGPU device is shared by browser workers. Keep
      // one Vitest worker as the lifecycle boundary for this real-WebGPU
      // project; the split runner adds a process boundary between groups.
      fileParallelism: false,
      maxWorkers: 1,
      deps: {
        optimizer: {
          client: { enabled: false },
        },
      },
      browser: {
        enabled: true,
        // Keep headed screenshots at their authored size instead of scaling
        // the test iframe to fit Vitest's preview panel.
        ui: false,
        commands: {
          ...nativeBindingCommands,
          ...fixedFieldCommands,
          ...renderWorkerCommands,
          ...websocketListenerCommands,
          ...vfxMeshLightingCommands,
          ...materialPublicationCommands,
          ...generatedLodCommands,
          ...rayPathCommands,
          ...sdfCardsCommands,
          ...diffuseGiCommands,
        },
        provider: playwrightWithBackgroundPages({
          launchOptions: {
            ...browserLaunch,
            args: [
              ...browserLaunch.args.flatMap((argument) => {
                if (process.platform !== 'win32') return [argument];
                if (argument.startsWith('--enable-features=Vulkan')) return [];
                if (argument === '--use-vulkan=swiftshader')
                  return ['--use-webgpu-adapter=swiftshader'];
                return [argument];
              }),
              // CI deliberately selects software. Cold submissions can exceed
              // Chromium's GPU watchdog; the unchanged test deadlines bound them.
              ...(process.env.CI
                ? [
                    ...(process.platform === 'win32' ? [] : ['--use-angle=swiftshader']),
                    '--disable-gpu-watchdog',
                  ]
                : []),
            ],
          },
        }),
        instances: [{ browser: 'chromium' }],
        headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0' && !!process.env.CI,
      },
    },
  };
}
