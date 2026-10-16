import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type FixtureFiles = Readonly<Record<string, string | Uint8Array>>;

export async function writeFixture(root: string, files: FixtureFiles): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export async function withFixture<T>(
  files: FixtureFiles,
  body: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'feature-lab-asset-identity-'));
  try {
    await writeFixture(root, files);
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function imageMeta(guid: string, extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    importSettings: {},
    subAssets: [{ guid, sourceIndex: 0, kind: 'texture' }],
    ...extra,
  });
}

export function errorCode(result: {
  readonly ok: boolean;
  readonly error?: { readonly code?: string };
}): string {
  return result.ok ? 'ok' : String(result.error?.code);
}
