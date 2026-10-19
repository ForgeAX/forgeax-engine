import type { CatalogEntry } from '@forgeax/engine-types';

/** A small image uses the ordinary preview rig with independent background and lighting. */
export const THUMBNAIL_PREVIEW = {
  size: 128,
  background: 'transparent',
  lighting: 'neutral',
  antialias: 0,
  bloom: 0,
  vfxFrames: 30,
} as const;

/** Content identity excludes session generations, locators, names and unrelated outputs. */
export function previewThumbnailInput(
  entries: ReadonlyMap<string, CatalogEntry>,
  guid: string,
): string | undefined {
  const visited = new Set<string>();
  const closure: [string, string, string][] = [];
  const visit = (id: string): boolean => {
    if (visited.has(id)) return true;
    visited.add(id);
    const entry = entries.get(id);
    if (!entry || entry.lifecycle !== 'current') return false;
    const output = entry.publication?.outputs.find((item) => item.guid === id);
    const digest = output?.digest ?? entry.revision?.digest;
    if (!digest) return false;
    closure.push([id, entry.kind, digest]);
    const refs = output?.refs ?? entry.refs ?? [];
    return refs.every(visit);
  };
  return visit(guid) ? JSON.stringify(closure.sort(([a], [b]) => a.localeCompare(b))) : undefined;
}
