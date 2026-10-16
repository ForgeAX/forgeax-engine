import type { RenderFeaturePlan } from '@forgeax/engine-render';
import type { TextureFormat } from '@forgeax/engine-rhi';

export interface DebugDrawRenderFeatureInput {
  readonly vertexCapacity: number;
  readonly vertexCount?: number;
  readonly views: readonly {
    readonly identity: string;
    readonly target: string;
    readonly colorFormat?: TextureFormat;
    readonly viewProjection: ArrayBufferView;
  }[];
}

/** One shared primitive buffer, projected through each renderer-owned view. */
export function createDebugDrawRenderFeaturePlan(
  input: DebugDrawRenderFeatureInput,
): RenderFeaturePlan {
  const vertexCount = Math.max(0, input.vertexCount ?? input.vertexCapacity);
  if (vertexCount === 0 || input.views.length === 0) return { work: [] };
  const program = 'debug-draw.program';
  const bindings = 'debug-draw.bindings';
  const vertices = 'debug-draw.vertices';
  const vertexData = 'debug-draw.vertex-data';
  return {
    work: [
      {
        scope: 'frame',
        resources: [
          {
            kind: 'buffer',
            name: vertices,
            size: Math.max(1, input.vertexCapacity) * 16,
            usage: ['vertex'],
          },
          { kind: 'vertex-data', name: vertexData, layout: 'debug-draw-line', buffer: vertices },
        ],
        passes: [],
      },
      ...input.views.map((view) => ({
        scope: { view: view.identity },
        resources: [
          {
            kind: 'graphics-program' as const,
            name: program,
            program: {
              shader: 'forgeax::debug-draw.line',
              vertexLayout: 'debug-draw-line',
              colorFormats: [view.colorFormat ?? 'bgra8unorm'],
              topology: 'line-list' as const,
            },
          },
          {
            kind: 'graphics-bindings' as const,
            name: bindings,
            program,
            values: { viewProjection: view.viewProjection },
          },
        ],
        passes: [
          {
            kind: 'raster' as const,
            name: 'debug-draw.raster',
            colorAttachments: [
              { target: view.target, loadOp: 'load' as const, storeOp: 'store' as const },
            ],
            draws: [
              {
                program,
                bindings: [bindings],
                vertexData: [{ slot: 0, resource: vertexData }],
                draw: { kind: 'draw' as const, vertexCount, instanceCount: 1 },
              },
            ],
          },
        ],
      })),
    ],
  };
}
