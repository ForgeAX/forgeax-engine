import type { ReflectionProbeTable } from '../reflection/gpu-table';
import type { ReflectionProbeSelectionResult } from '../reflection/projection';

export const EMPTY_MATERIAL_BINDINGS: ReadonlyMap<string, string> = new Map();

/** Probe selection is an object fact; no material values participate in this projection. */
export class ReflectionProbeBindingProjection {
  private selections: ReadonlyMap<string, ReflectionProbeSelectionResult> | undefined;
  private indices = '';
  private value: ReadonlyMap<string, string> = EMPTY_MATERIAL_BINDINGS;

  project(
    selections: ReadonlyMap<string, ReflectionProbeSelectionResult>,
    table: ReflectionProbeTable,
  ): ReadonlyMap<string, string> {
    // Only resident probe addresses affect binding classes, not texture generations or shading.
    const indices = JSON.stringify(table.rows.map((row) => [row.primitiveKey, row.index]));
    if (this.selections === selections && this.indices === indices) return this.value;
    const classes = new Map<string, string>();
    if (table.rows.length > 0) {
      for (const [key, selection] of selections) {
        if (selection.kind !== 'probe') continue;
        const index = table.cpuIndexByPrimitive(`${selection.worldId}:${selection.entityKey}`);
        if (index !== undefined) classes.set(key, `probe:${index}`);
      }
    }
    this.value = classes.size === 0 ? EMPTY_MATERIAL_BINDINGS : classes;
    this.selections = selections;
    this.indices = indices;
    return this.value;
  }
}
