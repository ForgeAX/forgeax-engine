import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { discoverPluginAssets, executionWorkerEntries, publishedPluginInventory, pluginProgramsBuild, pluginRuntimeProjection } from '@forgeax/engine-devkit/plugin-build';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { audioImporter } from '@forgeax/engine-audio-webaudio/audio-importer';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { fbxImporter } from '@forgeax/engine-fbx';
import { gltfImporter } from '@forgeax/engine-gltf';
import { fontImporter } from '@forgeax/engine-font/font-importer';
import { createUiImporter } from '@forgeax/engine-ui/importer';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { parseProducerReadiness } from '@forgeax/engine-import';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { defineConfig } from 'vite';
import { targetProfileImporter } from '../../apps/game-capability-lab/assets/plugins/target-profile-importer';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { resolveProjectPort } from '@forgeax/engine-devkit';
import {
  collectAssetDeclarationRoots,
  gameCapabilityAssetRoots,
  parseTemplateSmokeSlugs,
  selectTemplateAssetRoots,
} from './src/template-asset-roots';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..');
const previewPort = resolveProjectPort(undefined);
const templatesDir = resolve(monorepoRoot, 'templates');
const smokeRoot = process.env.FORGEAX_TEMPLATE_SMOKE === '1'
  && process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1'
  && process.env.FORGEAX_TEMPLATE_SMOKE_ROOT
  ? resolve(process.env.FORGEAX_TEMPLATE_SMOKE_ROOT)
  : undefined;
const smokeSlug = process.env.FORGEAX_TEMPLATE_SMOKE_SLUGS;
const templateRoot = (slug: string, source: string) =>
  smokeRoot && smokeSlug === slug ? smokeRoot : source;
const game3dRoot = templateRoot('game-3d', resolve(templatesDir, 'game-3d'));
const appsDir = resolve(monorepoRoot, 'apps');
const gameCapabilityRoot = templateRoot('game-capability-lab', resolve(appsDir, 'game-capability-lab'));
const templateAssetRoot = resolve(gameCapabilityRoot, 'assets');
const isPublicDistribution = existsSync(resolve(monorepoRoot, '.forgeax-public-distribution'));
const publicTemplateResourceRoot = resolve(templateAssetRoot, 'sdk-resources');
const brotatoAssetRoot = resolve(templateRoot('brotato-3d', resolve(appsDir, 'showcase', 'brotato-3d')), 'assets');
const previewUiAuthoringMetaPath = resolve(
  here,
  'assets',
  'ui-authoring',
  'preview-hud.ui.html.meta.json',
);
const surfaceEvidencePackRoot = resolve(here, 'assets', 'surface-standard-evidence.pack.ts');
const surfaceOnly = process.env.FORGEAX_SURFACE_ONLY === '1';
const surfacePackRoots = [
  resolve(templatesDir, 'game-3d', 'assets', 'materials.pack.ts'),
  surfaceEvidencePackRoot,
  resolve(here, 'assets', 'surface-water-splash.pack.json'),
  resolve(here, 'assets', 'surface-water-splash-material.pack.json'),
];
// Keep the authored WGSL tree under assets/ so the template has one visible
// content root, but do not hand build-only shader sidecars to vite-plugin-pack.
// Pack is a runtime catalog; forgeaxShader owns WGSL compilation and manifest
// publication. Explicit file roots make that boundary executable instead of
// relying on a directory-name convention.
const gameCapabilityPackRoots = gameCapabilityAssetRoots(templateAssetRoot);
const selectedTemplateSlugs = parseTemplateSmokeSlugs(process.env.FORGEAX_TEMPLATE_SMOKE_SLUGS);
const templatePackRoots = selectTemplateAssetRoots(
  [
    { slug: 'game-capability-lab', roots: gameCapabilityPackRoots },
    {
      slug: 'empty',
      roots: collectAssetDeclarationRoots(resolve(templateRoot('empty', resolve(templatesDir, 'empty')), 'assets')),
    },
    {
      slug: 'game-3d',
      roots: collectAssetDeclarationRoots(resolve(game3dRoot, 'assets')),
    },
    {
      slug: 'brotato-3d',
      roots: [
        resolve(brotatoAssetRoot, 'brotato-3d.pack.ts'),
        resolve(brotatoAssetRoot, 'game.pack.json'),
        resolve(brotatoAssetRoot, 'brotato-impact-vfx.pack.json'),
        resolve(brotatoAssetRoot, 'ui/hud.pack.json'),
      ],
    },
  ],
  selectedTemplateSlugs,
);
const game3dOnlySmoke =
  selectedTemplateSlugs.length === 1 && selectedTemplateSlugs[0] === 'game-3d';
const materialPackages = selectedTemplateSlugs.length > 0 && !selectedTemplateSlugs.includes('game-capability-lab')
  ? []
  : [
      resolve(templateAssetRoot, 'animated-target-material.pack.json'),
      resolve(templateAssetRoot, 'hit-flash-material.pack.json'),
      resolve(templateAssetRoot, 'arc-nova-sigil.shader.pack.json'),
      resolve(templateAssetRoot, 'arc-nova-violet-sigil.shader.pack.json'),
      resolve(templateAssetRoot, 'arc-nova-shard.shader.pack.json'),
      resolve(templateAssetRoot, 'arc-nova-ember-shard.shader.pack.json'),
    ];
