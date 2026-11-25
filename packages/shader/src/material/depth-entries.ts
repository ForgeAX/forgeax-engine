import type { ShaderEntryPointReads } from '@forgeax/engine-types';

export const PREDEPTH_FRAGMENT_ENTRY = 'fs_depth_masked';

const MAIN = 1;
const OPAQUE = 2;
const SCREEN = 4;
const MASKED = 8;
const AO = 16;

function entryBit(name: string): number {
  switch (name) {
    case 'fs_main':
      return MAIN;
    case 'fs_opaque':
      return OPAQUE;
    case 'fs_forward_screen':
      return SCREEN;
    case PREDEPTH_FRAGMENT_ENTRY:
      return MASKED;
    case 'fs_ao_input':
      return AO;
    default:
      return 0;
  }
}

// The low three bits name color entries whose Surface coverage can be replayed.
// MASKED selects the physical depth entry even if its effects prevent replay.
function depthBits(
  entries: readonly ShaderEntryPointReads[],
  colors = MAIN | OPAQUE | SCREEN,
  names?: Map<string, ShaderEntryPointReads | null>,
): number {
  let declared = 0;
  let pure = 0;
  let declaresAo = false;
  for (const entry of entries) {
    if (names !== undefined) {
      const previous = names.get(entry.name);
      if (previous === undefined) names.set(entry.name, entry);
      else if (previous !== null && previous.stage !== entry.stage) names.set(entry.name, null);
    }
    if (entry.name === 'fs_ao_input') declaresAo = true;
    if (entry.stage !== 'fragment') continue;
    const bit = entryBit(entry.name);
    if ((bit & (colors | MASKED | AO)) === 0 || (declared & bit) !== 0) continue;
    declared |= bit;
    const effects = entry.effects;
    if (effects && !effects.writesDepth && !effects.writesSampleMask && !effects.writesStorage)
      pure |= bit;
  }
  const depth = declared & MASKED || AO;
  const replay = (pure & depth) !== 0 && (!declaresAo || (pure & AO) !== 0);
  return (declared & MASKED) | (replay ? pure & (MAIN | OPAQUE | SCREEN) : 0);
}

type Entries = readonly ShaderEntryPointReads[];
type DepthProgram = { readonly entryPoints?: Entries | undefined };

// The registry admits immutable reflection once, shared across programs and devices.
interface PublishedEntries {
  readonly depth: number;
  readonly names: ReadonlyMap<string, ShaderEntryPointReads | null>;
}
const admitted = new WeakMap<Entries, PublishedEntries>();

export function admitMaterialShaderEntries(entries: Entries): void {
  if (admitted.has(entries)) return;
  const names = new Map<string, ShaderEntryPointReads | null>();
  const depth = depthBits(entries, MAIN | OPAQUE | SCREEN, names);
  admitted.set(entries, { depth, names });
}

/** Read the first matching declaration. Caller-owned arrays remain live. */
export function findMaterialShaderEntry(
  entries: Entries | undefined,
  name: string | null | undefined,
  stage?: ShaderEntryPointReads['stage'],
): ShaderEntryPointReads | undefined {
  if (entries === undefined || name == null) return;
  const publication = admitted.get(entries);
  if (publication !== undefined) {
    const entry = publication.names.get(name);
    // One source module has unique names. Mixed-stage legacy declarations retain array order.
    if (entry !== null) return stage === undefined || entry?.stage === stage ? entry : undefined;
  }
  for (const entry of entries)
    if (entry.name === name && (stage === undefined || entry.stage === stage)) return entry;
  return undefined;
}

export function materialDepthFragmentEntry(program: DepthProgram): string {
  const entries = program.entryPoints;
  const bits = entries === undefined ? undefined : admitted.get(entries)?.depth;
  const masked =
    bits !== undefined
      ? (bits & MASKED) !== 0
      : entries?.some(
          (entry) => entry.stage === 'fragment' && entry.name === PREDEPTH_FRAGMENT_ENTRY,
        );
  return masked ? PREDEPTH_FRAGMENT_ENTRY : 'fs_ao_input';
}

export function materialDepthCoversEntry(program: DepthProgram, name: string): boolean {
  const bit = entryBit(name) & (MAIN | OPAQUE | SCREEN);
  if (bit === 0) return false;
  const entries = program.entryPoints;
  return (
    entries !== undefined && ((admitted.get(entries)?.depth ?? depthBits(entries, bit)) & bit) !== 0
  );
}
