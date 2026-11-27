import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { isMap, isSeq, parseDocument } from 'yaml';
import { persistFieldEditMoveEvidence } from './renderer-irradiance-field-edit-evidence.fixture';

function nativeGiPatterns(stepName: string) {
  const workflow = parseDocument(
    readFileSync(
      new URL('../../../../.github/workflows/native-ray-query.yml', import.meta.url),
      'utf8',
    ),
  );
  const steps = workflow.getIn(['jobs', 'native-node-gi', 'steps']);
  if (!isSeq(steps)) throw new Error('Maintained Native GI steps required');
  const step = steps.items.find((item) => isMap(item) && item.get('name') === stepName);
  if (!isMap(step)) throw new Error('Actual Native GI artifact step required');
  const config = step.get('with', true);
  if (!isMap(config)) throw new Error('Actual upload inputs required');
  const paths = config.get('path');
  if (typeof paths !== 'string') throw new Error('Artifact path block required');
  return paths
    .trim()
    .split(/\r?\n/)
    .map((path) => path.trim());
}

const matchesUpload = (patterns: readonly string[], name: string) =>
  patterns.some((pattern) => posix.matchesGlob(`artifacts/irradiance-field/dawn/${name}`, pattern));

it('persists the actual move capture before the first existing move assertion', () => {
  const text = readFileSync(
    new URL('./renderer-irradiance-field-edit.dawn.test.ts', import.meta.url),
    'utf8',
  );
  const source = ts.createSourceFile('edit.ts', text, ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const moved = text.indexOf('const moved = fieldInspection(h)');
  expect(moved).toBeGreaterThan(0);
  const persist = calls.find(
    (call) => call.expression.getText(source) === 'persistFieldEditMoveEvidence',
  );
  const firstGuard = calls.find(
    (call) =>
      call.getStart(source) > moved &&
      ['expect', 'assert'].includes(call.expression.getText(source)),
  );
  expect(persist, 'Same-path evidence call must exist').toBeDefined();
  expect(firstGuard).toBeDefined();
  expect(persist?.getStart(source)).toBeLessThan(firstGuard?.getStart(source) ?? Number.NaN);
});

it('retains exact transport bytes and metadata after the unchanged scalar continuity gate fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-field-edit-evidence-'));
  const directory = join(root, 'artifacts', 'irradiance-field', 'dawn');
  const image = (value: number, frameId: number) => ({
    receipt: { frameId, deviceGeneration: 2 },
    bytes: Uint8Array.from([frameId, 2, 3, 4]),
    red: Float32Array.from([value, value, value, value]),
    mean: value,
  });
  const reference = image(0.186078242957592, 7);
  const edit = image(0.07618187367916107, 9);
  const encoded = {
    bytes: Uint8Array.from([6, 5, 4, 3]),
    digest: 'synthetic CPU transport, not a GPU tape',
  };
  try {
    const receipt = persistFieldEditMoveEvidence({
      directory,
      size: 2,
      encoded,
      dark: image(0, 1),
      frames: [reference],
      reference,
      edit,
      metadata: {
        domain: 'CPU persistence fault injection only, not rendering or physical validation',
      },
    });
    expect(() => expect(edit.mean).toBeGreaterThan(0.5 * reference.mean)).toThrow();
    expect([...edit.red].every((value) => value > 0)).toBe(true);
    expect(receipt.status).not.toContain('PASS');
    for (const file of receipt.files) {
      const bytes = readFileSync(join(directory, file.name));
      expect(bytes.byteLength).toBe(file.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
    expect(readFileSync(join(directory, 'edit-frame.rhitape'))).toEqual(Buffer.from(encoded.bytes));
    expect(readFileSync(join(directory, 'edit-moved-first.linear-hdr.bin'))).toEqual(
      Buffer.from(edit.bytes),
    );
    const metadata = JSON.parse(readFileSync(join(directory, 'edit-move-evidence.json'), 'utf8'));
    expect(metadata).toMatchObject({
      editMean: edit.mean,
      referenceMean: reference.mean,
      editFrameId: 9,
    });
    const failingFrames = nativeGiPatterns('Upload failing native GI frames');
    for (const file of receipt.files)
      expect(matchesUpload(failingFrames, file.name), `Missing artifact ${file.name}`).toBe(true);
    expect(
      matchesUpload(nativeGiPatterns('Upload native GI evidence'), 'edit-move-evidence.json'),
    ).toBe(true);
  } finally {
    expect(dirname(root)).toBe(tmpdir());
    rmSync(root, { recursive: true, force: true });
  }
});
