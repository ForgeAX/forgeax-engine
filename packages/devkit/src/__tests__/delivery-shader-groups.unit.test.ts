import { decompressZstd } from '@forgeax/engine-codec';
import { expect, it } from 'vitest';
import { compressShaderGroups, SHADER_GROUP_TARGET_BYTES } from '../delivery-shader-groups';

it('bounds compression groups without splitting programs and preserves input order', async () => {
  const entries = [600_000, 600_000, SHADER_GROUP_TARGET_BYTES + 1, 400_000, 400_000].map(
    (size, index) => ({ identity: String(index), bytes: new Uint8Array(size).fill(index + 1) }),
  );
  const groups = await compressShaderGroups(entries);
  expect(groups).toHaveLength(4);
  const restored: Uint8Array[] = [];
  for (const group of groups) {
    const result = await decompressZstd(group.bytes);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.length <= SHADER_GROUP_TARGET_BYTES || group.members.length === 1).toBe(
      true,
    );
    for (const member of group.members)
      restored.push(
        result.value.slice(
          member.decodedRange.offset,
          member.decodedRange.offset + member.decodedRange.length,
        ),
      );
  }
  expect(restored).toEqual(entries.map((entry) => entry.bytes));
  expect(await compressShaderGroups([])).toEqual([]);
});
