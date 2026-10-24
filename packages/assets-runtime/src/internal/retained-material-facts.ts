import { internJson, isMaterialProgramAbi, type MaterialProgramAbi } from '@forgeax/engine-types';
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
          // Equal ABI nodes are held once across ABIs and packages.
          if (isMaterialProgramAbi(abi)) {
            const canonical = internJson(abi) as MaterialProgramAbi | undefined;
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
