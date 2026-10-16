import { uuidv7obj } from 'uuidv7';
import { PackError } from './errors.js';
import { uuidV5 } from './uuid-v5.js';

/**
 * 16-byte UUID branded ABI. Prevents assignment from plain Uint8Array or string.
 * Brand field mirrors the declaration in @forgeax/engine-types for cross-package
 * structural compatibility (both use __guidBrand: 'AssetGuid').
 */
export type AssetGuid = Uint8Array & { readonly __guidBrand: 'AssetGuid' };

/** Pack-level identity. It is intentionally not assignable to AssetGuid. */
export type PackageId = Uint8Array & { readonly __packageIdBrand: 'PackageId' };

/** Minimal Result alias for this module (structurally compatible with ScanResult). */
export type GuidResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

function brand(bytes: Uint8Array): AssetGuid {
  return bytes as AssetGuid;
}

const HEX_BYTE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function bytesToDashForm(bytes: Uint8Array): string {
  const h = HEX_BYTE;
  // biome-ignore lint/style/noNonNullAssertion: length guaranteed 16
  return `${h[bytes[0]!]}${h[bytes[1]!]}${h[bytes[2]!]}${h[bytes[3]!]}-${h[bytes[4]!]}${h[bytes[5]!]}-${h[bytes[6]!]}${h[bytes[7]!]}-${h[bytes[8]!]}${h[bytes[9]!]}-${h[bytes[10]!]}${h[bytes[11]!]}${h[bytes[12]!]}${h[bytes[13]!]}${h[bytes[14]!]}${h[bytes[15]!]}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stable author-owned output identity. Paths and payloads are not identity inputs. */
export const PACK_SOURCE_KEY_RE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

export function isValidPackSourceKey(value: unknown): value is string {
  return typeof value === 'string' && PACK_SOURCE_KEY_RE.test(value);
}

export function isValidAssetGuidString(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function dashFormToBytes(dashForm: string): Uint8Array {
  const hex = dashForm.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function randomUuidBytes(): Uint8Array {
  const uuid = uuidv7obj();
  const bytes = new Uint8Array(16);
  bytes.set(uuid.bytes);
  return bytes;
}

function packageId(value: Uint8Array): PackageId {
  return value as PackageId;
}

/** Utilities for the pack-level UUID identity. */
export const PackageId = {
  parse(dashForm: string): GuidResult<PackageId, PackError> {
    const parsed = AssetGuid.parse(dashForm);
    return parsed.ok ? { ok: true, value: packageId(parsed.value) } : parsed;
  },
  format(value: PackageId): string {
    return bytesToDashForm(value);
  },
  random(): PackageId {
    return packageId(randomUuidBytes());
  },
} as const;

function derivedGuid(namespace: PackageId, sourceKey: string): AssetGuid {
  if (!(namespace instanceof Uint8Array) || namespace.byteLength !== 16) {
    throw new TypeError('AssetGuid.derive requires a 16-byte PackageId');
  }
  if (!isValidPackSourceKey(sourceKey)) {
    const error = new TypeError(
      `AssetGuid.derive received invalid sourceKey ${JSON.stringify(sourceKey)}`,
    ) as TypeError & { readonly code?: string };
    Object.defineProperty(error, 'code', { value: 'pack-source-key-invalid' });
    throw error;
  }
  return brand(uuidV5(namespace, sourceKey));
}

/**
 * Utilities for the AssetGuid branded 16-byte UUID type.
 * Declare the type via `import type { AssetGuid } from '@forgeax/engine-pack/guid'`
 * or `import type { AssetGuid } from '@forgeax/engine-types'`.
 */
export const AssetGuid = {
  /**
   * Parse a 36-char RFC 4122 dash-form UUID string into an AssetGuid.
   * Returns Ok(AssetGuid) on success or Err(PackError) with code 'pack-guid-malformed' on failure.
   * Never throws for expected failures (requirements §4.2 / §14 / charter proposition 4).
   */
  parse(dashForm: string): GuidResult<AssetGuid, PackError> {
    if (!isValidAssetGuidString(dashForm)) {
      return {
        ok: false,
        error: new PackError({
          code: 'pack-guid-malformed',
          expected: '36-char RFC 4122 dash-form UUID',
          hint: 'use AssetGuid.random() or a UUIDv7 generator; all GUID fields must be 36-char RFC 4122 dash-form',
          detail: {
            raw: dashForm,
            reason: 'expected 36-char RFC 4122 dash-form UUID',
          },
        }),
      };
    }
    return { ok: true, value: brand(dashFormToBytes(dashForm)) };
  },

  /**
   * Format an AssetGuid as a 36-char RFC 4122 lowercase dash-form string.
   */
  format(guid: AssetGuid): string {
    return bytesToDashForm(guid);
  },

  /**
   * Test byte-by-byte equality between two AssetGuids.
   */
  equals(a: AssetGuid, b: AssetGuid): boolean {
    for (let i = 0; i < 16; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  },

  /**
   * Mint a new time-ordered UUIDv7 as an AssetGuid.
   * Works in both Node.js and browser environments.
   */
  random(): AssetGuid {
    return brand(randomUuidBytes());
  },

  /** Derive the stable UUIDv5 projection for one Pack subject and sourceKey. */
  derive(namespace: PackageId, sourceKey: string): AssetGuid {
    return derivedGuid(namespace, sourceKey);
  },
} as const;
