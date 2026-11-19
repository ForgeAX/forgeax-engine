import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Durable authoring selection only; runtime handles and tokens never persist. */
export function createWorkspaceSelection(root: string) {
  const path = join(root, '.forgeax', 'host', 'workspace-selection.json');
  return {
    async read(): Promise<string | null | undefined> {
      try {
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (
          !value ||
          typeof value !== 'object' ||
          !('schemaVersion' in value) ||
          value.schemaVersion !== 1 ||
          !('project' in value) ||
          (value.project !== null && typeof value.project !== 'string')
        )
          throw new Error('Invalid persisted workspace project selection.');
        return value.project as string | null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async write(project: string | null) {
      await mkdir(join(root, '.forgeax', 'host'), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, project }), { mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
