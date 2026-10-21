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
