import { ShadowClaimTable } from '../src/gpu-driven/shadow-claims';
import { worldEntityKey } from '../src/record/frame-snapshot';
import type { RenderableSnapshot, ShadowCasterMembership } from '../src/render-system-extract';
import type { PersistentGpuDrivenState } from '../src/scene/render-scene';
type Slot = PersistentGpuDrivenState['slots'][number];
export const modes = [
  'stable',
  'new-snapshots',
  'membership-rebuild',
  'mixed-misses',
  'many-draws',
  'many-draws-rebuild',
  'wide-draws',
  'wide-draws-rebuild',
] as const;
export function createCase(mode: (typeof modes)[number]) {
  const wide = mode.startsWith('wide-draws');
  const many = mode.startsWith('many-draws');
  const count = wide ? 1 : many ? 24 : 775,
    drawsPerEntity = wide ? 1024 : many ? 64 : 2;
  const membership: ShadowCasterMembership[] = [];
  const slots: Slot[] = [];
  for (let e = 0; e < count; e++) {
    const worldId = e % 3,
      entityKey = Math.floor(e / 3) + 1;
    const materials = Array.from({ length: drawsPerEntity }, (_, d) => ({
      materialHandle: 20 + (d % 3),
    }));
    const draws = materials.map((_, d) => ({ drawItemIndex: d * 3 + 1, materialSlot: d }));
    const snapshot = {
      worldId,
      entityKey,
      materials,
      material: materials[0],
      gpuDrivenDraws: draws,
    } as unknown as RenderableSnapshot;
    slots.push({ slot: e, generation: 0, snapshot } as Slot);
    for (let d = 0; d < drawsPerEntity; d++)
      membership.push({
        worldEntity: worldEntityKey(worldId, entityKey),
        renderableIndex: e,
        materialHandle: 20 + (d % 3),
        drawItemIndex: d * 3 + 1,
        passIndex: 1,
        gpuDrivenEligible: true,
        renderState: { cullMode: 'back' },
      } as ShadowCasterMembership);
  }
  if (mode === 'mixed-misses')
    for (let e = 0; e < count; e += 4) {
      const snapshot = slots[e]!.snapshot;
      slots[e] = {
        ...slots[e]!,
        snapshot: {
          ...snapshot,
          materials: snapshot.materials.map((m) => ({ ...m, materialHandle: 120 })),
        },
      };
    }
  const candidates = Array.from({ length: drawsPerEntity }, (_, d) => ({
    drawItemIndex: d * 3 + 1,
  }));
  let table = new ShadowClaimTable(undefined, membership);
  const rebuilt = mode.endsWith('rebuild');
  const newSnapshots =
    mode === 'new-snapshots' ||
    mode === 'mixed-misses' ||
    mode === 'many-draws' ||
    mode === 'wide-draws';
  let calls = 0,
    builds = 1,
    refreshed = 0;
  return {
    run(iterations: number) {
      let checksum = 0;
      for (let f = 0; f < iterations; f++) {
        if (rebuilt) {
          table = new ShadowClaimTable(undefined, membership);
          builds++;
        }
        for (const original of slots) {
          const slot = newSnapshots
            ? { ...original, snapshot: { ...original.snapshot } }
            : original;
          if (newSnapshots) refreshed++;
          for (const candidate of candidates) {
            const c = table.claim(slot, candidate);
            checksum += c.keys.length + (c.compatible ? 1 : 0);
            calls++;
          }
        }
      }
      return checksum;
    },
    retainTables: (count: number) =>
      Array.from({ length: count }, () => new ShadowClaimTable(undefined, membership)),
    inspect: () => ({ calls, builds, refreshed }),
    shape: () => ({
      keys: [...(table.casterKeys ?? [])],
      claims: slots.flatMap((s) => candidates.map((c) => table.claim(s, c))),
    }),
  };
}
