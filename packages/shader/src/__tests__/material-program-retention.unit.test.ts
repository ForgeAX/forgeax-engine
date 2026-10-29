import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import { expect, it } from 'vitest';
import { createMaterialShaderProgram } from '../material/program';

function retainedProgram(index: number) {
  return createMaterialShaderProgram(
    `const MATERIAL_BODY_RETENTION_${index}: u32 = 0u;\n${' '.repeat(2 * 1024 * 1024)}\n@vertex fn retained_vertex(@location(0) long_retained_position_input: vec3f) -> @builtin(position) vec4f {return vec4f(long_retained_position_input,1.);}`,
  );
}

it('retains fragment owners without capturing complete analyzed bodies in lazy source accessors', () => {
  const programs = Array.from({ length: 3 }, (_, index) => retainedProgram(index));
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-material-retention-'));
  try {
    const snapshot = JSON.parse(
      readFileSync(writeHeapSnapshot(join(directory, 'heap.heapsnapshot')), 'utf8'),
    );
    const fields: string[] = snapshot.snapshot.meta.node_fields;
    const width = fields.length;
    const names: string[] = snapshot.strings;
    const kinds: string[] = snapshot.snapshot.meta.node_types[0];
    const nodes: number[] = snapshot.nodes;
    let fullBodies = 0;
    for (let offset = 0; offset < nodes.length; offset += width) {
      const kind = kinds[nodes[offset + fields.indexOf('type')] as number];
      const name = names[nodes[offset + fields.indexOf('name')] as number] as string;
      const bytes = nodes[offset + fields.indexOf('self_size')] as number;
      if (
        kind === 'string' &&
        name.startsWith('const MATERIAL_BODY_RETENTION_') &&
        bytes > 1024 * 1024
      )
        fullBodies++;
    }
    // V8 may keep its latest RegExp input; it must not retain one body per program.
    expect(fullBodies).toBeLessThanOrEqual(1);
    for (const program of programs) expect(program.source.length).toBeGreaterThan(2 * 1024 * 1024);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
