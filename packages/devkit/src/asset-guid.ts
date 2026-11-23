import { AssetGuid, PackageId } from '@forgeax/engine-pack';
import type { CommandResult } from './types.js';
import { failCommand } from './types.js';

export interface AssetGuidOptions {
  readonly packageId?: string;
  readonly key?: string;
}

/**
 * Derive the stable AssetGuid of a Pack subject: UUIDv5 of the sourceKey in the
 * package id namespace. Pure and offline; the same value a build publishes.
 */
export async function assetGuidCommand(
  options: AssetGuidOptions & Record<string, unknown> = {},
): Promise<CommandResult<{ packageId: string; key: string; guid: string }>> {
  const { packageId, key } = options;
  if (typeof packageId !== 'string' || typeof key !== 'string') {
    return failCommand(
      'asset-guid-arguments-missing',
      'forgeax asset guid <packageId> <key>',
      'Pass the Pack package id (dash-form UUID) and the asset sourceKey, for example material/punk-smoke.',
      {},
    );
  }
  const parsed = PackageId.parse(packageId);
  if (!parsed.ok)
    return failCommand(
      'asset-guid-package-id-invalid',
      '36-char RFC 4122 dash-form package id',
      'Copy packageId from the .pack.json or pack.ts definition.',
      { packageId },
    );
  try {
    const guid = AssetGuid.format(AssetGuid.derive(parsed.value, key));
    return { ok: true, value: { packageId: PackageId.format(parsed.value), key, guid } };
  } catch (cause) {
    const failure = cause as { code?: string; expected?: string; hint?: string };
    return failCommand(
      failure.code ?? 'asset-guid-key-invalid',
      failure.expected ?? 'a lower-case "/"-separated sourceKey',
      failure.hint ?? 'Use lower-case segments of a-z, 0-9, ".", "_" or "-".',
      { key },
    );
  }
}
