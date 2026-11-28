import type { RenderFeatureWork } from '../features/plan';
import type { CloudShadowFormat } from './lighting/shadow-format';
import type { CloudShadowSpatialPass } from './lighting/shadow-spatial-layout';

export function cloudShadowFilterWork(
  view: string,
  source: string,
  format: CloudShadowFormat,
  { name, input, output }: CloudShadowSpatialPass,
): RenderFeatureWork {
  return {
    scope: { view },
    resources: [
      {
        kind: 'fullscreen-program',
        name,
        source,
        usesView: false,
        reads: [{ key: input, sampleType: 'unfilterable-float' }],
      },
      {
        kind: 'graphics-program',
        name: `${name}.pipeline`,
        program: {
          shader: name,
          vertexLayout: 'none',
          sampleCount: 1,
          colorFormats: [format],
          renderState: { depthWriteEnabled: false, depthCompare: 'always' },
        },
      },
      {
        kind: 'graphics-bindings',
        name: `${name}.inputs`,
        program: `${name}.pipeline`,
        values: { group: 1, fullscreen: true, shader: name, input },
      },
    ],
    passes: [
      {
        kind: 'raster',
        name,
        colorAttachments: [{ target: output, loadOp: 'clear', storeOp: 'store' }],
        sampledTargets: [input],
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
