import { err, ok, RenderGraphError, type Result } from '../errors.js';

export const COLOR_VALUE_DOMAINS = ['linear-hdr', 'linear-ldr', 'display-encoded'] as const;

export type ColorValueDomain = (typeof COLOR_VALUE_DOMAINS)[number];

export type ColorDomainConversion =
  | { readonly kind: 'encode-srgb' }
  | { readonly kind: 'decode-srgb' }
  | { readonly kind: 'tone-map' };

export interface ColorResourceDescriptor {
  readonly domain: ColorValueDomain;
  readonly format: string;
}

export interface ColorDomainConnection {
  readonly source: string;
  readonly destination: string;
  readonly conversion?: ColorDomainConversion | undefined;
}

export type ColorDomainValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: RenderGraphError };

export function isColorValueDomain(value: unknown): value is ColorValueDomain {
  return typeof value === 'string' && COLOR_VALUE_DOMAINS.includes(value as ColorValueDomain);
}

function invalidDomain(value: unknown): RenderGraphError {
  return new RenderGraphError({
    code: 'invalid-color-domain',
    expected: `domain is one of ${COLOR_VALUE_DOMAINS.join(', ')}`,
    hint: 'set an explicit color domain; do not infer it from the attachment format',
    detail: { value: String(value) },
  });
}

function missingDomain(resourceKey?: string): RenderGraphError {
  return new RenderGraphError({
    code: 'missing-color-domain',
    expected: 'every connected color resource has an explicit domain',
    hint: `add domain to the color resource descriptor${resourceKey === undefined ? '' : ` '${resourceKey}'`}`,
    detail: { resourceKey: resourceKey ?? '<descriptor>' },
  });
}

export function serializeColorValueDomain(domain: ColorValueDomain): string {
  if (!isColorValueDomain(domain)) throw invalidDomain(domain);
  return JSON.stringify(domain);
}

export function deserializeColorValueDomain(
  value: unknown,
): Result<ColorValueDomain, RenderGraphError> {
  let candidate = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      candidate = value;
    }
  }
  return isColorValueDomain(candidate) ? ok(candidate) : err(invalidDomain(candidate));
}

export function serializeColorResourceDescriptor(descriptor: ColorResourceDescriptor): string {
  if (!isColorValueDomain(descriptor.domain)) throw invalidDomain(descriptor.domain);
  return JSON.stringify(descriptor);
}

export function deserializeColorResourceDescriptor(
  value: unknown,
): Result<ColorResourceDescriptor, RenderGraphError> {
  if (typeof value !== 'object' || value === null) return err(missingDomain());
  const candidate = value as { domain?: unknown; format?: unknown };
  if (candidate.domain === undefined) return err(missingDomain());
  if (!isColorValueDomain(candidate.domain)) return err(invalidDomain(candidate.domain));
  if (typeof candidate.format !== 'string' || candidate.format.length === 0) {
    return err(
      new RenderGraphError({
        code: 'invalid-color-domain',
        expected: 'color resource descriptor includes a non-empty format',
        hint: 'set format separately from the explicit color domain',
        detail: { value: String(candidate.format) },
      }),
    );
  }
  return ok({ domain: candidate.domain, format: candidate.format });
}

function conversionMatches(
  source: ColorValueDomain,
  destination: ColorValueDomain,
  conversion: ColorDomainConversion,
): boolean {
  if (conversion.kind === 'encode-srgb') {
    return (
      (source === 'linear-hdr' || source === 'linear-ldr') && destination === 'display-encoded'
    );
  }
  if (conversion.kind === 'decode-srgb') {
    return (
      source === 'display-encoded' && (destination === 'linear-hdr' || destination === 'linear-ldr')
    );
  }
  return (
    source === 'linear-hdr' && (destination === 'linear-ldr' || destination === 'display-encoded')
  );
}

export function validateColorDomainConnection(
  source: unknown,
  destination: unknown,
  conversion?: ColorDomainConversion,
): ColorDomainValidation {
  if (source === undefined || source === null) return { ok: false, error: missingDomain('source') };
  if (destination === undefined || destination === null) {
    return { ok: false, error: missingDomain('destination') };
  }
  if (!isColorValueDomain(source)) return { ok: false, error: invalidDomain(source) };
  if (!isColorValueDomain(destination)) return { ok: false, error: invalidDomain(destination) };
  if (source === destination) return { ok: true };
  if (conversion !== undefined && conversionMatches(source, destination, conversion)) {
    return { ok: true };
  }
  return {
    ok: false,
    error: new RenderGraphError({
      code: 'color-domain-mismatch',
      expected: `source and destination share a domain or use an explicit valid conversion (${source} -> ${destination})`,
      hint: 'insert an explicit linear blend or output encoding pass; never mix into an encoded destination',
      detail: { sourceDomain: source, destinationDomain: destination },
    }),
  };
}

export { invalidDomain, missingDomain };
