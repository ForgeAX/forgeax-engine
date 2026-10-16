import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  DEFAULT_MATERIAL_VARIANT_CONTEXT,
  type MaterialVariantContext,
} from './variant-context.js';

export type MaterialDefineValue =
  | { readonly type: 'undefined' }
  | { readonly type: 'bool'; readonly value: boolean }
  | { readonly type: 'int'; readonly value: number }
  | { readonly type: 'uint'; readonly value: number }
  | boolean
  | number
  | undefined;

export interface MaterialSpecializationPassInput {
  readonly name: string;
  readonly module: string;
  readonly entries?: Readonly<Record<string, string>>;
  readonly sourceClosure?: Readonly<Record<string, string>>;
  readonly defs?: Readonly<Record<string, MaterialDefineValue>>;
  readonly moduleSlots?: Readonly<Record<string, string>>;
  readonly renderState?: Readonly<Record<string, unknown>>;
}

export interface MaterialSpecializationKeyInput {
  readonly contractHash: string;
  readonly passes: readonly MaterialSpecializationPassInput[];
  readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
  readonly versions: {
    readonly profile: string;
    readonly adapter: string;
    readonly compiler: string;
  };
  readonly path?: string;
  readonly generation?: number;
  readonly variantContext?: MaterialVariantContext;
}

export interface MaterialSpecializationKey {
  readonly preimage: string;
  readonly digest: string;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => compareKeys(left, right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}

function normalizeDefine(value: MaterialDefineValue): Record<string, unknown> {
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'boolean') return { type: 'bool', value };
  if (typeof value === 'number') return { type: 'int', value };
  return value.type === 'undefined' ? { type: 'undefined' } : value;
}

function normalizeDefs(defs: Readonly<Record<string, MaterialDefineValue>> | undefined) {
  return Object.fromEntries(
    Object.entries(defs ?? {})
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([name, value]) => [name, normalizeDefine(value)]),
  );
}

function normalizeSlots(slots: Readonly<Record<string, string>> | undefined) {
  return Object.entries(slots ?? {})
    .sort(([left], [right]) => compareKeys(left, right))
    .map(([name, module]) => ({ module, name }));
}

function normalizePass(pass: MaterialSpecializationPassInput) {
  return {
    name: pass.name,
    module: pass.module,
    entries: pass.entries ?? {},
    sourceClosure: pass.sourceClosure ?? {},
    defs: normalizeDefs(pass.defs),
    moduleSlots: normalizeSlots(pass.moduleSlots),
    renderState: pass.renderState ?? {},
  };
}

function normalizeInput(input: MaterialSpecializationKeyInput) {
  const variantContext =
    input.variantContext === undefined ||
    canonical(input.variantContext) === canonical(DEFAULT_MATERIAL_VARIANT_CONTEXT)
      ? undefined
      : input.variantContext;
  return {
    schema: 'forgeax.material.specialization.v1',
    contractHash: input.contractHash,
    passes: input.passes.map(normalizePass),
    vertexInputs: [...input.vertexInputs].sort((left, right) => {
      const leftLocation = Number(left.location ?? 0);
      const rightLocation = Number(right.location ?? 0);
      return leftLocation - rightLocation;
    }),
    versions: input.versions,
    ...(variantContext === undefined ? {} : { variantContext }),
  };
}

export function createMaterialSpecializationKey(
  input: MaterialSpecializationKeyInput,
): MaterialSpecializationKey {
  const preimage = canonical(normalizeInput(input));
  return { preimage, digest: bytesToHex(sha256(new TextEncoder().encode(preimage))) };
}
