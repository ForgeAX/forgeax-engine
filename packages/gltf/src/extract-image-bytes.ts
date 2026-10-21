import type { BufferViewJson } from './accessor/decode-accessor.js';
import { dataUriBase64Payload, decodeBase64 } from './data-uri.js';
import { err, type GltfError, gltfErr, ok, type Result } from './errors.js';

export interface GltfImageJson {
  readonly name?: string;
  readonly mimeType?: string;
  readonly uri?: string;
  readonly bufferView?: number;
}

/** Source locators are resolved while the parser owns their backing buffers. */
export interface GltfImageIr {
  readonly name?: string;
  readonly mimeType?: string;
  readonly source:
    | { readonly kind: 'bufferView'; readonly bytes: Result<Uint8Array, string> }
    | { readonly kind: 'data-uri'; readonly uri: string }
    | { readonly kind: 'external-uri'; readonly uri: string; readonly bytes: Uint8Array };
}

type ImageSourceKind = GltfImageIr['source']['kind'];
interface ExtractedImage {
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/png' | 'image/jpeg';
  readonly source: ImageSourceKind;
}
interface ExtractFailure {
  readonly imageIndex: number;
  readonly source: ImageSourceKind;
  readonly reason: string;
}
const DATA_URI_MIME_RE = /^data:([^;,]+)(?:;[^,;]+)*;base64,/;

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

function imageBufferView(
  index: number,
  bufferViews: readonly BufferViewJson[],
  buffers: readonly Uint8Array[],
): Result<Uint8Array, string> {
  const view = bufferViews[index];
  if (view === undefined) return err(`bufferView index ${index} out of range`);
  const buffer = buffers[view.buffer];
  if (buffer === undefined)
    return err(`buffer index ${view.buffer} out of range (have ${buffers.length})`);
  const offset = view.byteOffset ?? 0;
  const length = view.byteLength;
  if (offset + length > buffer.byteLength) {
    return err(
      `bufferView ${index} byte range [${offset}..${offset + length}) exceeds buffer ${view.buffer} length ${buffer.byteLength}`,
    );
  }
  return ok(buffer.slice(offset, offset + length));
}

export async function parseGltfImages(
  images: readonly GltfImageJson[],
  bufferViews: readonly BufferViewJson[],
  buffers: readonly Uint8Array[],
  externalLoader: (uri: string) => Promise<ArrayBuffer>,
): Promise<Result<GltfImageIr[], GltfError>> {
  // Preserve the document's MIME admission before any external image read.
  for (const image of images) {
    const mimeType = image.mimeType;
    if (mimeType !== undefined && mimeType !== 'image/jpeg' && mimeType !== 'image/png')
      return err(gltfErr('gltf-image-mime-unsupported', { mimeType }));
  }
  const result: GltfImageIr[] = [];
  for (const image of images) {
    let source: GltfImageIr['source'];
    if (image.bufferView !== undefined) {
      source = {
        kind: 'bufferView',
        bytes: imageBufferView(image.bufferView, bufferViews, buffers),
      };
    } else if (image.uri !== undefined) {
      if (dataUriBase64Payload(image.uri) !== undefined)
        source = { kind: 'data-uri', uri: image.uri };
      else {
        try {
          source = {
            kind: 'external-uri',
            uri: image.uri,
            bytes: new Uint8Array(await externalLoader(image.uri)),
          };
        } catch {
          return err(gltfErr('gltf-texture-load-failed', { uri: image.uri }));
        }
      }
    } else source = { kind: 'bufferView', bytes: err('image row has neither bufferView nor uri') };
    result.push({
      source,
      ...(image.name === undefined ? {} : { name: image.name }),
      ...(image.mimeType === undefined ? {} : { mimeType: image.mimeType }),
    });
  }
  return ok(result);
}

/** No source parsing or I/O: extraction consumes the parser's accepted image sources. */
export function extractImageBytes(images: readonly GltfImageIr[]): {
  readonly extracted: ReadonlyMap<number, ExtractedImage>;
  readonly failures: readonly ExtractFailure[];
} {
  const extracted = new Map<number, ExtractedImage>();
  const failures: ExtractFailure[] = [];
  for (const [imageIndex, image] of images.entries()) {
    const source = image.source;
    let bytes: Uint8Array;
    let declaredMime = image.mimeType;
    if (source.kind === 'bufferView') {
      if (!source.bytes.ok) {
        failures.push({ imageIndex, source: source.kind, reason: source.bytes.error });
        continue;
      }
      bytes = source.bytes.value;
    } else if (source.kind === 'external-uri') bytes = source.bytes;
    else {
      try {
        bytes = decodeBase64(dataUriBase64Payload(source.uri) ?? '');
      } catch (error) {
        failures.push({
          imageIndex,
          source: source.kind,
          reason: `base64 decode failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      declaredMime = DATA_URI_MIME_RE.exec(source.uri)?.[1] ?? declaredMime;
    }
    const mimeType = classifyMime(declaredMime, bytes);
    if (mimeType === undefined) {
      const reason =
        source.kind === 'bufferView'
          ? `unsupported / unrecognised mime (declared "${declaredMime ?? '<absent>'}", magic byte sniff failed)`
          : source.kind === 'data-uri'
            ? `data: URI mime "${declaredMime ?? '<absent>'}" not png/jpeg`
            : `external URI "${source.uri}" mime not png/jpeg (declared "${declaredMime ?? '<absent>'}", magic byte sniff failed)`;
      failures.push({ imageIndex, source: source.kind, reason });
    } else extracted.set(imageIndex, { bytes, mimeType, source: source.kind });
  }
  return { extracted, failures };
}