// Contributor builds read the private asset checkout. Public SDK source builds
// use the exact allowlisted files materialized below apps/game-capability-lab.
const skyMetaPath = resolve(
  monorepoRoot,
  ...(isPublicDistribution
    ? ['packages', 'preview', 'assets', 'canonical-kit', 'sky.hdr.meta.json']
    : ['forgeax-engine-assets', 'demo-assets', 'template-game-default', 'sky.hdr.meta.json']),
);
const submoduleJpegMetaPath = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution
    ? ['demo-assets', 'hello-sprite', 'wood-container.jpg.meta.json']
    : ['forgeax-engine-assets', 'demo-assets', 'hello-sprite', 'wood-container.jpg.meta.json']),
);
const submoduleSfxDir = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution ? ['sfx'] : ['forgeax-engine-assets', 'sfx']),
);
const submoduleBgmMetaPath = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution
    ? ['collectathon-audio', 'bgm-loop.wav.meta.json']
    : ['forgeax-engine-assets', 'collectathon-audio', 'bgm-loop.wav.meta.json']),
);
const submoduleFbxDir = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution ? ['vendor', 'fbx-test'] : ['forgeax-engine-assets', 'vendor', 'fbx-test']),
);
const submoduleGlbDir = resolve(monorepoRoot, 'forgeax-engine-assets', 'khronos-gltf-samples', 'BoxTextured');
const submoduleDejavuFontMetaPath = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution
    ? ['dejavu-fonts', 'DejaVuSansMono.ttf.meta.json']
    : ['forgeax-engine-assets', 'dejavu-fonts', 'DejaVuSansMono.ttf.meta.json']),
);
const submoduleDejavuLegacyAtlasMetaPath = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution
    ? ['dejavu-fonts', 'DejaVuSansMono.atlas.png.meta.json']
    : ['forgeax-engine-assets', 'dejavu-fonts', 'DejaVuSansMono.atlas.png.meta.json']),
);
const submoduleDejavuLegacyPackPath = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution
    ? ['dejavu-fonts', 'DejaVuSansMono.font.pack.json']
    : ['forgeax-engine-assets', 'dejavu-fonts', 'DejaVuSansMono.font.pack.json']),
);
const submoduleVideoDir = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution
    ? ['demo-assets', 'hello-video-cutscene']
    : ['forgeax-engine-assets', 'demo-assets', 'hello-video-cutscene']),
);
const submoduleSpriteAtlasDir = resolve(
  isPublicDistribution ? publicTemplateResourceRoot : monorepoRoot,
  ...(isPublicDistribution
    ? ['demo-assets', 'hello-sprite-atlas']
    : ['forgeax-engine-assets', 'demo-assets', 'hello-sprite-atlas']),
);
const externalAssetRoots = isPublicDistribution
  ? [
      skyMetaPath,
      submoduleJpegMetaPath,
      submoduleSfxDir,
      submoduleBgmMetaPath,
      submoduleFbxDir,
      submoduleDejavuFontMetaPath,
      submoduleDejavuLegacyAtlasMetaPath,
      submoduleDejavuLegacyPackPath,
      submoduleSpriteAtlasDir,
    ]
  : [
      skyMetaPath,
      submoduleJpegMetaPath,
      submoduleSfxDir,
      submoduleBgmMetaPath,
      submoduleFbxDir,
      submoduleGlbDir,
      submoduleDejavuFontMetaPath,
      submoduleDejavuLegacyAtlasMetaPath,
      submoduleDejavuLegacyPackPath,
      submoduleSpriteAtlasDir,
    ];
// The tracked template packs are the Preview's required catalog. Public SDK
// source snapshots intentionally omit contributor-only binary fixtures, so
// exclude only those missing optional roots instead of disabling Pack (and
// therefore every tracked game-3d pack) as a unit. The SDK collision lane
// selects only game-3d; keep its startup closure to that template rather than
// scanning unrelated Preview fixtures before the server can listen. The full
// empty template needs no external resources. The full smoke roster retains
// every template and its external dependency closure. The large
// Surface material matrix is prepared only by the independent Surface owner.
const packRoots = surfaceOnly
  ? [...surfacePackRoots, ...(process.env.FORGEAX_WATER_DEMO === '1' ? [skyMetaPath] : [])]
  : [
      ...templatePackRoots,
      ...(game3dOnlySmoke || (selectedTemplateSlugs.length === 1 && selectedTemplateSlugs[0] === 'empty')
        ? []
        : [
            // Template journeys never consume the independent Surface/water
            // or UI-authoring fixtures. Their own gates retain those roots.
            ...(process.env.FORGEAX_TEMPLATE_SMOKE === '1'
              ? []
              : [surfaceEvidencePackRoot, previewUiAuthoringMetaPath]),
            ...externalAssetRoots.filter((root) => existsSync(root)),
          ]),
    ];
