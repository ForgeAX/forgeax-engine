// Runtime is the default. Exceptions name an owning tool or platform entry,
// never an existing violation count. New packages inherit the runtime rules.
export const TOOL_OWNERS = new Map([
  ['devkit', 'Node project build, development and CLI host'],
  ['dsh', 'Node AI CLI process host'],
  ['intelligence-dsh', 'Node AI CLI transport'],
  ['mesh-io', 'Node-only source-format import and static mesh export workers'],
  ['shader-compiler', 'Offline shader compiler and cooker'],
  ['vfx-compiler', 'Offline VFX program compiler'],
  ['vite-plugin-pack', 'Explicit Vite asset adapter'],
  ['vite-plugin-shader', 'Explicit Vite shader adapter'],
  ['vite-plugin-rhi-debug', 'Explicit Vite capture transport'],
]);

export const HOST_ENVIRONMENT_ENTRIES = new Map([
  ['packages/pack/src/catalog-builder.ts', 'Node offline catalog producer'],
  ['packages/pack/src/scriptable-pack-node.ts', 'Node scriptable Pack process host'],
  ['packages/pack/src/scriptable-pack-worker.ts', 'Node isolated authoring worker'],
  ['packages/font/src/atlas-generator.ts', 'Node MSDF worker and resource host'],
  ['packages/font/src/font-importer.ts', 'Offline Node font importer hosting the MSDF worker'],
  ['packages/font/src/cli-font.ts', 'Node font authoring CLI entry'],
  ['packages/import/src/build-production.ts', 'Node offline asset build coordinator'],
  ['packages/import/src/scriptable-pack-product-cache.ts', 'Node scriptable Pack product cache'],
  [
    'packages/import/src/scriptable-pack-transport-cache.ts',
    'Node Scriptable Pack transport metadata cache',
  ],
  ['packages/import/src/index.ts', 'Node export branch; the browser branch has a separate entry'],
  ['packages/pack/src/build.ts', 'Node-only Pack build entry'],
  ['packages/pack/src/cli-asset.ts', 'Node-only asset CLI entry'],
  ['packages/pack/src/pack-authoring-node.ts', 'Node authoring process entry'],
  ['packages/pack/src/scanner.ts', 'Filesystem Pack scanner entry'],
]);

export const NODE_SOURCE_SCOPES = new Map([
  ['packages/rhi-wgpu-native/src/', 'Explicit opt-in Node native GPU backend'],
  ['packages/dawn-node/src/', 'Explicit Node GPU provider'],
  ['packages/modeling/src/tools/', 'Explicit Node modeling tool entry'],
]);

export const SOURCE_ASSET_PRODUCERS = new Map([
  [
    'packages/render/src/terrain/layer-bake.ts',
    'Render tsup text loader owns Terrain WGSL inlining',
  ],
  ['packages/shader/src/auto-exposure-source.ts', 'Shader tsup text loader owns WGSL inlining'],
  ['packages/shader/src/tsr-source.ts', 'Shader tsup text loader owns TSR WGSL inlining'],
]);

export const TOOL_SOURCE_SCOPES = new Map([
  ['packages/three/src/build/', 'Explicit offline Three material cooker export'],
]);

export const TOOL_SOURCE_ENTRIES = new Map([
  ['packages/pack/src/author-closure.ts', 'Offline Pack source closure analyzer'],
  ['packages/pack/src/build.ts', 'Node-only Pack authoring and build entry'],
  ['packages/pack/src/catalog-builder.ts', 'Node offline catalog producer'],
  ['packages/pack/src/cli-asset.ts', 'Node-only asset CLI entry'],
  ['packages/pack/src/evidence/source-inventory.ts', 'Node Pack source inventory helper'],
  ['packages/pack/src/pack-authoring-document.ts', 'Pack authoring source AST reader'],
  ['packages/pack/src/pack-authoring-drafts-node.ts', 'Node Pack authoring draft manager'],
  ['packages/pack/src/pack-authoring-literals.ts', 'Pack authoring declaration AST reader'],
  ['packages/pack/src/pack-authoring-node.ts', 'Node Pack authoring process entry'],
  ['packages/pack/src/pack-authoring-parent.ts', 'Node Pack authoring parent resolver'],
  ['packages/pack/src/pack-generation-projection.ts', 'Pack authoring AST projection'],
  ['packages/pack/src/pack-source-index.ts', 'Node Pack source index producer'],
  ['packages/pack/src/scanner.ts', 'Filesystem Pack scanner entry'],
  ['packages/pack/src/scriptable-pack-node.ts', 'Node scriptable Pack process host'],
  ['packages/pack/src/scriptable-pack-source-snapshot.ts', 'Scriptable Pack source AST snapshot'],
  ['packages/pack/src/scriptable-pack-worker.ts', 'Node isolated authoring worker'],
  ['packages/fbx/src/cli-fbx.ts', 'Node FBX import CLI'],
  ['packages/gltf/src/cli-gltf.ts', 'Node glTF import CLI'],
  ['packages/import/src/build-production.ts', 'Node offline asset build coordinator'],
  ['packages/import/src/catalog-inventory.ts', 'Node catalog inventory producer'],
  ['packages/import/src/index.ts', 'Node-conditioned import entry'],
  ['packages/import/src/pack-projection.ts', 'Node Pack build projection'],
  ['packages/import/src/scriptable-pack-build.ts', 'Node scriptable Pack producer'],
  ['packages/import/src/scriptable-pack-host.ts', 'Node scriptable Pack host'],
  ['packages/import/src/source-package-publication.ts', 'Node source package publication'],
  ['packages/import/src/source-package.ts', 'Node source package producer'],
  ['packages/import/src/source-path.ts', 'Node Pack source path resolver'],
  [
    'packages/import/src/scriptable-pack-transport-cache.ts',
    'Node Scriptable Pack transport cache helper',
  ],
  ['packages/modeling/src/tools/capture-worker.ts', 'Node modeling capture tool'],
]);

