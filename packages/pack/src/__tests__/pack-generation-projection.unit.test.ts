import { describe, expect, it } from 'vitest';
import { readPackAuthoringDeclaration } from '../pack-authoring-literals.js';
import { projectPackGenerationModules } from '../pack-generation-projection.js';

const source = (
  specifier: string,
) => `import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { model, sel } from '${specifier}';
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0f1'),
  parameters: [{ name: 'depth', type: 'f32', default: 0.1, apply: { asset: 'mesh/crate', path: ['lodHysteresis'] } }],
  build: ({ values }) => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'shell' });
    m.extrude(sel.facing('+y'), { distance: values.depth, region: 'merged' });
    return m.finish({ key: 'crate' });
  },
});
`;

function project(text: string) {
  const declaration = readPackAuthoringDeclaration('crate.pack.ts', text).unwrap();
  return projectPackGenerationModules('crate.pack.ts', { 'crate.pack.ts': text }, declaration);
}

describe('live generation isolation imports', () => {
  it('admits the modeling kernel through the umbrella subpath and the physical package', () => {
    for (const specifier of ['@forgeax/engine/modeling', '@forgeax/engine-modeling'])
      expect(project(source(specifier))['crate.pack.ts']).toContain(specifier);
  });

  it('admits Pack mesh LOD generation but not the rest of Import', () => {
    for (const specifier of [
      '@forgeax/engine/import/mesh-lod-generator',
      '@forgeax/engine-import/mesh-lod-generator',
    ])
      expect(project(source(specifier))['crate.pack.ts']).toContain(specifier);
    expect(() => project(source('@forgeax/engine-import'))).toThrow();
  });

  it('keeps rejecting packages outside the pure generation surface', () => {
    let failure: unknown;
    try {
      project(source('@forgeax/engine/runtime'));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'pack-source-mutation-unsupported',
      detail: {
        reason:
          'live generation isolation: import @forgeax/engine/runtime is not a pure generation dependency',
      },
    });
  });
});
