import {
  buildMeshAttributeMapForUvSets,
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexBufferLayout,
  deriveVertexBufferLayoutFromProjection,
  type GpuVertexBufferLayoutEntry,
  SKIN_VERTEX_ATTRIBUTE_MAP,
  type VertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type { VertexAttributeMap } from '@forgeax/engine-types';
import { PARTICLE_MESH_VERTEX_BUFFER } from '../features/particle-mesh-layout';
import { RENDER_FEATURE_VERTEX_LAYOUTS } from '../features/prepared-graphics';

type FeatureFloatVertexFormat = 'float32x2' | 'float32x3' | 'float32x4';

interface FeatureVertexAttribute {
  readonly shaderLocation: number;
  readonly format: FeatureFloatVertexFormat;
}

interface FeatureVertexBufferSpec {
  readonly stepMode: 'vertex' | 'instance';
  readonly attributes: readonly FeatureVertexAttribute[];
}

const FLOAT32_COMPONENT_COUNT: Readonly<Record<FeatureFloatVertexFormat, number>> = {
  float32x2: 2,
  float32x3: 3,
  float32x4: 4,
};

/**
 * Keep feature layouts as one declarative attribute table. The stride and
 * byte offsets are derived from that table so an attribute edit cannot leave
 * a stale `arrayStride` or byte offset behind.
 */
function defineFeatureVertexBuffer(spec: FeatureVertexBufferSpec): GPUVertexBufferLayout {
  let offsetFloats = 0;
  const attributes = spec.attributes.map(({ shaderLocation, format }) => {
    const attribute = {
      shaderLocation,
      offset: offsetFloats * Float32Array.BYTES_PER_ELEMENT,
      format,
    };
    offsetFloats += FLOAT32_COMPONENT_COUNT[format];
    return attribute;
  });
  return {
    arrayStride: offsetFloats * Float32Array.BYTES_PER_ELEMENT,
    stepMode: spec.stepMode,
    attributes,
  };
}

const POSITION_SIZE_COLOR_INSTANCE_SPEC = {
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 0, format: 'float32x3' },
    { shaderLocation: 1, format: 'float32x2' },
    { shaderLocation: 2, format: 'float32x4' },
  ],
} as const satisfies FeatureVertexBufferSpec;

const BILLBOARD_MATERIAL_INSTANCE_SPEC = {
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 0, format: 'float32x3' },
    { shaderLocation: 1, format: 'float32x2' },
    { shaderLocation: 2, format: 'float32x2' },
    { shaderLocation: 3, format: 'float32x4' },
    { shaderLocation: 4, format: 'float32x4' },
    { shaderLocation: 5, format: 'float32x4' },
    { shaderLocation: 6, format: 'float32x4' },
    { shaderLocation: 7, format: 'float32x4' },
    { shaderLocation: 8, format: 'float32x4' },
  ],
} as const satisfies FeatureVertexBufferSpec;

const TOPOLOGY_SEGMENT_INSTANCE_SPEC = {
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 0, format: 'float32x3' },
    { shaderLocation: 1, format: 'float32x3' },
    { shaderLocation: 2, format: 'float32x4' },
    { shaderLocation: 3, format: 'float32x2' },
  ],
} as const satisfies FeatureVertexBufferSpec;

const MESH_GEOMETRY_MATERIAL_INSTANCE_SPEC = {
  stepMode: 'instance',
  attributes: [
    { shaderLocation: 4, format: 'float32x3' },
    { shaderLocation: 5, format: 'float32x3' },
    { shaderLocation: 6, format: 'float32x3' },
    { shaderLocation: 7, format: 'float32x3' },
    { shaderLocation: 8, format: 'float32x4' },
    { shaderLocation: 9, format: 'float32x2' },
  ],
} as const satisfies FeatureVertexBufferSpec;

/** Geometry-owned maps retained here only as feature-pipeline aliases. */
export const PREPARED_INSTANCE_VERTEX_ATTRS = buildMeshAttributeMapForUvSets(2);
export const PREPARED_MATERIAL_INSTANCE_VERTEX_ATTRS = SKIN_VERTEX_ATTRIBUTE_MAP;

export const POSITION_SIZE_COLOR_INSTANCE_VERTEX_BUFFERS = [
  defineFeatureVertexBuffer(POSITION_SIZE_COLOR_INSTANCE_SPEC),
] satisfies readonly GPUVertexBufferLayout[];

export const BILLBOARD_MATERIAL_INSTANCE_VERTEX_BUFFERS = [
  defineFeatureVertexBuffer(BILLBOARD_MATERIAL_INSTANCE_SPEC),
] satisfies readonly GPUVertexBufferLayout[];

export const TOPOLOGY_SEGMENT_INSTANCE_VERTEX_BUFFERS = [
  defineFeatureVertexBuffer(TOPOLOGY_SEGMENT_INSTANCE_SPEC),
] satisfies readonly GPUVertexBufferLayout[];

/**
 * The mesh stream is derived from geometry's canonical attribute projection.
 * The second stream remains a feature-owned instance ABI because it carries
 * particle transform/material data rather than MeshAsset attributes.
 */
export const MESH_GEOMETRY_MATERIAL_INSTANCE_VERTEX_BUFFERS = [
  PARTICLE_MESH_VERTEX_BUFFER,
  defineFeatureVertexBuffer(MESH_GEOMETRY_MATERIAL_INSTANCE_SPEC),
] satisfies readonly GPUVertexBufferLayout[];

const PREPARED_MATERIAL_VERTEX_LAYOUTS: ReadonlySet<string> = new Set([
  RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInstance,
  RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInputInstance,
  RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentInstance,
  RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentMaterialInputInstance,
  RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInstance,
  RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInputInstance,
]);

