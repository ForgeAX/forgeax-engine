export const CANONICAL_KIT_RECEIPT = {
  schemaVersion: '1.0.0',
  producer: 'packages/preview/scripts/build-canonical-kit.mjs',
  source: {
    sourceKey: 'forgeax-engine-assets/demo-assets/template-game-default/sky.hdr',
    guid: '81eec382-392f-5a93-8998-0ecf11ef7990',
    digest: 'sha256:1dd1cc7c2d9c8efb63b86bd196039b69445411d4a5543426418a03a34133ab4c',
    metaDigest: 'sha256:5f7942e73ad007c67b8c0b8903ffe5a06a5c89f73d427443f3a50fa9db4649a9',
  },
  recipe: {
    digest: 'sha256:e6551f1d31f92aefa2622b16709c96c6e477a97814c0ac2d7b6dc48d74d1f3bb',
    value: {
      schemaVersion: '1.0.0',
      rig: 'handle-sphere',
      environment: 'engine-canonical',
      skybox: 'engine-canonical',
      skylight: 'engine-canonical',
      directionalLight: 'engine-canonical',
      stage: 'neutral-material-checker-unlit',
      camera: 'bounds-derived',
    },
  },
  cooked: {
    importer: 'image',
    kind: 'equirect',
    sourceDigest: 'sha256:1dd1cc7c2d9c8efb63b86bd196039b69445411d4a5543426418a03a34133ab4c',
    metaDigest: 'sha256:5f7942e73ad007c67b8c0b8903ffe5a06a5c89f73d427443f3a50fa9db4649a9',
  },
  package: { name: '@forgeax/engine-preview', root: 'assets/canonical-kit' },
  transport: {
    dev: 'pluginPack',
    build: 'pluginPack',
    sdk: 'files/assets/canonical-kit',
    source: 'sky.hdr',
    meta: 'sky.hdr.meta.json',
  },
} as const;

export function meshFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'mesh',
    digest: 'sha256:mesh-subject',
    vertexDigest: 'sha256:mesh-vertices',
    indexDigest: 'sha256:mesh-indices',
    submeshDigest: 'sha256:mesh-submeshes',
    aabbDigest: 'sha256:mesh-aabb',
    vertices: Float32Array.of(-1, -1, 0, 1, -1, 0, 0, 1, 0),
    attributes: { position: Float32Array.of(-1, -1, 0, 1, -1, 0, 0, 1, 0) },
    aabb: Float32Array.of(-1, -1, 0, 1, 1, 0),
    submeshes: [{ topology: 'triangle-list', indexOffset: 0, indexCount: 3, materialSlot: 0 }],
    materialSlots: [{ slotName: 'default' }],
    ...overrides,
  };
}
