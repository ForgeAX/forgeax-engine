import type { RenderFeatureWork } from '../features/plan';
import { SkyPass } from '../record/gpu-pass-timing/sky-pass-names';

export function cloudShadowFilterWork(view: string, source: string): RenderFeatureWork {
  const name = SkyPass.cloudShadowFilter;
  return {
    scope: { view },
    resources: [
      {
        kind: 'fullscreen-program',
        name,
        source,
        usesView: false,
        reads: [{ key: 'cloud-shadow-raw', sampleType: 'unfilterable-float' }],
      },
      {
        kind: 'graphics-program',
        name: `${name}.pipeline`,
        program: {
          shader: name,
          vertexLayout: 'none',
          sampleCount: 1,
          colorFormats: ['rgba32float'],
          renderState: { depthWriteEnabled: false, depthCompare: 'always' },
        },
      },
      {
        kind: 'graphics-bindings',
        name: `${name}.inputs`,
        program: `${name}.pipeline`,
        values: { group: 1, fullscreen: true, shader: name, input: 'cloud-shadow-raw' },
      },
    ],
    passes: [
      {
        kind: 'raster',
        name,
        colorAttachments: [{ target: 'cloud-shadow', loadOp: 'clear', storeOp: 'store' }],
        sampledTargets: ['cloud-shadow-raw'],
        draws: [
          {
            program: `${name}.pipeline`,
            bindings: [`${name}.inputs`],
            vertexData: [],
            vertexLayout: 'none',
            draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
          },
        ],
      },
    ],
  };
}
