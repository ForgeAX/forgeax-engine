import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { resolveMaterialShaderVariantSet, selectNoColorPbrVariant } from '../assembly/factory';
import { createClusterBinScratch } from '../cluster-binner';
import { createHdrpClusterMembershipBindGroupLayoutDescriptor } from '../hdrp-buffers';
import { RhiErrorListenerRegistry } from '../lifecycle';
import { prepareStandardLighting } from '../pipeline/standard-lighting/prepare';
import { deriveStandardTopologyInput } from '../pipeline/standard-lighting/topology';
import { selectStandardClusterTransport } from '../pipeline/standard-lighting/transport';
import {
  standardCapabilityVariantSet,
  standardStorageVariantSet,
  standardTopologyBindGroupReady,
  standardTopologyVariantSet,
  variantSetFromVertexLayoutProjection,
} from '../pipeline-spec';
import { writeHdrpClusterAndSsaoBuffers } from '../record/frame-lighting';
import type { RenderFrameState } from '../record/frame-snapshot';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RenderSystemInternals } from '../record/render-context';

const standardVariants = [
  { defines: { CLUSTER_FORWARD_AVAILABLE: true, STORAGE_BUFFER_AVAILABLE: true } },
  { defines: { CLUSTER_FORWARD_AVAILABLE: false, STORAGE_BUFFER_AVAILABLE: true } },
];

