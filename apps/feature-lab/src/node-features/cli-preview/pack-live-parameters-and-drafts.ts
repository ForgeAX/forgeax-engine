import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileSystemPackDrafts, type PackDraftSnapshot } from '@forgeax/engine/pack/build';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Pack live parameters and drafts',
  catalog: 'Pack live parameters and drafts',
  kind: 'headless',
  summary:
    'A filesystem draft reads literal generation/live declarations without executing user code. Edits, undo/redo, Save, reopen and conflict-aware refresh use the real Pack source owner.',
  expect:
    'Checks pass: an edit leaves source bytes unchanged, undo/redo restore values, Save survives reopening, and an external write rejects Save until refresh merges unrelated source changes. Actual preview and Worker generation use the owning integration gates.',
  async run(checks) {
    const root = await mkdtemp(join(tmpdir(), 'feature-lab-pack-draft-'));
    const path = join(root, 'scene.pack.ts');
    const source = `export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-000000000077'),
  parameters: [
    { name: 'radius', type: 'f32', default: 1 },
    { name: 'intensity', type: 'f32', default: 1, apply: {
      asset: 'scene/main', path: ['entities', 'sun', 'components', 'DirectionalLight', 'intensity']
    } }
  ],
  build() { throw new Error('declaration and draft edits must not execute'); }
});`;
    const drafts = createFileSystemPackDrafts({ gameRoot: root });
    try {
      await writeFile(path, source);
      const opened = (await drafts.execute({
        action: 'open',
        sourcePath: 'scene.pack.ts',
      })) as PackDraftSnapshot;
      checks.equal(
        'both literal parameters are discovered',
        opened.fields.map((field) => field.name),
        ['radius', 'intensity'],
      );
      checks.equal('generation parameter has no live binding', opened.fields[0]?.apply, undefined);
      checks.ok('live parameter retains its binding', typeof opened.fields[1]?.apply === 'object');
      const edit = await drafts.execute({
        action: 'edit',
        draftId: opened.id,
        field: 'intensity',
        value: 3.2,
      });
      checks.ok('edit is unsaved', 'unsaved' in edit && edit.unsaved);
      checks.equal('edit does not write source', await readFile(path, 'utf8'), source);
      const undone = (await drafts.execute({
        action: 'undo',
        draftId: opened.id,
      })) as PackDraftSnapshot;
      checks.equal('undo restores the initial value', undone.values.intensity, 1);
      const redone = (await drafts.execute({
        action: 'redo',
        draftId: opened.id,
      })) as PackDraftSnapshot;
      checks.equal('redo restores the edit', redone.values.intensity, 3.2);
      const saved = (await drafts.execute({
        action: 'save',
        draftId: opened.id,
      })) as PackDraftSnapshot;
      checks.equal('save clears unsaved state', saved.unsaved, false);
      await drafts.execute({ action: 'close', draftId: opened.id });
      const reopened = (await drafts.execute({
        action: 'open',
        sourcePath: 'scene.pack.ts',
      })) as PackDraftSnapshot;
      checks.equal('reopen reads the saved default', reopened.values.intensity, 3.2);
      await drafts.execute({ action: 'edit', draftId: reopened.id, field: 'intensity', value: 2 });
      await writeFile(path, `// external source edit\n${await readFile(path, 'utf8')}`);
      let conflict: unknown;
      try {
        await drafts.execute({ action: 'save', draftId: reopened.id });
      } catch (error) {
        conflict = error;
      }
      checks.equal(
        'concurrent source write rejects Save',
        (conflict as { code?: string } | undefined)?.code,
        'pack-source-revision-conflict',
      );
      const retained = (await drafts.execute({
        action: 'get',
        draftId: reopened.id,
      })) as PackDraftSnapshot;
      checks.equal('conflict retains the author edit', retained.values.intensity, 2);
      await drafts.execute({ action: 'refresh', draftId: reopened.id });
      await drafts.execute({ action: 'save', draftId: reopened.id });
      checks.ok(
        'refresh preserves unrelated source code',
        (await readFile(path, 'utf8')).startsWith('// external source edit\n'),
      );
      await drafts.execute({ action: 'close', draftId: reopened.id });
      const merged = (await drafts.execute({
        action: 'open',
        sourcePath: 'scene.pack.ts',
      })) as PackDraftSnapshot;
      checks.equal('merged save survives reopening', merged.values.intensity, 2);
    } finally {
      drafts.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
});
