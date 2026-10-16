import { AssetGuid } from '@forgeax/engine-pack/guid';
import { validatePluginAsset } from '@forgeax/engine-pack/runtime';
import {
  AssetError,
  type AssetPublicationTuple,
  err,
  ok,
  type PackV2,
  type PluginAssetDefinition,
  type Result,
} from '@forgeax/engine-types';
import type { AssetRegistry } from '../asset-registry.js';
import { freezePackValue, PackReader, validatePackEnvelope } from '../internal/pack-reader.js';
import { isRetainedJsonTree } from '../internal/retained-pack-json.js';
import {
  fetchAndCachePackFile,
  resolveCatalogEntry,
  validateRegistryReferences,
} from './load-by-guid.js';

export async function readPluginDefinition(
  registry: AssetRegistry,
  guid: string,
  expectedScope?: string,
  isSourceCurrent: () => boolean = () => true,
): Promise<Result<PluginAssetDefinition, unknown>> {
  const parsed = AssetGuid.parse(guid);
  if (!parsed.ok) return err(parsed.error);
  const generation = registry.generations.get(guid.toLowerCase());
  const globalGeneration = registry.globalGeneration;
  const resolved = await resolveCatalogEntry(registry, guid);
  if (!resolved.ok) return resolved;
  const entry = resolved.value;
  if (!entry || entry.kind !== 'plugin')
    return err(
      new AssetError({
        code: 'asset-not-found',
        expected: `a plugin Catalog row for ${guid}`,
        hint: 'inspect and rebuild the plugin Pack',
      }),
    );
  const before = validateRegistryReferences(registry, guid);
  if (!before.ok) return before;
  if (registry.packFiles.get(entry.packageUrl)?.value === undefined) {
    const loaded = await fetchAndCachePackFile(
      registry,
      entry.packageUrl,
      guid,
      undefined,
      isSourceCurrent,
    );
    if (!loaded.ok) return loaded;
  }
  const retained = registry.packFiles.get(entry.packageUrl)?.value;
  const jsonTree = isRetainedJsonTree(retained);
  // Arbitrary public cache values retain whole-clone semantics, including
  // unrelated non-cloneable payloads and getters evaluated only by the clone.
  const raw = jsonTree ? retained : structuredClone(retained);
  const observed = raw as unknown as AssetPublicationTuple;
  const expected = {
    ...observed,
    ...entry.publication,
    scopeId: expectedScope ?? observed?.scopeId,
  };
  const checked = jsonTree
    ? validatePackEnvelope(raw, expected)
    : new PackReader().verify(raw, expected);
  if (!checked.ok) return checked;
  const pack = raw as unknown as PackV2<unknown>;
  const envelope = pack.assets.find((asset) => asset.guid === guid);
  // Only an owner-parsed, currently intact JSON tree skips the whole-Pack copy.
  // The slow path already owns and freezes the complete clone through verify.
  const payload = jsonTree
    ? freezePackValue(structuredClone(envelope?.payload))
    : envelope?.payload;
  const definition = validatePluginAsset(payload);
  if (!definition.ok) return definition;
  const after = validateRegistryReferences(registry, guid);
  if (!after.ok) return after;
  const current = registry.packIndexCache?.get(guid.toLowerCase());
  if (
    !isSourceCurrent() ||
    registry.globalGeneration !== globalGeneration ||
    registry.generations.get(guid.toLowerCase()) !== generation ||
    current?.packageUrl !== entry.packageUrl ||
    current?.publication?.generation !== entry.publication?.generation ||
    current?.publication?.digest !== entry.publication?.digest ||
    current?.publication?.outputSetDigest !== entry.publication?.outputSetDigest
  )
    return err(
      new AssetError({
        code: 'asset-invalidated',
        expected: 'the same plugin publication after reading its definition',
        hint: 'read the current definition before mounting',
      }),
    );
  const { scopeId, generation: publicationGeneration, digest, outputSetDigest } = pack;
  return ok({
    guid,
    asset: definition.value,
    evidence: {
      kind: 'publication',
      publication: { scopeId, generation: publicationGeneration, digest, outputSetDigest },
    },
  });
}
