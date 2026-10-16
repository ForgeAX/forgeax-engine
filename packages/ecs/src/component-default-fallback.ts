// @forgeax/engine-ecs - Layer-3 default-value SSOT helper (feat-20260517-
// spawn-default-fallback / M1).
//
// AI users: this file is the SINGLE PHYSICAL LOCATION of the layer-3
// `typeDefault(fieldType)` table. Three runtime paths consume it (D-2
// / plan-strategy §2.1 / AC-05):
//
//   - `world.spawn(...)`               (M2 — t9)
//   - `world.addComponent(...)`        (M2 — t9, ComponentData<S> shared)
//
// Two-layer split (D-3 / plan-strategy §2.2 — DELIBERATELY NOT MERGED):
//
//   layer-3 (this file)
//     "raw value fallback" — fills missing schema fields with the
//     spawn-data raw shape: 0 / false / ENTITY_NULL_RAW / [] / 0 (slot
//     id placeholder). The output is the input shape `world.spawn`
//     receives (`Partial<ShapeOf<S>>` -> `Record<string, unknown>` with
//     all schema keys present).
//
//   layer-4 (silent fallback inside writeRow / write{Buffer,Array,
//            UniqueRef}Field)
//     "column-store value fallback" — when raw === 0 hits a managed-
//     family arm (string / unique<T> / buffer / buffer<N> / array<T> for
//     T != entity), the column store routes 0 to "empty slot" semantics
//     (UniqueRefStore handle 0 / BufferPool slot 0 / array slot
//     length === 0). The two layers are NEVER merged — layer-3 stays
//     pure / unaware of column physics; layer-4 stays inside writeRow
//     where the column instance is in scope.
//
// The 14-vocab x default-value table (AC-06 closed table, grep-gate t2
// keyword "layer-3 typeDefault table"):
//
//   ScalarFieldType (11 arms):
//     f32 / f64 / i32 / u32 / i16 / u16 / i8 / u8       -> 0
//     bool                                              -> false
//     enum / ref (legacy scalar)                        -> 0
//
//   SchemaVocabKeyword (8 arms; one "buffer" + one "buffer<N>"; one
//   "ref<T>" + one "handle<T>"; one "entity" + one "string"; two array
//   variants — array<T,N> / array<T> — collapse to two table arms:
//     'string'                  -> 0  (uniqueRefs handle slot;
//                                       resolved payload '' on read)
//     'entity'                  -> ENTITY_NULL_RAW (NULL_ENTITY u32
//                                       = 0xffffffff)
//     'array<entity>'           -> []  (THE ONLY array<T> arm with []
//                                       — entity[] runtime shape is a
//                                       JS array of Entity, not a
//                                       BufferPool slot id)
//     'array<T>'  (T != entity) -> 0  (BufferPool slot id; layer-4
//                                       writeArrayField bottoms out to
//                                       empty slot — D-2 asymmetric;
//                                       SceneAsset byte-equivalence,
//                                       OOS-6 letter)
//     'array<T, N>' (any T)     -> 0  (inline stride-N column,
//                                       feat-20260602; fallback writes the
//                                       zeroed row, not a slot id)
//     'buffer'                  -> 0  (BufferPool slot id; variable
//                                       byte capacity)
//     'buffer<N>'               -> 0  (inline stride-N u8 column,
//                                       feat-20260602; fallback writes the
//                                       zeroed row, not a slot id)
//     'unique<T>'                  -> 0  (UniqueRefStore handle slot)
//     'handle<T>'               -> 0  (unmanaged handle phantom u32;
//                                       schema-level nullable -> NULL
//                                       sentinel 0)
//
// Brand-class semantics (AC-10 / requirements §A-3 reframe round 2):
// `handle<T>` and `ref<T>` are SCHEMA-LEVEL nullable. Spawn `data: {}`
// is legal; layer-3 fills 0 (NULL sentinel for unmanaged handles) /
// 0 (uniqueRefs handle slot, '' payload). SceneAsset.instantiate
// produces byte-equivalent column state.
//
// Anchors:
//   - requirements §AC-05 (helper SSOT) + §AC-06 (closed 14-vocab table)
//     + §AC-09 (SceneAsset byte-equiv) + §AC-10 (brand-class nullable)
//   - plan-strategy §2.1 (helper file location decision)
//             §2.2 (two-layer split JSDoc declaration)
//             §2.3 (array<T> T!=entity asymmetric raw 0)
//             §3.1 (helper node in component graph)
//             §8.2 (naming rules: fillComponentDefaults / typeDefault)
//             §8.4 (head JSDoc as discovery anchor)

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
  // every other vocab keyword (incl. 'string' / 'unique<T>' / 'handle<T>'
  // / 'buffer' / 'buffer<N>' / 'array<T>' (T!=entity) / 'array<T, N>')
  // and every remaining ScalarFieldType (f* / i* / u* / enum / ref)
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
 * Pure: no World / store side effect. Thread-safety irrelevant (single-
 * thread JS engine), but the helper allocates one `Object.create(null)`
 * per call so repeated invocations cannot share a mutable record.
 *
 * @param token  Component token (name + schema + optional defaults).
 * @param raw    Partial spawn-data raw — caller's `Partial<ShapeOf<S>>`.
 *               Keys not present in the schema are passed through
 *               unchanged (the spawn write path will emit a write-time
 *               error if applicable; helper does not validate keys).
 * @returns      Record with every schema field populated by layer-1 /
 *               layer-2 / layer-3 defaults in that order.
 */
export function fillComponentDefaults<S extends ComponentSchema>(
  token: Component<string, S>,
  raw: Partial<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const schema = componentSchema(token) as Record<string, string>;
  const layer2 = componentDefinition(token).defaults;
  const out: Record<string, unknown> = Object.create(null);
  const rawObj = (raw as Record<string, unknown> | undefined) ?? undefined;
  for (const fieldName of Object.keys(schema)) {
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
  for (const fieldName of Object.keys(rawObj)) {
    if (!(fieldName in schema)) {
      return new SpawnDataUnknownFieldError(token.name, fieldName, Object.keys(schema));
    }
  }
  return null;
}
