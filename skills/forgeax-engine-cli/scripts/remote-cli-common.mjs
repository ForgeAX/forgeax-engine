// remote-cli-common.mjs — SSOT for the shared plumbing of the remote-live CLI
// driver. Ported from the editor's gateway-cli-common.mjs (strict arg parse +
// snippet read + {ok,value|error} print convention) so the two repos stay
// isomorphic. The engine has one live driver today (remote-live.mjs); this file
// keeps the drift-prone plumbing in one place so a future headless driver reuses
// the exact same contract.

import { readFileSync } from 'node:fs';

/**
 * Spec-driven CLI parser. `spec` declares exactly which flags THIS script accepts:
 *   { boolean: [], value: ['file'], number: [] }
 *   - boolean[]: presence-only flags (`--flag` → flags.flag = true)
 *   - value[]:   `--flag <value>` flags (next argv token is the value)
 *   - number[]:  subset of value[] whose value is coerced with Number()
 * The first non-`--` token becomes the positional `code`.
 * An undeclared `--flag` is a hard error (exit 2) — a flag the script does not
 * declare can never leak into `code` (the bug that motivated this SSOT: a bare
 * flag value silently becoming part of the eval'd script). Returns { code, flags }.
 */
export function parseArgs(argv, spec = {}) {
  const boolean = new Set(spec.boolean ?? []);
  const value = new Set(spec.value ?? []);
  const number = new Set(spec.number ?? []);
  const known = new Set([...boolean, ...value]);

  const flags = {};
  let code;
  // argv is process.argv; skip node + script path.
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const name = t.slice(2);
      if (!known.has(name)) {
        const accepted = [...known].sort().map((f) => `--${f}`).join(', ') || '(none)';
        console.error(`unknown flag '${t}'. Accepted flags: ${accepted}`);
        process.exit(2);
      }
      if (boolean.has(name)) {
        flags[name] = true;
      } else {
        const raw = argv[++i];
        if (raw === undefined) {
          console.error(`flag '${t}' expects a value`);
          process.exit(2);
        }
        flags[name] = number.has(name) ? Number(raw) : raw;
      }
    } else if (code === undefined) {
      code = t;
    }
    // extra positionals after `code` are ignored — quote multi-token snippets.
  }
  return { code, flags };
}

/**
 * Resolve the JS snippet to run: `--file <path>` reads from disk, else the
 * positional `code`. Neither present → usage error (exit 2).
 */
export function readSnippet({ code, file }, usage = 'pass code as an argument or --file <path>') {
  if (file) return readFileSync(file, 'utf8');
  if (code) return code;
  console.error(`no snippet — ${usage}`);
  process.exit(2);
}

/**
 * The one print + exit convention: pretty-print the {ok,value|error} envelope and
 * set exit 1 on a domain failure (ok:false), else 0. Uses process.exitCode so a
 * caller's `finally { ... }` still runs.
 */
export function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result && result.ok === false ? 1 : 0;
}
