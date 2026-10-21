import {
  createPackageResponse,
  type FixedPackExecution,
  type FixedPackPublication,
  type PackProgram,
  type PackProgramError,
  validateFixedPackPublication,
} from '@forgeax/engine-pack/runtime';
import { type PluginProgramEntry, samePluginEvidence } from '@forgeax/engine-plugin';
import type { PackageFetcher, PackageResponse } from '@forgeax/engine-types';
import {
  type AssetArtifactError,
  type AssetLoadError,
  type CatalogEntry,
  err,
  ok,
  type PackV2Error,
  type PluginAssetDefinition,
  type PluginBuildTarget,
  type Result,
} from '@forgeax/engine-types';
import type { AssetRegistry } from './asset-registry.js';
import type { CatalogSource } from './catalog-source.js';
import { PackReader } from './internal/pack-reader.js';
import { runtimeSourceReader } from './internal/runtime-assets.js';
import { assetLoadCancelled } from './internal/wait-for-asset.js';
import { readArtifact } from './registry/artifact-io.js';
import { resolveCatalogAssetUrl } from './registry/catalog.js';

// Matches the AssetGraph read bound so one capture cannot monopolize the host connection pool.
const CAPTURE_READ_CONCURRENCY = 8;

/** Capture one complete publication; replay must still pass the normal domain loaders. */
export async function captureAssetPublication(
  selected: CatalogEntry,
  entries: readonly CatalogEntry[],
  source: CatalogSource,
  fetcher: PackageFetcher,
  options: {
    readonly registry?: AssetRegistry;
    readonly executions?: readonly {
      readonly target: PluginBuildTarget;
      readonly programs: ReadonlyMap<string, Pick<PluginProgramEntry, 'exportSource'>>;
      readonly tools: ReadonlyMap<string, FixedPackExecution['tools'][string]>;
      readonly definitions: ReadonlyMap<string, PluginAssetDefinition['evidence']>;
    }[];
    readonly signal?: AbortSignal;
  } = {},
): Promise<
  Result<FixedPackPublication, AssetLoadError | AssetArtifactError | PackV2Error | PackProgramError>
