import { err, ok, type Result } from '@forgeax/engine-rhi';
import { ASSET_ERROR_HINTS, AssetError, type CatalogProjection } from '@forgeax/engine-types';
import type { CatalogRecord } from './catalog';

export interface RuntimeProjection {
  readonly subject: CatalogProjection['subject'];
  readonly execution: CatalogProjection['execution'];
  readonly lifecycle: CatalogProjection['lifecycle'];
  readonly packageUrl: string;
}

function projectionError(guid: string, expected: string): AssetError {
  return new AssetError({
    code: 'asset-not-imported',
    expected,
    hint: `${ASSET_ERROR_HINTS['asset-not-imported']} (GUID ${guid})`,
  });
}

/**
 * Resolve the producer-declared runtime projection. Legacy rows return
 * undefined so inline/dev assets retain their existing registration path;
 * rows that publish any projection axis must publish all three axes.
 */
export function resolveRuntimeProjection(
  guid: string,
  record: CatalogRecord,
): Result<RuntimeProjection | undefined, AssetError> {
  const hasAxes =
    record.subject !== undefined ||
    record.execution !== undefined ||
    record.lifecycle !== undefined ||
    record.projection !== undefined;
  if (!hasAxes) return ok(undefined);

  const projection = record.projection;
  if (
    projection === undefined ||
    record.subject === undefined ||
    record.execution === undefined ||
    record.lifecycle === undefined
  ) {
    return err(
      projectionError(
        guid,
        'catalog entry to publish subject, execution, lifecycle, and projection together',
      ),
    );
  }
  if (
    projection.subject !== record.subject ||
    projection.execution !== record.execution ||
    projection.lifecycle !== record.lifecycle
  ) {
    return err(projectionError(guid, 'catalog projection axes to agree with their row fields'));
  }
  return ok({
    subject: projection.subject,
    execution: projection.execution,
    lifecycle: projection.lifecycle,
    packageUrl: record.packageUrl,
  });
}