export function isPreparedMaterialVertexLayout(layout: string | undefined): boolean {
  return layout !== undefined && PREPARED_MATERIAL_VERTEX_LAYOUTS.has(layout);
}

/**
 * Derive the prepared particle layout that appends one to four material-input
 * vec4 lanes to the instance stream. The base layouts stay shared with the
 * no-input path; only the final stream stride and locations change, which
 * keeps the vertex-data ABI and pipeline cache key in lockstep.
 */
export function particleMaterialInputVertexBuffers(
  vertexLayout: string | undefined,
  lanes?: number,
): readonly GPUVertexBufferLayout[] | undefined {
  const buffers =
    vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInputInstance
      ? BILLBOARD_MATERIAL_INSTANCE_VERTEX_BUFFERS
      : vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentMaterialInputInstance
        ? TOPOLOGY_SEGMENT_INSTANCE_VERTEX_BUFFERS
        : vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInputInstance
          ? MESH_GEOMETRY_MATERIAL_INSTANCE_VERTEX_BUFFERS
          : undefined;
  if (buffers === undefined || lanes === undefined) return undefined;
  if (!Number.isInteger(lanes) || lanes < 1 || lanes > 4) {
    throw new RangeError('Particle material input layouts require 1 through 4 lanes');
  }
  return buffers.map((buffer, index) => {
    if (index !== buffers.length - 1) return buffer;
    const attributes = [...buffer.attributes];
    const firstLocation = Math.max(...attributes.map((attribute) => attribute.shaderLocation)) + 1;
    return {
      ...buffer,
      arrayStride: buffer.arrayStride + lanes * 16,
      attributes: [
        ...attributes,
        ...Array.from({ length: lanes }, (_, lane) => ({
          shaderLocation: firstLocation + lane,
          offset: buffer.arrayStride + lane * 16,
          format: 'float32x4' as const,
        })),
      ],
    };
  });
}

function toGpuVertexFormat(
  format: GpuVertexBufferLayoutEntry['attributes'][number]['format'],
): GPUVertexFormat {
  switch (format) {
    case 'float32x2':
    case 'float32x3':
    case 'float32x4':
    case 'uint16x4':
      return format;
    default:
      throw new Error(`Unsupported geometry vertex format: ${format}`);
  }
}

export function toGpuVertexBufferLayouts(
  entries: readonly GpuVertexBufferLayoutEntry[],
): readonly GPUVertexBufferLayout[] {
  return entries.map((entry) => ({
    arrayStride: entry.arrayStride,
    ...(entry.stepMode === undefined ? {} : { stepMode: entry.stepMode }),
    attributes: entry.attributes.map((attribute) => ({
      shaderLocation: attribute.shaderLocation,
      offset: attribute.offset,
      format: toGpuVertexFormat(attribute.format),
    })),
  }));
}

export function resolveWebGPUVertexBufferLayouts(options: {
  vertexInputContract: 'none' | 'render-material';
  vertexLayout: string | undefined;
  vertexLayoutProjection: VertexLayoutProjection | undefined;
  resolvedUvSetCount: number | undefined;
  layoutKind: string;
  meshAttributes: VertexAttributeMap | undefined;
  particleInputLanes: number | undefined;
}): readonly GPUVertexBufferLayout[] {
  const {
    vertexInputContract,
    vertexLayout,
    vertexLayoutProjection,
    resolvedUvSetCount,
    layoutKind,
    meshAttributes,
    particleInputLanes,
  } = options;
  const inputVertexBuffers = particleMaterialInputVertexBuffers(vertexLayout, particleInputLanes);
  return vertexInputContract === 'none'
    ? []
    : inputVertexBuffers !== undefined
      ? inputVertexBuffers
      : vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.positionSizeColorInstance
        ? POSITION_SIZE_COLOR_INSTANCE_VERTEX_BUFFERS
        : vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInstance
          ? BILLBOARD_MATERIAL_INSTANCE_VERTEX_BUFFERS
          : vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentInstance
            ? TOPOLOGY_SEGMENT_INSTANCE_VERTEX_BUFFERS
            : vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInstance
              ? MESH_GEOMETRY_MATERIAL_INSTANCE_VERTEX_BUFFERS
              : vertexLayoutProjection !== undefined
                ? toGpuVertexBufferLayouts(
                    deriveVertexBufferLayoutFromProjection(
                      vertexLayoutProjection,
                      resolvedUvSetCount !== undefined
                        ? { shaderUvSetCount: resolvedUvSetCount }
                        : undefined,
                    ),
                  )
                : layoutKind === 'pbr-skin' || layoutKind === 'gpu-driven-cluster-skin'
                  ? toGpuVertexBufferLayouts(
                      deriveVertexBufferLayout(
                        meshAttributes ?? SKIN_VERTEX_ATTRIBUTE_MAP,
                        resolvedUvSetCount !== undefined
                          ? { shaderUvSetCount: resolvedUvSetCount }
                          : undefined,
                      ),
                    )
                  : meshAttributes !== undefined ||
                      (resolvedUvSetCount !== undefined && resolvedUvSetCount > 1)
                    ? toGpuVertexBufferLayouts(
                        deriveVertexBufferLayout(
                          meshAttributes ?? DEFAULT_VERTEX_ATTRIBUTE_MAP,
                          resolvedUvSetCount !== undefined && resolvedUvSetCount > 1
                            ? { shaderUvSetCount: resolvedUvSetCount }
                            : undefined,
                        ),
                      )
                    : toGpuVertexBufferLayouts(
                        deriveVertexBufferLayout(DEFAULT_VERTEX_ATTRIBUTE_MAP),
                      );
}
