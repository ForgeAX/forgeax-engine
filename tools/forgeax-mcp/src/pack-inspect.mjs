import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import { createFileSystemPackAuthoringGateway } from '@forgeax/engine-pack/build';

const [root, sourcePath] = process.argv.slice(2);
try {
  // An explicit file root makes the Pack owner validate this source and its
  // closure without admitting unrelated sibling Packs into the scan.
  const gateway = createFileSystemPackAuthoringGateway({ gameRoot: root, scanRoots: [sourcePath] });
  const result = await gateway.execute({
    operation: 'asset.inspect', requestId: randomUUID(), subject: relative(root, sourcePath),
  });
  const value = result.ok ? result.value : undefined;
  const record = value && typeof value === 'object' ? value : {};
  const source = record.source && typeof record.source === 'object' ? record.source : {};
  const response = result.ok
    ? { ok: true, value: {
      sourcePath,
      revision: record.revision ?? source.revision,
      packageId: record.packageId ?? source.packageId,
      format: record.format ?? source.format,
      sourceKey: record.sourceKey,
      assets: Array.isArray(record.assets) ? record.assets.slice(0, 50).map(item => ({
        guid: item.guid, kind: item.kind, sourceKey: item.sourceKey, state: item.state,
      })) : [],
    } }
    : { ok: false, error: {
      code: result.error.code,
      expected: result.error.expected,
      hint: result.error.hint,
    } };
  process.stdout.write(`${JSON.stringify(response)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: {
    code: error.code ?? 'pack-inspect-failed',
    expected: 'an inspectable Pack source',
    hint: String(error.message).slice(0, 240),
  } })}\n`);
}
