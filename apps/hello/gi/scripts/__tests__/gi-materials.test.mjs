import assert from 'node:assert/strict';
import test from 'node:test';
import { cookGiMaterials } from '../gi-dawn.mjs';
import { GI_MATERIAL_NAMES } from '../../src/scenes.ts';

test('GI reference materials consume the admitted cooked publication', async () => {
  const cooked = await cookGiMaterials();
  assert.deepEqual([...cooked.keys()], GI_MATERIAL_NAMES);
  for (const [name, entry] of cooked) {
    assert.equal(entry.ready.status, 'Ready', name);
    assert.equal(entry.program.context, 'ray-hit', name);
    assert.ok(entry.program.wgsl.length > 0, name);
    assert.ok(entry.program.paramSchema.some((parameter) => parameter.name === 'baseColor'), name);
    assert.equal(
      entry.program.sourceClosureDigest,
      entry.ready.record.receipt.identity.sourceClosureDigest,
      name,
    );
  }
});
