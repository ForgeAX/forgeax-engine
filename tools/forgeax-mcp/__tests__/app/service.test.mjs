import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createViewService } from '../../src/app/service.mjs';
import { readResourceBytes } from '../../src/app/resource-bytes.ts';

test('public presentation identity retires source bytes even when its URL stays fixed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-view-service-'));
  await writeFile(join(directory, 'full-view.html'), `<script>__FX_VIEW_CONFIG__</script>${randomBytes(100000).toString('hex')}`);
  let presentationId = '1'.repeat(64);
  const service = createViewService({ root: '/project', async request(operation) {
    assert.equal(operation, 'view.start');
    return { ok: true, value: { phase: 'ready', url: 'http://localhost:4000/', presentationId } };
  } }, { artifactRoot: pathToFileURL(`${directory}/`) });
  try {
    await service.open();
    const first = await service.invoke({ action: 'view-document' });
    assert.equal(first.encoding, 'gzip');
    assert.ok(first.bytes > 49152);
    const bytes = await readResourceBytes(first, input => service.invoke(input));
    assert.ok(new TextDecoder().decode(bytes).includes(presentationId));
    await service.open();
    assert.equal((await service.invoke({ action: 'view-document' })).resourceId, first.resourceId);
    presentationId = '2'.repeat(64);
    await service.open();
    const replacement = await service.invoke({ action: 'view-document' });
    assert.notEqual(replacement.resourceId, first.resourceId);
    assert.ok(new TextDecoder().decode(await readResourceBytes(replacement, input => service.invoke(input))).includes(presentationId));
    await assert.rejects(service.invoke({ action: 'chunk', resourceId: first.resourceId, offset: 0 }), /Expired resource/);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
