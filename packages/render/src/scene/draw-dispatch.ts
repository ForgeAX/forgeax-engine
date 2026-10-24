import type { ValidatedRenderable } from '../record/frame-snapshot';
import type { DispatchList } from '../render-system-extract';
import type { MaterialFrame } from './material-dispatch';

/**
 * A direct dispatch depends only on each row's identity, layer, caster flag,
 * index and selected material resources within one fixed MaterialFrame. Rows of
 * moving entities keep these facts while their snapshots change every frame.
 * Active frame consumers own the output; this cache must not pin old row sets.
 */
const projectedDispatches = new WeakMap<
  MaterialFrame,
  { facts: unknown[]; value: WeakRef<DispatchList> }[]
>();

function directDispatchFacts(draws: readonly ValidatedRenderable[]): unknown[] {
  const facts: unknown[] = [];
  for (const draw of draws) {
    const source = draw.source;
    facts.push(
      source.worldId,
      source.entityKey,
      source.layer ?? 0,
      source.shadowCaster !== false,
      draw.renderableIndex,
    );
    const indices = draw.submeshIndices ?? [...draw.mesh.submeshes.keys()];
    facts.push(indices.length);
    for (const index of indices) {
      const submesh = draw.mesh.submeshes[index];
      facts.push(
        submesh === undefined
          ? undefined
          : (source.materials[submesh.materialSlot] ?? source.material),
      );
    }
  }
  return facts;
}

function sameFacts(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

export function projectDrawDispatch(
  draws: readonly ValidatedRenderable[],
  materials: MaterialFrame,
): DispatchList {
  const facts = directDispatchFacts(draws);
  let retained = projectedDispatches.get(materials);
  const hit = retained?.find((entry) => sameFacts(entry.facts, facts));
  const cached = hit?.value.deref();
  if (cached !== undefined) return cached;
  const value = projectFreshDrawDispatch(draws, materials);
  if (hit !== undefined) {
    hit.value = new WeakRef(value);
    return value;
  }
  if (retained === undefined) {
    retained = [];
    projectedDispatches.set(materials, retained);
  }
  // Each scene pass projects its own row set; keep a small bounded roster.
  if (retained.length >= 8) retained.shift();
  retained.push({ facts, value: new WeakRef(value) });
  return value;
}

function projectFreshDrawDispatch(
  draws: readonly ValidatedRenderable[],
  materials: MaterialFrame,
): DispatchList {
  return materials.project(
    draws.map((draw) => {
      return {
        source: draw.source,
        renderableIndex: draw.renderableIndex,
        materials: [...(draw.submeshIndices ?? draw.mesh.submeshes.keys())].map((index) => {
          const submesh = draw.mesh.submeshes[index];
          if (submesh === undefined) throw new Error('Direct draw has no selected submesh');
          return draw.source.materials[submesh.materialSlot] ?? draw.source.material;
        }),
      };
    }),
  );
}
