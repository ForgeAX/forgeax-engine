import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MaterialRenderState } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { freezeRenderProfile, validateRenderProfile } from '../assembly/renderer-facade';
import type { GpuDrivenBatch } from '../gpu-driven/batch-topology';
import {
  gbufferBatchDepth,
  gbufferDiagnosticView,
  gbufferOrderInterfaceEligible,
  gbufferOrderInterfaceEvidence,
  gbufferProgramDigest,
  isGBufferOrderDiagnosticEncode,
  orderGBufferDiagnostic,
} from '../gpu-driven/gbuffer-order-diagnostic';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import type { CameraSnapshot } from '../render-contract';
import type { RenderableSnapshot } from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const camera = () => ({ world: identity(), position: [0, 0, 0] }) as unknown as CameraSnapshot;
const artifact = {
  material: 'unknown::custom',
  receipt: { sceneIndexEntry: 'vs_scene_index' },
} as MaterialShaderArtifact;

describe('GBuffer batch order diagnostic', () => {
  it('admits only stock six-target early GBuffer and leaves other command lanes unchanged', () => {
    expect(
      isGBufferOrderDiagnosticEncode(true, 'deferred-opaque', 'fs_gbuffer', false, 'all', 6),
    ).toBe(true);
    expect(
      isGBufferOrderDiagnosticEncode(false, 'deferred-opaque', 'fs_gbuffer', false, 'all', 6),
    ).toBe(false);
    for (const phase of ['early', 'late', 'shadow'])
      expect(
        isGBufferOrderDiagnosticEncode(true, 'deferred-opaque', 'fs_gbuffer', false, phase, 6),
      ).toBe(false);
    for (const filter of ['opaque', 'forward-only-opaque', 'single-layer-medium', undefined])
      expect(isGBufferOrderDiagnosticEncode(true, filter, 'fs_gbuffer', false, 'all', 6)).toBe(
        false,
      );
    expect(
      isGBufferOrderDiagnosticEncode(true, 'deferred-opaque', 'fs_shadow', false, 'all', 6),
    ).toBe(false);
    expect(
      isGBufferOrderDiagnosticEncode(true, 'deferred-opaque', 'fs_gbuffer', true, 'all', 6),
    ).toBe(false);
    expect(
      isGBufferOrderDiagnosticEncode(true, 'deferred-opaque', 'fs_gbuffer', false, 'all', 7),
    ).toBe(false);
  });
  it('keeps default references and never evaluates metadata while disabled', () => {
    const rows = [{ id: 3 }, { id: 1 }];
    expect(
      orderGBufferDiagnostic(rows, undefined, () => {
        throw Error('disabled');
      }).batches,
    ).toBe(rows);
    expect(DEFAULT_STANDARD_PROFILE.gbufferBatchOrderDiagnostic).toBeUndefined();
  });
  it('sorts near/far stably inside independent runs and preserves all command identities', () => {
    const rows = [
      { z: 8, id: 0 },
      { z: 2, id: 1 },
      { z: 2, id: 2 },
      { id: 3 },
      { z: 9, id: 4 },
      { z: 1, id: 5 },
      { z: NaN, id: 6 },
      { z: 7, id: 7 },
    ];
    const near = orderGBufferDiagnostic(rows, 'near', (x) => x.z);
    const far = orderGBufferDiagnostic(rows, 'far', (x) => x.z);
    expect(near.batches.map((x) => x.id)).toEqual([1, 2, 0, 3, 5, 4, 6, 7]);
    expect(far.batches.map((x) => x.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(near.batches)).toEqual(new Set(rows));
    expect(near.eligible).toBe(6);
    expect(near.moved).toBe(5);
    expect(rows.map((x) => x.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it('requires the actual full-source digest; unknown custom layouts alone grant no permission', () => {
    expect(gbufferProgramDigest('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const audited = [gbufferProgramDigest('audited whole program')];
    expect(audited.includes(gbufferProgramDigest('same layout, unknown implementation'))).toBe(
      false,
    );
    expect(audited.includes(gbufferProgramDigest('audited whole program'))).toBe(true);
  });
  it('keeps no-write/blend/stencil/nonstandard entries and skin as barriers even with audited source', () => {
    expect(gbufferOrderInterfaceEligible(artifact, undefined, 'rigid')).toBe(true);
    expect(gbufferOrderInterfaceEligible(artifact, { depthCompare: 'greater' }, 'rigid')).toBe(
      true,
    );
    for (const state of [
      { depthWriteEnabled: false },
      { depthCompare: 'always' },
      { depthCompare: 'less-equal' },
      { depthCompare: 'greater-equal' },
      { blend: {} },
      { outputs: [{ blend: {} }] },
      { stencil: {} },
      { stencilWriteMask: 0 },
      { depthBias: 1 },
      { alphaToCoverageEnabled: true },
    ] as MaterialRenderState[])
      expect(gbufferOrderInterfaceEligible(artifact, state, 'rigid')).toBe(false);
    expect(gbufferOrderInterfaceEligible(artifact, undefined, 'skin')).toBe(false);
    expect(
      gbufferOrderInterfaceEligible(
        { ...artifact, vertexEntry: 'custom_vertex' },
        undefined,
        'rigid',
      ),
    ).toBe(false);
    expect(
      gbufferOrderInterfaceEligible(
        { ...artifact, fragmentEntry: 'custom_fragment' },
        undefined,
        'rigid',
      ),
    ).toBe(false);
    const { receipt: _receipt, ...withoutReceipt } = artifact;
    expect(gbufferOrderInterfaceEligible(withoutReceipt, undefined, 'rigid')).toBe(false);
  });
  it('reports all simultaneous interface failures and copies their actual inputs', () => {
    const state = {
      depthCompare: 'always' as NonNullable<MaterialRenderState['depthCompare']>,
      depthWriteEnabled: false,
      depthBias: 2,
      stencilReadMask: 7,
      alphaToCoverageEnabled: true,
    };
    const proof = gbufferOrderInterfaceEvidence(
      { ...artifact, fragmentEntry: 'custom' },
      state,
      'skin',
      'vs_main',
    );
    expect(proof.rejections).toEqual(
      expect.arrayContaining([
        'rigid',
        'selectedVertex',
        'fixedFragment',
        'depthWrite',
        'strictDepthCompare',
        'noDepthBias',
        'noStencilReadMask',
        'noAlphaToCoverage',
      ]),
    );
    expect(proof.facts).toMatchObject({
      deformation: 'skin',
      selectedVertexEntry: 'vs_main',
      authoredFragmentEntry: 'custom',
      depthCompare: 'always',
      depthWriteEnabled: false,
      depthBias: 2,
      stencilReadMask: 7,
      alphaToCoverageEnabled: true,
    });
    state.depthCompare = 'less';
    expect(proof.facts.depthCompare).toBe('always');
  });
  it('checks the effective scene-index entry while preserving the legacy direct-entry barrier', () => {
    const forward = { ...artifact, vertexEntry: 'vs_main', fragmentEntry: 'fs_main' };
    // collectGpuDrivenMaterialArtifacts retains the authored Forward entries.
    // Only the real GPU-driven factory overrides that direct vertex metadata.
    expect(gbufferOrderInterfaceEligible(forward, undefined, 'rigid')).toBe(false);
    expect(gbufferOrderInterfaceEligible(forward, undefined, 'rigid', 'vs_scene_index')).toBe(true);
    expect(gbufferOrderInterfaceEligible(forward, undefined, 'rigid', 'custom_vertex')).toBe(false);
    expect(
      gbufferOrderInterfaceEligible(
        { ...forward, fragmentEntry: 'custom_fragment' },
        undefined,
        'rigid',
        'vs_scene_index',
      ),
    ).toBe(false);
  });
  it('derives current camera and transformed union bounds anew without touching candidates/ordinals', () => {
    const world = identity();
    world[14] = -10;
    const source = {
      localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
      transform: { world },
      material: {},
      materials: [],
    } as unknown as RenderableSnapshot;
    const batch = {
      key: { materialSlot: 0 },
      candidates: [
        { primitiveIndex: 4, instanceOrdinal: 7 },
        { primitiveIndex: 4, instanceOrdinal: 2 },
      ],
    } as unknown as GpuDrivenBatch;
    const slotAt = (() => ({ snapshot: source })) as unknown as PersistentGpuDrivenState['slotAt'];
    const c = camera();
    const view = gbufferDiagnosticView(c);
    expect(view).toBeDefined();
    expect(gbufferBatchDepth(batch, slotAt, view as Float32Array)).toBe(10);
    world[14] = -20;
    expect(gbufferBatchDepth(batch, slotAt, view as Float32Array)).toBe(20);
    c.world[14] = -5;
    expect(gbufferBatchDepth(batch, slotAt, gbufferDiagnosticView(c) as Float32Array)).toBe(15);
    c.world[10] = -1;
    expect(gbufferBatchDepth(batch, slotAt, gbufferDiagnosticView(c) as Float32Array)).toBe(-15);
    expect(batch.candidates.map((x) => x.instanceOrdinal)).toEqual([7, 2]);
    expect(gbufferBatchDepth(batch, () => undefined, view as Float32Array)).toBeUndefined();
    world[14] = NaN;
    expect(gbufferBatchDepth(batch, slotAt, view as Float32Array)).toBeUndefined();
  });
  it('freezes a bounded explicit audit list and rejects malformed diagnostic settings', () => {
    const programDigests = [gbufferProgramDigest('abc')];
    const profile = {
      ...DEFAULT_STANDARD_PROFILE,
      gbufferBatchOrderDiagnostic: { order: 'near' as const, programDigests },
    };
    expect(validateRenderProfile(profile)).toBeUndefined();
    const frozen = freezeRenderProfile(profile);
    programDigests.length = 0;
    expect(frozen.gbufferBatchOrderDiagnostic?.programDigests).toHaveLength(1);
    expect(Object.isFrozen(frozen.gbufferBatchOrderDiagnostic?.programDigests)).toBe(true);
    for (const bad of [
      'near',
      { order: 'other', programDigests: [] },
      { order: 'far', programDigests: ['identity-not-digest'] },
      { order: 'near', programDigests: [], skip: true },
    ])
      expect(
        validateRenderProfile({
          ...DEFAULT_STANDARD_PROFILE,
          gbufferBatchOrderDiagnostic: bad,
        } as never),
      ).toContain('gbufferBatchOrderDiagnostic');
  });
});
