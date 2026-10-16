// controller-db.ts -- pure SDL_GameControllerDB parsing + GUID derivation.
//
// This module holds ONLY pure functions (no DOM, no ECS, no vendored data
// import). The 554KB gamecontrollerdb.txt lives in the separate
// `./controller-db-data` sub-export so it never enters the main-entry
// bundle; the backend dynamic-imports both this module and the data module
// on first sight of a non-standard gamepad (D-2 lazy-load).
//
// SDL GUID reference: KB source
// .forgeax-harness/knowledge-base/sources/2026-07-07-sdl-guid-browser-gamepad-id-mapping.md
//
// D-13 strategy 2: build a match GUID from VID/PID with bus=USB(0x03),
// CRC=0, version=0, driver signature/data=0. This matches the vast
// majority of gamecontrollerdb.txt native entries directly.

/** A single mapping token target: physical button / axis / hat index. */
export type MappingToken =
  | { readonly kind: 'button'; readonly index: number }
  | { readonly kind: 'axis'; readonly index: number; readonly half?: '+' | '-' }
  | { readonly kind: 'hat'; readonly index: number; readonly mask: number };

/**
 * Parsed mapping tokens for one controller entry, keyed by the SDL logical
 * name (`a`, `b`, `leftx`, `dpup`, `lefttrigger`, ...). Values are the
 * physical source (button `bN`, axis `aN`, hat `hN.M`).
 */
export type MappingTokens = Readonly<Record<string, MappingToken>>;

/** One controller-DB row: its platform section + parsed mapping tokens. */
export interface ControllerDbEntry {
  readonly platform: string | undefined;
  readonly tokens: MappingTokens;
}

/**
 * Parsed controller DB: SDL GUID (32-char hex) -> one entry per platform
 * section. The same GUID can appear in multiple platform sections, so the
 * value is an array.
 */
export type ControllerDb = Readonly<Record<string, readonly ControllerDbEntry[]>>;

/** Recognised web platform section labels (D-13). */
const CONTROLLER_PLATFORMS = ['Windows', 'Mac OS X', 'Linux', 'Android', 'iOS'] as const;
export type ControllerPlatform = (typeof CONTROLLER_PLATFORMS)[number];

/** Parse one `key:source` mapping token into a MappingToken. */
function parseMappingToken(source: string): MappingToken | undefined {
  // Half-axis prefix: +aN / -aN.
  let half: '+' | '-' | undefined;
  let body = source;
  if (body.startsWith('+') || body.startsWith('-')) {
    half = body[0] as '+' | '-';
    body = body.slice(1);
  }
  const prefix = body[0];
  if (prefix === 'b') {
    const index = Number.parseInt(body.slice(1), 10);
    return Number.isNaN(index) ? undefined : { kind: 'button', index };
  }
  if (prefix === 'a') {
    const index = Number.parseInt(body.slice(1), 10);
    if (Number.isNaN(index)) return undefined;
    return half ? { kind: 'axis', index, half } : { kind: 'axis', index };
  }
  if (prefix === 'h') {
    // hN.M -- hat N, direction mask M.
    const dot = body.indexOf('.');
    if (dot < 0) return undefined;
    const index = Number.parseInt(body.slice(1, dot), 10);
    const mask = Number.parseInt(body.slice(dot + 1), 10);
    return Number.isNaN(index) || Number.isNaN(mask) ? undefined : { kind: 'hat', index, mask };
  }
  return undefined;
}

/**
 * Parse a gamecontrollerdb.txt string into a ControllerDb map. Comment
 * (`#`) and blank lines are skipped. Each data line is
 * `GUID,Name,token:source,...,platform:PLATFORM,`.
 */
export function parseControllerDb(txt: string): ControllerDb {
  const db: Record<string, ControllerDbEntry[]> = {};
  for (const rawLine of txt.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const fields = line.split(',');
    const guid = fields[0];
    if (!guid || guid.length !== 32) continue;
    let platform: string | undefined;
    const tokens: Record<string, MappingToken> = {};
    // fields[1] is the human-readable name; mapping tokens start at index 2.
    for (let i = 2; i < fields.length; i++) {
      const field = fields[i];
      if (!field) continue;
      const colon = field.indexOf(':');
      if (colon < 0) continue;
      const key = field.slice(0, colon);
      const source = field.slice(colon + 1);
      if (key === 'platform') {
        platform = source;
        continue;
      }
      // crc / sdk / hint fields are not physical mappings; skip non b/a/h.
      const token = parseMappingToken(source);
      if (token) tokens[key] = token;
    }
    const entry: ControllerDbEntry = { platform, tokens };
    const bucket = db[guid];
    if (bucket) {
      bucket.push(entry);
    } else {
      db[guid] = [entry];
    }
  }
  return db;
}

