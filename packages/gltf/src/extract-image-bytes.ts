// extract-image-bytes.ts - resolve glTF `images[<imageIndex>]` into raw
// PNG / JPEG bytes (feat-20260608 M3 D-6 / requirements AC-08 + AC-09 + AC-10).
//
// The gltfImporter walks `images[]` and funnels three image source paths
// through a single decode seam:
//   (a) bufferView    : slice the named buffer at the bufferView range
//   (b) data: URI     : base64-decode the URI payload
//   (c) external URI  : ctx.readSibling(uri) reads the file co-located
//                       with the .gltf source
//
// This module owns the byte-extraction (no decoding); decoding is the job of
// ctx.decodeImage (D-1 seam: gltfImporter never imports
// `@forgeax/engine-image` directly). On any failure the caller produces a
// `gltf-image-extract-failed` GltfError carrying { imageIndex, source,
// reason }.
//
// Why not reuse parse-gltf.ts's buffer resolution? parseGltf.ts encapsulates
// buffer / bufferView decoding inside `parseGltfWithBin` and never surfaces
// the byte arrays. Re-running that machinery for image extraction would
// double the work; instead the gltfImporter parses the doc twice (parseGltf
// for the IR, this helper for the raw bytes) — both passes are O(file
// size) and the importer only runs at build time.

import type { ImportContext, ImportError as ImportErrorType } from '@forgeax/engine-types';
import { dataUriBase64Payload, decodeBase64 } from './data-uri.js';
import { parseGlbChunks } from './parse-glb-chunks.js';

/** Source of an image: matches `GltfImageExtractFailedDetail.source`. */
export type ImageSourceKind = 'bufferView' | 'data-uri' | 'external-uri';

/** One extracted image: bytes + the source kind that produced them. */
export interface ExtractedImage {
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/png' | 'image/jpeg';
  readonly source: ImageSourceKind;
}

/**
 * Failure shape — the importer wraps this in a `gltf-image-extract-failed`
 * GltfError. `source` may be undefined when the image row is malformed
 * (no uri / no bufferView), so the importer can name 'bufferView' (most
 * common) by default.
 */
export interface ExtractFailure {
  readonly imageIndex: number;
  readonly source: ImageSourceKind;
  readonly reason: string;
}

const DATA_URI_MIME_RE = /^data:([^;,]+)(?:;[^,;]+)*;base64,/;

/** Pull the source-read-failed reason out of an ImportError without
 * widening the discriminated union — the caller only ever sees
 * source-read-failed here (readSibling's only failure shape). The
 * ImportError class carries a structurally typed `.detail` field that does
 * not auto-narrow on the `.code` discriminator, so we read `.message`
 * which the class composes from `expected: ...; reason: ...`. */
function describeImportError(err: ImportErrorType): string {
  return err.message;
}

/** Pick PNG vs JPEG from declared mimeType + magic-byte fallback. */
function classifyMime(
  declaredMime: string | undefined,
  bytes: Uint8Array,
): 'image/png' | 'image/jpeg' | undefined {
  if (declaredMime === 'image/png' || declaredMime === 'image/jpeg') return declaredMime;
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return undefined;
}

interface BufferViewJsonSlim {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
}

interface ImageJsonSlim {
  readonly uri?: string;
  readonly mimeType?: string;
  readonly bufferView?: number;
}

interface BufferJsonSlim {
  readonly uri?: string;
  readonly byteLength: number;
}

interface RootJsonSlim {
  readonly images?: readonly ImageJsonSlim[];
  readonly bufferViews?: readonly BufferViewJsonSlim[];
  readonly buffers?: readonly BufferJsonSlim[];
}

