import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCER_RESERVATION_END_WORD } from '../cluster-binner';
import { inspectStandardLighting } from '../pipeline/standard-lighting/inspection';
import { LIGHT_INDEX_LIST_CAPACITY } from '../pipeline/standard-lighting/layout';
import { capStandardLocalLights } from '../pipeline/standard-lighting/local-light-cap';
import type { ViewLights } from '../world/render-lights';
import { STANDARD_CLUSTER_TEST_ABI } from './cluster-test-abi';
import {
  clusterPayload,
  fixtureCamera,
  fixtureFrameState,
  fixtureInternals,
  fixtureLights,
  hashPayload,
} from './standard-light-cap-fixture';

/**
 * Cluster payload digests for rosters within the admission cap. Disjoint
 * finite sources have an empty cell box and a canonical producer record.
 */
const UNCAPPED_DIGESTS = [
  [
    { point: 1, spot: 0, rect: 0 },
    '0970622e61b66c2ddcc77b4202a89f9fb566bc6c10083543c8374190744b53f9',
  ],
  [
    { point: 20, spot: 8, rect: 4 },
    '2aaa190f0c38d688185734227dc236879c51570010517e8fcf995f4d1173fd04',
  ],
  [
    { point: 160, spot: 64, rect: 32 },
    'd26db93675b6110858ae29d93492f31bc787d489feda8694de001f99165a0ff4',
  ],
  [
    { point: 160, spot: 64, rect: 32, range: 40 },
    '8d37fe8d7d0d12946322c478aa1db7a3238aef24f05006037c033d85c5308516',
  ],
] as const;

// In this fixture the camera has translation only. Test the six frustum planes
// directly against each light's view-space AABB, independently of cell projection.
function fixtureVisibleLights(
  payload: ReturnType<typeof clusterPayload>,
  camera = fixtureCamera(),
) {
  const slopeY = Math.tan(camera.fov / 2),
    slopeX = slopeY * camera.aspect;
  const indices = new Set<number>();
  for (const [index, light] of payload.prepared.local.entries()) {
    const radius = light.range;
    const depth = (camera.position[2] ?? 0) - (light.position[2] ?? 0);
    if (
      depth + radius >= camera.near &&
      depth - radius <= camera.far &&
      Math.abs(light.position[0] ?? 0) - radius <= (depth + radius) * slopeX &&
      Math.abs(light.position[1] ?? 0) - radius <= (depth + radius) * slopeY
    )
      indices.add(index);
  }
  return indices;
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let at = out.length - 1; at > 0; at--) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const pick = state % (at + 1);
    [out[at], out[pick]] = [out[pick] as T, out[at] as T];
  }
  return out;
}

/** The same lights in another extraction order. */
function reordered(lights: ViewLights, seed: number): ViewLights {
  return {
    ...lights,
    point: shuffled(lights.point, seed),
    spot: shuffled(lights.spot, seed + 1),
    rect: shuffled(lights.rect, seed + 2),
  };
}