export const MIXED_TOOL_DEPENDENCIES = new Map([
  [
    'pack',
    {
      dependencies: new Set(['typescript']),
      reason:
        'Only explicit Node authoring and scanning entries use TypeScript; public runtime entries remain compiler-free.',
    },
  ],
  [
    'three',
    {
      dependencies: new Set(['@forgeax/engine-shader-compiler']),
      reason:
        'Only the explicit build subpath imports the offline cooker; player entries remain runtime.',
    },
  ],
]);

const PACK_NODE_EXPORTS = new Set([
  'build',
  'cli-asset',
  'native-cooker',
  'resolve',
  'scanner',
  'schema-build',
  'source-node',
]);

export function isPackToolSpecifier(specifier) {
  const subpath =
    /^@forgeax\/engine-pack\/([^/]+)$/.exec(specifier)?.[1] ??
    /^@forgeax\/engine\/pack\/([^/]+)$/.exec(specifier)?.[1];
  return subpath !== undefined && PACK_NODE_EXPORTS.has(subpath);
}

export function sourceAuthority(file) {
  const owner = file.split('/')[1];
  const sourceFile = file.replace('/dist/', '/src/').replace(/\.[cm]?js$/, '.ts');
  const engineFacade = /^packages\/engine\/dist\/facades\/(.+)\.mjs$/.exec(file)?.[1];
  const engineToolEntry =
    file === 'packages/engine/dist/bin/forgeax.mjs' ||
    (engineFacade && isBuildTool(`@forgeax/engine/${engineFacade}`));
  const tool = TOOL_OWNERS.has(owner);
  return {
    tools:
      tool ||
      Boolean(engineToolEntry) ||
      TOOL_SOURCE_ENTRIES.has(sourceFile) ||
      [...TOOL_SOURCE_SCOPES.keys()].some((prefix) => sourceFile.startsWith(prefix)),
    environment:
      tool ||
      HOST_ENVIRONMENT_ENTRIES.has(sourceFile) ||
      [...NODE_SOURCE_SCOPES.keys()].some((prefix) => sourceFile.startsWith(prefix)),
    metadata: owner?.startsWith('vite-plugin-') === true,
    assets: SOURCE_ASSET_PRODUCERS.has(file),
  };
}

export function isBuildTool(specifier) {
  const engineOwner = /^@forgeax\/engine(?:-|\/)([^/]+)(?:\/|$)/.exec(specifier)?.[1];
  return (
    /^(?:vite|vitest|esbuild|rollup|rolldown|webpack|parcel|tsup|typescript)(?:\/|$)/.test(
      specifier,
    ) ||
    /^@(?:vitejs|vitest|esbuild|rollup|rolldown|webpack|parcel)\//.test(specifier) ||
    /^@(?:babel|swc|rspack|rsbuild)\/core(?:\/|$)/.test(specifier) ||
    isPackToolSpecifier(specifier) ||
    /^@forgeax\/engine-vite-plugin-/.test(specifier) ||
    TOOL_OWNERS.has(engineOwner) ||
    /^@forgeax\/engine(?:-|\/)three\/build(?:\/|$)/.test(specifier) ||
    specifier.startsWith('virtual:')
  );
}