const noColorVariants = [
  {
    defines: {
      CLUSTER_FORWARD_AVAILABLE: true,
      STORAGE_BUFFER_AVAILABLE: true,
      VERTEX_COLOR_AVAILABLE: false,
    },
  },
  {
    defines: {
      CLUSTER_FORWARD_AVAILABLE: false,
      STORAGE_BUFFER_AVAILABLE: true,
      VERTEX_COLOR_AVAILABLE: false,
    },
  },
] as never;
const noColorManifest = { variants: noColorVariants } as never;
describe('Standard clustered variant resolution', () => {
  it('preserves an admitted integer-texture cluster on WebGL2', () => {
    const variants = [
      {
        defines: {
          CLUSTER_FORWARD_AVAILABLE: true,
          STORAGE_BUFFER_AVAILABLE: false,
          VERTEX_COLOR_AVAILABLE: false,
        },
      },
    ];
    expect(
      resolveMaterialShaderVariantSet(
        standardTopologyVariantSet({ kind: 'clustered' }, false, false),
        variants,
        'wgpu-webgl2',
        false,
        16,
      ),
    ).toBe(
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=false',
    );
  });

  it.each([
    false,
    true,
  ])('retains colored clustered geometry when reflection fallback is %s', (fallback) => {
    const projection = deriveVertexLayoutProjection({
      position: new Float32Array(9),
      color: new Float32Array(12),
    });
    const projected = variantSetFromVertexLayoutProjection(
      projection,
      standardTopologyVariantSet({ kind: 'clustered' }, true, true),
    );
    if (!projected.ok) throw projected.error;
    const geometry = projected.value;
    const request =
      geometry === '' && fallback
        ? ''
        : `${geometry === '' ? '' : `${geometry}+`}REFLECTION_FALLBACK_AVAILABLE=${fallback}`;
    const resolved = resolveMaterialShaderVariantSet(
      request,
      [
        {
          defines: {
            CLUSTER_FORWARD_AVAILABLE: true,
            STORAGE_BUFFER_AVAILABLE: true,
            VERTEX_COLOR_AVAILABLE: true,
            REFLECTION_FALLBACK_AVAILABLE: false,
          },
        },
      ],
      'webgpu',
      true,
    );
    if (fallback) expect(resolved).toBe('');
    else
      expect(resolved).toBe(
        'CLUSTER_FORWARD_AVAILABLE=true+REFLECTION_FALLBACK_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=true',
      );
  });

  it('derives the canonical capability key for every storage/cluster pair', () => {
    expect(standardCapabilityVariantSet(true, true, true)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=true',
    );
    expect(standardCapabilityVariantSet(true, true, false)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    );
    expect(standardCapabilityVariantSet(false, true, true)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=true',
    );
    expect(standardCapabilityVariantSet(false, false, true)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=true',
    );
  });

  it('derives PBR, skin, and sprite-lit variants from the frame topology', () => {
    const noLocalForward = { kind: 'no-local-lights' as const, renderPath: 'forward' as const };
    const clusteredForward = { kind: 'clustered' as const, renderPath: 'forward' as const };
    const clusteredDeferred = { kind: 'clustered' as const, renderPath: 'deferred' as const };

    expect(standardTopologyVariantSet(noLocalForward, true, false)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    );
    expect(standardTopologyVariantSet(clusteredForward, true, false)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    );
    expect(standardTopologyVariantSet(clusteredDeferred, true, false)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    );
  });

  it('expands the clustered base before requesting the object-level probe ABI', () => {
    const noLocalForward = { kind: 'no-local-lights' as const };
    const clusteredForward = { kind: 'clustered' as const };

    expect(standardTopologyVariantSet(noLocalForward, true, false, true)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false+PROBE_BLEND_AVAILABLE=true',
    );
    expect(standardTopologyVariantSet(clusteredForward, true, false, true)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false+PROBE_BLEND_AVAILABLE=true',
    );
    expect(standardTopologyVariantSet(clusteredForward, true, true, true)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=true+PROBE_BLEND_AVAILABLE=true',
    );
    expect(standardTopologyVariantSet(clusteredForward, false, false, true)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=false',
    );
  });

  it('preserves clustered lighting through the colored-mesh producer and backend resolver', () => {
    const projection = deriveVertexLayoutProjection({
      position: new Float32Array(0),
      color: new Float32Array(0),
    });
    const requested = variantSetFromVertexLayoutProjection(
      projection,
      standardTopologyVariantSet({ kind: 'clustered' }, true, true),
    ).unwrap();
    const resolved = resolveMaterialShaderVariantSet(
      requested,
      [
        {
          defines: {
            CLUSTER_FORWARD_AVAILABLE: true,
            STORAGE_BUFFER_AVAILABLE: true,
            VERTEX_COLOR_AVAILABLE: true,
            WEBGL2_COMPAT: false,
          },
        },
      ],
      'webgpu',
      true,
    );
    expect(resolved).toContain('CLUSTER_FORWARD_AVAILABLE=true');
    expect(resolved).toContain('VERTEX_COLOR_AVAILABLE=true');
  });

  it('fails closed when a clustered frame is missing its unified group', () => {
    expect(standardTopologyBindGroupReady({ kind: 'no-local-lights' }, null)).toBe(true);
    expect(standardTopologyBindGroupReady({ kind: 'clustered' }, {})).toBe(true);
    expect(standardTopologyBindGroupReady({ kind: 'clustered' }, null)).toBe(false);
    expect(standardTopologyBindGroupReady({ kind: 'clustered' }, undefined)).toBe(false);
  });

  it('derives storage-only keys for unlit material consumers', () => {
    expect(standardStorageVariantSet(true, true)).toBe('');
    expect(standardStorageVariantSet(true, false)).toBe(
      'STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    );
    expect(standardStorageVariantSet(false, true)).toBe(
      'STORAGE_BUFFER_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=true',
    );
  });

  it('normalizes an explicit all-true capability request to the canonical empty key', () => {
    expect(
      resolveMaterialShaderVariantSet(
        'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true',
        standardVariants,
        'webgpu',
        true,
      ),
    ).toBe('');
  });

  it('normalizes an absent request to the explicit URP false key', () => {
    expect(resolveMaterialShaderVariantSet(undefined, standardVariants, 'webgpu', true)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true',
    );
    expect(
      resolveMaterialShaderVariantSet(
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true',
        standardVariants,
        'webgpu',
        true,
      ),
    ).toBe('CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true');
  });

  it('keeps a zero-local storage frame on the clustered ABI', () => {
    const prepared = prepareStandardLighting({
      directional: undefined,
      local: [],
      view: mat4.create(),
      projection: mat4.create(),
      near: 0.1,
      far: 100,
      grid: { x: 4, y: 3, z: 4 },
      lightCount: 32,
      renderPath: 'forward',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const transport = selectStandardClusterTransport(
      { compute: true, storageBuffer: true, membershipPipelineReady: true },
      prepared.value,
    );
    expect(transport.ok).toBe(true);
    if (!transport.ok) return;
    expect(transport.value.requestedLightCount).toBe(0);
    expect(transport.value.membershipEntryCount).toBe(0);
    const topology = deriveStandardTopologyInput({
      kind: 'clustered',
      prepared: prepared.value,
      transport: transport.value,
    });
    expect(topology.ok).toBe(true);
    if (!topology.ok) return;
    expect(topology.value.kind).toBe('clustered');
    expect(standardTopologyVariantSet(topology.value, true, false)).toBe(
      'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    );
  });

  it('selects no-color HDRP for empty and expanded true keys', () => {
    expect(selectNoColorPbrVariant(noColorManifest, true, '')).toBe(noColorVariants[0]);
    expect(
      selectNoColorPbrVariant(
        noColorManifest,
        true,
        'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true',
      ),
    ).toBe(noColorVariants[0]);
  });

  it('selects no-color URP for an expanded false key', () => {
    expect(
      selectNoColorPbrVariant(
        noColorManifest,
        true,
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true',
      ),
    ).toBe(noColorVariants[1]);
  });

  it('keeps fallback PBR layout selection aligned with the requested probe ABI', () => {
    const noProbeUrp = {
      defines: {
        CLUSTER_FORWARD_AVAILABLE: false,
        PROBE_BLEND_AVAILABLE: false,
        STORAGE_BUFFER_AVAILABLE: true,
        VERTEX_COLOR_AVAILABLE: false,
      },
      composedWgsl: 'no-probe-urp',
    };
    const probeUrp = {
      defines: {
        CLUSTER_FORWARD_AVAILABLE: false,
        PROBE_BLEND_AVAILABLE: true,
        STORAGE_BUFFER_AVAILABLE: true,
        VERTEX_COLOR_AVAILABLE: false,
      },
      composedWgsl: 'probe-urp',
    };
    const noProbeHdrp = {
      defines: {
        CLUSTER_FORWARD_AVAILABLE: true,
        PROBE_BLEND_AVAILABLE: false,
        STORAGE_BUFFER_AVAILABLE: true,
        VERTEX_COLOR_AVAILABLE: false,
      },
      composedWgsl: 'no-probe-hdrp',
    };
    const probeHdrp = {
      defines: {
        CLUSTER_FORWARD_AVAILABLE: true,
        PROBE_BLEND_AVAILABLE: true,
        STORAGE_BUFFER_AVAILABLE: true,
        VERTEX_COLOR_AVAILABLE: false,
      },
      composedWgsl: 'probe-hdrp',
    };
    const manifest = { variants: [probeUrp, noProbeUrp, probeHdrp, noProbeHdrp] } as never;

    expect(selectNoColorPbrVariant(manifest, true, undefined)).toBe(noProbeUrp);
    expect(
      selectNoColorPbrVariant(
        manifest,
        true,
        'CLUSTER_FORWARD_AVAILABLE=true+PROBE_BLEND_AVAILABLE=true',
      ),
    ).toBe(probeHdrp);
  });

  it('rebuilds membership in write after a device and layout generation change', async () => {
    const adapter = new RhiNullAdapter();
    const deviceAResult = await adapter.requestDevice();
    const deviceBResult = await adapter.requestDevice();
    expect(deviceAResult.ok).toBe(true);
    expect(deviceBResult.ok).toBe(true);
    if (!deviceAResult.ok || !deviceBResult.ok) return;
    const deviceA = deviceAResult.value;
    const deviceB = deviceBResult.value;
    const layoutA = deviceA.createBindGroupLayout({ entries: [] }).unwrap();
    const layoutB = deviceB
      .createBindGroupLayout(createHdrpClusterMembershipBindGroupLayoutDescriptor())
      .unwrap();
    const staleBindGroup = deviceA.createBindGroup({ layout: layoutA, entries: [] }).unwrap();
    const frameState = {
      clusteredLighting: true,
      installedPipelineConfig: undefined,
      standardOncePerFrameFired: new Set(),
      hdrpClusterMembership: { device: deviceA, layout: layoutA, bindGroup: staleBindGroup },
      hdrpClusterGridScratch: null,
      hdrpLightIndexListScratch: null,
      hdrpClusterBinScratch: createClusterBinScratch(),
    } as unknown as RenderFrameState;
    const internals = {
      device: deviceB,
      errorRegistry: new RhiErrorListenerRegistry(),
    } as unknown as RenderSystemInternals;
    const prepared = prepareStandardLighting({
      directional: undefined,
      local: [],
      view: mat4.create(),
      projection: mat4.create(),
      near: 0.1,
      far: 100,
      grid: { x: 4, y: 3, z: 4 },
      lightCount: 1,
      renderPath: 'forward',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const transport = selectStandardClusterTransport(
      { compute: true, storageBuffer: true, membershipPipelineReady: true },
      prepared.value,
    );
    expect(transport.ok).toBe(true);
    if (!transport.ok) return;
    writeHdrpClusterAndSsaoBuffers(
      internals,
      frameState,
      makeZeroCameraFallbackSnapshot(),
      prepared.value,
      transport.value,
      undefined,
      true,
      layoutB,
    );
    expect(frameState.hdrpClusterMembership?.device).toBe(deviceB);
    expect(frameState.hdrpClusterMembership?.layout).toBe(layoutB);
    expect(frameState.hdrpClusterMembership?.bindGroup).not.toBe(staleBindGroup);
  });
});
