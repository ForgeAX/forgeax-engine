import type { MaterialResource } from '../material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { MaterialFrame } from '../scene/material-dispatch';
import type { MeshFrame } from '../scene/mesh-frame';
import { effectiveMeshMaterials, meshMaterialGeometry } from '../scene/mesh-materials';

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

const EMPTY_MATERIALS = new MaterialFrame(undefined);

/** Membership comes from actual culling; later adoption visits changed shared assets only. */
export class SubsurfaceSelection {
  private readonly members = new Map<MaterialResource, SubsurfaceDemand>();
  private readonly profiles = new Map<SubsurfaceDemand, number>();
  /** Members only hidden, unprepared rows selected; the dispatch has not admitted them. */
  private readonly unadmitted = new Set<MaterialResource>();
  private frame: MaterialFrame | undefined;
  private distinct = 0;

  /**
   * A row with authored overrides draws the effective Mesh bindings the
   * material dispatch admitted, not its direct placeholder resources; pass the
   * frame's Mesh versions so membership reads the same resources.
   */
  add(
    row: Parameters<typeof effectiveMeshMaterials>[0] &
      Partial<
        Pick<
          RenderableSnapshot,
          | 'assetHandle'
          | 'skinBinding'
          | 'spriteInstances'
          | 'authorVisible'
          | 'pipelinePreparation'
        >
      >,
    materials: MaterialFrame,
    meshes?: MeshFrame,
  ): void {
    const geometry =
      row.materialOverrides === undefined || meshes === undefined
        ? undefined
        : meshes.get(row.assetHandle);
    const source =
      geometry === undefined
        ? row
        : effectiveMeshMaterials(row, geometry, meshMaterialGeometry(row));
    // The dispatch admits a row's materials only for a visible or prepared row;
    // a hidden row's binding has no accepted version until it gains that demand.
    const admitted = row.authorVisible !== false || row.pipelinePreparation !== undefined;
    // Runs per renderable each frame: no one-element array for the default slot.
    const slots = source.materials;
    if (slots.length === 0) this.addMember(source.material, materials, admitted);
    for (let index = 0; index < slots.length; index++)
      this.addMember(slots[index] as MaterialResource, materials, admitted);
  }

  private addMember(resource: MaterialResource, materials: MaterialFrame, admitted: boolean): void {
    const old = this.members.get(resource);
    if (old !== undefined) {
      // A visible row sharing a hidden row's resource makes its absence an error again.
      if (admitted && this.unadmitted.delete(resource) && materials.get(resource) === undefined)
        this.replace(resource, old, 'missing-material');
      return;
    }
    const accepted = materials.get(resource);
    if (!admitted) this.unadmitted.add(resource);
    const value =
      accepted !== undefined ? profile(accepted.snapshot) : admitted ? 'missing-material' : 0;
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
        const value =
          after === undefined && this.unadmitted.has(resource) ? 0 : profile(after?.snapshot);
        this.replace(resource, old, value);
      });
    this.frame = materials;
  }

  private replace(resource: MaterialResource, old: SubsurfaceDemand, value: SubsurfaceDemand) {
    if (old === value) return;
    this.adjust(old, -1);
    this.adjust(value, 1);
    this.members.set(resource, value);
  }

  /**
   * Membership of every accepted material, maintained from frame changes. The
   * GPU lane admits all owned rows, so its demand is material-wide.
   */
  trackAll(materials: MaterialFrame): void {
    if (this.frame === materials) return;
    materials.changesSince(this.frame ?? EMPTY_MATERIALS, (before, after) => {
      const resource = (after ?? before)?.resource;
      if (resource === undefined) return;
      const old = this.members.get(resource);
      if (old !== undefined) {
        this.adjust(old, -1);
        this.members.delete(resource);
      }
      if (after === undefined) return;
      const value = profile(after.snapshot);
      this.members.set(resource, value);
      this.adjust(value, 1);
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
