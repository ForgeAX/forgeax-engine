import { isMaterialProgramAbi, type MaterialProgramAbi } from '@forgeax/engine-types';
import {
  isRetainedMaterialPayload,
  isSharedMaterialAbi,
  markRetainedMaterialPayload,
  shareFrozenMaterialAbi,
} from './shared-immutable.js';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function freezeJson(root: object): void {
  const pending = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === undefined || Object.isFrozen(value)) continue;
    Object.freeze(value);
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === 'object') pending.push(child);
    }
  }
}

/**
 * Realm-wide structural sharing of retained ABI JSON. Every ABI node is
 * canonicalized bottom-up: a node whose content equals an already retained
 * node is replaced by that node, so equal vertex inputs, slots, and rows are
 * held once across all ABIs and packages instead of once per ABI copy. A node
 * key spells its primitive fields exactly and refers to children by the id of
 * their canonical node, so it is injective and short. Canonical nodes are
 * frozen before they become shareable; the table holds them weakly.
 */
const canonicalIds = new WeakMap<object, number>();
const canonicalNodes = new Map<string, WeakRef<object>>();
const collectedNodes =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<string>((key) => {
        if (canonicalNodes.get(key)?.deref() === undefined) canonicalNodes.delete(key);
      })
    : undefined;
let nextCanonicalId = 1;

function leafKey(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return `s${value.length}:${value}`;
    case 'number':
      // JSON text cannot carry non-finite numbers; -0 stays distinct from 0.
      return Number.isFinite(value) ? (Object.is(value, -0) ? 'n-0,' : `n${value},`) : undefined;
    case 'boolean':
      return value ? 't' : 'f';
    default:
      return value === null ? 'z' : undefined;
  }
}

/** The canonical node equal to `node`, or undefined when it is not plain exact JSON. */
function canonicalJsonNode(node: object): object | undefined {
  if (canonicalIds.has(node)) return node;
  const array = Array.isArray(node);
  if (Object.getPrototypeOf(node) !== (array ? Array.prototype : Object.prototype))
    return undefined;
  const record = node as Record<string, unknown>;
  let key = array ? '[' : '{';
  for (const field of Object.keys(record)) {
    if (!array) key += `${field.length}:${field}`;
    const child = record[field];
    if (child !== null && typeof child === 'object') {
      const canonical = canonicalJsonNode(child);
      if (canonical === undefined) return undefined;
      if (canonical !== child) record[field] = canonical;
      key += `#${canonicalIds.get(canonical)}`;
    } else {
      const leaf = leafKey(child);
      if (leaf === undefined) return undefined;
      key += leaf;
    }
  }
  const known = canonicalNodes.get(key)?.deref();
  if (known !== undefined) return known;
  Object.freeze(node);
  canonicalIds.set(node, nextCanonicalId++);
  canonicalNodes.set(key, new WeakRef(node));
  collectedNodes?.register(node, key);
  return node;
}

/** Only freshly parsed resource-package JSON enters this owner. */
export function retainJsonMaterialFacts(assets: readonly unknown[]): void {
  const abis = new Map<object, MaterialProgramAbi | null>();
  const programs = new WeakSet<object>();
  for (const raw of assets) {
    const asset = object(raw);
    if (asset?.kind !== 'material') continue;
    const payload = object(asset.payload);
    const cooked = object(payload?.cooked);
    if (
      payload === undefined ||
      cooked?.schemaVersion !== 'material-cook/4' ||
      !Array.isArray(cooked.programs)
    )
      continue;
    for (const rawProgram of cooked.programs) {
      const program = object(rawProgram);
      if (program === undefined || programs.has(program)) continue;
      programs.add(program);
      const selections = program.selections;
      if (!Array.isArray(selections)) continue;
      for (const rawSelection of selections) {
        const selection = object(rawSelection);
        const abi = object(selection?.abi);
        if (selection === undefined || abi === undefined) continue;
        // The package program table already shares one ABI object per entry;
        // canonicalize each distinct object once.
        let retained = abis.get(abi);
        if (retained === undefined) {
          retained = null;
          if (isMaterialProgramAbi(abi)) {
            const canonical = canonicalJsonNode(abi) as MaterialProgramAbi | undefined;
            if (canonical !== undefined) {
              retained = canonical;
              shareFrozenMaterialAbi(retained);
            }
          }
          abis.set(abi, retained);
        }
        if (retained !== null) selection.abi = retained;
      }
    }
    freezeJson(cooked);
    Object.defineProperty(payload, 'cooked', { writable: false, configurable: false });
    markRetainedMaterialPayload(payload);
  }
}

/** Keep mutable decoder inputs detached from the retained package. */
export function cloneRetainedPackPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const cloned = structuredClone(payload);
  if (isRetainedMaterialPayload(payload)) {
    Object.defineProperty(cloned, 'cooked', {
      value: payload.cooked,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  }
  return cloned;
}

export function isRetainedMaterialAbi(value: unknown): value is MaterialProgramAbi {
  return value !== null && typeof value === 'object' && isSharedMaterialAbi(value);
}
