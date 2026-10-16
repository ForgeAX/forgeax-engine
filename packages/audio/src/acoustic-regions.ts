import { defineComponent, type World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { GlobalTransform } from '@forgeax/engine-scene';
import { type AudioError, ok, type Result } from '@forgeax/engine-types';
import {
  type AcousticEnvironment,
  type AcousticParameter,
  type AcousticRoutes,
  acousticFailure,
  validateAcousticEnvironment,
  validateAcousticRoutes,
} from './acoustic-controls';
import type { AudioBackend } from './audio-backend';
import { AudioListener, AudioSource } from './components';

/** Ordinary SceneAsset fields; no physics trigger or second asset registry. */
export const AcousticShapeValue = { box: 0, sphere: 1 } as const;
export const AcousticRegion = defineComponent('AcousticRegion', {
  enabled: { type: 'bool', default: true },
  shape: { type: 'enum', default: AcousticShapeValue.box, labels: AcousticShapeValue },
  halfExtents: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
  radius: { type: 'f32', default: 1 },
  priority: { type: 'i32', default: 0 },
  blendDistance: { type: 'f32', default: 0.25 },
  sourceBus: { type: 'string', default: '' },
  listenerWetBus: { type: 'string', default: '' },
  wet: { type: 'f32', default: 1 },
  listenerSendBus: { type: 'string', default: '' },
  listenerSendTarget: { type: 'string', default: '' },
  sendGain: { type: 'f32', default: 1 },
});

interface Region {
  readonly entity: number;
  readonly fingerprint: string;
  readonly inverse: mat4.Mat4;
  readonly shape: number;
  readonly halfExtents: readonly number[];
  readonly radius: number;
  readonly priority: number;
  readonly blendDistance: number;
  readonly sourceBus: string;
  readonly listenerWetBus: string;
  readonly wet: number;
  readonly listenerSendBus: string;
  readonly listenerSendTarget: string;
  readonly sendGain: number;
}

const FALLBACK: AcousticRoutes = { fallback: 1, buses: [] };

function weight(region: Region, x: number, y: number, z: number): number {
  const m = region.inverse;
  const lx = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
  const ly = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
  const lz = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0);
  const depth =
    region.shape === AcousticShapeValue.sphere
      ? region.radius - Math.hypot(lx, ly, lz)
      : Math.min(
          (region.halfExtents[0] ?? 0) - Math.abs(lx),
          (region.halfExtents[1] ?? 0) - Math.abs(ly),
          (region.halfExtents[2] ?? 0) - Math.abs(lz),
        );
  return region.blendDistance === 0
    ? depth >= 0
      ? 1
      : 0
    : Math.max(0, Math.min(1, depth / region.blendDistance));
}

function select(
  regions: readonly Region[],
  x: number,
  y: number,
  z: number,
  listener: boolean,
): { region: Region; weight: number }[] {
  let priority = -Infinity;
  const selected: { region: Region; weight: number }[] = [];
  for (const region of regions) {
    if (listener ? !region.listenerWetBus && !region.listenerSendBus : !region.sourceBus) continue;
    if (region.priority < priority) continue;
    const amount = weight(region, x, y, z);
    if (amount <= 0) continue;
    if (region.priority > priority) {
      selected.length = 0;
      priority = region.priority;
    }
    selected.push({ region, weight: amount });
  }
  const divisor = Math.max(
    1,
    selected.reduce((sum, r) => sum + r.weight, 0),
  );
  for (const item of selected) item.weight /= divisor;
  return selected;
}

function routesAt(regions: readonly Region[], matrix: Float32Array | undefined): AcousticRoutes {
  const selected = select(regions, matrix?.[12] ?? 0, matrix?.[13] ?? 0, matrix?.[14] ?? 0, false);
  if (!selected.length) return FALLBACK;
  const buses = new Map<string, number>();
  for (const { region, weight } of selected)
    buses.set(region.sourceBus, (buses.get(region.sourceBus) ?? 0) + weight);
  return {
    fallback: Math.max(0, 1 - selected.reduce((sum, r) => sum + r.weight, 0)),
    buses: [...buses].sort(([a], [b]) => a.localeCompare(b)).map(([bus, gain]) => ({ bus, gain })),
  };
}

