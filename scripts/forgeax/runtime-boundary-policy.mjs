// Runtime is the default. Exceptions name an owning tool or platform entry,
// never an existing violation count. New packages inherit the runtime rules.
export const TOOL_OWNERS = new Map([
  ['devkit', 'Node project build, development and CLI host'],
  ['dsh', 'Node AI CLI process host'],
  ['intelligence-dsh', 'Node AI CLI transport'],
  ['mesh-io', 'Node-only source-format import and static mesh export workers'],
  ['vfx-compiler', 'Offline VFX program compiler'],
  ['vite-plugin-pack', 'Explicit Vite asset adapter'],
  ['vite-plugin-shader', 'Explicit Vite shader adapter'],
  ['vite-plugin-rhi-debug', 'Explicit Vite capture transport'],
]);

// The program compiler is portable. Only these file/process adapters own Node inputs.
export const NODE_TOOL_ENTRIES = new Map([
  ['packages/shader-compiler/src/index.ts', 'Node authoring and cooker umbrella'],
  ['packages/shader-compiler/src/compiler-fingerprint.ts', 'Node source/compiler fingerprint'],
  ['packages/shader-compiler/src/program-compiler.ts', 'Node bounded program reuse host'],
  ['packages/shader-compiler/src/texture-generator-cooker.ts', 'Node texture-generator producer'],
  ['packages/shader-compiler/src/material/pack-cooker.ts', 'Node material file discovery and cook'],
  ['packages/shader-compiler/src/material/pack-variant-reuse.ts', 'Node cook reuse hashing'],
  ['packages/shader-compiler/src/material/node-program-compiler.ts', 'Node program worker host'],
  ['packages/shader-compiler/src/material/node-material-cooker.ts', 'Node material worker host'],
]);

const PORTABLE_SHADER_PROGRAM_EXPORTS = new Set([
  '@forgeax/engine-shader-compiler/program',
  '@forgeax/engine/shader-compiler/program',
]);

export const HOST_ENVIRONMENT_ENTRIES = new Map([
  ['packages/image/src/node-encode-pool.ts', 'Node-only offline image encoder process host'],
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
  ['packages/shader/src/sky-sh-source.ts', 'Shader tsup text loader owns Sky SH WGSL inlining'],
  [
    'packages/shader/src/scene-velocity-source.ts',
    'Shader tsup text loader owns velocity WGSL inlining',
  ],
  ['packages/shader/src/tsr-source.ts', 'Shader tsup text loader owns TSR WGSL inlining'],
]);

export const TOOL_SOURCE_SCOPES = new Map([
  ['packages/three/src/build/', 'Explicit offline Three material cooker export'],
]);

export const TOOL_SOURCE_ENTRIES = new Map([
  ['packages/image/src/node-encode-pool.ts', 'Node-only offline image encoder process host'],
  ['packages/pack/src/author-closure.ts', 'Offline Pack source closure analyzer'],
  ['packages/pack/src/build.ts', 'Node-only Pack authoring and build entry'],
  ['packages/pack/src/catalog-builder.ts', 'Node offline catalog producer'],
  ['packages/pack/src/cli-asset.ts', 'Node-only asset CLI entry'],
  ['packages/pack/src/evidence/source-inventory.ts', 'Node Pack source inventory helper'],
  ['packages/pack/src/pack-authoring-document.ts', 'Pack authoring source AST reader'],
  ['packages/pack/src/pack-authoring-drafts-node.ts', 'Node Pack authoring draft manager'],
  ['packages/pack/src/pack-authoring-literals.ts', 'Pack authoring declaration AST reader'],
  ['packages/pack/src/pack-authoring-node.ts', 'Node Pack authoring process entry'],
  ['packages/pack/src/pack-generation-projection.ts', 'Pack authoring AST projection'],
  ['packages/pack/src/pack-source-index.ts', 'Node Pack source index and static parent resolver'],
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
    'runtime',
    {
      dependencies: new Set(['@forgeax/engine-shader-compiler']),
      reason:
        'The host lazily imports only the portable /program service for source-template publications; Node cooker entries remain forbidden.',
    },
  ],
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
  const tool = TOOL_OWNERS.has(owner) || NODE_TOOL_ENTRIES.has(sourceFile);
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
    /^@forgeax\/engine(?:-|\/)image\/encode-pool(?:\/|$)/.test(specifier) ||
    /^@forgeax\/engine-vite-plugin-/.test(specifier) ||
    TOOL_OWNERS.has(engineOwner) ||
    (engineOwner === 'shader-compiler' && !PORTABLE_SHADER_PROGRAM_EXPORTS.has(specifier)) ||
    /^@forgeax\/engine(?:-|\/)three\/build(?:\/|$)/.test(specifier) ||
    specifier.startsWith('virtual:')
  );
}
