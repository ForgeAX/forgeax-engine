import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackDraftSnapshot } from '../pack-authoring-draft.js';
import { createFileSystemPackDrafts } from '../pack-authoring-drafts-node.js';
import { createFileSystemPackAuthoringGateway } from '../pack-authoring-node.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-author-draft-'));
  roots.push(root);
  const source = `export default definePack({schemaVersion:'2.0.0',packageId:definePackageId('01900000-0000-7000-8000-000000000077'),parameters:[{name:'radius',type:'f32',default:1},{name:'color',type:'vec3',default:[1,1,1],apply:{asset:'scene/main',path:['entities','sun','components','DirectionalLight','color']}}],build(){throw new Error('must not run');}});`;
  await writeFile(join(root, 'scene.pack.ts'), source);
  return { root, source };
}

describe('filesystem Pack drafts', () => {
  it('uses the existing gateway and writes only after save', async () => {
    const { root, source } = await setup();
    const gateway = createFileSystemPackAuthoringGateway({ gameRoot: root });
    const opened = (
      await gateway.execute({
        operation: 'asset.source.draft',
        requestId: 'open',
        draft: { action: 'open', sourcePath: 'scene.pack.ts' },
      })
    ).unwrap().draft as PackDraftSnapshot;
    const edited = await gateway.execute({
      operation: 'asset.source.draft',
      requestId: 'edit',
      draft: { action: 'edit', draftId: opened.id, field: 'color', value: [0.1, 0.2, 0.3] },
    });
    expect(edited).toMatchObject({
      ok: true,
      value: { draft: { unsaved: true, changed: { field: 'color', value: [0.1, 0.2, 0.3] } } },
    });
    expect(await readFile(join(root, 'scene.pack.ts'), 'utf8')).toBe(source);
    expect(
      await gateway.execute({
        operation: 'asset.source.draft',
        requestId: 'save',
        draft: { action: 'save', draftId: opened.id },
      }),
    ).toMatchObject({ ok: true, value: { draft: { unsaved: false, needsGeneration: true } } });
    expect(await readFile(join(root, 'scene.pack.ts'), 'utf8')).toBe(
      source.replace('[1,1,1]', '[0.1,0.2,0.3]'),
    );
    gateway.dispose?.();
  });

  it('retains edits on a CAS conflict, then merges external code before saving', async () => {
    const { root, source } = await setup();
    const manager = createFileSystemPackDrafts({ gameRoot: root });
    const opened = (await manager.execute({
      action: 'open',
      sourcePath: 'scene.pack.ts',
    })) as PackDraftSnapshot;
    await manager.execute({
      action: 'edit',
      draftId: opened.id,
      field: 'color',
      value: [0.1, 0.2, 0.3],
    });
    await writeFile(join(root, 'scene.pack.ts'), `// external edit\n${source}`);
    await expect(manager.execute({ action: 'save', draftId: opened.id })).rejects.toMatchObject({
      code: 'pack-source-revision-conflict',
    });
    expect(await manager.execute({ action: 'get', draftId: opened.id })).toMatchObject({
      unsaved: true,
    });
    await manager.execute({ action: 'refresh', draftId: opened.id });
    await manager.execute({ action: 'save', draftId: opened.id });
    expect(await readFile(join(root, 'scene.pack.ts'), 'utf8')).toBe(
      `// external edit\n${source.replace('[1,1,1]', '[0.1,0.2,0.3]')}`,
    );
    manager.dispose();
  });

  it('confines real paths and prevents cross-session draft access', async () => {
    const one = await setup();
    const two = await setup();
    await symlink(join(two.root, 'scene.pack.ts'), join(one.root, 'escape.pack.ts'));
    const first = createFileSystemPackDrafts({ gameRoot: one.root });
    const second = createFileSystemPackDrafts({ gameRoot: one.root });
    await expect(
      first.execute({ action: 'open', sourcePath: 'escape.pack.ts' }),
    ).rejects.toMatchObject({ code: 'pack-source-mutation-unsupported' });
    const opened = (await first.execute({
      action: 'open',
      sourcePath: 'scene.pack.ts',
    })) as PackDraftSnapshot;
    await expect(second.execute({ action: 'get', draftId: opened.id })).rejects.toMatchObject({
      code: 'pack-source-mutation-unsupported',
    });
    first.dispose();
    second.dispose();
  });
});

