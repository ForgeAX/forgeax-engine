import { canonicalDdcDigest, writeCanonicalDdcJson } from './canonical-json.js';

export interface SemanticDdcInput {
  readonly schemaVersion: string;
  readonly importer: string;
  readonly codec: string;
  readonly settings: unknown;
  readonly sourceBytes: readonly Uint8Array[];
  readonly declaredGuids: readonly string[];
  readonly targetProfile: string;
  readonly producer: string;
}

export function canonicalDdcJson(value: unknown): string {
  const chunks: string[] = [];
  writeCanonicalDdcJson(value, (chunk) => chunks.push(chunk));
  return chunks.join('');
}

export function semanticDdcKey(input: SemanticDdcInput): string {
  const semantic = {
    schemaVersion: input.schemaVersion,
    importer: input.importer,
    codec: input.codec,
    settings: input.settings,
    sourceBytes: input.sourceBytes,
    declaredGuids: [...input.declaredGuids].sort(),
    targetProfile: input.targetProfile,
    producer: input.producer,
  };
  return canonicalDdcDigest(semantic);
}
