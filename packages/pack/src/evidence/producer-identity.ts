import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';

export interface ProducerSemanticIdentityInput {
  readonly producerRoot: string;
  readonly sourcePath: string;
  readonly sourceDigest: string;
  readonly schemaVersion: string;
  readonly importer: string;
  readonly codec: string;
  readonly settings: unknown;
  readonly producer: string;
  readonly profile: string;
  readonly declaredGuids?: readonly string[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function producerRelativeLogicalPath(producerRoot: string, sourcePath: string): string {
  const root = resolve(producerRoot);
  const source = resolve(sourcePath);
  const path = relative(root, source);
  if (
    path.length === 0 ||
    path === '..' ||
    path.startsWith(`..${sep}`) ||
    resolve(root, path) !== source
  ) {
    throw new Error('producer source must be inside the injected producer root');
  }
  return path.split(sep).join('/');
}

export function producerRelativeDdcKey(input: ProducerSemanticIdentityInput): string {
  const logicalPath = producerRelativeLogicalPath(input.producerRoot, input.sourcePath);
  const semantic = {
    schemaVersion: input.schemaVersion,
    logicalPath,
    sourceDigest: input.sourceDigest,
    importer: input.importer,
    codec: input.codec,
    settings: stableValue(input.settings),
    producer: input.producer,
    profile: input.profile,
    declaredGuids: [...(input.declaredGuids ?? [])].sort(),
  };
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
}
