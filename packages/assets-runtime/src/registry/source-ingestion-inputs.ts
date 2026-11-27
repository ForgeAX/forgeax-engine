import type { Component } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  type Asset,
  AssetError,
  type AssetHandle,
  type AssetPublicationEnvelope,
  err,
  materialGuidText,
  ok,
  type Result,
  type SceneAsset,
} from '@forgeax/engine-types';
import type { RuntimeAssetError } from '../asset-registry';
import type { AssetSource, SourceEntry } from '../internal/asset-source';
import type { DecoderRegistry } from '../internal/decoder-registry';

/** Immutable source inputs and scalar selections of one short-lived ingestion. */
export interface SourceIngestionEntry extends Omit<SourceEntry, 'value'> {
  readonly inputReferences: readonly string[];
  readonly parent: string | undefined;
  readonly programKey: string | undefined;
}

export interface SourceIngestionInputs {
  readonly entries: ReadonlyMap<string, SourceIngestionEntry>;
  readonly selections: ReadonlyMap<string, AssetHandle | undefined>;
  readonly schemas: ReadonlyMap<string, Component | undefined>;
  borrow(guid: string): Result<SourceEntry, RuntimeAssetError>;
  validate(): Result<void, RuntimeAssetError>;
  dispose(): void;
}

/** Capture source inheritance as input, without turning material parents into runtime edges. */
export function sourceInputReferences(entry: SourceEntry): readonly string[] {
  if (entry.references === 'deferred') return [];
  const asset = entry.value as Asset;
  const refs = new Set(entry.refs.map((guid) => guid.toLowerCase()));
  if (asset?.kind === 'material' && asset.parent !== undefined)
    refs.add(materialGuidText(asset.parent).toLowerCase());
  if (asset?.kind === 'mesh') {
    for (const slot of asset.materialSlots)
      if (slot.defaultMaterial !== undefined && typeof slot.defaultMaterial !== 'number')
        refs.add(AssetGuid.format(slot.defaultMaterial).toLowerCase());
    for (const lod of asset.lods ?? [])
      if (typeof lod.mesh !== 'number') refs.add(AssetGuid.format(lod.mesh).toLowerCase());
  }
  if (asset?.kind === 'animation-graph')
    for (const node of asset.nodes)
      if (node.type === 'clip' && typeof node.clip === 'string') refs.add(node.clip.toLowerCase());
  return [...refs];
}

function samePublication(
  expected: SourceEntry['publication'],
  actual: AssetPublicationEnvelope | undefined,
  scopeId: string,
): boolean {
  return (
    actual !== undefined &&
    expected.scopeId === scopeId &&
    expected.sourcePath === actual.sourcePath &&
    expected.sourceRevision === actual.sourceRevision &&
    expected.generation === actual.generation &&
    expected.digest === actual.digest &&
    expected.outputSetDigest === actual.outputSetDigest &&
    expected.receipt.inputFingerprint === actual.receipt.inputFingerprint
  );
}

function captureSchemas(
  scene: SceneAsset,
  resolve: (name: string) => Component | undefined,
  schemas: Map<string, Component | undefined>,
): void {
  const capture = (components: Readonly<Record<string, unknown>>) => {
    for (const name of Object.keys(components))
      if (!schemas.has(name)) schemas.set(name, resolve(name));
  };
  for (const entity of Object.values(scene.entities)) {
    capture(entity.components);
    for (const patch of entity.instance?.overrides ?? []) capture(patch.components);
  }
}

/** No await or extension preparation runs while these initial expectations are selected. */
export function captureSourceIngestionInputs(
  source: AssetSource,
  decoders: DecoderRegistry,
  root: string,
  selected: (guid: string) => AssetHandle | undefined,
  component: (name: string) => Component | undefined,
  programKey: (value: Asset) => string | undefined = () => undefined,
): Result<SourceIngestionInputs, RuntimeAssetError> {
  const entries = new Map<string, SourceIngestionEntry>();
  const selections = new Map<string, AssetHandle | undefined>();
  const schemas = new Map<string, Component | undefined>();
  const revisions = new Map<string, number>();
  const pending = [root.toLowerCase()];
  let closed = false;
  while (pending.length > 0) {
    const key = pending.pop() as string;
    if (entries.has(key)) continue;
    const entry = source.entry(key);
    if (entry === undefined)
      return err(
        new AssetError({
          code: 'asset-not-found',
          expected: `prepared source ${key}`,
          hint: 'load the declared source closure before ingestion',
        }),
      );
    const asset = entry.value as Asset;
    const { value: _value, ...metadata } = entry;
    const inputReferences = sourceInputReferences(entry);
    entries.set(key, {
      ...metadata,
      refs: Object.freeze([...entry.refs]),
      inputReferences,
      parent:
        asset?.kind === 'material' && asset.parent !== undefined
          ? materialGuidText(asset.parent).toLowerCase()
          : undefined,
      programKey: asset?.kind === 'material' ? programKey(asset) : undefined,
    });
    revisions.set(key, source.revision(key));
    selections.set(key, selected(key));
    if (asset?.kind === 'scene') captureSchemas(asset, component, schemas);
    for (const reference of inputReferences) pending.push(reference);
  }
  const conflict = () =>
    new AssetError({
      code: 'asset-write-conflict',
      expected: 'the initial source, decoder, schema and GUID selections',
      hint: 'restart ingestion from the current verified source',
    });
  let failure: RuntimeAssetError | undefined;
  let validatedPublicationVersion: number | undefined;
  const validate = (): Result<void, RuntimeAssetError> => {
    if (closed) return err(conflict());
    if (failure !== undefined) return err(failure);
    const catalog = source.catalog;
    const scopeId = catalog.scopeId;
    const publicationVersion = catalog.publicationVersion;
    for (const [key, expected] of entries) {
      if (
        source.entry(key)?.identity !== expected.identity ||
        source.revision(key) !== revisions.get(key) ||
        decoders.identity(expected.kind) !== expected.decoderIdentity ||
        selected(key) !== selections.get(key) ||
        !samePublication(expected.publication, catalog.get(key)?.publication, scopeId)
      ) {
        failure = conflict();
        return err(failure);
      }
    }
    // Reference evidence reads only immutable Catalog rows. Source values,
    // decoder identities, selected handles and schemas still revalidate on
    // every work boundary, including synchronous extension re-entry.
    if (catalog.isStale || validatedPublicationVersion !== publicationVersion) {
      const publicationsCurrent = source.checkCurrentMany(entries.keys());
      if (!publicationsCurrent.ok) {
        failure = publicationsCurrent.error;
        return publicationsCurrent;
      }
      validatedPublicationVersion = publicationVersion;
    }
    for (const [name, expected] of schemas)
      if (component(name) !== expected) {
        failure = conflict();
        return err(failure);
      }
    return ok(undefined);
  };
  const ready = validate();
  if (!ready.ok) return ready;
  return ok({
    entries,
    selections,
    schemas,
    borrow: (guid) => {
      const expected = entries.get(guid);
      const entry = source.entry(guid);
      if (
        closed ||
        failure !== undefined ||
        expected === undefined ||
        entry?.identity !== expected.identity ||
        source.revision(guid) !== revisions.get(guid)
      ) {
        failure ??= conflict();
        return err(failure);
      }
      return ok(entry);
    },
    validate,
    dispose: () => {
      closed = true;
      entries.clear();
      selections.clear();
      schemas.clear();
      revisions.clear();
    },
  });
}
