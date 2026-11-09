import type { PassKind } from '@forgeax/engine-types';
import { declaredFragmentEntry, materialProgramSource } from '../record/standard-opaque-entry';

/**
 * The fragment entry a material pipeline requests: `null` keeps a vertex-only
 * depth pipeline, an authored entry wins, and HDR forward sprites use their
 * HDR entry.
 */
export function materialFragmentEntry(
  authoredFragmentEntry: string | null | undefined,
  isHdr: boolean,
  passKind: PassKind,
  materialShaderId: string | undefined,
): string | null | undefined {
  if (authoredFragmentEntry !== undefined) return authoredFragmentEntry;
  const hdrSprite =
    isHdr &&
    passKind === 'forward' &&
    (materialShaderId === 'forgeax::sprite' || materialShaderId === 'forgeax::sprite-lit');
  return hdrSprite ? 'fs_main_hdr' : undefined;
}

/** `null` keeps a vertex-only pipeline; other entries resolve against the program. */
export function declaredOrVertexOnlyFragmentEntry(
  fragmentEntry: string | null | undefined,
  materialShaderEntry: Parameters<typeof materialProgramSource>[0],
): string | null | undefined {
  if (fragmentEntry === null) return null;
  return declaredFragmentEntry(fragmentEntry, materialProgramSource(materialShaderEntry));
}