it('serializes saves from independent documents targeting the same source', async () => {
  const { root } = await setup();
  const first = createFileSystemPackDrafts({ gameRoot: root });
  const second = createFileSystemPackDrafts({ gameRoot: root });
  try {
    const one = (await first.execute({
      action: 'open',
      sourcePath: 'scene.pack.ts',
    })) as PackDraftSnapshot;
    const two = (await second.execute({
      action: 'open',
      sourcePath: 'scene.pack.ts',
    })) as PackDraftSnapshot;
    await first.execute({ action: 'edit', draftId: one.id, field: 'radius', value: 2 });
    await second.execute({ action: 'edit', draftId: two.id, field: 'color', value: [0, 0.5, 1] });
    const saved = await Promise.allSettled([
      first.execute({ action: 'save', draftId: one.id }),
      second.execute({ action: 'save', draftId: two.id }),
    ]);
    expect(saved.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(saved.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const remaining =
      saved[0]?.status === 'rejected' ? ([first, one] as const) : ([second, two] as const);
    await remaining[0].execute({ action: 'refresh', draftId: remaining[1].id });
    expect(await remaining[0].execute({ action: 'save', draftId: remaining[1].id })).toMatchObject({
      unsaved: false,
    });
    expect(await readFile(join(root, 'scene.pack.ts'), 'utf8')).toContain('default:2');
    expect(await readFile(join(root, 'scene.pack.ts'), 'utf8')).toContain('[0,0.5,1]');
  } finally {
    first.dispose();
    second.dispose();
  }
});

describe('source refresh after external writes', () => {
  const scaled = (source: string) =>
    source.replace('parameters:[', "parameters:[{name:'scale',type:'f32',default:2},");

  it('opens the settled source when an initial truncated read finishes after the write', async () => {
    const { root, source } = await setup();
    const path = join(root, 'scene.pack.ts');
    await writeFile(path, '');
    let reads = 0;
    const manager = createFileSystemPackDrafts({
      gameRoot: root,
      sourceOptions: async (_path, text) => {
        reads++;
        // Complete the actual disk write after the opening read, before its parse.
        if (text === '') await writeFile(path, source);
        return {};
      },
    });
    try {
      const opened = await manager.execute({ action: 'open', sourcePath: 'scene.pack.ts' });
      expect(opened).toMatchObject({ sourcePath: 'scene.pack.ts', unsaved: false });
      expect(opened).not.toHaveProperty('error');
      expect(reads).toBe(2);
      expect(await readFile(path, 'utf8')).toBe(source);
    } finally {
      manager.dispose();
    }
  });

  it('keeps a stable unsupported initial source as an error without retrying it', async () => {
    const { root } = await setup();
    await writeFile(join(root, 'scene.pack.ts'), '');
    let reads = 0;
    const manager = createFileSystemPackDrafts({
      gameRoot: root,
      sourceOptions: async () => {
        reads++;
        return {};
      },
    });
    try {
      await expect(
        manager.execute({ action: 'open', sourcePath: 'scene.pack.ts' }),
      ).rejects.toMatchObject({ code: 'pack-source-mutation-unsupported' });
      expect(reads).toBe(1);
    } finally {
      manager.dispose();
    }
  });

  it('bounds an opening whose source keeps changing instead of admitting a stale draft', async () => {
    const { root, source } = await setup();
    let reads = 0;
    const manager = createFileSystemPackDrafts({
      gameRoot: root,
      sourceOptions: async () => {
        await writeFile(join(root, 'scene.pack.ts'), `${source}\n// write ${++reads}`);
        return {};
      },
    });
    try {
      await expect(
        manager.execute({ action: 'open', sourcePath: 'scene.pack.ts' }),
      ).rejects.toMatchObject({ code: 'pack-source-revision-conflict' });
      expect(reads).toBeGreaterThan(1);
      expect(reads).toBeLessThanOrEqual(8);
      expect(await manager.hasSource('scene.pack.ts')).toBe(false);
    } finally {
      manager.dispose();
    }
  });

  it('clears a truncated-read failure once the complete source parses', async () => {
    const { root, source } = await setup();
    const manager = createFileSystemPackDrafts({ gameRoot: root });
    const opened = (await manager.execute({
      action: 'open',
      sourcePath: 'scene.pack.ts',
    })) as PackDraftSnapshot;
    await writeFile(join(root, 'scene.pack.ts'), '');
    expect((await manager.refreshSource('scene.pack.ts'))?.error).toBeDefined();
    await writeFile(join(root, 'scene.pack.ts'), scaled(source));
    const recovered = await manager.refreshSource('scene.pack.ts');
    expect(recovered?.error).toBeUndefined();
    expect(recovered?.fields.map((field) => field.name)).toContain('scale');
    expect(await manager.execute({ action: 'get', draftId: opened.id })).not.toHaveProperty(
      'error',
    );
    manager.dispose();
  });

  it('settles overlapping refreshes on the latest disk content', async () => {
    const { root, source } = await setup();
    const manager = createFileSystemPackDrafts({ gameRoot: root });
    const opened = (await manager.execute({
      action: 'open',
      sourcePath: 'scene.pack.ts',
    })) as PackDraftSnapshot;
    await writeFile(join(root, 'scene.pack.ts'), '');
    const truncated = manager.refreshSource('scene.pack.ts');
    await writeFile(join(root, 'scene.pack.ts'), scaled(source));
    const complete = manager.refreshSource('scene.pack.ts');
    await Promise.all([truncated, complete]);
    const settled = (await manager.execute({
      action: 'get',
      draftId: opened.id,
    })) as PackDraftSnapshot;
    expect(settled.error).toBeUndefined();
    expect(settled.fields.map((field) => field.name)).toContain('scale');
    manager.dispose();
  });
});
