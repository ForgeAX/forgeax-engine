import { isStandardPbrMaterialShader } from '../pbr-pipeline';
import { renderStateHash } from '../pipeline-spec';
import type { DispatchEntry, DispatchList } from '../render-system-extract';
import { FirstEntryMap } from './first-entry-map';
import type { ValidatedRenderable } from './frame-snapshot';

/** One row's selected material Passes, in the emitted dispatch order. */
export type MaterialPasses = FirstEntryMap<number, DispatchEntry | DispatchEntry[]>;
export interface MaterialPassLookup {
  readonly temporal: boolean;
  readonly size: number;
  get(index: number): MaterialPasses | undefined;
  keys(): IterableIterator<number>;
}

/** Exact Scene Pass context that may consume the phase's admitted groups. */
export interface PreparedGeometryMaterialPasses {
  readonly dispatch: DispatchList;
  readonly validatedOrdered: readonly ValidatedRenderable[];
  readonly ordered: boolean;
  readonly temporal: boolean;
  readonly groups: MaterialPassLookup;
}

/** Compared only within one renderable/material: omitted slots share its Surface owner. */
export function sameOpaqueTemporalDraw(a: DispatchEntry, b: DispatchEntry): boolean {
  return (
    ((isStandardPbrMaterialShader(a.materialShaderId) &&
      a.materialShaderId === b.materialShaderId) ||
      (a.tags.SurfaceKind === 'standard' &&
        b.tags.SurfaceKind === 'standard' &&
        a.tags.SurfaceModule === b.tags.SurfaceModule &&
        a.tags.GeometryVariant === b.tags.GeometryVariant)) &&
    a.renderState?.blend === undefined &&
    b.renderState?.blend === undefined &&
    a.renderState?.stencil === undefined &&
    b.renderState?.stencil === undefined &&
    a.stencilReference === b.stencilReference &&
    renderStateHash(a.renderState) === renderStateHash(b.renderState)
  );
}

export function includeMaterialPass(
  byMaterial: MaterialPasses,
  dispatch: DispatchEntry,
  temporal: boolean,
): void {
  const passes = byMaterial.get(dispatch.materialHandle);
  if (passes === undefined) byMaterial.set(dispatch.materialHandle, dispatch);
  else if (Array.isArray(passes)) {
    if (!temporal || !passes.some((previous) => sameOpaqueTemporalDraw(previous, dispatch)))
      passes.push(dispatch);
  } else if (!temporal || !sameOpaqueTemporalDraw(passes, dispatch)) {
    byMaterial.set(dispatch.materialHandle, [passes, dispatch]);
  }
}

/**
 * An actual phase member owns its emitted Pass sequence. Compact row addresses
 * and pose changes do not replace the sequence; changed entries or order do.
 */
export class MemberMaterialPasses {
  private entries: readonly DispatchEntry[] = [];
  private next: DispatchEntry[] | undefined;
  private epoch = -1;
  private count = 0;
  private groups: [MaterialPasses?, MaterialPasses?] = [];

  append(entry: DispatchEntry, epoch: number): void {
    if (this.epoch !== epoch) {
      this.epoch = epoch;
      this.count = 0;
      this.next = undefined;
    }
    if (this.next === undefined && this.entries[this.count] !== entry)
      this.next = this.entries.slice(0, this.count);
    this.next?.push(entry);
    this.count += 1;
  }

  finish(epoch: number, temporal: boolean): MaterialPasses | undefined {
    if (this.epoch !== epoch) return undefined;
    if (this.next !== undefined || this.count !== this.entries.length) {
      this.entries = this.next ?? this.entries.slice(0, this.count);
      this.next = undefined;
      this.groups = [];
    }
    const slot = temporal ? 1 : 0;
    let value = this.groups[slot];
    if (value === undefined) {
      value = new FirstEntryMap();
      for (const entry of this.entries) includeMaterialPass(value, entry, temporal);
      this.groups[slot] = value;
    }
    return value;
  }
}

/** Compact addressing changes this small table, retaining each unchanged row's groups. */
export function materialPassLookup(
  rows: readonly (MaterialPasses | undefined)[],
  offset: number,
  size: number,
  temporal: boolean,
): MaterialPassLookup {
  return {
    size,
    temporal,
    get: (index) => rows[index - offset],
    *keys() {
      for (let index = 0; index < rows.length; index++)
        if (rows[index] !== undefined) yield offset + index;
    },
  };
}
