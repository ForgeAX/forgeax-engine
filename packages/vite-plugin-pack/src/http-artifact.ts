import { gzip } from 'node:zlib';

export interface HttpArtifact {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

interface HttpRequest {
  readonly method?: string | undefined;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>> | undefined;
}

interface HttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  getHeader?(name: string): number | string | readonly string[] | undefined;
  removeHeader?(name: string): void;
  end(body: string | Uint8Array): void;
}

function quality(value: string | undefined): number {
  if (value === undefined) return 0;
  const parameter = value
    .split(';')
    .slice(1)
    .find((part) => /^\s*q\s*=/i.test(part));
  if (parameter === undefined) return 1;
  const q = parameter.split('=')[1]?.trim();
  return q !== undefined && /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q) ? Number(q) : 0;
}

function encodingEntry(
  value: string | readonly string[] | undefined,
  name: string,
): string | undefined {
  const entries = (typeof value === 'string' ? value : (value?.join(',') ?? ''))
    .toLowerCase()
    .split(',')
    .map((entry) => entry.trim());
  return entries.find((entry) => entry.split(';')[0]?.trim() === name);
}

export function identityAllowed(value: string | readonly string[] | undefined): boolean {
  const identity = encodingEntry(value, 'identity');
  if (identity !== undefined) return quality(identity) > 0;
  const wildcard = encodingEntry(value, '*');
  return wildcard === undefined || quality(wildcard) > 0;
}

function codingQuality(value: string | readonly string[] | undefined, coding: string): number {
  if (value === undefined) return 1;
  return quality(encodingEntry(value, coding) ?? encodingEntry(value, '*'));
}

function acceptsGzip(value: string | readonly string[] | undefined): boolean {
  if (value === undefined) return false;
  const gzipQuality = codingQuality(value, 'gzip');
  const identity = encodingEntry(value, 'identity');
  return gzipQuality > 0 && (identity === undefined || gzipQuality >= quality(identity));
}

function notAcceptable(response: HttpResponse): void {
  response.statusCode = 406;
  response.removeHeader?.('Content-Encoding');
  response.setHeader('Content-Length', '0');
  response.end('');
}

export function varyEncoding(response: HttpResponse): void {
  const previous = response.getHeader?.('Vary');
  const values = String(previous ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.some((value) => value === '*' || value.toLowerCase() === 'accept-encoding')) {
    values.push('Accept-Encoding');
  }
  response.setHeader('Vary', values.join(', '));
}

/** Server-local representations weakly owned by the existing published raw body. */
export class HttpArtifactCompression {
  private readonly prepared = new WeakMap<Uint8Array, Uint8Array | undefined>();
  private readonly pending = new WeakMap<Uint8Array, Promise<void>>();
  private tail: Promise<void> = Promise.resolve();

  async prepare(artifacts: Iterable<HttpArtifact>): Promise<void> {
    for (const artifact of artifacts) {
      const bytes = artifact.bytes;
      if (this.prepared.has(bytes)) continue;
      let pending = this.pending.get(bytes);
      if (pending === undefined) {
        pending = this.tail.then(async () => {
          if (
            bytes.byteLength < 1024 ||
            !/^(?:application\/(?:x-forgeax-mesh|octet-stream)|text\/(?:wgsl|plain))$/i.test(
              artifact.mimeType,
            )
          ) {
            this.prepared.set(bytes, undefined);
            return;
          }
          const encoded = await new Promise<Uint8Array | undefined>((resolve) => {
            gzip(bytes, { level: 1 }, (error, body) => {
              if (error !== null) {
                console.warn('forgeax: HTTP artifact gzip failed; serving identity', error);
                resolve(undefined);
              } else resolve(body.byteLength < bytes.byteLength ? body : undefined);
            });
          }).catch((error: unknown) => {
            console.warn('forgeax: HTTP artifact gzip failed; serving identity', error);
            return undefined;
          });
          this.prepared.set(bytes, encoded);
        });
        this.pending.set(bytes, pending);
        this.tail = pending;
      }
      await pending;
    }
  }

  /** Never encode in an HTTP request: unprepared or failed bodies remain identity. */
  send(request: HttpRequest, response: HttpResponse, artifact: HttpArtifact): void {
    response.setHeader('Content-Type', artifact.mimeType);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Range, Content-Length, Accept-Ranges',
    );
    varyEncoding(response);
    const range = request.headers?.range;
    const acceptEncoding = request.headers?.['accept-encoding'];
    const existingEncoding = response.getHeader?.('Content-Encoding');
    if (existingEncoding !== undefined) {
      const codings = String(existingEncoding)
        .toLowerCase()
        .split(',')
        .map((coding) => coding.trim());
      if (
        codings.some((coding) =>
          coding === 'identity'
            ? !identityAllowed(acceptEncoding)
            : codingQuality(acceptEncoding, coding) <= 0,
        )
      ) {
        notAcceptable(response);
        return;
      }
    }
    const encoded =
      range === undefined &&
      request.method !== 'HEAD' &&
      existingEncoding === undefined &&
      acceptsGzip(acceptEncoding)
        ? this.prepared.get(artifact.bytes)
        : undefined;
    if (
      existingEncoding === undefined &&
      encoded === undefined &&
      !identityAllowed(acceptEncoding)
    ) {
      notAcceptable(response);
      return;
    }
    if (range !== undefined) {
      const match = typeof range === 'string' ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
      const start = Number(match?.[1]),
        end = Number(match?.[2]);
      if (
        !match ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end >= artifact.bytes.byteLength
      ) {
        response.statusCode = 416;
        response.setHeader('Content-Range', `bytes */${artifact.bytes.byteLength}`);
        response.setHeader('Content-Length', '0');
        response.end('');
        return;
      }
      response.statusCode = 206;
      response.setHeader('Content-Range', `bytes ${start}-${end}/${artifact.bytes.byteLength}`);
      response.setHeader('Content-Length', String(end - start + 1));
      response.end(request.method === 'HEAD' ? '' : artifact.bytes.subarray(start, end + 1));
      return;
    }
    const bytes = encoded ?? artifact.bytes;
    response.statusCode = 200;
    if (encoded !== undefined) response.setHeader('Content-Encoding', 'gzip');
    response.setHeader('Content-Length', String(bytes.byteLength));
    response.end(request.method === 'HEAD' ? '' : bytes);
  }
}
