#!/usr/bin/env node
import { globSync, readFileSync } from 'node:fs';

const failures = [];
const smokePaths = globSync('apps/**/smoke*.mjs');

for (const smokePath of smokePaths) {
  const lines = readFileSync(smokePath, 'utf8').split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!/(^|[^.])\brenderer\.attach/.test(lines[lineIndex])) continue;

    const priorSource = lines.slice(0, lineIndex).join('\n');
    const rendererInitialized =
      /\bconst\s+renderer\s*=/.test(priorSource) ||
      /\brenderer\s*=\s*(?:await\s+)?[^;\n]+/.test(priorSource) ||
      /\b(?:const|let|var)\s*\{[^}]*\brenderer\b[^}]*\}\s*=/.test(priorSource) ||
      /\(\s*\{[^}]*\brenderer\b[^}]*\}\s*=/.test(priorSource);

    if (!rendererInitialized) failures.push(`${smokePath}:${lineIndex + 1}`);
  }
}

if (failures.length > 0) {
  console.error('[smoke-renderer-attachment-order] attach called before renderer initialization:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`[smoke-renderer-attachment-order] PASS (${smokePaths.length} scripts)`);
