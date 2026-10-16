import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('changing voxel spacing preserves every thin-gap ray and geometric reference', async () => {
  const output = await mkdtemp(join(tmpdir(), 'forgeax-thin-gap-'));
  try {
    execFileSync('bun', ['scripts/raytracing/gltf/prepare-thin-gap-sdf.mjs', output], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      timeout: 30_000,
    });
    const manifest = JSON.parse(await readFile(join(output, 'composition.json')));
    const coarse = manifest.cases.filter((c) => c.name.startsWith('v100-'));
    assert(coarse.length > 0);
    for (const c of coarse) {
      const fine = manifest.cases.find((r) => r.name === c.name.replace('v100-', 'v50-'));
      assert(fine);
      assert.equal(c.sources[0].meshDigest, fine.sources[0].meshDigest);
      assert.deepEqual(c.grid, fine.grid);
      assert.deepEqual(
        await readFile(join(output, c.queryFile)),
        await readFile(join(output, fine.queryFile)),
      );
      assert.notEqual(
        manifest.fields[c.sources[0].fieldFile].sha256,
        manifest.fields[fine.sources[0].fieldFile].sha256,
      );
      if (c.name.includes('-z200-')) {
        const moved = manifest.cases.find((r) => r.name === c.name.replace('-z200-', '-z225-'));
        assert(moved);
        const originalRays = JSON.parse(await readFile(join(output, c.queryFile)));
        const movedRays = JSON.parse(await readFile(join(output, moved.queryFile)));
        assert.deepEqual(originalRays.rays, movedRays.rays);
        assert.notDeepEqual(originalRays.exact, movedRays.exact);
      }
    }
    const control = manifest.cases.find((c) => c.name === 'masked-control');
    assert(control);
    assert.equal(control.queryFile, coarse[0].queryFile);
    assert.deepEqual(
      control.sources,
      coarse[0].sources.map((s) => ({ ...s, mask: 0 })),
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
