// Shared raw input defaults for spawn and component insertion.

import type { Component, ComponentSchema } from './component';
import { componentSchema } from './component';
import { componentDefinition } from './component-schema';
import { ENTITY_NULL_RAW } from './entity-handle';
import { SpawnDataUnknownFieldError } from './errors';

/**
 * Layer-3 silent default for a single schema field type. Returned when
 * the spawn-data raw input (layer 1) and the owner definition defaults
 * map (layer 2) both omit a known schema field.
 *
 * Pure function — runs once per missing field per (component, spawn /
 * instantiate) call. No `BufferPool` / `UniqueRefStore` / `World`
 * dependency: the helper hands back raw column-shape values (u32 / bool
 * / number array literal); the layer-4 silent fallback inside
 * `writeRow` / `write{Buffer,Array,UniqueRef}Field` turns raw `0` into
 * the live column-store value (unique-ref handle 0 / BufferPool slot
 * id 0 / array slot length 0).
 *
 * Mapping is the same closed table the head-JSDoc table documents.
 *
 * @internal — helper-private; AI users call `fillComponentDefaults`.
 */
function typeDefault(fieldType: string): unknown {
  // bool is the only scalar arm with a non-zero default.
  if (fieldType === 'bool') return false;
  // 'entity' uses the runtime NULL_ENTITY sentinel (0xffffffff).
  if (fieldType === 'entity') return ENTITY_NULL_RAW;
  // 'array<entity>' is the only array<T> arm whose layer-3 default is a
  // JS array literal — entity[] runtime shape is a JS Array<Entity>,
  // not a BufferPool slot id (D-2 asymmetric pivot).
  if (fieldType === 'array<entity>') return [];
  // every other vocab keyword (incl. 'string' / 'unique<T>' / 'asset<kind>'
  // / 'buffer' / 'buffer<N>' / 'array<T>' (T!=entity) / 'array<T, N>')
  // and every remaining ScalarFieldType (f* / i* / u* / enum)
  // defaults to numeric 0 at the spawn-data raw surface. Layer-4
  // silent fallback inside writeRow turns 0 into the empty-slot
  // shape on the column-store side when applicable.
  return 0;
}

/**
 * Fill missing schema fields on a partial spawn-data raw with their
 * layer-2 / layer-3 defaults. Public surface used by:
 *
 *   - `World.spawn`                            (writeRow entry, M2)
 *   - `World.addComponent`                     (writeRow entry, M2)
 *
 * Resolution order (matches scene-instance-container.ts JSDoc):
 *
 *   layer 1 — explicit raw value (caller passed `data[field] = v`).
 *             Carrier: the raw input itself; not handled by this
 *             helper — copied through the `if (key in raw)` branch.
 *             SceneAsset.instantiate additionally remaps `entity` /
 *             `array<entity>` LocalEntityId values BEFORE handing the raw
 *             to the helper (the entity-remap layer is NOT this
 *             helper's responsibility).
 *
 *   layer 2 — owner definition defaults (declared via
 *             `defineComponent(name, schema, { defaults })`). Layer-2
 *             defaults beat layer-3.
 *
 *   layer 3 — `typeDefault(fieldType)` (this file's private dispatch).
 *
 * Returns a fresh `Record<string, unknown>` carrying every schema
 * field. The output is column-shape raw — the caller's writeRow path
 * walks it field-by-field and applies layer-4 silent fallback when a
 * raw `0` lands on a managed-family arm.
 *
 * Pure: no World / store side effect. Each call returns a fresh record so
 * repeated invocations cannot share mutable state; a field-less tag shares
 * one frozen empty record.
 *
 * @param token  Component token (name + schema + optional defaults).
 * @param raw    Partial spawn-data raw — caller's `Partial<ShapeOf<S>>`.
 *               Keys not present in the schema are passed through
 *               unchanged (the spawn write path will emit a write-time
 *               error if applicable; helper does not validate keys).
 * @returns      Record with every schema field populated by layer-1 /
 *               layer-2 / layer-3 defaults in that order.
 */
const EMPTY_FILLED: Record<string, unknown> = Object.freeze(Object.create(null));