function environmentAt(
  regions: readonly Region[],
  matrix: Float32Array | undefined,
): AcousticEnvironment[] {
  if (!matrix) return [];
  const selected = select(regions, matrix[12] ?? 0, matrix[13] ?? 0, matrix[14] ?? 0, true);
  const buses = new Map<
    string,
    { wet?: { weight: number; sum: number }; sends: Map<string, { weight: number; sum: number }> }
  >();
  const bus = (id: string) => {
    let entry = buses.get(id);
    if (!entry) {
      entry = { sends: new Map() };
      buses.set(id, entry);
    }
    return entry;
  };
  for (const { region, weight } of selected) {
    if (region.listenerWetBus) {
      const entry = bus(region.listenerWetBus);
      entry.wet ??= { weight: 0, sum: 0 };
      entry.wet.weight += weight;
      entry.wet.sum += weight * region.wet;
    }
    if (region.listenerSendBus) {
      const entry = bus(region.listenerSendBus);
      const send = entry.sends.get(region.listenerSendTarget) ?? { weight: 0, sum: 0 };
      send.weight += weight;
      send.sum += weight * region.sendGain;
      entry.sends.set(region.listenerSendTarget, send);
    }
  }
  const parameter = (p: { weight: number; sum: number }): AcousticParameter => ({
    weight: p.weight,
    value: p.sum / p.weight,
  });
  return [...buses]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, entry]) => ({
      bus: id,
      ...(entry.wet ? { wet: parameter(entry.wet) } : {}),
      sends: [...entry.sends]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([target, gain]) => ({ target, gain: parameter(gain) })),
    }));
}

