import { runtimeMaterialShaderId } from '@forgeax/engine-assets-runtime';
import type { MaterialPass } from '@forgeax/engine-types';
import type { MaterialSnapshot } from './render-system-extract';

// A fixed value fact belongs to the snapshot, independently of its latest resource.
// Borrowed snapshots keep the original direct resource entry.
type SnapshotEntry = MaterialResource | { resource: MaterialResource | undefined };
const resources = new WeakMap<MaterialSnapshot, SnapshotEntry>();

export function captureMaterialSnapshot(snapshot: MaterialSnapshot): MaterialSnapshot {
  const captured = Object.freeze({ ...snapshot, immutableValues: true as const });
  resources.set(captured, { resource: undefined });
  return captured;
}

/** One renderer's accepted shared material. Entity bindings retain this identity. */
export class MaterialResource {
  private current: MaterialSnapshot;
  private fixedValues: MaterialSnapshot | undefined;

  static from(snapshot: MaterialSnapshot): MaterialResource {
    return materialResource(snapshot) ?? new MaterialResource(snapshot);
  }

  constructor(snapshot: MaterialSnapshot) {
    this.current = snapshot;
    this.fixedValues = this.recordSnapshot(snapshot, false) ? snapshot : undefined;
  }

  get snapshot(): MaterialSnapshot {
    return this.current;
  }

  ownsValues(snapshot: MaterialSnapshot): boolean {
    return this.fixedValues === snapshot;
  }

  /** Called by material preparation at the renderer's adoption boundary. */
  adopt(snapshot: MaterialSnapshot): void {
    this.replace(snapshot, false);
  }

  /** The program owner changes schema/entry reads while retaining the same value subtree. */
  adoptProgramSnapshot(snapshot: MaterialSnapshot): void {
    this.replace(snapshot, this.fixedValues === this.current);
  }

  private replace(snapshot: MaterialSnapshot, valuesOwned: boolean): void {
    this.current = snapshot;
    this.fixedValues = this.recordSnapshot(snapshot, valuesOwned) ? snapshot : undefined;
  }

  private recordSnapshot(snapshot: MaterialSnapshot, valuesOwned: boolean): boolean {
    const entry = resources.get(snapshot);
    if (entry !== undefined && !(entry instanceof MaterialResource)) {
      entry.resource = this;
      return true;
    }
    resources.set(snapshot, valuesOwned ? { resource: this } : this);
    return valuesOwned;
  }
}

export function materialResource(snapshot: MaterialSnapshot): MaterialResource | undefined {
  const entry = resources.get(snapshot);
  return entry instanceof MaterialResource ? entry : entry?.resource;
}

/** Ownership inspection never invokes a borrowed getter or rejects a proxy's input. */
export function ownedMaterialValues(snapshot: MaterialSnapshot): boolean {
  try {
    return Object.getOwnPropertyDescriptor(snapshot, 'immutableValues')?.value === true;
  } catch {
    return false;
  }
}

export function runtimeMaterialShaderIdForMaterial(
  passes: readonly MaterialPass[],
  programs: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const pass =
    passes.find(
      (pass) =>
        !/shadow|depth/i.test(
          String(
            (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode ?? pass.name,
          ),
        ),
    ) ?? passes[0];
  if (pass === undefined) return undefined;
  return programs === undefined
    ? runtimeMaterialShaderId(pass.program.module, pass.name)
    : programs[pass.name];
}

/** Sprite geometry follows the immutable author program, independent of cooked IDs. */
export function materialUsesSpriteGeometry(material: Pick<MaterialSnapshot, 'passes'>): boolean {
  const shader = runtimeMaterialShaderIdForMaterial(material.passes, undefined);
  return shader === 'forgeax::sprite' || shader === 'forgeax::sprite-lit';
}
