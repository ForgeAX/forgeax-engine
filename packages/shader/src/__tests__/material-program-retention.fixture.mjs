import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import { createMaterialShaderProgram } from '../../dist/index.mjs';

function retainedProgram(index) {
  return createMaterialShaderProgram(
    `const MATERIAL_BODY_RETENTION_${index}: u32 = 0u;\n${' '.repeat(2 * 1024 * 1024)}\n@vertex fn retained_vertex(@location(0) long_retained_position_input: vec3f) -> @builtin(position) vec4f {return vec4f(long_retained_position_input,1.);}`,
  );
}

const programs = Array.from({ length: 3 }, (_, index) => retainedProgram(index));
const directory = mkdtempSync(join(tmpdir(), 'forgeax-material-retention-'));
try {
  const snapshot = JSON.parse(
    readFileSync(writeHeapSnapshot(join(directory, 'heap.heapsnapshot')), 'utf8'),
  );
  const fields = snapshot.snapshot.meta.node_fields;
  const width = fields.length;
  const names = snapshot.strings;
  const kinds = snapshot.snapshot.meta.node_types[0];
  const nodes = snapshot.nodes;
  let fullBodies = 0;
  for (let offset = 0; offset < nodes.length; offset += width) {
    const kind = kinds[nodes[offset + fields.indexOf('type')]];
    const name = names[nodes[offset + fields.indexOf('name')]];
    const bytes = nodes[offset + fields.indexOf('self_size')];
    if (
      kind === 'string' &&
      name.startsWith('const MATERIAL_BODY_RETENTION_') &&
      bytes > 1024 * 1024
    )
      fullBodies++;
  }
  process.stdout.write(
    `${JSON.stringify({ fullBodies, sourceLengths: programs.map((program) => program.source.length) })}\n`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
