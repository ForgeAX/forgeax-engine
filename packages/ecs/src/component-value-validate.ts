// feat-20260713-mount-override-component-add-and-shared-ref-round M2 / w9 —
// P3 shared-field value gate.
//
// `validateComponentDataKeys` (component-default-fallback.ts) checks that every
// key in a spawn / addComponent / set payload is a declared schema field. It
// does NOT check value TYPES. A `shared<T>` scalar / `array<shared<T>>` element
// must be a resolved numeric Handle; a raw GUID string / `{ guid }` / `{ kind }`
// object (the pre-resolution shape a sidecar hands an AI user) was silently
// coerced to the all-zero sentinel by the column packer
// (`typed[i] = typeof val === 'number' ? val : 0`) / scalar write path, so a
// mis-bound reference read back as `0` / `[0,0,0,0]` and rendered blank with no
// error.
//
// This module closes that value-type gap. It is a pure validator (no World /
// store side effect) invoked at all three write entries (spawn / addComponent /
// set) BEFORE any archetype mutation, mirroring the validate-first ordering of
// `validateComponentDataKeys`. §2.5: it depends only on the schema field-type
// SHAPE (`shared<...>` / `array<shared<...>>`), never on any GUID / asset
// concretion — the GUID domain stays sealed in assets-runtime; ecs only sees a
// numeric handle vs a non-handle.

import type { Component, ComponentSchema } from './component';
import { componentSchema } from './component';
import { componentDefinition } from './component-schema';
import { ManagedArrayInvalidValueError, SharedFieldInvalidValueError } from './errors';

/** A resolved shared handle is a plain number (the branded Handle bit pattern). */
function isNumericHandle(v: unknown): boolean {
  return typeof v === 'number';
}

/** `shared<T>` scalar field type. */
function isSharedScalarType(fieldType: string): boolean {
  return fieldType.startsWith('shared<') && fieldType.endsWith('>');
}

/**
 * `array<shared<T>>` / `array<shared<T>, N>` field type. The inner element type
 * is a `shared<...>` template; we test the array wrapper and the `shared<`
 * infix rather than fully re-parsing (parseManagedArraySchema owns the strict
 * grammar — here we only need the coarse "is this an array of shared refs"
 * discriminant).
 */
function isSharedArrayType(fieldType: string): boolean {
  if (!fieldType.startsWith('array<') || !fieldType.endsWith('>')) return false;
  const inner = fieldType.slice(6, -1);
  const head = inner.indexOf(',') === -1 ? inner : inner.slice(0, inner.indexOf(',')).trim();
  return head.startsWith('shared<') && head.endsWith('>');
}

function isArrayPayload(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  // DataView and ArrayBuffer are views/buffers without an element `length`;
  // the storage writer cannot interpret them as a managed array payload.
  return ArrayBuffer.isView(value) && typeof (value as { length?: unknown }).length === 'number';
}

/**
 * Validate the outer value shape for every managed `array<T>` field present in
 * a write payload. This is deliberately a preflight-only check: element
 * coercion remains owned by the column writer, while arbitrary objects are
 * rejected before any row, buffer slot, retain, or epoch mutation can occur.
 */
export function validateManagedArrayValues<S extends ComponentSchema>(
  token: Component<string, S>,
  raw: Partial<Record<string, unknown>> | undefined,
): ManagedArrayInvalidValueError | null {
  if (raw === undefined) return null;
  const fields = componentDefinition(token).fields as Readonly<
    Record<string, { readonly type: string; readonly arrayMeta?: unknown }>
  >;
  const rawObj = raw as Record<string, unknown>;
  for (const fieldName of Object.keys(rawObj)) {
    const reflection = fields[fieldName];
    if (reflection?.arrayMeta === undefined) continue;
    const value = rawObj[fieldName];
    // `fillComponentDefaults` deliberately uses numeric zero as the layer-3
    // raw sentinel for every non-entity array vocabulary. The column writer
    // owns translating that sentinel into an empty variable slot or a
    // zero-filled fixed row, so it must pass this preflight just like an
    // omitted/null value. Other scalar/object values remain invalid.
    if (value === 0) continue;
    if (value === undefined || value === null || isArrayPayload(value)) continue;
    return new ManagedArrayInvalidValueError(token.name, fieldName, reflection.type, value);
  }
  return null;
}

/**
 * Validate that every `shared<T>` scalar / `array<shared<T>>` element present in
 * `raw` is a resolved numeric Handle. Returns the FIRST offending field's
 * `SharedFieldInvalidValueError` (deterministic for AI users), or `null` on
 * success.
 *
 * Pure: no World / store side effect. Only fields PRESENT in `raw` are checked
 * (an omitted shared field takes its schema default — a numeric sentinel — via
 * `fillComponentDefaults`, so it is never a non-handle). `undefined` / `null`
 * values are treated as "omitted" (the write path routes them to the sentinel
 * intentionally); only a concrete non-numeric value (string / object) is a
 * mis-bound GUID and fails fast.
 *
 * @param token  Component token (name + schema).
 * @param raw    Caller's raw payload (spawn / addComponent / set value).
 * @returns      `null` on success; `SharedFieldInvalidValueError` on the first
 *               shared field bound to a non-handle value.
 */
export function validateSharedFieldValues<S extends ComponentSchema>(
  token: Component<string, S>,
  raw: Partial<Record<string, unknown>> | undefined,
): SharedFieldInvalidValueError | null {
  if (raw === undefined) return null;
  const schema = componentSchema(token) as Record<string, string>;
  const rawObj = raw as Record<string, unknown>;
  for (const fieldName of Object.keys(rawObj)) {
    const fieldType = schema[fieldName];
    if (fieldType === undefined) continue; // key validation owns unknown keys.
    const value = rawObj[fieldName];
    if (value === undefined || value === null) continue; // omitted -> sentinel default.
    if (isSharedScalarType(fieldType)) {
      if (!isNumericHandle(value)) {
        return new SharedFieldInvalidValueError(token.name, fieldName, fieldType, value);
      }
    } else if (isSharedArrayType(fieldType)) {
      if (!Array.isArray(value)) continue; // non-array raw for an array field: write path no-ops.
      for (let i = 0; i < value.length; i++) {
        const el = value[i];
        if (el === undefined || el === null) continue;
        if (!isNumericHandle(el)) {
          return new SharedFieldInvalidValueError(token.name, fieldName, fieldType, el, i);
        }
      }
    }
  }
  return null;
}