/** Per-World projection. Unchanged fields/poses produce no control publications. */
export function createAcousticRegionSystem() {
  let regions = new Map<number, Region>();
  const previous = new Map<number, string>();
  let environment = '[]';
  return {
    reset(backend: AudioBackend): void {
      for (const entity of previous.keys()) backend.setAcousticRoutes(entity, FALLBACK);
      if (environment !== '[]') backend.setAcousticEnvironment([]);
      previous.clear();
      regions.clear();
      environment = '[]';
    },
    update(world: World, backend: AudioBackend): Result<void, AudioError> {
      const next = new Map<number, Region>();
      const query = world.query({ read: [AcousticRegion], optional: [GlobalTransform] });
      if (!query.ok) return acousticFailure('region query unavailable');
      for (const row of query.value) {
        const data = row.get(AcousticRegion);
        if (!data.enabled) continue;
        if (next.size >= 128) return acousticFailure('at most 128 enabled regions per World');
        const matrix = row.get(GlobalTransform)?.world;
        if (
          !matrix ||
          matrix.length !== 16 ||
          ![...matrix].every(Number.isFinite) ||
          matrix[3] !== 0 ||
          matrix[7] !== 0 ||
          matrix[11] !== 0 ||
          matrix[15] !== 1
        )
          return acousticFailure('region requires a finite affine propagated Transform');
        const determinant =
          (matrix[0] ?? 0) *
            ((matrix[5] ?? 0) * (matrix[10] ?? 0) - (matrix[9] ?? 0) * (matrix[6] ?? 0)) -
          (matrix[4] ?? 0) *
            ((matrix[1] ?? 0) * (matrix[10] ?? 0) - (matrix[9] ?? 0) * (matrix[2] ?? 0)) +
          (matrix[8] ?? 0) *
            ((matrix[1] ?? 0) * (matrix[6] ?? 0) - (matrix[5] ?? 0) * (matrix[2] ?? 0));
        if (
          Math.abs(determinant) <= 1e-8 ||
          !Object.values(AcousticShapeValue).includes(data.shape as 0 | 1) ||
          ![...data.halfExtents, data.radius].every((n) => Number.isFinite(n) && n > 0) ||
          !Number.isFinite(data.blendDistance) ||
          data.blendDistance < 0 ||
          !Number.isFinite(data.wet) ||
          data.wet < 0 ||
          data.wet > 1 ||
          !Number.isFinite(data.sendGain) ||
          data.sendGain < 0 ||
          [data.sourceBus, data.listenerWetBus, data.listenerSendBus, data.listenerSendTarget].some(
            (s) => s.length > 128,
          ) ||
          !!data.listenerSendBus !== !!data.listenerSendTarget
        )
          return acousticFailure(
            'invalid region shape, dimensions, transform or wet/send declaration',
          );
        const fields = {
          shape: data.shape,
          halfExtents: [...data.halfExtents],
          radius: data.radius,
          priority: data.priority,
          blendDistance: data.blendDistance,
          sourceBus: data.sourceBus,
          listenerWetBus: data.listenerWetBus,
          wet: data.wet,
          listenerSendBus: data.listenerSendBus,
          listenerSendTarget: data.listenerSendTarget,
          sendGain: data.sendGain,
        };
        const fingerprint = JSON.stringify([fields, [...matrix]]);
        const cached = regions.get(row.entity);
        if (cached?.fingerprint === fingerprint) next.set(row.entity, cached);
        else {
          const inverse = mat4.invert(mat4.create(), matrix);
          if (!inverse.every(Number.isFinite))
            return acousticFailure('region inverse must fit the finite native float range');
          next.set(row.entity, { ...fields, entity: row.entity, fingerprint, inverse });
        }
      }
      const ordered = [...next.values()].sort((a, b) => a.entity - b.entity);
      if (!ordered.length && !previous.size && environment === '[]') {
        regions = next;
        return ok(undefined);
      }
      const sources = world.query({ read: [AudioSource], optional: [GlobalTransform] });
      if (!sources.ok) return acousticFailure('source query unavailable');
      const requests: { entity: number; routes: AcousticRoutes; fingerprint: string }[] = [];
      const alive = new Set<number>();
      for (const row of sources.value) {
        if (!row.get(AudioSource).playing) continue;
        if (ordered.length && alive.size >= 256)
          return acousticFailure('at most 256 playing regional sources per World');
        alive.add(row.entity);
        const routes = routesAt(ordered, row.get(GlobalTransform)?.world);
        const fingerprint = JSON.stringify(routes);
        if (
          previous.get(row.entity) !== fingerprint &&
          (previous.has(row.entity) || routes !== FALLBACK)
        )
          requests.push({ entity: row.entity, routes, fingerprint });
      }
      let listenerMatrix: Float32Array | undefined;
      const listeners = world.query({ read: [GlobalTransform], with: [AudioListener] });
      if (listeners.ok)
        for (const row of listeners.value) {
          listenerMatrix = row.get(GlobalTransform).world;
          break;
        }
      const env = environmentAt(ordered, listenerMatrix);
      for (const request of requests) {
        const valid = validateAcousticRoutes(request.routes);
        if (!valid.ok) return valid;
      }
      const validEnvironment = validateAcousticEnvironment(env);
      if (!validEnvironment.ok) return validEnvironment;
      const envFingerprint = JSON.stringify(env);
      regions = next;
      for (const request of requests) {
        backend.setAcousticRoutes(request.entity, request.routes);
        if (request.routes === FALLBACK) previous.delete(request.entity);
        else previous.set(request.entity, request.fingerprint);
      }
      if (environment !== envFingerprint) {
        backend.setAcousticEnvironment(env);
        environment = envFingerprint;
      }
      for (const id of previous.keys()) if (!alive.has(id)) previous.delete(id);
      return ok(undefined);
    },
  };
}