> {
  const reader = new PackReader();
  try {
    options.signal?.throwIfAborted();
    // Freeze metadata and the source-owned byte lease before the first asynchronous boundary.
    const normalize = (entry: CatalogEntry): CatalogEntry => {
      const row = structuredClone(entry);
      const publication = row.publication;
      if (!publication?.current) return row;
      return {
        ...row,
        publication: {
          ...publication,
          current: {
            ...publication.current,
            packageUrl: resolveCatalogAssetUrl(
              { packIndexUrl: source.url },
              publication.current.packageUrl,
            ),
          },
        },
      };
    };
    const row = normalize(selected);
    const rows = entries.filter((entry) => entry.packageUrl === row.packageUrl).map(normalize);
    const bound = source.openPackage?.(row.packageUrl) ?? fetcher;
    const scopeId = source.expectedScope?.scopeId;
    const projections = (options.executions ?? []).map((projection) => ({
      target: projection.target,
      programs: new Map(
        [...projection.programs].map(([name, entry]) => [name, entry.exportSource]),
      ),
      tools: structuredClone(new Map(projection.tools)),
      definitions: structuredClone(new Map(projection.definitions)),
    }));
    if (new Set(projections.map((projection) => projection.target)).size !== projections.length)
      throw new TypeError('duplicate fixed execution target');
    const publication = row.publication;
    if (
      !publication ||
      publication.failure ||
      row.lifecycle === 'failed' ||
      row.lifecycle === 'stale'
    )
      throw new TypeError('a fixed capture requires a current publication');
    const signal = options.signal ?? new AbortController().signal;
    const request = { signal };
    const existing = runtimeSourceReader(options.registry, source);
    const verifiedPack =
      existing === undefined
        ? await (async () => {
            const response = await bound(row.packageUrl, request);
            if (!response.ok) throw new TypeError('fixed Pack is unavailable');
            const raw = await response.json();
            options.signal?.throwIfAborted();
            const packageScope =
              scopeId ??
              (raw !== null &&
              typeof raw === 'object' &&
              'scopeId' in raw &&
              typeof raw.scopeId === 'string'
                ? raw.scopeId
                : undefined);
            if (packageScope === undefined)
              throw new TypeError('fixed Pack is missing its scope identity');
            return reader.verify(raw, {
              scopeId: packageScope,
              generation: publication.generation,
              digest: publication.digest,
              outputSetDigest: publication.outputSetDigest,
            });
          })()
        : await existing.readPack(row, signal, bound);
    if (!verifiedPack.ok) return verifiedPack;
    const pack = verifiedPack.value;
    const bodies = new Map<string, Promise<Result<Uint8Array<ArrayBuffer>, PackageResponse>>>();
    const executions: Partial<
      Record<
        PluginBuildTarget,
        {
          programs: Record<string, PackProgram>;
          tools: Record<string, FixedPackExecution['tools'][string]>;
        }
      >
    > = Object.create(null);
    for (const asset of pack.assets) {
      options.signal?.throwIfAborted();
      if (asset.kind === 'plugin')
        for (const projection of projections) {
          if (!projection.tools.has(asset.guid)) continue;
          const { programs: availablePrograms, tools: availableTools, definitions } = projection;
          const execution = executions[projection.target] ?? {
            programs: Object.create(null),
            tools: Object.create(null),
          };
          executions[projection.target] = execution;
          const { programs, tools } = execution;
          const exportProgram = async (name: string) => {
            if (Object.hasOwn(programs, name)) return;
            const producer = availablePrograms.get(name);
            if (!producer) throw new TypeError(`missing portable plugin program ${name}`);
            programs[name] = structuredClone(await producer());
            options.signal?.throwIfAborted();
          };
          const evidence = definitions.get(asset.guid);
          if (!evidence) throw new TypeError(`missing plugin program evidence ${asset.guid}`);
          if (evidence.kind === 'publication') {
            if (
              !samePluginEvidence(evidence, {
                kind: 'publication',
                publication: {
                  scopeId: pack.scopeId,
                  generation: pack.generation,
                  digest: pack.digest,
                  outputSetDigest: pack.outputSetDigest,
                },
              })
            )
              throw new TypeError(`plugin program publication differs ${asset.guid}`);
          } else {
            const bytes = new Uint8Array(
              await crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(JSON.stringify(asset.payload)),
              ),
            );
            const digest = `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
            if (evidence.revision !== publication.sourceRevision || evidence.digest !== digest)
              throw new TypeError(`plugin program source differs ${asset.guid}`);
          }
          const name = (asset.payload as { readonly program?: unknown })?.program;
          if (typeof name !== 'string')
            throw new TypeError(`missing portable plugin program ${String(name)}`);
          await exportProgram(name);
          const contract = availableTools.get(asset.guid);
          if (!contract) throw new TypeError(`missing portable plugin tool contract ${asset.guid}`);
          tools[asset.guid] = contract;
          for (const declaration of contract.commands) {
            if (declaration.executor === undefined) continue;
            await exportProgram(declaration.executor);
          }
        }
    }
    // Read across the entire pack, retaining authored result order and one byte
    // lease per stored path. Native Hosts need no browser Response implementation.
    const reads = pack.assets.flatMap((asset) =>
      Object.entries(asset.artifacts).map(([artifactKey, descriptor]) => ({
        asset,
        artifactKey,
        descriptor,
      })),
    );
    const results: PromiseSettledResult<Result<Uint8Array, AssetArtifactError | AssetLoadError>>[] =
      new Array(reads.length);
    let next = 0;
    const worker = async () => {
      while (next < reads.length) {
        const index = next++;
        const read = reads[index];
        if (read === undefined) continue;
        const { asset, artifactKey, descriptor } = read;
        try {
          options.signal?.throwIfAborted();
          if (existing !== undefined && descriptor.byteRange === undefined) {
            const captured = await existing.readArtifact(
              { packageUrl: row.packageUrl, guid: asset.guid, artifactKey, descriptor },
              signal,
              bound,
            );
            if (captured.ok)
              bodies.set(
                descriptor.path,
                Promise.resolve(ok(captured.value.stored as Uint8Array<ArrayBuffer>)),
              );
            results[index] = {
              status: 'fulfilled',
              value: captured.ok ? ok(captured.value.decoded) : captured,
            };
            continue;
          }
          const verified = await readArtifact(
            { packageUrl: row.packageUrl, guid: asset.guid, artifactKey, descriptor },
            async (url) => {
              let bytes = bodies.get(descriptor.path);
              if (bytes === undefined) {
                bytes = (async () => {
                  const response = await bound(url, request);
                  if (!response.ok) {
                    bodies.delete(descriptor.path);
                    return err(response);
                  }
                  // Descriptor integrity describes decoded bytes. Preserve the stored encoding.
                  return ok(new Uint8Array(await response.arrayBuffer()));
                })().catch((error) => {
                  if (bodies.get(descriptor.path) === bytes) bodies.delete(descriptor.path);
                  throw error;
                });
                bodies.set(descriptor.path, bytes);
              }
              const body = await bytes;
              return body.ok ? createPackageResponse(body.value) : body.error;
            },
          );
          results[index] = { status: 'fulfilled', value: verified };
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CAPTURE_READ_CONCURRENCY, reads.length) }, worker),
    );
    options.signal?.throwIfAborted();
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      if (!result.value.ok) return result.value;
    }
    options.signal?.throwIfAborted();
    return validateFixedPackPublication(
      {
        pack,
        rows,
        blobs: Object.fromEntries(
          await Promise.all(
            [...bodies].map(async ([path, bytes]) => [path, (await bytes).unwrap()]),
          ),
        ),
        ...(Object.keys(executions).length ? { executions } : {}),
      },
      row,
    );
  } catch (cause) {
    if (options.signal?.aborted) return err(assetLoadCancelled(selected.guid));
    return err({
      code: 'asset-package-invalid',
      expected: 'one complete fixed publication with portable artifacts and programs',
      hint: 'restore the published bytes and program closure before saving this dependency',
      detail: {
        guid: selected.guid,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    });
  } finally {
    reader.dispose();
  }
}
