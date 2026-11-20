import {
  assertMaterialAsset,
  err,
  type MaterialRootAsset,
  type MaterialTemplateSources,
  ok,
  type Result,
} from '@forgeax/engine-types';
import { AssetGuid } from '../guid.js';
import { createMaterialArtifactDigest, type MaterialCookRefs } from './material-cook.js';

export const MATERIAL_TEMPLATE_SOURCES_MEDIA_TYPE = 'application/vnd.forgeax.material-sources+json';

/** The Pack binds a resolved material to immutable WGSL inputs. It carries no selected programs. */
export interface MaterialTemplatePublication {
  readonly schemaVersion: 'material-template/1';
  readonly guid: string;
  readonly resolved: MaterialRootAsset;
  readonly refs: MaterialCookRefs;
  readonly sourceArtifact: {
    readonly path: string;
    readonly digest: string;
  };
}

export type { MaterialTemplateSources } from '@forgeax/engine-types';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Validate the durable contract independently of whether a renderer has a compiler. */
export function validateMaterialTemplatePublication(
  input: unknown,
): Result<MaterialTemplatePublication, string> {
  if (
    !record(input) ||
    input.schemaVersion !== 'material-template/1' ||
    typeof input.guid !== 'string' ||
    !AssetGuid.parse(input.guid).ok ||
    !record(input.sourceArtifact) ||
    typeof input.sourceArtifact.path !== 'string' ||
    typeof input.sourceArtifact.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(input.sourceArtifact.digest) ||
    input.sourceArtifact.path !== `material-sources/${input.sourceArtifact.digest.slice(7)}.json`
  )
    return err('invalid material template identity or source artifact');
  const refs = input.refs;
  if (
    !record(refs) ||
    !strings(refs.parent) ||
    !strings(refs.textures) ||
    !strings(refs.samplers) ||
    !strings(refs.modules)
  )
    return err('invalid material template references');
  try {
    assertMaterialAsset(input.resolved, input.guid);
    if (input.resolved.parent !== undefined || input.resolved.passes?.length === undefined)
      return err('material template requires the resolved root with its passes');
  } catch (cause) {
    return err(cause instanceof Error ? cause.message : String(cause));
  }
  return ok({
    schemaVersion: input.schemaVersion,
    guid: input.guid,
    resolved: input.resolved,
    refs: {
      parent: refs.parent,
      textures: refs.textures,
      samplers: refs.samplers,
      modules: refs.modules,
    },
    sourceArtifact: { path: input.sourceArtifact.path, digest: input.sourceArtifact.digest },
  });
}

function sourceEntries(value: unknown): value is Readonly<Record<string, string>> {
  return record(value) && Object.values(value).every((source) => typeof source === 'string');
}

export function readMaterialTemplateSources(
  bytes: Uint8Array,
  expectedDigest: string,
): Result<MaterialTemplateSources, string> {
  if (createMaterialArtifactDigest(bytes) !== expectedDigest)
    return err('material template source artifact digest mismatch');
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!record(parsed) || !sourceEntries(parsed.engine) || !sourceEntries(parsed.project))
      return err('invalid material template source library');
    return ok({ engine: parsed.engine, project: parsed.project });
  } catch (cause) {
    return err(cause instanceof Error ? cause.message : String(cause));
  }
}
