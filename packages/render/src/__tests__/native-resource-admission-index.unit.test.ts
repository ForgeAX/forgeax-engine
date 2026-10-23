import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  createNativeResourceAdmission,
  createPreparedResourceMaps,
} from '../features/native-resource-admission';
import type { RenderFeatureResourceDeclaration } from '../features/plan';
import type {
  RenderFeatureGpuBufferRef,
  RenderFeatureGpuPrepareSession,
} from '../features/prepared-gpu-work';

const buffer = (name: string): RenderFeatureResourceDeclaration =>
  ({ kind: 'buffer', name, size: 16, usage: ['storage'] }) as RenderFeatureResourceDeclaration;
const ref = (name: string, generation = 0) => ({ name, generation }) as RenderFeatureGpuBufferRef;

function session() {
  return {
    captureResourceDomain: () => ok({}),
    retainResourceDomain: vi.fn(() => ok(true)),
    prepareProgram: () => ok({}),
    writeBuffer: () => ok(undefined),
  } as unknown as RenderFeatureGpuPrepareSession;
}

function admission(gpu: RenderFeatureGpuPrepareSession, frame: number, refs: Map<string, unknown>) {
  const prepare = vi.fn((resources: readonly RenderFeatureResourceDeclaration[]) => {
    const prepared = createPreparedResourceMaps();
    for (const resource of resources)
      (prepared.buffers as Map<string, unknown>).set(resource.name, refs.get(resource.name));
    return ok(prepared);
  });
  return {
    ...createNativeResourceAdmission({ gpu, frame, isActive: () => true, prepare }),
    prepare,
  };
}

it('indexes a retained domain once and resolves it only while it is retained', () => {
  const gpu = session();
  const first = ref('state');
  const one = admission(gpu, 1, new Map([['state', first]]));
  const domain = one.admission.admit('frame', [buffer('state')]);
  expect(one.prepared('frame')?.buffers.get('state')).toBe(first);
  [...one.usedScopes()];

  const two = admission(gpu, 2, new Map());
  expect(two.prepared('frame')).toBeUndefined();
  expect(two.admission.retain('frame', domain)).toBe(true);
  expect(two.prepare).not.toHaveBeenCalled();
  expect(two.prepared('frame')?.buffers.get('state')).toBe(first);

  // A frame that does not retain the domain cannot observe its names.
  const three = admission(gpu, 3, new Map());
  three.admission.program('frame', 'unrelated', { wgsl: 'x', entryPoints: ['main'] });
  expect(three.prepared('frame')?.buffers.get('state')).toBeUndefined();
  // Pruned after a frame without it; retaining again re-indexes the same refs.
  const four = admission(gpu, 4, new Map());
  expect(four.admission.retain('frame', domain)).toBe(true);
  expect(four.prepared('frame')?.buffers.get('state')).toBe(first);
});

it('keeps separate admissions of one frame on their own references', () => {
  const gpu = session();
  const a = admission(gpu, 1, new Map([['state', ref('state', 1)]]));
  const b = admission(gpu, 1, new Map([['state', ref('state', 2)]]));
  a.admission.admit('frame', [buffer('state')]);
  b.admission.admit('frame', [buffer('state')]);
  expect((a.prepared('frame')?.buffers.get('state') as { generation: number }).generation).toBe(1);
  expect((b.prepared('frame')?.buffers.get('state') as { generation: number }).generation).toBe(2);
});

it('shares an identical name between domains and rejects a different live reference', () => {
  const gpu = session();
  const shared = ref('program-buffer');
  const one = admission(gpu, 1, new Map([['program-buffer', shared]]));
  const left = one.admission.admit('frame', [buffer('program-buffer')]);
  const right = one.admission.admit('frame', [buffer('program-buffer')]);
  const two = admission(gpu, 2, new Map());
  expect(two.admission.retain('frame', right)).toBe(true);
  expect(two.prepared('frame')?.buffers.get('program-buffer')).toBe(shared);
  const three = admission(gpu, 3, new Map([['program-buffer', ref('program-buffer', 9)]]));
  expect(three.admission.retain('frame', left)).toBe(true);
  expect(() => three.admission.admit('frame', [buffer('program-buffer')])).toThrow(
    /replaces an active name/,
  );
});
