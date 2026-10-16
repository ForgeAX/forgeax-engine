import type { EnvironmentCandidate, FogCandidate } from '../extract/environment';

export interface EnvironmentSignatureInput {
  readonly environments: readonly EnvironmentCandidate[];
  readonly fogs: readonly FogCandidate[];
  readonly suns: readonly {
    readonly entityKey: number;
    readonly direction: readonly [number, number, number];
    readonly color: readonly [number, number, number];
    readonly intensity: number;
  }[];
}

export interface EnvironmentFactSignatures {
  readonly environmentSignature: string;
  readonly fogSignature: string;
  readonly signature: string;
}

function sorted<T extends { readonly entityKey: number }>(items: readonly T[]): readonly T[] {
  return [...items].sort((left, right) => left.entityKey - right.entityKey);
}

/** Derive a deterministic source signature without retaining GPU objects. */
export function environmentSignature(input: EnvironmentSignatureInput): string {
  return JSON.stringify({
    environments: sorted(input.environments),
    fogs: sorted(input.fogs),
    suns: sorted(input.suns),
  });
}

/** Signature for Environment and Sun facts, excluding the independent Fog channel. */
export function environmentOnlySignature(input: EnvironmentSignatureInput): string {
  return JSON.stringify({
    environments: sorted(input.environments),
    suns: sorted(input.suns),
  });
}

/** Signature for the independent Fog channel. */
export function fogOnlySignature(input: Pick<EnvironmentSignatureInput, 'fogs'>): string {
  return JSON.stringify({ fogs: sorted(input.fogs) });
}

/** Build all frame signatures from one immutable source fact set. */
export function environmentFactSignatures(
  input: EnvironmentSignatureInput,
): EnvironmentFactSignatures {
  return {
    environmentSignature: environmentOnlySignature(input),
    fogSignature: fogOnlySignature(input),
    signature: environmentSignature(input),
  };
}
