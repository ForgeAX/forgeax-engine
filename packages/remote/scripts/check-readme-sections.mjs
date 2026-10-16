#!/usr/bin/env node
// AC-12 grep gate: assert packages/remote/README.md contains the 5 locked
// H2 section heading literals defined by feat-20260629-inspector-two-layer-model
// plan-strategy round 2 (unified abstraction path) + plan-tasks.json w27/w28
// single-source lock-in (M6 milestone rewrite to eval/remote mindset).
//
// Locked literals (closed set, 5; character-exact match including spaces /
// punctuation). All headings are plain ASCII (English-only entry doc per
// AGENTS.md English-only rule).
//
// Both this script and packages/remote/README.md derive from the same
// plan-strategy §8 + plan-tasks.json w27+w28 notes block; the literals
// MUST stay byte-for-byte aligned (rename one side without the other = CI red).
//
// Pattern aligns with sibling remote gates (check-no-string-sugar.mjs etc):
// zero npm deps, plain `node:fs` + `node:path`, exit 1 on any miss. Walks
// only the single README target - recursion is unnecessary.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const REQUIRED_HEADINGS = [
  '## Overview',
  '## Eval Recipes',
  '## RemoteErrorCode',
  '## Transport and Security',
  '## Physical Isolation',
];

const README = join(process.cwd(), 'packages', 'remote', 'README.md');

function main() {
  let text;
  try {
    text = readFileSync(README, 'utf8');
  } catch (e) {
    process.stderr.write(
      `[fail] AC-12: cannot read ${README}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  }

  // Split on newline so a heading literal must appear as a full line; this
  // prevents an inline mention inside a paragraph from accidentally
  // satisfying the gate.
  const lines = text.split(/\r?\n/);
  const lineSet = new Set(lines);

  const missing = [];
  for (const h of REQUIRED_HEADINGS) {
    if (!lineSet.has(h)) missing.push(h);
  }

  if (missing.length > 0) {
    process.stderr.write(
      `[fail] AC-12: packages/remote/README.md missing ${missing.length} required H2 heading(s):\n`,
    );
    for (const h of missing) {
      process.stderr.write(`  ${h}\n`);
    }
    process.stderr.write(
      `\n  expected: each literal appears on its own line (character-exact)\n` +
        `  hint:     update README.md AND scripts/check-readme-sections.mjs together (single-source lock-in, plan-review round 1 F-2)\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `[ok] AC-12: packages/remote/README.md contains all 5 locked H2 headings\n`,
  );
}

main();