const particleSourceRoots = surfaceOnly ? [resolve(here, 'assets')] : selectTemplateAssetRoots(
  [
    { slug: 'game-capability-lab', roots: [templateAssetRoot] },
    { slug: 'brotato-3d', roots: [brotatoAssetRoot] },
  ],
  selectedTemplateSlugs,
);
export default defineConfig(async ({ command }) => {
  const readiness = parseProducerReadiness(process.env.FORGEAX_DEV_PACK_READINESS);
  if (!readiness.ok) {
    throw Object.assign(new Error(`${readiness.error.code}: ${readiness.error.hint}`), readiness.error);
  }
  const runtimeBinding = createStandaloneRuntimeAssetBinding('preview');
  const pack = pluginPack({
      runtimeBinding,
      producerReadiness: readiness.value,
      refresh: reloadAssetHost(),
      ddc: {
        buildCacheRoot: resolve(monorepoRoot, 'shared-build-inputs', 'ddc'),
        projectDdcRoot: resolve(here, '.forgeax', 'ddc', 'v2'),
      },
      roots: packRoots,
      importers: [
        audioImporter,
        imageImporter,
        fbxImporter,
        gltfImporter,
        fontImporter,
        createUiImporter(),
        targetProfileImporter(),
      ],
      cookers: [
        createMaterialPackCooker([
          resolve(game3dRoot, 'assets', 'shaders'),
          resolve(here, 'assets', 'shaders'),
          resolve(templateAssetRoot),
        ]),
        createParticleCodeNativeCookerFromRoots(particleSourceRoots),
      ],
    });
  const manifests = [
    ['game-capability-lab', resolve(gameCapabilityRoot, 'forge.json')],
    ['depth-of-field', resolve(gameCapabilityRoot, 'depth-of-field.forge.json')],
    ['brotato-3d', 'apps/showcase/brotato-3d/forge.json'],
    ['empty', 'templates/empty/forge.json'],
    ['game-3d', resolve(game3dRoot, 'forge.json')],
  ] as const;
  const programPlugins = await Promise.all(manifests.map(async ([namespace, path]) => {
    const manifest = JSON.parse(await readFile(resolve(monorepoRoot, path), 'utf8'));
    const selected = !surfaceOnly && (!selectedTemplateSlugs.length || selectedTemplateSlugs.includes(namespace) ||
      namespace === 'depth-of-field' && selectedTemplateSlugs.includes('game-capability-lab'));
    const projectRoot = dirname(resolve(monorepoRoot, path));
    const inventory = selected ? await discoverPluginAssets({ root: projectRoot, assetRoots: ['assets'] }) : { assets: new Map(), sourceInputs: new Map(), deferred: [] };
    return pluginProgramsBuild({ namespace, projectRoot, roots: selected ? manifest.roots : {}, tools: [],
      inventory: () => publishedPluginInventory(projectRoot, inventory, pack), binding: runtimeBinding, pack });
  }));
  return ({
  ...(command === 'build'
    ? { define: { 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': JSON.stringify('0') } }
    : {}),
  // Template smoke exercises the real browser module graph, but Vite's
  // automatic dependency discovery eagerly crawls every Preview template and
  // can spend more than the CI startup budget in shader/WASM transforms before
  // opening the HTTP listener. The smoke path keeps discovery disabled and
  // lets the browser request the same modules on demand; runtime errors remain
  // observable in the existing template journey.
  ...(command === 'serve' && process.env.FORGEAX_TEMPLATE_SMOKE === '1'
      ? { optimizeDeps: {
          noDiscovery: true,
          include: ['@forgeax/engine-ui/authoring', '@forgeax/engine-ui/importer'],
        } }
      : {}),
  plugins: [
    executionWorkerEntries(),
    forgeaxShader({
      // game-default custom materials are authored packs: the pack owns the
      // parameter contract, while the WGSL module remains the build-time
      // source. This keeps manifest paramSchema and runtime MaterialAsset in
      // lockstep on WebGPU and the WebGL2 fallback.
      // Other template servers have no game-capability-lab material users.
      // Leaving this list empty lets forgeaxShader consume the verified
      // shared engine manifest without compiling unrelated custom materials.
      materialPackages,
    }) as never,
    // RHI capture is a dev-only inspection front door. Keeping the plugin out
    // of `vite build` makes the production Preview graph free of the recorder,
    // upload route, and debug-only browser chunk.
    ...(command === 'serve' && process.env.FORGEAX_SURFACE_PROBE !== '1'
      ? [vitePluginRhiDebug()]
      : []),
    pack,
    pluginRuntimeProjection(),
    ...programPlugins,
  ],
  server: {
    ...previewPort,
    fs: {
      allow: [monorepoRoot, game3dRoot, gameCapabilityRoot],
    },
  },
  preview: previewPort,
  // VideoAsset is intentionally a runtime-only URL descriptor. Serve the
  // licensed WebM from the asset submodule without inventing a Pack importer.
  publicDir: submoduleVideoDir,
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        water: resolve(here, 'water.html'),
      },
    },
  },
});
});