function entities(lights: Pick<ViewLights, 'point' | 'spot' | 'rect'>): number[] {
  return [...lights.point, ...lights.spot, ...lights.rect].map((light) => light.entity as number);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Standard local-light cap', () => {
  it.each(UNCAPPED_DIGESTS)('keeps the uncapped Cluster payload stable (%j)', (counts, digest) => {
    const payload = clusterPayload(fixtureLights(counts));
    expect(payload.transport.admittedLightCount).toBe(payload.transport.requestedLightCount);
    expect(new Set(payload.indices)).toEqual(fixtureVisibleLights(payload));
    expect(payload.bounds[PRODUCER_RESERVATION_END_WORD]).toBe(payload.indices.length);
    // All other words retain their existing digests; this previously reserved word
    // now closes the last cell independently of the GPU-produced count.
    const legacyBounds = payload.bounds.slice();
    legacyBounds[PRODUCER_RESERVATION_END_WORD] = 0;
    expect(hashPayload({ ...payload, bounds: legacyBounds })).toBe(digest);
  });

  it('passes a roster within the limit through without copying', () => {
    const lights = fixtureLights({ point: 20, spot: 8, rect: 4 });
    const capped = capStandardLocalLights(lights, 32);
    expect(capped.dropped).toBe(0);
    expect(capped.kept).toBe(lights);
  });

  it('keeps the first N lights of the canonical order, whatever the extraction order', () => {
    const lights = fixtureLights({ point: 30, spot: 10, rect: 5 });
    // Entities are handed out point, spot, rect in order, so canonical order is ascending entity.
    const expected = entities(lights).slice(0, 32);
    for (const seed of [1, 2, 3]) {
      const capped = capStandardLocalLights(reordered(lights, seed), 32);
      expect(capped.dropped).toBe(13);
      expect(entities(capped.kept)).toEqual(expected);
    }
  });

  it('orders by kind, then world, entity index and generation', () => {
    const light = (kind: 'point' | 'spot' | 'rect', entity: number, worldId: number) =>
      ({ kind, entity, worldId }) as never;
    const generation = (index: number, gen: number) => ((gen << 24) | index) >>> 0;
    const capped = capStandardLocalLights(
      {
        point: [
          light('point', generation(5, 1), 0),
          light('point', generation(5, 0), 0),
          light('point', 1, 1),
        ],
        spot: [light('spot', 0, 0)],
        rect: [light('rect', 0, 0)],
      },
      4,
    );
    expect(entities(capped.kept)).toEqual([generation(5, 0), generation(5, 1), 1, 0]);
    expect(capped.kept.rect).toEqual([]);
  });

  it('drops the same lights from every camera', () => {
    const lights = fixtureLights({ point: 30, spot: 10, rect: 5 });
    const internals = fixtureInternals(32);
    const kept = (z: number) =>
      clusterPayload(lights, internals, fixtureFrameState(), fixtureCamera(z)).prepared.local.map(
        (light) => light.source?.entity,
      );
    expect(kept(-30)).toEqual(kept(5));
  });

  it('shades the kept lights instead of rejecting the frame, and inspects the drop', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lights = fixtureLights({ point: 30, spot: 10, rect: 5 });
    const payload = clusterPayload(lights, fixtureInternals(32));
    expect(payload.prepared.local).toHaveLength(32);
    expect(payload.transport.requestedLightCount).toBe(45);
    expect(payload.transport.admittedLightCount).toBe(32);
    const inspection = inspectStandardLighting({
      kind: 'clustered',
      prepared: payload.prepared,
      transport: payload.transport,
    });
    expect(inspection.requested).toBe(45);
    expect(inspection.admitted).toBe(32);
    expect(inspection.droppedLocalLights).toBe(13);
  });

  it('reports zero dropped lights when the roster fits', () => {
    const payload = clusterPayload(fixtureLights({ point: 20, spot: 8, rect: 4 }));
    const inspection = inspectStandardLighting({
      kind: 'clustered',
      prepared: payload.prepared,
      transport: payload.transport,
    });
    expect(inspection.droppedLocalLights).toBe(0);
  });

  it('warns once per renderer, not once per frame', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const internals = fixtureInternals(32);
    const frameState = fixtureFrameState();
    for (let frame = 0; frame < 3; frame++)
      clusterPayload(
        fixtureLights({ point: 30, spot: 10, rect: 5 }, frame + 1),
        internals,
        frameState,
      );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('45 local lights exceed the 32-light limit');
    clusterPayload(fixtureLights({ point: 30, spot: 10, rect: 5 }), internals, fixtureFrameState());
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('shades 1024 lights end to end at the default budget and drops only past it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lights = fixtureLights({ point: 700, spot: 300, rect: 24 });
    const mixed = clusterPayload(lights);
    const intersecting = fixtureVisibleLights(mixed);
    expect(intersecting.size).toBe(1010);
    expect(new Set(mixed.indices)).toEqual(intersecting);
    const full = clusterPayload(lights, fixtureInternals(), fixtureFrameState(), fixtureCamera(65));
    expect(full.prepared.local).toHaveLength(1024);
    expect(full.transport.admittedLightCount).toBe(1024);
    expect(full.prepared.droppedLocalLights ?? 0).toBe(0);
    expect(new Set(full.indices).size).toBe(1024);
    const over = clusterPayload(fixtureLights({ point: 700, spot: 300, rect: 30 }));
    expect(over.transport.requestedLightCount).toBe(1030);
    expect(over.transport.admittedLightCount).toBe(1024);
    const rects = over.prepared.local.filter((light) => light.kind === 'rect-area');
    expect(rects).toHaveLength(24);
  });

  it('caps Cluster entries at K once 1024 lights cover the whole view', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const payload = clusterPayload(fixtureLights({ point: 700, spot: 0, rect: 324, range: 1000 }));
    const cells = payload.grid.length / 2;
    expect(payload.prepared.local).toHaveLength(1024);
    expect(payload.prepared.clusterEntryCapK).toBe(Math.floor(LIGHT_INDEX_LIST_CAPACITY / cells));
    expect(payload.indices.length).toBe((payload.prepared.clusterEntryCapK as number) * cells);
  });

  it('does not warn within the limit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    clusterPayload(fixtureLights({ point: 20, spot: 8, rect: 4 }), fixtureInternals(32));
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps additional DirectionalLights out of the grid and after the binned slots', () => {
    const local = clusterPayload(fixtureLights({ point: 20, spot: 8, rect: 4 }));
    const both = clusterPayload(
      fixtureLights({ point: 20, spot: 8, rect: 4, additionalDirectional: 2 }),
    );
    // The binned part is byte-identical to the frame without directional lights.
    expect(both.grid).toEqual(local.grid);
    expect(both.indices).toEqual(local.indices);
    expect(both.bounds).toEqual(local.bounds);
    expect(both.prepared.local.slice(32).map((light) => light.kind)).toEqual([
      'directional',
      'directional',
    ]);
    const offsets = STANDARD_CLUSTER_TEST_ABI.clusterUniformOffsets;
    const uniform = new DataView(both.uniform.buffer);
    expect(uniform.getUint32(offsets.grid + 12, true)).toBe(32);
    expect(uniform.getUint32(offsets.cluster_layout + 12, true)).toBe(2);
    expect(new DataView(local.uniform.buffer).getUint32(offsets.cluster_layout + 12, true)).toBe(0);
  });

  it('does not count additional DirectionalLights toward lightCount', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const payload = clusterPayload(
      fixtureLights({ point: 20, spot: 8, rect: 4, additionalDirectional: 2 }),
      fixtureInternals(32),
    );
    expect(payload.prepared.droppedLocalLights).toBe(0);
    expect(payload.prepared.local).toHaveLength(34);
    expect(warn).not.toHaveBeenCalled();
  });

  it('bounds local lights by the slots the DirectionalLights leave free', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const payload = clusterPayload(
      fixtureLights({ point: 700, spot: 300, rect: 24, additionalDirectional: 2 }),
    );
    expect(payload.prepared.local).toHaveLength(1024);
    expect(payload.prepared.membershipLightCount).toBe(1022);
    expect(payload.prepared.droppedLocalLights).toBe(2);
  });
});
