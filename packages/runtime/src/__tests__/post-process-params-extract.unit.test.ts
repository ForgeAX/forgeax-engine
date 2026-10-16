// post-process-params-extract.unit.test.ts — red-phase unit test for
// extract-stage PostProcessParams snapshot collection (M-A1 / w3).
//
// AC-A4 three-consumer point 2: the extract collection point builds a
// `Map<string, AllowSharedBufferSource>` snapshot (via Uint8Array views
// from the ECS 'buffer' vocab).
// Plan-strategy D-1: extract phase iterates PostProcessParams entities,
// collects into Map<shaderId, AllowSharedBufferSource>.

import { World } from '@forgeax/engine-ecs';
import { PostProcessParams } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';

describe('extractFrame PostProcessParams snapshot collection', () => {
  it('should contain postProcessParams empty map when no PostProcessParams entities exist', () => {
    const world = new World();
    const frame = extractFrame(world, prepareExtractContext(world));
    expect(frame.postProcessParams).toBeDefined();
    expect(frame.postProcessParams.size).toBe(0);
  });

  it('should collect a single PostProcessParams entity into the snapshot map', () => {
    const world = new World();
    const bytes = new Uint8Array(16);
    world.spawn({
      component: PostProcessParams,
      data: { shader: 'forgeax::tonemap', data: bytes },
    });
    const frame = extractFrame(world, prepareExtractContext(world));
    expect(frame.postProcessParams.size).toBe(1);
    expect(frame.postProcessParams.has('forgeax::tonemap')).toBe(true);
    const collected = frame.postProcessParams.get('forgeax::tonemap');
    expect(collected).toBeInstanceOf(Uint8Array);
    expect(collected?.length).toBe(16);
  });

  it('should collect multiple shader ids in parallel', () => {
    const world = new World();
    const bytesA = new Uint8Array([10, 20]);
    const bytesB = new Uint8Array([30, 40, 50, 60]);
    world.spawn({
      component: PostProcessParams,
      data: { shader: 'forgeax::tonemap', data: bytesA },
    });
    world.spawn({
      component: PostProcessParams,
      data: { shader: 'mypkg::vignette', data: bytesB },
    });
    const frame = extractFrame(world, prepareExtractContext(world));
    expect(frame.postProcessParams.size).toBe(2);
    expect(frame.postProcessParams.has('forgeax::tonemap')).toBe(true);
    expect(frame.postProcessParams.has('mypkg::vignette')).toBe(true);
    const a = frame.postProcessParams.get('forgeax::tonemap');
    const b = frame.postProcessParams.get('mypkg::vignette');
    expect([...(a ?? new Uint8Array(0))]).toEqual([10, 20]);
    expect([...(b ?? new Uint8Array(0))]).toEqual([30, 40, 50, 60]);
  });

  it('should use last-one-wins when same shader id exists on multiple entities', () => {
    const world = new World();
    world.spawn({
      component: PostProcessParams,
      data: { shader: 'forgeax::tonemap', data: new Uint8Array([1, 2]) },
    });
    world.spawn({
      component: PostProcessParams,
      data: { shader: 'forgeax::tonemap', data: new Uint8Array([3, 4, 5]) },
    });
    const frame = extractFrame(world, prepareExtractContext(world));
    expect(frame.postProcessParams.size).toBe(1);
    const collected = frame.postProcessParams.get('forgeax::tonemap');
    expect(collected).toBeDefined();
    expect([...(collected ?? new Uint8Array(0))]).toEqual([3, 4, 5]);
  });

  it('should collect multiple independent shaders with distinct data', () => {
    const world = new World();
    world.spawn({
      component: PostProcessParams,
      data: { shader: 's1', data: new Uint8Array([0]) },
    });
    world.spawn({
      component: PostProcessParams,
      data: { shader: 's2', data: new Uint8Array([1]) },
    });
    world.spawn({
      component: PostProcessParams,
      data: { shader: 's3', data: new Uint8Array([2]) },
    });
    const frame = extractFrame(world, prepareExtractContext(world));
    expect(frame.postProcessParams.size).toBe(3);
    expect(frame.postProcessParams.get('s1')?.[0]).toBe(0);
    expect(frame.postProcessParams.get('s2')?.[0]).toBe(1);
    expect(frame.postProcessParams.get('s3')?.[0]).toBe(2);
  });
});
