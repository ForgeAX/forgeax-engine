export function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected the UI fixture value to exist');
  return value;
}

/** File commands and screenshots have different relative roots in Vitest. */
export function uiEvidenceDirectory(testPath: string, name: string): string {
  const path = testPath.replaceAll('\\', '/');
  const packageStart = path.lastIndexOf('/packages/ui-blitz/');
  if (packageStart < 0) throw new Error(`UI test is outside its package: ${testPath}`);
  return `${path.slice(0, packageStart)}/artifacts/${name}`;
}
