import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sel } from '@forgeax/engine-modeling';
import { attachSourceLines, recordingSessions } from '../record';

let directory: string | undefined;
afterEach(() => { if (directory !== undefined) rmSync(directory, { recursive: true, force: true }); });

describe('case journal source correspondence', () => {
  it('matches boolean calls routed through the case join helper and rejects a changed operation', () => {
    directory = mkdtempSync(join(tmpdir(), 'forgeax-case-source-'));
    const file = join(directory, 'fixture.ts');
    const source = [
      "const body = session('body');",
      'body.box({ size: [1, 1, 1] });',
      "const detail = session('detail');",
      'detail.box({ size: [0.5, 0.5, 0.5] });',
      "join(body, 'union', detail);",
    ].join('\n');
    writeFileSync(file, source);
    const recording = recordingSessions();
    const body = recording.session('body');
    body.box({ size: [1, 1, 1] });
    const detail = recording.session('detail');
    detail.box({ size: [0.5, 0.5, 0.5] });
    detail.markRole(sel.all(), 'detail');
    body.union(detail);
    expect(body.poisoned).toBeUndefined();
    expect(attachSourceLines(recording.steps, file).map(step => step.line)).toEqual([2, 4, 5, 5]);
    writeFileSync(file, source.replace("'union'", "'difference'"));
    expect(() => attachSourceLines(recording.steps, file)).toThrow('journal recorded body.union');
  });
});