/** Format a 16-bit value as a 4-char little-endian hex pair. */
function le16Hex(value: number): string {
  const lo = value & 0xff;
  const hi = (value >> 8) & 0xff;
  return lo.toString(16).padStart(2, '0') + hi.toString(16).padStart(2, '0');
}

/**
 * Build a 32-char SDL GUID hex from a VID/PID pair (D-13 strategy 2):
 * bus (default USB 0x03) + CRC=0 + VID + fill + PID + fill + version=0 +
 * driver sig/data=0. Each 16-bit field is little-endian within the string.
 *
 * Example: buildGuidFromVidPid(0x045e, 0x028e) ->
 * '030000005e0400008e02000000000000' (Xbox 360).
 */
export function buildGuidFromVidPid(vid: number, pid: number, bus = 0x03): string {
  return (
    le16Hex(bus) + // bytes 0-1: bus type
    '0000' + // bytes 2-3: CRC = 0
    le16Hex(vid) + // bytes 4-5: VID (LE)
    '0000' + // bytes 6-7: fill
    le16Hex(pid) + // bytes 8-9: PID (LE)
    '0000' + // bytes 10-11: fill
    '0000' + // bytes 12-13: version = 0
    '0000' // bytes 14-15: driver signature + data = 0
  );
}

const CHROME_VENDOR_RE = /Vendor:\s*([0-9a-f]{1,4})/i;
const CHROME_PRODUCT_RE = /Product:\s*([0-9a-f]{1,4})/i;

/**
 * Extract an SDL GUID from a browser `Gamepad.id` string. Handles the
 * Chrome/Edge (`Vendor: XXXX Product: YYYY`) and Firefox (`VID-PID-Name`,
 * leading-zero tolerant) formats. Returns undefined when VID/PID cannot be
 * extracted (Safari name-only strings, XInput devices) so the caller keeps
 * the Feat1 empty-signal (graceful degradation, R-3).
 */
export function extractGuidFromGamepadId(id: string): string | undefined {
  // XInput devices expose no VID/PID in either Chrome or Firefox.
  if (id.toLowerCase().includes('xinput')) return undefined;

  // Chrome / Edge: "... (STANDARD GAMEPAD Vendor: 054c Product: 09cc)".
  const vendorMatch = id.match(CHROME_VENDOR_RE);
  const productMatch = id.match(CHROME_PRODUCT_RE);
  if (vendorMatch?.[1] && productMatch?.[1]) {
    const vid = Number.parseInt(vendorMatch[1], 16);
    const pid = Number.parseInt(productMatch[1], 16);
    if (!Number.isNaN(vid) && !Number.isNaN(pid)) return buildGuidFromVidPid(vid, pid);
  }

  // Firefox: "046d-c216-Logitech Dual Action" (VID-PID-Name). The first two
  // dash segments must be pure hex; a name-only Safari string fails this.
  const parts = id.split('-');
  if (parts.length >= 3 && parts[0] && parts[1]) {
    const vidHex = parts[0];
    const pidHex = parts[1];
    if (/^[0-9a-f]{1,4}$/i.test(vidHex) && /^[0-9a-f]{1,4}$/i.test(pidHex)) {
      const vid = Number.parseInt(vidHex, 16);
      const pid = Number.parseInt(pidHex, 16);
      if (!Number.isNaN(vid) && !Number.isNaN(pid)) return buildGuidFromVidPid(vid, pid);
    }
  }

  return undefined;
}

/**
 * Map a `navigator.userAgent` string to a gamecontrollerdb.txt platform
 * section label (D-13). Returns undefined when the UA is unrecognised, in
 * which case the caller falls back to any-platform entry selection.
 */
export function platformFromUserAgent(ua: string): ControllerPlatform | undefined {
  // Order matters: iOS + Android both contain substrings that overlap with
  // the desktop checks, so test the mobile/specific cases first.
  if (/iPhone|iPad|iPod/.test(ua)) return CONTROLLER_PLATFORMS[4];
  if (/Android/.test(ua)) return CONTROLLER_PLATFORMS[3];
  if (/Windows/.test(ua)) return CONTROLLER_PLATFORMS[0];
  if (/Mac OS X|Macintosh/.test(ua)) return CONTROLLER_PLATFORMS[1];
  if (/Linux/.test(ua)) return CONTROLLER_PLATFORMS[2];
  return undefined;
}

/**
 * Select the best mapping entry for a GUID: prefer the entry whose platform
 * section matches `platform`, else fall back to the first available entry
 * (any platform). Returns undefined when the GUID is absent from the DB.
 */
export function selectBestMappingEntry(
  db: ControllerDb,
  guid: string,
  platform: string | undefined,
): ControllerDbEntry | undefined {
  const entries = db[guid];
  if (!entries || entries.length === 0) return undefined;
  if (platform) {
    const match = entries.find((e) => e.platform === platform);
    if (match) return match;
  }
  return entries[0];
}