export function fillComponentDefaults<S extends ComponentSchema>(
  token: Component<string, S>,
  raw: Partial<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const definition = componentDefinition(token);
  const fieldNames = definition.fieldNames;
  // Tags have nothing to fill; one frozen record serves every caller.
  if (fieldNames.length === 0) return EMPTY_FILLED;
  const schema = componentSchema(token) as Record<string, string>;
  const layer2 = definition.defaults;
  // A plain literal keeps the record in fast (shared hidden class) mode; only a
  // schema declaring `__proto__` needs the prototype-free dictionary form.
  const out: Record<string, unknown> = Object.hasOwn(schema, '__proto__')
    ? Object.create(null)
    : {};
  const rawObj = (raw as Record<string, unknown> | undefined) ?? undefined;
  for (let index = 0; index < fieldNames.length; index++) {
    const fieldName = fieldNames[index] as string;
    const fieldType = schema[fieldName];
    if (fieldType === undefined) continue;
    // layer 1 — explicit raw value (caller may pass undefined to mean
    // "use default"; mirror the existing scene-instance-container
    // behaviour where the gate is `fieldName in raw`).
    if (rawObj !== undefined && fieldName in rawObj) {
      out[fieldName] = rawObj[fieldName];
      continue;
    }
    // layer 2 — component-level defaults map.
    if (layer2 !== undefined && fieldName in layer2) {
      out[fieldName] = layer2[fieldName];
      continue;
    }
    // layer 3 — TS type defaults (silent — no error code).
    out[fieldName] = typeDefault(fieldType);
  }
  return out;
}

/**
 * One field of `fillComponentDefaults(token, raw)` without building the
 * record: the explicit raw value, else the layer-2 default, else the layer-3
 * type default. Row writers resolve fields this way to skip the temporary.
 */
export function filledFieldValue(
  defaults: Readonly<Record<string, unknown>> | undefined,
  fieldType: string,
  raw: Readonly<Record<string, unknown>> | undefined,
  fieldName: string,
): unknown {
  if (raw !== undefined && fieldName in raw) return raw[fieldName];
  if (defaults !== undefined && fieldName in defaults) return defaults[fieldName];
  return typeDefault(fieldType);
}

// Re-export the private dispatch for unit-test introspection (t1
// keyword pin — every vocab arm gets a one-liner it() block). The
// helper-private arity is preserved at callers via the
// `fillComponentDefaults` boundary.
export { typeDefault };

/**
 * Validate that every key in `raw` is a declared schema field on `token`.
 *
 * Returned as a `SpawnDataUnknownFieldError` on the FIRST offending key
 * (deterministic for AI users; subsequent unknown keys surface on the next
 * spawn after the first is fixed). Pre-fix the unknown key was silently
 * dropped inside `fillComponentDefaults` (which iterates only schema keys),
 * routing typos like `MeshRenderer { material }` (singular legacy field name)
 * into the empty-default path and producing invisible / mid-grey entities
 * downstream.
 *
 * Pure: no World / store side effect; allocates no closure on the hot path
 * (early-returns null when raw is undefined / empty).
 *
 * Call order at every spawn / addComponent / SceneAsset.instantiate /
 * Commands.spawn site: validate FIRST, then `fillComponentDefaults`. The
 * split keeps `fillComponentDefaults` pure (charter P3 SSOT — a fill helper
 * never validates) while every layer-1 raw key reaches one validator gate.
 *
 * @param token  Component token (name + schema).
 * @param raw    Caller's `Partial<ShapeOf<S>>` — raw spawn payload.
 * @returns      `null` on success; `SpawnDataUnknownFieldError` on the first
 *               key not declared in `componentSchema(token)`.
 */
export function validateComponentDataKeys<S extends ComponentSchema>(
  token: Component<string, S>,
  raw: Partial<Record<string, unknown>> | undefined,
): SpawnDataUnknownFieldError | null {
  if (raw === undefined) return null;
  const schema = componentSchema(token) as Record<string, unknown>;
  const rawObj = raw as Record<string, unknown>;
  for (const fieldName in rawObj) {
    if (!(fieldName in schema) && Object.hasOwn(rawObj, fieldName)) {
      return new SpawnDataUnknownFieldError(token.name, fieldName, Object.keys(schema));
    }
  }
  return null;
}
