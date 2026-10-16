import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const PNG_1X1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
);

export type FixtureFiles = Readonly<Record<string, string | Uint8Array>>;

export async function withFixture<T>(
  files: FixtureFiles,
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'feature-lab-import-loading-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function imageMeta(guid: string): string {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    importSettings: {},
    subAssets: [{ guid, sourceIndex: 0, kind: 'texture' }],
  });
}

export function codeOf(error: unknown): string {
  return String((error as { code?: unknown } | undefined)?.code);
}
