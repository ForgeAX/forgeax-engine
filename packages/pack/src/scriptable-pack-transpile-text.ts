import { createHash } from 'node:crypto';

/** Disposable derived text owned by one captured source generation, never an admission. */
export interface SnapshotTranspileText {
  readonly key: string;
  readonly filename: string;
  readonly sourceDigest: string;
  readonly recipeDigest: string;
  readonly outputDigest: string;
  readonly outputText: string;
}
export function transpileTextDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
export function snapshotTranspileKey(
  filename: string,
  sourceDigest: string,
  recipeDigest: string,
): string {
  return transpileTextDigest(JSON.stringify([filename, sourceDigest, recipeDigest]));
}
export function snapshotTranspileText(
  filename: string,
  source: string,
  recipeDigest: string,
  outputText: string,
): SnapshotTranspileText {
  const sourceDigest = transpileTextDigest(source);
  return {
    key: snapshotTranspileKey(filename, sourceDigest, recipeDigest),
    filename,
    sourceDigest,
    recipeDigest,
    outputDigest: transpileTextDigest(outputText),
    outputText,
  };
}
export function validSnapshotTranspileText(
  value: unknown,
  filename: string,
  source: string,
  recipeDigest: string,
): value is SnapshotTranspileText {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<SnapshotTranspileText>;
  const sourceDigest = transpileTextDigest(source);
  return (
    entry.filename === filename &&
    entry.recipeDigest === recipeDigest &&
    entry.sourceDigest === sourceDigest &&
    entry.key === snapshotTranspileKey(filename, sourceDigest, recipeDigest) &&
    typeof entry.outputText === 'string' &&
    typeof entry.outputDigest === 'string' &&
    entry.outputDigest === transpileTextDigest(entry.outputText)
  );
}
