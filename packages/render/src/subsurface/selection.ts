import type { MaterialResource } from '../material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import type { MaterialFrame } from '../scene/material-dispatch';

export type SubsurfaceDemand = number | 'invalid-values' | 'invalid-surface' | 'missing-material';

function profile(material: MaterialSnapshot | undefined): SubsurfaceDemand {
  if (material === undefined) return 'missing-material';
  const radius = material.paramSnapshot?.subsurfaceRadius ?? [0, 0, 0];
  const weight = material.paramSnapshot?.subsurfaceWeight ?? 0;
  if (
    !Array.isArray(radius) ||
    radius.length !== 3 ||
    radius.some((n) => !Number.isFinite(n) || n < 0 || n > 12) ||
    typeof weight !== 'number' ||
    !Number.isFinite(weight) ||
    weight < 0 ||
    weight > 1
  )
    return 'invalid-values';
  const rgb = radius.map((r) => Math.round((r * 255) / 12));
  const key = (rgb[0] ?? 0) | ((rgb[1] ?? 0) << 8) | ((rgb[2] ?? 0) << 16);
  if (Math.round(weight * 255) === 0 || key === 0) return 0;
  if (
    material.deferredPass !== true ||
    material.surfaceModel !== 'standard' ||
    material.renderState?.blend !== undefined ||
    material.renderState?.depthWriteEnabled === false
  )
    return 'invalid-surface';
  return key;
}

/** Membership comes from actual culling; later adoption visits changed shared assets only. */
export class SubsurfaceSelection {
  private readonly members = new Map<MaterialResource, SubsurfaceDemand>();
  private readonly profiles = new Map<SubsurfaceDemand, number>();
  private frame: MaterialFrame | undefined;
  private distinct = 0;

  add(source: Pick<RenderableSnapshot, 'material' | 'materials'>, materials: MaterialFrame): void {
    // Runs per renderable each frame: no one-element array for the default slot.
    const slots = source.materials;
    if (slots.length === 0) this.addMember(source.material, materials);
    for (let index = 0; index < slots.length; index++)
      this.addMember(slots[index] as MaterialResource, materials);
  }

  private addMember(resource: MaterialResource, materials: MaterialFrame): void {
    if (this.members.has(resource)) return;
    const value = profile(materials.get(resource)?.snapshot);
    this.members.set(resource, value);
    this.adjust(value, 1);
  }

  adopt(materials: MaterialFrame): void {
    if (this.frame === materials) return;
    if (this.frame !== undefined)
      materials.changesSince(this.frame, (before, after) => {
        const resource = (after ?? before)?.resource;
        if (resource === undefined) return;
        const old = this.members.get(resource);
        if (old === undefined) return;
        const value = profile(after?.snapshot);
        if (old === value) return;
        this.adjust(old, -1);
        this.adjust(value, 1);
        this.members.set(resource, value);
      });
    this.frame = materials;
  }

  /** A scalar result cannot change when this selection adopts a later frame. */
  get demand(): SubsurfaceDemand {
    if (this.profiles.has('missing-material')) return 'missing-material';
    if (this.profiles.has('invalid-values')) return 'invalid-values';
    if (this.profiles.has('invalid-surface')) return 'invalid-surface';
    return this.distinct;
  }

  private adjust(value: SubsurfaceDemand, delta: number): void {
    if (value === 0) return;
    const old = this.profiles.get(value) ?? 0;
    const next = old + delta;
    if (next === 0) this.profiles.delete(value);
    else this.profiles.set(value, next);
    if (typeof value === 'number') this.distinct += Number(old === 0) - Number(next === 0);
  }
}
