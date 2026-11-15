import { definePackageId, gpuTextureOutputs } from '@forgeax/engine/pack/source';
import { validateTextureGenerator } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Runtime GPU texture assets',
  catalog: 'Runtime GPU texture assets',
  kind: 'headless',
  summary:
    'Pack publishes a finite generator graph and independent GPU texture references; Renderer generates pixels and mips on its GPU.',
  expect:
    'Generated outputs have stable GUID references and no CPU pixels. This authoring probe does not claim GPU acceptance.',
  run(checks) {
    const shape = { viewDimension: '2d', extent: { width: 64, height: 64 } } as const;
    const outputs = gpuTextureOutputs(
      definePackageId('01900000-0000-7000-8000-000000000010'),
      'paint',
      {
        values: { seed: 42 },
        inputs: {},
        transient: {},
        outputs: {
          albedo: {
            shape,
            format: 'rgba8unorm-srgb',
            colorSpace: 'srgb',
            mips: { kind: 'generate' },
          },
        },
        passes: [
          {
            kind: 'raster',
            program: { module: 'game::paint', fragmentEntry: 'paint' },
            reads: {},
            writes: ['albedo'],
          },
        ],
      },
    );
    checks.equal('one generator and one GPU texture', Object.keys(outputs), [
      'generator/paint',
      'gpu-gpu-texture/paint/albedo',
    ]);
    checks.ok(
      'no CPU pixels',
      Object.values(outputs).every((asset) => !Object.hasOwn(asset, 'data')),
    );
    checks.ok('finite graph admitted', validateTextureGenerator(outputs['generator/paint']).ok);
    checks.ok(
      'runtime rejects an unprepared program',
      !validateTextureGenerator(outputs['generator/paint'], true).ok,
    );
  },
});
