import { it } from 'vitest';
import { verifyCompressedSnapshot } from './compressed-snapshot.fixture';

it('snapshots compressed array textures including sub-block mips', async (ctx) => {
  const result = await verifyCompressedSnapshot();
  if (result.status === 'unavailable') ctx.skip(result.reason);
});
