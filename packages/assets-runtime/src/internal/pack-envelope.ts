/** Shared admission for HTTP Pack envelopes, before any lookup or cache write. */
export function packEnvelopeIssue(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'envelope';
  const asset = value as Record<string, unknown>;
  if (typeof asset.guid !== 'string' || !isGuid(asset.guid)) return 'guid';
  if (typeof asset.kind !== 'string' || asset.kind.length === 0) return 'kind';
  if (asset.payload === undefined) return 'payload';
  if (asset.refs !== undefined) {
    if (!Array.isArray(asset.refs)) return 'refs';
    const invalid = asset.refs.findIndex((ref) => typeof ref !== 'string' || !isGuid(ref));
    if (invalid !== -1) return `refs[${invalid}]`;
  }
  if (asset.artifacts !== undefined) {
    if (
      asset.artifacts === null ||
      typeof asset.artifacts !== 'object' ||
      Array.isArray(asset.artifacts)
    ) {
      return 'artifacts';
    }
    for (const [key, descriptor] of Object.entries(asset.artifacts)) {
      if (
        key.length === 0 ||
        descriptor === null ||
        typeof descriptor !== 'object' ||
        Array.isArray(descriptor)
      ) {
        return `artifacts.${key}`;
      }
      if (typeof descriptor.mediaType !== 'string') return `artifacts.${key}.mediaType`;
      if (
        descriptor.integrity !== undefined &&
        (descriptor.integrity === null ||
          typeof descriptor.integrity !== 'object' ||
          typeof descriptor.integrity.digest !== 'string' ||
          descriptor.integrity.algorithm !== 'sha256')
      )
        return `artifacts.${key}.integrity`;
      if (typeof descriptor.path !== 'string' || descriptor.path.length === 0)
        return `artifacts.${key}.path`;
    }
  }
  return undefined;
}

function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