/**
 * Extract raw image bytes for every `images[]` row in the parsed glTF doc.
 *
 * @param sourceBytes the original .glb / .gltf file bytes (the GLB BIN
 *   chunk is reconstructed from these for buffer-0 lookups).
 * @param sourcePath  the meta.source path; used only for diagnostics
 *   (parseGlbChunks errors carry it through).
 * @param ctx         the ImportContext — reused for `readSibling` (external
 *   buffer .bin / external image .png/.jpg). data: URIs do not call ctx.
 *
 * Returns a Map<imageIndex, ExtractedImage> with one entry per resolved
 * image. Rows that fail to extract are returned in `failures[]` so the
 * caller can emit one `gltf-image-extract-failed` per failure (single
 * failure does not abort the whole importer — the runner's GUID iron-law
 * check then surfaces missing image GUIDs as a structured outage instead
 * of the silent white-box render).
 */
export async function extractImageBytes(
  sourceBytes: Uint8Array,
  sourcePath: string,
  ctx: ImportContext,
): Promise<{
  readonly extracted: ReadonlyMap<number, ExtractedImage>;
  readonly failures: readonly ExtractFailure[];
}> {
  const isGlb = sourcePath.toLowerCase().endsWith('.glb');
  let json: RootJsonSlim;
  let glbBin: Uint8Array | undefined;

  if (isGlb) {
    const ab = sourceBytes.buffer.slice(
      sourceBytes.byteOffset,
      sourceBytes.byteOffset + sourceBytes.byteLength,
    ) as ArrayBuffer;
    const chunks = parseGlbChunks(ab, sourcePath);
    if (!chunks.ok) {
      return {
        extracted: new Map(),
        failures: [
          {
            imageIndex: -1,
            source: 'bufferView',
            reason: `GLB chunk parse failed: ${chunks.error.code}`,
          },
        ],
      };
    }
    try {
      json = JSON.parse(new TextDecoder().decode(chunks.value.jsonChunk)) as RootJsonSlim;
    } catch (e) {
      return {
        extracted: new Map(),
        failures: [
          {
            imageIndex: -1,
            source: 'bufferView',
            reason: `GLB JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
      };
    }
    glbBin = chunks.value.binChunk;
  } else {
    try {
      json = JSON.parse(new TextDecoder().decode(sourceBytes)) as RootJsonSlim;
    } catch (e) {
      return {
        extracted: new Map(),
        failures: [
          {
            imageIndex: -1,
            source: 'bufferView',
            reason: `gltf JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
      };
    }
  }

  const images = json.images ?? [];
  const bufferViews = json.bufferViews ?? [];
  const buffersJson = json.buffers ?? [];
  const extracted = new Map<number, ExtractedImage>();
  const failures: ExtractFailure[] = [];

  // Resolve buffers (lazy: only buffers actually referenced by images get fetched).
  const buffersCache = new Map<number, Uint8Array | { readonly error: ImportErrorType | string }>();
  async function getBuffer(bufferIndex: number): Promise<Uint8Array | { readonly error: string }> {
    const cached = buffersCache.get(bufferIndex);
    if (cached !== undefined) {
      if (cached instanceof Uint8Array) return cached;
      const e = cached.error;
      return { error: typeof e === 'string' ? e : e.message };
    }
    const bufJson = buffersJson[bufferIndex];
    if (bufJson === undefined) {
      const reason = `buffer index ${bufferIndex} out of range (have ${buffersJson.length})`;
      buffersCache.set(bufferIndex, { error: reason });
      return { error: reason };
    }
    if (bufJson.uri === undefined) {
      // GLB BIN chunk slot — buffer-0.
      if (glbBin === undefined) {
        const reason = `buffer ${bufferIndex} has no uri and no GLB BIN chunk available`;
        buffersCache.set(bufferIndex, { error: reason });
        return { error: reason };
      }
      buffersCache.set(bufferIndex, glbBin);
      return glbBin;
    }
    const dataPayload = dataUriBase64Payload(bufJson.uri);
    if (dataPayload !== undefined) {
      try {
        const bytes = decodeBase64(dataPayload);
        buffersCache.set(bufferIndex, bytes);
        return bytes;
      } catch (e) {
        const reason = `buffer ${bufferIndex} data URI base64 decode failed: ${e instanceof Error ? e.message : String(e)}`;
        buffersCache.set(bufferIndex, { error: reason });
        return { error: reason };
      }
    }
    const sib = await ctx.readSibling(bufJson.uri);
    if (!sib.ok) {
      const reason = `external buffer "${bufJson.uri}" read failed: ${describeImportError(sib.error)}`;
      buffersCache.set(bufferIndex, { error: reason });
      return { error: reason };
    }
    buffersCache.set(bufferIndex, sib.value);
    return sib.value;
  }

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (img === undefined) continue;

    if (img.bufferView !== undefined) {
      const bv = bufferViews[img.bufferView];
      if (bv === undefined) {
        failures.push({
          imageIndex: i,
          source: 'bufferView',
          reason: `bufferView index ${img.bufferView} out of range`,
        });
        continue;
      }
      const buf = await getBuffer(bv.buffer);
      if (!(buf instanceof Uint8Array)) {
        failures.push({ imageIndex: i, source: 'bufferView', reason: buf.error });
        continue;
      }
      const off = bv.byteOffset ?? 0;
      const len = bv.byteLength;
      if (off + len > buf.byteLength) {
        failures.push({
          imageIndex: i,
          source: 'bufferView',
          reason: `bufferView ${img.bufferView} byte range [${off}..${off + len}) exceeds buffer ${bv.buffer} length ${buf.byteLength}`,
        });
        continue;
      }
      const bytes = buf.subarray(off, off + len);
      const mime = classifyMime(img.mimeType, bytes);
      if (mime === undefined) {
        failures.push({
          imageIndex: i,
          source: 'bufferView',
          reason: `unsupported / unrecognised mime (declared "${img.mimeType ?? '<absent>'}", magic byte sniff failed)`,
        });
        continue;
      }
      extracted.set(i, { bytes: new Uint8Array(bytes), mimeType: mime, source: 'bufferView' });
      continue;
    }

    if (img.uri !== undefined) {
      const dataPayload = dataUriBase64Payload(img.uri);
      if (dataPayload !== undefined) {
        let bytes: Uint8Array;
        try {
          bytes = decodeBase64(dataPayload);
        } catch (e) {
          failures.push({
            imageIndex: i,
            source: 'data-uri',
            reason: `base64 decode failed: ${e instanceof Error ? e.message : String(e)}`,
          });
          continue;
        }
        const mimeMatch = DATA_URI_MIME_RE.exec(img.uri);
        const declaredMime = mimeMatch?.[1] ?? img.mimeType;
        const mime = classifyMime(declaredMime, bytes);
        if (mime === undefined) {
          failures.push({
            imageIndex: i,
            source: 'data-uri',
            reason: `data: URI mime "${declaredMime ?? '<absent>'}" not png/jpeg`,
          });
          continue;
        }
        extracted.set(i, { bytes, mimeType: mime, source: 'data-uri' });
        continue;
      }
      const sib = await ctx.readSibling(img.uri);
      if (!sib.ok) {
        failures.push({
          imageIndex: i,
          source: 'external-uri',
          reason: `external URI "${img.uri}" read failed: ${describeImportError(sib.error)}`,
        });
        continue;
      }
      const mime = classifyMime(img.mimeType, sib.value);
      if (mime === undefined) {
        failures.push({
          imageIndex: i,
          source: 'external-uri',
          reason: `external URI "${img.uri}" mime not png/jpeg (declared "${img.mimeType ?? '<absent>'}", magic byte sniff failed)`,
        });
        continue;
      }
      extracted.set(i, {
        bytes: new Uint8Array(sib.value),
        mimeType: mime,
        source: 'external-uri',
      });
      continue;
    }

    failures.push({
      imageIndex: i,
      source: 'bufferView',
      reason: 'image row has neither bufferView nor uri',
    });
  }

  return { extracted, failures };
}
