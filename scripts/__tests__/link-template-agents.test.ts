import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linkTemplateAgents } from '../forgeax/link-template-agents.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('linkTemplateAgents', () => {
  it('links every game template to the shared guide and is idempotent', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-template-agents-'));
    roots.push(root);
    await mkdir(resolve(root, 'templates', 'empty'), { recursive: true });
    await mkdir(resolve(root, 'templates', 'docs-only'), { recursive: true });
    await writeFile(resolve(root, 'templates', 'AGENTS.md'), '# Shared\n');
    await writeFile(resolve(root, 'templates', 'empty', 'forge.json'), '{}\n');

    expect(await linkTemplateAgents(root)).toEqual({ linked: ['empty'], unchanged: [] });
    expect(await readlink(resolve(root, 'templates', 'empty', 'AGENTS.md'))).toBe('../AGENTS.md');
    expect(await linkTemplateAgents(root)).toEqual({ linked: [], unchanged: ['empty'] });
  });
});
