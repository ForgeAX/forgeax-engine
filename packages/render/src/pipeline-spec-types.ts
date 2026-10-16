import type { VertexLayoutProjection } from '@forgeax/engine-geometry';
import type {
  MaterialRenderState,
  PrimitiveTopology,
  VertexAttributeMap,
} from '@forgeax/engine-types';

export interface PipelineSpec {
  readonly shader: {
    readonly id: string;
    readonly passKind: string;
    readonly variantSet: string | undefined;
    readonly vertexEntry?: string;
    readonly fragmentEntry?: string;
    /** Pipeline-time fragment overrides; not runtime WGSL feature defines. */
    readonly constants?: Readonly<Record<string, number>> | undefined;
  };
  readonly attachments: {
    readonly colorFormats: readonly GPUTextureFormat[];
    readonly depthFormat: GPUTextureFormat | undefined;
    readonly sampleCount: 1 | 4;
  };
  readonly geometry: {
    readonly topology: PrimitiveTopology;
    readonly stripIndexFormat?: 'uint16' | 'uint32' | undefined;
    readonly vertexLayout: VertexAttributeMap;
    /** Geometry-owned immutable descriptor projection, when already derived. */
    readonly vertexLayoutProjection?: VertexLayoutProjection | undefined;
    /** Explicit multi-stream layout supplied by the prepared-graphics owner. */
    readonly vertexBuffers?: readonly GPUVertexBufferLayout[];
    readonly shaderUvSetCount?: number | undefined;
  };
  readonly renderState: MaterialRenderState | undefined;
}
