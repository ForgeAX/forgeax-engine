import { ok } from '@forgeax/engine-types';
import type { RenderFeatureDrawDeclaration, RenderFeatureWorkPlan } from '../features/plan';
import type { RenderFeature, RenderFeatureResourceDeclaration } from '../index';

interface Frame {
  readonly vertexCount: number;
  readonly indexCount: number;
}

const feature = {
  identity: 'prepared.graphics.positive',
  extract: () => ok<Frame>({ vertexCount: 6, indexCount: 6 }),
  plan(data, context) {
    const target = context.views[0]?.targets.find((candidate) => candidate.kind === 'color');
    const resources: readonly RenderFeatureResourceDeclaration[] = [
      {
        kind: 'graphics-program',
        name: 'forward-program',
        program: {
          shader: 'unlit',
          vertexLayout: 'position',
          colorFormats: [target?.format ?? 'rgba8unorm'],
        },
      },
      {
        kind: 'graphics-bindings',
        name: 'forward-bindings',
        program: 'forward-program',
        values: { opacity: 1 },
      },
      {
        kind: 'vertex-data',
        name: 'quad-vertices',
        layout: 'position',
        data: new Float32Array(data.vertexCount),
      },
      {
        kind: 'index-data',
        name: 'quad-indices',
        format: 'uint16',
        data: new Uint16Array(data.indexCount),
      },
    ];
    const vertexOnly: RenderFeatureDrawDeclaration = {
      program: 'forward-program',
      bindings: ['forward-bindings'],
      vertexData: [{ slot: 0, resource: 'quad-vertices' }],
      draw: { kind: 'draw', vertexCount: data.vertexCount, instanceCount: 1 },
    };
    const indexed: RenderFeatureDrawDeclaration = {
      program: 'forward-program',
      bindings: ['forward-bindings'],
      vertexData: [{ slot: 0, resource: 'quad-vertices' }],
      indexData: { resource: 'quad-indices', format: 'uint16' },
      draw: { kind: 'draw-indexed', indexCount: data.indexCount, instanceCount: 1 },
    };
    const plan: RenderFeatureWorkPlan = {
      resources,
      passes: [
        {
          kind: 'raster',
          name: 'forward',
          colorAttachments: [
            { target: target?.name ?? 'swapchain', loadOp: 'load', storeOp: 'store' },
          ],
          draws: [vertexOnly, indexed],
        },
      ],
    };
    return ok({ work: [{ scope: { view: 'main' }, ...plan }] });
  },
} satisfies RenderFeature<Frame>;

void feature;
