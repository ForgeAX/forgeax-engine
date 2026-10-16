import { resolveReflectionProbeBinding } from '../record/frame-lighting';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import type { ReflectionProbeRecordState } from '../record/render-context';
import type { RenderableSnapshot } from '../render-system-extract';

const mapHas = Map.prototype.has;
const mapGet = Map.prototype.get;
const mapIterator = Map.prototype[Symbol.iterator];
const mapForEach = Map.prototype.forEach;
const stringify = JSON.stringify;

/** null is an empty ordinary domain; undefined requires consumed-value checks.
 * Other inputs retain their complete serialization observation as a string.
 */
export function materialBindingSignature(
  classes: ReadonlyMap<string, string> | undefined,
): string | null | undefined {
  if (classes === undefined) return null;
  let ordinary = false;
  try {
    // Intrinsic brand checking does not invoke a Proxy or caller method.
    mapHas.call(classes, undefined as unknown as string);
    ordinary =
      Object.getPrototypeOf(classes) === Map.prototype &&
      Reflect.ownKeys(classes).length === 0 &&
      Object.getOwnPropertyDescriptor(Map.prototype, 'get')?.value === mapGet &&
      Object.getOwnPropertyDescriptor(Map.prototype, Symbol.iterator)?.value === mapIterator &&
      !('toJSON' in Array.prototype) &&
      JSON.stringify === stringify;
  } catch {
    // The original iterator remains the authority for unknown inputs and errors.
  }
  let empty = true;
  if (ordinary) {
    mapForEach.call(classes, (value, key) => {
      empty = false;
      if (typeof key !== 'string' || typeof value !== 'string') ordinary = false;
    });
  }
  return ordinary ? (empty ? null : undefined) : `${JSON.stringify([...classes])}`;
}

export function materialBindingKey(
  source: Pick<RenderableSnapshot, 'worldId' | 'entityKey'>,
  handle: number,
): string {
  return `${source.worldId}:${source.entityKey}:${handle}`;
}

/** Per-object bindings and pass membership are part of an indirect batch's resource identity. */
export function projectMaterialBindingClasses(
  rows: readonly Pick<ValidatedRenderable, 'source'>[],
  probes?: Pick<ReflectionProbeRecordState, 'selections' | 'table'>,
): ReadonlyMap<string, string> {
  const classes = new Map<string, string>();
  for (const row of rows) {
    const selection = probes?.selections.get(`${row.source.worldId}:${row.source.entityKey}`);
    const probe =
      selection === undefined
        ? undefined
        : resolveReflectionProbeBinding(selection, probes?.table).probeIndex;
    const materials =
      row.source.materials.length > 0 ? row.source.materials : [row.source.material];
    for (const material of materials) {
      const handle = material.materialHandle ?? -1;
      const passClass = material.deferredPass === true ? '' : 'forward';
      if (probe !== undefined || passClass !== '')
        classes.set(materialBindingKey(row.source, handle), `${passClass}|probe:${probe ?? ''}`);
    }
  }
  return classes;
}
