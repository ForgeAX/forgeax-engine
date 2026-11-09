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

/**
 * One RFC 9110 byte range: `first-last`, open-ended `first-` (the form
 * HTMLMediaElement sends), or suffix `-length`. Multipart ranges are refused.
 */
function parseByteRange(
  header: string | readonly string[],
  size: number,
): { readonly start: number; readonly end: number } | undefined {
  if (typeof header !== 'string') return undefined;
  const bounded = /^bytes=(\d+)-(\d+)$/.exec(header);
  if (bounded) return { start: Number(bounded[1]), end: Number(bounded[2]) };
  const open = /^bytes=(\d+)-$/.exec(header);
  if (open) return { start: Number(open[1]), end: size - 1 };
  const suffix = /^bytes=-(\d+)$/.exec(header);
  if (!suffix) return undefined;
  const length = Number(suffix[1]);
  if (length === 0) return undefined;
  return { start: Math.max(0, size - length), end: size - 1 };
}

/**
 * The satisfiable single-range window of `header` over `size` bytes:
 * `bytes=a-b`, open-ended `bytes=N-` (what a `<video>` element sends), and
 * suffix `bytes=-N`. Multipart, malformed, empty and out-of-bounds ranges are
 * `undefined` (answered with 416).
 */
function byteRange(
  header: string | readonly string[],
  size: number,
): { readonly start: number; readonly end: number } | undefined {
  const window = parseByteRange(header, size);
  if (window === undefined) return undefined;
  const { start, end } = window;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && end < size
    ? window
    : undefined;
}

/** Server-local representations weakly owned by the existing published raw body. */
export class HttpArtifactCompression {
  private readonly prepared = new WeakMap<Uint8Array, Uint8Array | undefined>();
  private readonly pending = new WeakMap<Uint8Array, Promise<void>>();
  private tail: Promise<void> = Promise.resolve();

  async prepare(artifacts: Iterable<HttpArtifact>): Promise<void> {
    // One queue across callers; small bodies overlap only within its bounded
    // window. A second prepare never creates another set of encoder slots.
    const pending = this.tail.then(() => this.prepareWindowed(artifacts));
    this.tail = pending.catch(() => {});
    await pending;
  }

  private async prepareWindowed(artifacts: Iterable<HttpArtifact>): Promise<void> {
    let pending: Promise<void>[] = [];
    let inputBytes = 0;
    const drain = async (): Promise<void> => {
      const active = pending;
      pending = [];
      inputBytes = 0;
      await Promise.all(active);
    };
    try {
      for (const artifact of artifacts) {
        const bytes = artifact.bytes;
        if (this.prepared.has(bytes) || this.pending.has(bytes)) continue;
        // Keep large inputs exclusive, and bound temporary encoder/output
        // storage independently of how many routes the publication contains.
        if (pending.length > 0 && inputBytes + bytes.byteLength > 4 * 1024 * 1024) await drain();
        const task = this.prepareArtifact(artifact);
        this.pending.set(bytes, task);
        pending.push(task);
        inputBytes += bytes.byteLength;
        if (pending.length === 4 || inputBytes >= 4 * 1024 * 1024) await drain();
      }
    } finally {
      await drain();
    }
  }

  private async prepareArtifact(artifact: HttpArtifact): Promise<void> {
    const bytes = artifact.bytes;
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
      const window = byteRange(range, artifact.bytes.byteLength);
      if (window === undefined) {
        response.statusCode = 416;
        response.setHeader('Content-Range', `bytes */${artifact.bytes.byteLength}`);
        response.setHeader('Content-Length', '0');
        response.end('');
        return;
      }
      const { start, end } = window;
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
