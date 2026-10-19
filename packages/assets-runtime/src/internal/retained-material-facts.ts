import { isMaterialProgramAbi, type MaterialProgramAbi } from '@forgeax/engine-types';

const retainedPayloads = new WeakSet<object>();
const retainedAbis = new WeakSet<object>();

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

function abiKey(value: object): string | undefined {
  let exact = true;
  try {
    const key = JSON.stringify(value, (_key, child: unknown) => {
      if (typeof child === 'number' && (!Number.isFinite(child) || Object.is(child, -0)))
        exact = false;
      return child;
    });
    return exact ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Only freshly parsed resource-package JSON enters this owner. */
export function retainJsonMaterialFacts(assets: readonly unknown[]): void {
  const abis = new Map<string, MaterialProgramAbi>();
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
      const selections = object(rawProgram)?.selections;
      if (!Array.isArray(selections)) continue;
      for (const rawSelection of selections) {
        const selection = object(rawSelection);
        const abi = object(selection?.abi);
        if (selection === undefined || abi === undefined) continue;
        const key = abiKey(abi);
        if (key === undefined) continue;
        let retained = abis.get(key);
        if (retained === undefined) {
          if (!isMaterialProgramAbi(abi)) continue;
          freezeJson(abi);
          retained = abi;
          abis.set(key, retained);
          retainedAbis.add(retained);
        }
        selection.abi = retained;
      }
    }
    freezeJson(cooked);
    Object.defineProperty(payload, 'cooked', { writable: false, configurable: false });
    retainedPayloads.add(payload);
  }
}

/** Keep mutable decoder inputs detached from the retained package. */
export function cloneRetainedPackPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const cloned = structuredClone(payload);
  if (retainedPayloads.has(payload)) {
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
  return value !== null && typeof value === 'object' && retainedAbis.has(value);
}
