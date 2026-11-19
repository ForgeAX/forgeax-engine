import { World } from '@forgeax/engine-ecs';
import { err, ok } from '@forgeax/engine-types';
import { assert, describe, expect, it, vi } from 'vitest';
import { RenderFeaturePreparationFailedError } from '../errors/render';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  hasSubmissionSensitiveFeatures,
} from '../features/host';
import {
  cloneRenderFeaturePlanSignatureSnapshot,
  deriveRenderFeaturePassAccess,
  deriveRenderFeaturePlanAccess,
  type RenderFeatureWorkPlan,
  rememberRenderFeaturePlanSignature,
  renderFeaturePlanSignature,
  renderFeaturePlanSignatureEvidenceMatches,
  renderFeaturePlanSignatureSnapshotEquals,
  validateRenderFeaturePlan,
} from '../features/plan';
import { createRenderFeatureTarget } from '../features/targets';
import type { RenderFeature } from '../features/types';
import { createWaterInfoFeature, inspectWaterInfoPublications } from '../water/water-info-feature';
import { submitFeatureFrame } from './feature-frame-driver';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

describe('submission-sensitive declared feature work', () => {
  it('keeps inactive WaterInfo with no publication or GPU work replayable', () => {
    const feature = createWaterInfoFeature();
    const host = createRenderFeatureHost([feature]).unwrap();
    try {
      const result = runSingleViewFeatureFrame(host, {
        world: new World(),
        frameNumber: 1,
        caps: {
          compute: true,
          storageBuffer: true,
          storageTexture: true,
          rgba16floatRenderable: true,
          rgba16floatStorage: true,
        } as never,
        frame: {
          view: {
            identity: 'main',
            width: 64,
            height: 64,
            cameraRevision: 0,
            deviceGeneration: 1,
            cameraPosition: [0, 4, 0],
          },
        },
      });
      expect(result.errors).toEqual([]);
      expect(result.preparationPending).not.toBe(true);
      expect(result.plans).toHaveLength(1);
      expect(inspectWaterInfoPublications(feature, 1)).toEqual([]);
      for (const planned of result.plans) {
        expect(planned.plan.resources).toEqual([]);
        expect(getRenderFeaturePlanExecutionProjection(planned)?.passes).toEqual([]);
      }
      expect(hasSubmissionSensitiveFeatures(result.plans)).toBe(false);
    } finally {
      host.dispose();
    }
  });

  it.each([
    { intent: 'none', sensitive: false },
    { intent: 'source-feedback', sensitive: true },
    { intent: 'clear-pass', sensitive: true },
  ] as const)('preserves the $intent submission authority', ({ intent, sensitive }) => {
    const feature: RenderFeature<undefined> = {
      identity: 'synthetic.submission-authority',
      extract: () => ok(undefined),
      plan: () =>
        ok({
          ...(intent === 'source-feedback' ? { sourceFeedback: { generation: 1 } } : {}),
          work: [
            {
              scope: { view: 'main' },
              resources: [],
              passes:
                intent === 'clear-pass'
                  ? [
                      {
                        kind: 'raster' as const,
                        name: 'clear-color',
                        colorAttachments: [
                          { target: 'color', loadOp: 'clear' as const, storeOp: 'store' as const },
                        ],
                        draws: [],
                      },
                    ]
                  : [],
            },
          ],
        }),
      onFrameSubmitted: () => {},
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    try {
      const result = runSingleViewFeatureFrame(host, {
        world: new World(),
        frameNumber: 1,
        caps: {} as never,
        targets: [
          createRenderFeatureTarget({ kind: 'scene-color', format: 'rgba8unorm', sampleCount: 1 }),
        ],
      });
      expect(result.errors).toEqual([]);
      expect(result.plans).toHaveLength(1);
      const planned = requiredFixtureValue(result.plans[0]);
      expect(getRenderFeaturePlanExecutionProjection(planned)?.passes).toHaveLength(
        intent === 'clear-pass' ? 1 : 0,
      );
      expect(hasSubmissionSensitiveFeatures(result.plans)).toBe(sensitive);
    } finally {
      host.dispose();
    }
  });

  it('keeps a real pending source unrecorded and preparation blocked', () => {
    const feature: RenderFeature<undefined> = {
      identity: 'synthetic.pending-submission-authority',
      extract: () => ok(undefined),
      plan: () =>
        ok({ pendingSource: { resource: 'water-mesh', reason: 'publication-pending' }, work: [] }),
      onFrameSubmitted: () => {},
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    try {
      const result = runSingleViewFeatureFrame(host, {
        world: new World(),
        frameNumber: 1,
        caps: {} as never,
      });
      expect(result.errors).toEqual([]);
      expect(result.plans).toEqual([]);
      expect(result.preparationPending).toBe(true);
      expect(result.preparationPendingReason).toMatchObject({
        featureIdentity: feature.identity,
        resource: 'water-mesh',
        reason: 'publication-pending',
      });
    } finally {
      host.dispose();
    }
  });
});

const plan = (data = new Uint32Array([1, 2, 3, 4])) =>
  ({
    resources: [
      {
        kind: 'compute-program',
        name: 'simulate-program',
        program: {
          wgsl: '@compute @workgroup_size(1) fn simulate() {}',
          entryPoints: ['simulate'],
          bindings: [
            {
              entries: [
                { binding: 0, visibility: 4, buffer: { type: 'storage' } },
                { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
              ],
            },
          ],
        },
      },
      {
        kind: 'graphics-program',
        name: 'draw-program',
        program: {
          shader: 'forgeax::feature-draw',
          vertexLayout: 'position',
          colorFormats: ['rgba8unorm'],
        },
      },
      {
        kind: 'buffer',
        name: 'particles',
        size: 64,
        usage: ['storage', 'vertex'],
        data,
      },
      {
        kind: 'buffer',
        name: 'params',
        size: 16,
        usage: ['uniform'],
      },
      {
        kind: 'buffer',
        name: 'indirect',
        size: 16,
        usage: ['storage', 'indirect'],
      },
      {
        kind: 'compute-bindings',
        name: 'simulate-bindings',
        program: 'simulate-program',
        entries: [
          { binding: 0, resource: 'particles' },
          { binding: 1, resource: 'params' },
        ],
      },
      {
        kind: 'graphics-bindings',
        name: 'draw-bindings',
        program: 'draw-program',
        values: {},
      },
      {
        kind: 'vertex-data',
        name: 'vertices',
        layout: 'position',
        buffer: 'particles',
      },
    ],
    passes: [
      {
        kind: 'compute',
        name: 'simulate',
        program: 'simulate-program',
        bindings: 'simulate-bindings',
        dispatches: [{ kind: 'direct', entryPoint: 'simulate', workgroups: [1] }],
      },
      {
        kind: 'raster',
        name: 'draw',
        colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
        draws: [
          {
            program: 'draw-program',
            bindings: ['draw-bindings'],
            vertexData: [{ slot: 0, resource: 'vertices' }],
            draw: { kind: 'draw-indirect', resource: 'indirect' },
          },
        ],
      },
    ],
  }) satisfies RenderFeatureWorkPlan;

describe('RenderFeature plan authority', () => {
  it('accepts unsigned direct counts on every axis, including empty work, without weakening resource validation', () => {
    const source = plan();
    const simulate = source.passes[0];
    if (simulate?.kind !== 'compute') throw new Error('Missing compute pass');
    const withCounts = (counts: readonly (number | undefined)[]): RenderFeatureWorkPlan => ({
      resources: source.resources,
      passes: [
        {
          ...simulate,
          dispatches: [
            {
              kind: 'direct',
              entryPoint: 'simulate',
              workgroups: counts as readonly [number, number?, number?],
            },
          ],
        },
      ],
    });
    for (const counts of [[0], [0, 1, 1], [1, 0, 1], [1, 1, 0], [0xffff_ffff, undefined, 1]]) {
      const current = withCounts(counts);
      expect(validateRenderFeaturePlan('counts', current).ok).toBe(true);
      expect(deriveRenderFeaturePassAccess(current, current.passes[0] as never)).toEqual(
        deriveRenderFeaturePassAccess(source, simulate),
      );
    }
    for (const invalid of [-1, NaN, Infinity, 0.5, 0x1_0000_0000])
      for (let axis = 0; axis < 3; axis += 1) {
        const counts = [0, 0, 0];
        counts[axis] = invalid;
        expect(validateRenderFeaturePlan('counts', withCounts(counts)).ok).toBe(false);
      }
    for (const counts of [[], [undefined], [0, 0, 0, 0]])
      expect(validateRenderFeaturePlan('counts', withCounts(counts)).ok).toBe(false);
    expect(validateRenderFeaturePlan('counts', { ...withCounts([0]), resources: [] }).ok).toBe(
      false,
    );
  });
  it('validates shadow draws without author-owned light targets and derives their buffer reads', () => {
    const source = plan();
    const raster = source.passes[1];
    if (raster?.kind !== 'raster') throw new Error('Missing fixture draw');
    const shadow: RenderFeatureWorkPlan = {
      resources: source.resources.map((resource) =>
        resource.kind === 'graphics-program'
          ? {
              ...resource,
              program: { ...resource.program, colorFormats: [], depthFormat: 'depth32float' },
            }
          : resource,
      ),
      passes: [{ kind: 'shadow-caster', name: 'shadow', draws: raster.draws }],
    };
    expect(validateRenderFeaturePlan('shadow', shadow).ok).toBe(true);
    const shadowPass = shadow.passes[0];
    if (shadowPass === undefined) throw new Error('Missing shadow fixture');
    expect(deriveRenderFeaturePassAccess(shadow, shadowPass)).toEqual([
      { resource: 'particles', usage: 'vertex-read' },
      { resource: 'indirect', usage: 'indirect-read' },
    ]);
    expect(
      validateRenderFeaturePlan('invalid-shadow', { ...shadow, resources: source.resources }).ok,
    ).toBe(false);
    expect(renderFeaturePlanSignature(shadow)).not.toBe(renderFeaturePlanSignature(source));
  });
  it('derives compute and raster access from descriptors', () => {
    const value = plan();
    expect(deriveRenderFeaturePassAccess(value, value.passes[0] as never)).toEqual([
      { resource: 'particles', usage: 'storage-read-write' },
      { resource: 'params', usage: 'uniform-read' },
    ]);
    expect(deriveRenderFeaturePassAccess(value, value.passes[1] as never)).toEqual([
      { resource: 'color', usage: 'color-attachment' },
      { resource: 'particles', usage: 'vertex-read' },
      { resource: 'indirect', usage: 'indirect-read' },
    ]);
  });

  it('derives complete ordered plan access while keeping borrowed inputs live between calls', () => {
    const source = plan();
    const raster = source.passes[1];
    if (raster?.kind !== 'raster') throw new Error('Missing raster fixture');
    const draw = raster.draws[0];
    assert(draw);
    let sampledTarget = 'sampled-color';
    const value: RenderFeatureWorkPlan = {
      resources: [
        ...source.resources.filter((resource) => resource.kind !== 'compute-program'),
        {
          kind: 'compute-program',
          name: 'simulate-program',
          program: {
            wgsl: '@compute @workgroup_size(1) fn simulate() {}',
            entryPoints: ['simulate'],
            bindings: [
              {
                entries: [
                  { binding: 0, visibility: 4, buffer: { type: 'storage' } },
                  { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
                  { binding: 2, visibility: 4, texture: {} },
                  {
                    binding: 3,
                    visibility: 4,
                    storageTexture: { access: 'write-only', format: 'rgba32float' },
                  },
                  {
                    binding: 4,
                    visibility: 4,
                    storageTexture: { access: 'read-only', format: 'rgba32float' },
                  },
                  {
                    binding: 5,
                    visibility: 4,
                    storageTexture: { access: 'read-write', format: 'rgba32float' },
                  },
                ],
              },
            ],
          },
        },
        {
          kind: 'compute-bindings',
          name: 'texture-bindings',
          program: 'simulate-program',
          entries: [2, 3, 4, 5].map((binding) => ({ binding, resource: `texture-${binding}` })),
        },
        {
          kind: 'prepared-gpu-resource',
          name: 'texture-2',
          resource: { kind: 'texture-view', value: undefined },
          get logicalTarget() {
            return sampledTarget;
          },
        },
        ...[3, 4, 5].map((binding) => ({
          kind: 'prepared-gpu-resource' as const,
          name: `texture-${binding}`,
          resource: { kind: 'texture-view' as const, value: undefined },
          logicalTarget: `target-${binding}`,
        })),
        { kind: 'index-data', name: 'indices', format: 'uint32', buffer: 'index-buffer' },
      ],
      passes: [
        {
          kind: 'compute',
          name: 'simulate',
          program: 'simulate-program',
          bindings: 'simulate-bindings',
          dispatches: [
            {
              kind: 'direct',
              entryPoint: 'simulate',
              bindings: 'simulate-bindings',
              workgroups: [1],
            },
            {
              kind: 'direct',
              entryPoint: 'simulate',
              bindings: 'texture-bindings',
              workgroups: [0],
            },
            {
              kind: 'indirect',
              entryPoint: 'simulate',
              bindings: 'texture-bindings',
              resource: 'indirect',
              offset: 0,
            },
          ],
        },
        {
          kind: 'copy',
          name: 'copy',
          textureReadbacks: [{ name: 'readback', target: 'readback-color' }],
          copies: [{ source: 'particles', destination: 'copied-particles', size: 16 }],
        },
        {
          ...raster,
          depthStencilAttachment: { target: 'depth', depthLoadOp: 'load', depthStoreOp: 'store' },
          sampledTargets: ['depth', 'sampled-color'],
          draws: [
            {
              ...draw,
              indexData: { resource: 'indices', format: 'uint32' },
              draw: { kind: 'draw-indexed-indirect', resource: 'indirect' },
            },
          ],
        },
        { kind: 'shadow-caster', name: 'shadow', draws: raster.draws },
        {
          kind: 'raster',
          name: 'depth-writer',
          colorAttachments: [],
          draws: [],
          depthStencilAttachment: { target: 'depth', depthLoadOp: 'clear', depthStoreOp: 'store' },
        },
      ],
    };
    const first = deriveRenderFeaturePlanAccess(value);
    expect(first).toEqual([
      { resource: 'particles', usage: 'storage-read-write' },
      { resource: 'params', usage: 'uniform-read' },
      { resource: 'sampled-color', usage: 'sampled-read' },
      { resource: 'target-3', usage: 'storage-write' },
      { resource: 'target-4', usage: 'storage-read' },
      { resource: 'target-5', usage: 'sampled-storage-read-write' },
      { resource: 'indirect', usage: 'indirect-read' },
      { resource: 'readback-color', usage: 'copy-src' },
      { resource: 'particles', usage: 'copy-src' },
      { resource: 'copied-particles', usage: 'copy-dst' },
      { resource: 'color', usage: 'color-attachment' },
      { resource: 'depth', usage: 'depth-stencil-read' },
      { resource: 'depth', usage: 'sampled-read' },
      { resource: 'sampled-color', usage: 'sampled-read' },
      { resource: 'particles', usage: 'vertex-read' },
      { resource: 'index-buffer', usage: 'index-read' },
      { resource: 'indirect', usage: 'indirect-read' },
      { resource: 'particles', usage: 'vertex-read' },
      { resource: 'indirect', usage: 'indirect-read' },
      { resource: 'depth', usage: 'depth-stencil-write' },
    ]);
    expect(first).toEqual(
      value.passes.flatMap((pass) => deriveRenderFeaturePassAccess(value, pass)),
    );
    expect(Object.isFrozen(first)).toBe(true);
    sampledTarget = 'next-color';
    const next = deriveRenderFeaturePlanAccess(value);
    expect(next[2]).toEqual({ resource: 'next-color', usage: 'sampled-read' });
    expect(first[2]).toEqual({ resource: 'sampled-color', usage: 'sampled-read' });
  });

  it('keeps buffer uploads out of the stable topology signature', () => {
    expect(renderFeaturePlanSignature(plan(new Uint32Array([1])))).toBe(
      renderFeaturePlanSignature(plan(new Uint32Array([2]))),
    );
  });

  it('accounts typed-array signature work per feature without changing identity', () => {
    const metrics = { calls: 0, typedArrayBytes: 0, outputChars: 0 };
    const first = renderFeaturePlanSignature(plan(new Uint32Array([1, 2])), metrics);
    const second = renderFeaturePlanSignature(plan(new Uint32Array([3, 4])), metrics);
    expect(first).toBe(second);
    // Buffer payloads stay out of the topology identity, but the detached
    // accounting still reports the bytes examined on both validation calls.
    expect(metrics).toMatchObject({ calls: 2, typedArrayBytes: 16 });
    expect(metrics.outputChars).toBeGreaterThan(0);
  });

  it('keeps vertex and index payloads in the canonical producer signature', () => {
    const vertex = (value: number): RenderFeatureWorkPlan => ({
      resources: [
        {
          kind: 'vertex-data',
          name: 'vertices',
          layout: 'position',
          data: new Float32Array([value]),
        },
      ],
      passes: [],
    });
    const index = (value: number): RenderFeatureWorkPlan => ({
      resources: [
        {
          kind: 'index-data',
          name: 'indices',
          format: 'uint16',
          data: new Uint16Array([value]),
        },
      ],
      passes: [],
    });
    expect(renderFeaturePlanSignature(vertex(1))).not.toBe(renderFeaturePlanSignature(vertex(2)));
    expect(renderFeaturePlanSignature(index(1))).not.toBe(renderFeaturePlanSignature(index(2)));
  });

  it('encodes every inline payload byte exactly across views and slices', () => {
    const bytes = new Uint8Array([0, 1, 2, 15, 16, 127, 128, 254, 255]);
    const sliced = bytes.subarray(2, 8);
    const shared = new Uint16Array(sliced.buffer, sliced.byteOffset, 3);
    const vertex = (data: ArrayBufferView): RenderFeatureWorkPlan => ({
      resources: [{ kind: 'vertex-data', name: 'vertices', layout: 'position', data }],
      passes: [],
    });
    expect(renderFeaturePlanSignature(vertex(sliced))).toBe(
      renderFeaturePlanSignature(vertex(shared)),
    );
    const mutated = new Uint8Array(sliced);
    const original = mutated[3];
    if (original === undefined) throw new Error('Missing mutation byte');
    mutated[3] = original ^ 0x01;
    expect(renderFeaturePlanSignature(vertex(mutated))).not.toBe(
      renderFeaturePlanSignature(vertex(sliced)),
    );
    expect(renderFeaturePlanSignature(vertex(new Uint8Array()))).not.toBe(
      renderFeaturePlanSignature(vertex(new Uint8Array([0]))),
    );
  });

  it('matches detached snapshots without treating buffer uploads as topology changes', () => {
    const first = plan(new Uint32Array([1, 2]));
    const snapshot = cloneRenderFeaturePlanSignatureSnapshot(first);
    expect(renderFeaturePlanSignatureSnapshotEquals(plan(new Uint32Array([9, 8])), snapshot)).toBe(
      true,
    );

    const vertex = {
      resources: [
        {
          kind: 'vertex-data',
          name: 'vertices',
          layout: 'position',
          data: new Float32Array([1]),
        },
      ],
      passes: [],
    } satisfies RenderFeatureWorkPlan;
    const vertexSnapshot = cloneRenderFeaturePlanSignatureSnapshot(vertex);
    (vertex.resources[0] as { data: Float32Array }).data[0] = 2;
    expect(renderFeaturePlanSignatureSnapshotEquals(vertex, vertexSnapshot)).toBe(false);
  });

  it('shares unchanged detached subtrees across a changed plan revision', () => {
    const first = plan();
    const firstSnapshot = cloneRenderFeaturePlanSignatureSnapshot(first);
    const changed: RenderFeatureWorkPlan = {
      resources: first.resources.map((resource, index) =>
        index === 3 && resource.kind === 'buffer'
          ? { ...resource, size: resource.size + 16 }
          : resource,
      ),
      passes: first.passes.map((pass, index) =>
        index === 0 && pass.kind === 'compute' ? { ...pass, name: 'simulate-next' } : pass,
      ),
    };

    const nextSnapshot = cloneRenderFeaturePlanSignatureSnapshot(changed, firstSnapshot);
    expect(nextSnapshot).not.toBe(firstSnapshot);
    expect(nextSnapshot.resources[0]).toBe(firstSnapshot.resources[0]);
    expect(nextSnapshot.resources[1]).toBe(firstSnapshot.resources[1]);
    expect(nextSnapshot.resources[2]).toBe(firstSnapshot.resources[2]);
    expect(nextSnapshot.resources[3]).not.toBe(firstSnapshot.resources[3]);
    expect(nextSnapshot.resources[4]).toBe(firstSnapshot.resources[4]);
    expect(nextSnapshot.passes).not.toBe(firstSnapshot.passes);
    if (nextSnapshot.passes.kind !== 'array' || firstSnapshot.passes.kind !== 'array') return;
    expect(nextSnapshot.passes.values[1]).toBe(firstSnapshot.passes.values[1]);
    expect(renderFeaturePlanSignatureSnapshotEquals(first, firstSnapshot)).toBe(true);
    expect(renderFeaturePlanSignatureSnapshotEquals(changed, nextSnapshot)).toBe(true);
  });

  it('reuses the prior snapshot for buffer-upload-only changes', () => {
    const first = plan(new Uint32Array([1, 2]));
    const firstSnapshot = cloneRenderFeaturePlanSignatureSnapshot(first);
    const nextSnapshot = cloneRenderFeaturePlanSignatureSnapshot(
      plan(new Uint32Array([9, 8])),
      firstSnapshot,
    );
    expect(nextSnapshot).toBe(firstSnapshot);
  });

  it('reuses immutable shader strings while rechecking new descriptors and changed siblings', () => {
    const first = plan();
    const program = first.resources.find((resource) => resource.kind === 'compute-program');
    if (program?.kind !== 'compute-program') throw new Error('Missing compute fixture');
    const wgsl = program.program.wgsl;
    const snapshot = cloneRenderFeaturePlanSignatureSnapshot(first);
    const next = plan(new Uint32Array([8, 9]));
    const changed: RenderFeatureWorkPlan = {
      ...next,
      resources: next.resources.map((resource) =>
        resource.kind === 'buffer' && resource.name === 'params'
          ? { ...resource, size: 32 }
          : resource,
      ),
    };
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      expect(renderFeaturePlanSignatureSnapshotEquals(next, snapshot)).toBe(true);
      expect(cloneRenderFeaturePlanSignatureSnapshot(next, snapshot)).toBe(snapshot);
      expect(renderFeaturePlanSignatureSnapshotEquals(changed, snapshot)).toBe(false);
      const updated = cloneRenderFeaturePlanSignatureSnapshot(changed, snapshot);
      expect(updated).not.toBe(snapshot);
      rememberRenderFeaturePlanSignature(changed, 'revision-1', updated);
      expect(renderFeaturePlanSignatureEvidenceMatches(changed, 'revision-1')).toBe(true);
      expect(stringify.mock.calls.some(([value]) => value === wgsl)).toBe(false);
    } finally {
      stringify.mockRestore();
    }
  });

  it('invalidates remembered evidence for shader and nested binding mutations', () => {
    const value = plan();
    const program = value.resources.find((resource) => resource.kind === 'compute-program');
    if (program?.kind !== 'compute-program') throw new Error('Missing compute fixture');
    const signature = renderFeaturePlanSignature(value);
    const snapshot = cloneRenderFeaturePlanSignatureSnapshot(value);
    rememberRenderFeaturePlanSignature(value, signature, snapshot);
    const original = program.program.wgsl;
    program.program.wgsl += '\n// changed shader source';
    expect(renderFeaturePlanSignatureEvidenceMatches(value, signature)).toBe(false);
    expect(renderFeaturePlanSignature(value)).not.toBe(signature);
    program.program.wgsl = original;
    expect(renderFeaturePlanSignatureEvidenceMatches(value, signature)).toBe(true);
    const binding = program.program.bindings[0]?.entries[0];
    if (binding === undefined) throw new Error('Missing binding fixture');
    binding.binding = 2;
    expect(renderFeaturePlanSignatureEvidenceMatches(value, signature)).toBe(false);
    expect(renderFeaturePlanSignature(value)).not.toBe(signature);
  });

  it('preserves escaped string identity across repeated host and graph admissions', () => {
    const feature: RenderFeature<undefined> = {
      identity: 'escaped-signature',
      extract: () => ok(undefined),
      plan: () => ok({ work: [] }),
    };
    const created = createRenderFeatureHost([feature]);
    if (!created.ok) throw new Error('Missing host fixture');
    let previous: string | undefined;
    let previousCanonical: string | undefined;
    for (const suffix of ['\n// "quoted" \\ path\t', '\n// other', '\n// "quoted" \\ path\t']) {
      const value = plan();
      const program = value.resources.find((resource) => resource.kind === 'compute-program');
      if (program?.kind !== 'compute-program') throw new Error('Missing compute fixture');
      program.program.wgsl += suffix;
      const signature = created.value.recordPlanSignature?.(feature.identity, value);
      const canonical = renderFeaturePlanSignature(value);
      if (previous === undefined) expect(signature).toBe(canonical);
      expect(canonical).not.toBe(previousCanonical);
      expect(signature).not.toBe(previous);
      if (signature === undefined) throw new Error('Missing signature fixture');
      expect(renderFeaturePlanSignatureEvidenceMatches(value, signature)).toBe(true);
      expect(created.value.recordPlanSignature?.(feature.identity, value)).toBe(signature);
      previous = signature;
      previousCanonical = canonical;
    }
  });

  it('retains sorted usage equality while rejecting changed usage multiplicity', () => {
    const value = plan();
    const buffer = value.resources.find(
      (resource) => resource.kind === 'buffer' && resource.name === 'particles',
    );
    if (buffer?.kind !== 'buffer') throw new Error('Missing buffer fixture');
    const signature = renderFeaturePlanSignature(value);
    const snapshot = cloneRenderFeaturePlanSignatureSnapshot(value);
    rememberRenderFeaturePlanSignature(value, signature, snapshot);
    buffer.usage.reverse();
    expect(renderFeaturePlanSignatureEvidenceMatches(value, signature)).toBe(true);
    expect(renderFeaturePlanSignature(value)).toBe(signature);
    buffer.usage[0] = 'storage';
    expect(renderFeaturePlanSignatureEvidenceMatches(value, signature)).toBe(false);
    expect(renderFeaturePlanSignature(value)).not.toBe(signature);
    const changed = cloneRenderFeaturePlanSignatureSnapshot(value, snapshot);
    expect(renderFeaturePlanSignatureSnapshotEquals(value, changed)).toBe(true);
  });

  it('does not share changed inline payload bytes', () => {
    const vertex = (value: number): RenderFeatureWorkPlan => ({
      resources: [
        {
          kind: 'vertex-data',
          name: 'vertices',
          layout: 'position',
          data: new Float32Array([value]),
        },
      ],
      passes: [],
    });
    const first = vertex(1);
    const firstSnapshot = cloneRenderFeaturePlanSignatureSnapshot(first);
    const nextSnapshot = cloneRenderFeaturePlanSignatureSnapshot(vertex(2), firstSnapshot);
    expect(nextSnapshot).not.toBe(firstSnapshot);
    expect(nextSnapshot.resources[0]).not.toBe(firstSnapshot.resources[0]);
    expect(renderFeaturePlanSignatureSnapshotEquals(vertex(2), nextSnapshot)).toBe(true);
    expect(renderFeaturePlanSignatureSnapshotEquals(first, firstSnapshot)).toBe(true);
  });

  it('detects nested mutation after evidence is remembered', () => {
    const value = {
      resources: [
        {
          kind: 'vertex-data',
          name: 'vertices',
          layout: 'position',
          data: new Float32Array([1]),
        },
      ],
      passes: [],
    } satisfies RenderFeatureWorkPlan;
    const signature = renderFeaturePlanSignature(value);
    const snapshot = cloneRenderFeaturePlanSignatureSnapshot(value);
    rememberRenderFeaturePlanSignature(value, signature, snapshot);
    expect(renderFeaturePlanSignatureEvidenceMatches(value, signature)).toBe(true);
    (value.resources[0] as { data: Float32Array }).data[0] = 2;
    expect(renderFeaturePlanSignatureEvidenceMatches(value, signature)).toBe(false);
  });

  it('records host cache hits separately from canonical signature calls', () => {
    const feature: RenderFeature<undefined> = {
      identity: 'synthetic.signature-cache',
      extract: () => ok(undefined),
      plan: () => ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] }),
    };
    const host = createRenderFeatureHost([feature]);
    expect(host.ok).toBe(true);
    if (!host.ok || host.value.recordPlanSignature === undefined) return;

    const empty: RenderFeatureWorkPlan = { resources: [], passes: [] };
    host.value.recordPlanSignature(feature.identity, empty);
    host.value.recordPlanSignature(feature.identity, { resources: [], passes: [] });
    expect(host.value.inspection?.().signatures).toMatchObject([
      { featureIdentity: feature.identity, calls: 1, cacheHits: 1, cacheMisses: 1 },
    ]);
  });

  it('does not request a graph revision for retired GPU leases that the candidate does not use', () => {
    const feature: RenderFeature<undefined> = {
      identity: 'synthetic.retired-gpu-lease',
      extract: () => ok(undefined),
      plan: () => ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] }),
    };
    const host = createRenderFeatureHost([feature]);
    expect(host.ok).toBe(true);
    if (!host.ok) return;
    const release = vi.fn(() => ok(undefined));
    const gpuWork = {
      beginFeature: () => ({
        retainResources: () => {},
        changedResourceNames: new Set(),
        commitFrame: () => [{ release }],
        abortFrame: () => ok(undefined),
      }),
    } as never;

    const result = runSingleViewFeatureFrame(host.value, {
      world: new World(),
      frameNumber: 1,
      generation: 1,
      caps: {} as never,
      gpuWork,
    });

    expect(result.errors).toEqual([]);
    expect(result.preparedResourceBatches).toHaveLength(0);
    submitFeatureFrame(host.value);
    expect(result.preparedResourceBatches).toHaveLength(1);
    expect(result.requiresPreparedResourceKey).toBe(false);
  });

  it('rejects descriptor references that do not exist', () => {
    const invalid: RenderFeatureWorkPlan = {
      resources: [],
      passes: [
        {
          kind: 'compute',
          name: 'simulate',
          program: 'missing',
          bindings: 'missing',
          dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [1] }],
        },
      ],
    };
    expect(validateRenderFeaturePlan('synthetic.invalid', invalid).ok).toBe(false);
  });

  it('accepts clear-only raster passes but rejects empty load-only and shadow passes', () => {
    const targets = [
      { name: 'color', kind: 'color', format: 'rgba8unorm', sampleCount: 1 },
    ] as const;
    const clearOnly: RenderFeatureWorkPlan = {
      resources: [],
      passes: [
        {
          kind: 'raster',
          name: 'clear-color',
          colorAttachments: [{ target: 'color', loadOp: 'clear', storeOp: 'store' }],
          draws: [],
        },
      ],
    };
    const loadOnly: RenderFeatureWorkPlan = {
      resources: [],
      passes: [
        {
          kind: 'raster',
          name: 'load-color',
          colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
          draws: [],
        },
      ],
    };
    const emptyShadow: RenderFeatureWorkPlan = {
      resources: [],
      passes: [{ kind: 'shadow-caster', name: 'empty-shadow', draws: [] }],
    };
    const missingClearTarget: RenderFeatureWorkPlan = {
      resources: [],
      passes: [
        {
          kind: 'raster',
          name: 'clear-missing-target',
          colorAttachments: [{ target: 'missing', loadOp: 'clear', storeOp: 'store' }],
          draws: [],
        },
      ],
    };

    expect(validateRenderFeaturePlan('clear-only', clearOnly, targets).ok).toBe(true);
    expect(validateRenderFeaturePlan('load-only', loadOnly, targets).ok).toBe(false);
    expect(validateRenderFeaturePlan('empty-shadow', emptyShadow, targets).ok).toBe(false);
    expect(validateRenderFeaturePlan('missing-target', missingClearTarget, targets).ok).toBe(false);
  });

  it('projects a clear-only raster pass without graphics pipelines or bindings', () => {
    const feature: RenderFeature<undefined> = {
      identity: 'synthetic.clear-only',
      extract: () => ok(undefined),
      plan: () =>
        ok({
          work: [
            {
              scope: { view: 'main' },
              resources: [],
              passes: [
                {
                  kind: 'raster',
                  name: 'clear-color',
                  colorAttachments: [{ target: 'color', loadOp: 'clear', storeOp: 'store' }],
                  draws: [],
                },
              ],
            },
          ],
        }),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    try {
      const result = runSingleViewFeatureFrame(host, {
        world: new World(),
        frameNumber: 1,
        caps: {} as never,
        targets: [
          createRenderFeatureTarget({ kind: 'scene-color', format: 'rgba8unorm', sampleCount: 1 }),
        ],
      });

      expect(result.errors).toEqual([]);
      expect(result.plans).toHaveLength(1);
      const planned = result.plans[0];
      expect(planned).toBeDefined();
      const projected = getRenderFeaturePlanExecutionProjection(requiredFixtureValue(planned));
      expect(projected?.passes).toHaveLength(1);
      expect(projected?.passes[0]?.graphics).toMatchObject({
        draws: [],
        attachments: { colors: [{ loadOp: 'clear', storeOp: 'store' }] },
      });
    } finally {
      host.dispose();
    }
  });

  it('resolves a prepared texture view through its graph-texture alias', () => {
    let preparedTarget: unknown;
    const feature: RenderFeature<undefined> = {
      identity: 'synthetic.graph-texture-view',
      extract: () => ok(undefined),
      plan: () =>
        ok({
          work: [
            {
              scope: { view: 'main' },
              resources: [
                {
                  kind: 'graph-texture',
                  name: 'water-output',
                  allocationKey: 'water-output',
                  descriptor: {
                    format: 'rgba16float',
                    size: { width: 16, height: 16, depthOrArrayLayers: 1 },
                    sampleCount: 1,
                    dimension: '2d',
                    usage: 1,
                  },
                  view: { dimension: '2d-array', arrayLayerCount: 1 },
                },
                {
                  kind: 'prepared-gpu-resource',
                  name: 'water-output-view',
                  resource: { kind: 'texture-view', value: undefined },
                  logicalTarget: 'water-output',
                },
              ],
              passes: [],
            },
          ],
        }),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const gpuWork = {
      beginFeature: () => ({
        prepareTextureView: (_name: string, _view: unknown, target: unknown) => {
          preparedTarget = target;
          return ok({ generation: 0 });
        },
        retainResources: () => {},
        changedResourceNames: new Set<string>(),
        commitFrame: () => [],
        abortFrame: () => ok(undefined),
      }),
    } as never;
    try {
      const result = runSingleViewFeatureFrame(host, {
        world: new World(),
        frameNumber: 1,
        generation: 0,
        caps: {} as never,
        gpuWork,
      });

      expect(result.errors).toEqual([]);
      expect(result.plans).toHaveLength(1);
      expect(preparedTarget).toMatchObject({ kind: 'graph-texture', name: 'water-output' });
    } finally {
      host.dispose();
    }
  });

  it('retries registry-pending compute preparation next frame while keeping compile failures visible', () => {
    let preparationError: RenderFeaturePreparationFailedError | undefined =
      new RenderFeaturePreparationFailedError(
        'synthetic.registry-pending',
        0,
        'prepare-gpu-program',
        'pipeline',
        'simulate-program',
        'registry module is still pending',
        'next-frame',
      );
    const feature: RenderFeature<undefined> = {
      identity: 'synthetic.registry-pending',
      extract: () => ok(undefined),
      plan: () =>
        ok({
          work: [
            {
              scope: { view: 'main' },
              resources: [
                {
                  kind: 'compute-program',
                  name: 'simulate-program',
                  program: {
                    wgsl: '@compute @workgroup_size(1) fn main() {}',
                    entryPoints: ['main'],
                  },
                },
              ],
              passes: [],
            },
          ],
        }),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const gpuWork = {
      beginFeature: () => ({
        prepareProgram: () =>
          preparationError === undefined ? ok({ generation: 1 }) : err(preparationError),
        retainResources: () => {},
        commitFrame: () => [],
        abortFrame: () => ok(undefined),
        changedResourceNames: new Set(),
      }),
    } as never;
    const input = {
      world: new World(),
      generation: 1,
      caps: {} as never,
      gpuWork,
    };
    try {
      const pending = runSingleViewFeatureFrame(host, { ...input, frameNumber: 1 });
      expect(pending.preparationPending).toBe(true);
      expect(pending.errors).toEqual([]);
      expect(host.diagnostics()).toMatchObject([
        { identity: feature.identity, status: 'active', latestError: undefined },
      ]);
      expect(pending.preparationPendingReason).toMatchObject({
        featureIdentity: feature.identity,
        reason: 'registry module is still pending',
      });

      preparationError = undefined;
      const ready = runSingleViewFeatureFrame(host, { ...input, frameNumber: 2 });
      expect(ready.preparationPending).not.toBe(true);
      expect(ready.errors).toEqual([]);
      expect(host.diagnostics()).toMatchObject([
        { identity: feature.identity, status: 'active', latestError: undefined },
      ]);

      preparationError = new RenderFeaturePreparationFailedError(
        feature.identity,
        0,
        'prepare-gpu-program',
        'pipeline',
        'simulate-program',
        'shader-compile-failed: invalid workgroup declaration',
        'renderer-recover',
      );
      const failed = runSingleViewFeatureFrame(host, { ...input, frameNumber: 3 });
      expect(failed.preparationPending).not.toBe(true);
      expect(failed.errors).toEqual([preparationError]);
      expect(host.diagnostics()).toMatchObject([
        {
          identity: feature.identity,
          status: 'failed',
          latestError: {
            code: 'render-feature-preparation-failed',
            detail: { reason: 'shader-compile-failed: invalid workgroup declaration' },
          },
        },
      ]);

      preparationError = new RenderFeaturePreparationFailedError(
        feature.identity,
        0,
        'prepare-gpu-program',
        'pipeline',
        'simulate-program',
        'rhi-not-available: retired adapter',
        'renderer-recover',
      );
      const unavailable = runSingleViewFeatureFrame(host, { ...input, frameNumber: 4 });
      expect(unavailable.preparationPending).not.toBe(true);
      expect(unavailable.errors).toEqual([preparationError]);
      expect(host.diagnostics()).toMatchObject([
        {
          identity: feature.identity,
          status: 'failed',
          latestError: {
            detail: { reason: 'rhi-not-available: retired adapter' },
          },
        },
      ]);
    } finally {
      host.dispose();
    }
  });

  it('never invokes legacy producer callbacks', () => {
    const prepare = vi.fn();
    const contribute = vi.fn();
    const legacyShaped = {
      identity: 'synthetic.plan-only',
      extract: () => ok(undefined),
      plan: () => ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] }),
      prepare,
      contribute,
    };
    const feature: RenderFeature<undefined> = legacyShaped;
    const host = createRenderFeatureHost([feature]);
    expect(host.ok).toBe(true);
    if (!host.ok) return;

    const result = runSingleViewFeatureFrame(host.value, {
      world: new World(),
      frameNumber: 1,
      caps: {} as never,
    });

    expect(result.errors).toEqual([]);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).not.toHaveProperty('execution');
    expect(result.stageEvents.map((event) => event.stage)).toEqual(['extract', 'plan']);
    expect(host.value.inspection?.().signatures).toMatchObject([
      { featureIdentity: 'synthetic.plan-only', calls: 1 },
    ]);
    expect(prepare).not.toHaveBeenCalled();
    expect(contribute).not.toHaveBeenCalled();
  });
});
