import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const isAssetDeclaration = (name: string): boolean =>
  name.endsWith('.meta.json') || name.endsWith('.pack.ts') || name.endsWith('.pack.json');

const TEMPLATE_TEST_DIRECTORY = '__tests__';

export type TemplateAssetRootGroup = {
  readonly slug: string;
  readonly roots: readonly string[];
};

const CANONICAL_TEMPLATE_SMOKE_SLUGS = [
  'empty',
  'game-3d',
  'game-capability-lab',
  'brotato-3d',
] as const;

/**
 * Parse the optional template smoke selection once at the asset-root owner.
 * An empty value means the Preview's complete canonical roster.
 */
export function parseTemplateSmokeSlugs(value: string | undefined): readonly string[] {
  const slugs = (value ?? '')
    .split(',')
    .map((slug) => slug.trim())
    .filter((slug) => slug.length > 0);
  const unknown = slugs.filter(
    (slug) => !(CANONICAL_TEMPLATE_SMOKE_SLUGS as readonly string[]).includes(slug),
  );
  if (unknown.length > 0) {
    throw new Error(`unknown engine templates: ${[...new Set(unknown)].join(', ')}`);
  }
  return [...new Set(slugs)];
}

/**
 * Select template-owned Pack/producer roots as one closed operation.
 * Without an explicit smoke selection, preserve every canonical group.
 */
export function selectTemplateAssetRoots(
  groups: readonly TemplateAssetRootGroup[],
  selectedSlugs: readonly string[],
): readonly string[] {
  const selected = new Set(selectedSlugs);
  return groups
    .filter((group) => selected.size === 0 || selected.has(group.slug))
    .flatMap((group) => group.roots);
}

/**
 * Collect the deterministic declaration closure for a template asset tree.
 *
 * The Pack plugin accepts both self-contained Pack files and importer
 * sidecars. Raw source files remain outside this list; the sidecar's `source`
 * field is the single authority for resolving them during import.
 */
export function collectAssetDeclarationRoots(root: string): readonly string[] {
  const roots: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        // Tests validate the template source but are not part of its shipped
        // asset closure. Skip the directory at every nesting level so a
        // fixture pack cannot become a production Catalog row by accident.
        if (entry.name === TEMPLATE_TEST_DIRECTORY) continue;
        visit(path);
      } else if (entry.isFile() && isAssetDeclaration(entry.name)) {
        roots.push(path);
      }
    }
  };
  visit(root);
  return roots;
}

/** Shared Preview/browser-test declaration closure; WGSL compilation stays with Shader. */
export function gameCapabilityAssetRoots(root: string): string[] {
  return [
    'animated-target-material.pack.json',
    'arc-nova-ember-shard.shader.pack.json',
    'arc-nova-geometry.pack.json',
    'arc-nova-shard.shader.pack.json',
    'arc-nova-sigil.shader.pack.json',
    'arc-nova-violet-sigil.shader.pack.json',
    'base-material.pack.json',
    'boss-lightning-contact.pack.json',
    'boss-lightning-flight.pack.json',
    'boss-lightning-materials.pack.json',
    'boss-lightning-suite.pack.json',
    'boss-lightning-telegraph.pack.json',
    'charge-vfx-effect.pack.json',
    'depth-of-field.pack.json',
    'game.pack.json',
    'hit-flash-material.pack.json',
    'hit-vfx-effect.pack.json',
    'hit-vfx-materials.pack.json',
    'multi-material-target.pack.json',
    'resonance-forge.pack.ts',
    'scene.pack.json',
    'target-profile.json.meta.json',
    'ui/hud.pack.json',
    'ui/settings.pack.json',
  ].map((relativePath) => resolve(root, relativePath));
}
