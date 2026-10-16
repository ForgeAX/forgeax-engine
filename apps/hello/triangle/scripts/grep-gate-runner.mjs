// grep-gate-runner.mjs - shared filesystem-walking + comment-stripping utilities for the
// hello-triangle scripts/* grep-gate suite (feat-20260514-ci-jscpd-duplication-gate M3
// T-013; clone #4 cash-out).
//
// Why this exists: jscpd reported clone #4
//   apps/hello/triangle/scripts/m4-escape-hatch-grep-gate.mjs:73-107
//   apps/hello/triangle/scripts/m6-resource-creation-grep-gate.mjs:116-150
//   (35 lines, javascript)
// as the `walkSourceFiles` generator + `stripLineComment` utility shared between the M4
// and M6 closure gates. plan-strategy D-P8 row 2 + requirements C-4 mandate extraction
// into a sibling helper file with no underscore prefix.
//
// ac-08-grep-gate.mjs deliberately keeps its own (richer) copies of these helpers because
// the AC-08 gate adds self-exclusion logic and a string-literal-aware comment stripper
// that the M4 / M6 closure gates do not need. This helper file targets only the
// M4 + M6 pair (charter proposition 5: helpers travel with the smallest cohesive cohort
// of consumers).
//
// Two exports:
//   walkSourceFiles(rootDir, exts) - generator yielding every absolute file path under
//                                    `rootDir` whose extension is in `exts`, skipping
//                                    `dist/`, `node_modules/`, and `.git/` subtrees.
//   stripLineComment(line) - trim `// ...` line-comment tail; block comments NOT
//                            stripped (consistent with M4/M6 simple stripper).
//
// Token preservation: the M4 / M6 gates remain self-narrating (their gate-id strings,
// FAIL message wording) so external tooling that greps the gate output sees no change.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Walk a directory tree yielding all matching extensions. Skips dist / node_modules / .git
// to keep the scan bounded; mirrors the simple variant used by m4-escape-hatch-grep-gate
// + m6-resource-creation-grep-gate before extraction.
export function* walkSourceFiles(rootDir, exts) {
  if (!existsSync(rootDir)) return;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === 'dist' || name === 'node_modules' || name === '.git') continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        for (const ext of exts) {
          if (full.endsWith(ext)) {
            yield full;
            break;
          }
        }
      }
    }
  }
}

// Strip line comments (// ...) - keeps block comments since they may span multiple
// lines and the simple stripper would over-match. Used by the M4 / M6 gates so that
// narrative comments mentioning the forbidden symbols do not trip the regexes.
export function stripLineComment(line) {
  const idx = line.indexOf('//');
  if (idx === -1) return line;
  return line.slice(0, idx);
}
