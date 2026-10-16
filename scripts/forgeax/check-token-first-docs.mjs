#!/usr/bin/env node

/**
 * Active-documentation token-first gate.
 *
 * Scans TypeScript fenced code blocks and inline code spans in active docs/skills
 * for old-form world.* registration calls. The gate is intentionally RED in M3:
 * non-ECS active docs still have old-form examples. Green certification belongs
 * only to w71 (M5 final docs gate).
 *
 * Usage:
 *   node scripts/forgeax/check-token-first-docs.mjs
 *
 * Exit code 0 = all active docs use token-first forms (green).
 * Exit code 1 = stale old-form examples found (red).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');

// ── Active documentation targets ──────────────────────────────────────────────
const ACTIVE_DOCS = [
  'packages/ecs/README.md',
  'packages/app/README.md',
  'packages/audio-webaudio/README.md',
  'packages/input/README.md',
  'packages/runtime/README.md',
  'packages/state/README.md',
  'skills/forgeax-engine-ecs/SKILL.md',
  'skills/forgeax-engine-app/SKILL.md',
  'skills/forgeax-engine-audio/SKILL.md',
  'skills/forgeax-engine-state/SKILL.md',
  'apps/hello/sprite-atlas/README.md',
  'apps/learn-render/1.getting-started/5.transformations/README.md',
  'apps/learn-render/1.getting-started/7.camera/README.md',
  'apps/learn-render/2.lighting/3.materials/README.md',
];

// ── Historical allowlist (exact paths, excluded from scan) ────────────────────
const _HISTORICAL_ALLOWLIST = new Set([
  'packages/ecs/CHANGELOG.md',
  'docs/roadmaps/2026-06-08-ecs-multithreading-roadmap.md',
  'docs/roadmaps/2026-06-19-engine-self-stability-roadmap.md',
  'docs/specs/2026-06-16-engine-state-and-state-scoped-entities-design.md',
  'docs/specs/2026-06-23-plugin-system-design.md',
]);

// ── Old-form patterns to detect ──────────────────────────────────────────────
// Each pattern is a regex that matches old-form (non-token-first) calls.
// We check within fenced code blocks and inline code spans.
const OLD_FORM_PATTERNS = [
  // world.addSystem without Update/FixedUpdate as first arg
  // (i.e. world.addSystem({...}) or world.addSystem(someToken) that isn't Update/FixedUpdate)
  {
    name: 'addSystem',
    re: /\.addSystem\(\s*(?!Update\s*,|FixedUpdate\s*,)/g,
    hint: 'world.addSystem(Update, ...) or world.addSystem(FixedUpdate, ...)',
  },
  // world.addSystems without Update/FixedUpdate as first arg
  {
    name: 'addSystems',
    re: /\.addSystems\(\s*(?!Update\s*,|FixedUpdate\s*,)/g,
    hint: 'world.addSystems(Update, set, ...) or world.addSystems(FixedUpdate, set, ...)',
  },
  // world.configureSets without Update/FixedUpdate as first arg
  {
    name: 'configureSets',
    re: /\.configureSets\(\s*(?!Update\s*,|FixedUpdate\s*,)/g,
    hint: 'world.configureSets(Update, ...) or world.configureSets(FixedUpdate, ...)',
  },
  // world.removeSystem without Update/FixedUpdate as first arg
  {
    name: 'removeSystem',
    re: /\.removeSystem\(\s*(?!Update\s*,|FixedUpdate\s*,)/g,
    hint: 'world.removeSystem(Update, ...) or world.removeSystem(FixedUpdate, ...)',
  },
  // world.replaceSystem without Update/FixedUpdate as first arg
  {
    name: 'replaceSystem',
    re: /\.replaceSystem\(\s*(?!Update\s*,|FixedUpdate\s*,)/g,
    hint: 'world.replaceSystem(Update, ...) or world.replaceSystem(FixedUpdate, ...)',
  },
  // world.update() with no argument (old form, should be world.update(delta))
  {
    name: 'update()',
    re: /\.update\(\s*\)/g,
    hint: 'world.update(delta) — the old no-argument world.update() is removed',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the content of a fenced TypeScript code block from markdown lines
 * starting at `startLine` (the line containing ```ts or ```typescript).
 * Returns { content, endLine } where endLine is the closing ``` line.
 */
function extractFencedBlock(lines, startLine) {
  const contentLines = [];
  let i = startLine + 1;
  while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
    contentLines.push(lines[i]);
    i++;
  }
  return { content: contentLines.join('\n'), endLine: i };
}

/**
 * Determine if a line is a fenced code block opener for TS/TypeScript.
 * Returns the language or null.
 */
function isTsFenceOpener(line) {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('```')) return null;
  const lang = trimmed.slice(3).trim();
  if (lang === 'ts' || lang === 'typescript' || lang === 'tsx' || lang === 'diff') return lang;
  return null;
}

/**
 * Scan text content for old-form patterns. Returns array of hits.
 */
function scanContent(content, path, baseLine) {
  const hits = [];
  for (const pattern of OLD_FORM_PATTERNS) {
    pattern.re.lastIndex = 0;
    let match = pattern.re.exec(content);
    while (match !== null) {
      // Calculate approximate line number within the block
      const beforeMatch = content.slice(0, match.index);
      const lineOffset = beforeMatch.split('\n').length - 1;
      const snippet = match[0].length > 60 ? `${match[0].slice(0, 60)}...` : match[0];
      hits.push({
        path,
        line: baseLine + lineOffset,
        api: pattern.name,
        snippet: snippet.trim(),
        hint: pattern.hint,
      });
      match = pattern.re.exec(content);
    }
  }
  return hits;
}

// ── Main scan ─────────────────────────────────────────────────────────────────

const allHits = [];

for (const docPath of ACTIVE_DOCS) {
  const absPath = resolve(REPO_ROOT, docPath);
  let content;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    // File doesn't exist — skip silently
    continue;
  }

  const lines = content.split('\n');

  // Pass 1: fenced code blocks
  for (let i = 0; i < lines.length; i++) {
    const fenceLang = isTsFenceOpener(lines[i]);
    if (fenceLang === null) continue;

    const { content: blockContent, endLine } = extractFencedBlock(lines, i);
    if (blockContent.length === 0) {
      i = endLine;
      continue;
    }

    const hits = scanContent(blockContent, docPath, i + 1);
    allHits.push(...hits);

    i = endLine; // Skip to end of fenced block
  }

  // Pass 2: inline code spans (backtick-enclosed, not in fenced blocks)
  // We look for `world.*` patterns in inline code spans.
  // Strategy: extract text outside fenced blocks, then find inline code spans.
  const nonFencedRegions = [];
  let inFence = false;
  let regionStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (isTsFenceOpener(lines[i]) !== null) {
      if (!inFence) {
        if (i > regionStart) nonFencedRegions.push({ start: regionStart, end: i - 1 });
        inFence = true;
      }
    } else if (lines[i].trimStart().startsWith('```') && inFence) {
      inFence = false;
      regionStart = i + 1;
    }
  }
  if (regionStart < lines.length) {
    nonFencedRegions.push({ start: regionStart, end: lines.length - 1 });
  }

  for (const region of nonFencedRegions) {
    for (let i = region.start; i <= region.end; i++) {
      const line = lines[i];
      // Find inline code spans: `...`
      const inlineRe = /`([^`]+)`/g;
      let m = inlineRe.exec(line);
      while (m !== null) {
        const span = m[1];
        const hits = scanContent(span, docPath, i + 1);
        allHits.push(...hits);
        m = inlineRe.exec(line);
      }
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

if (allHits.length > 0) {
  process.stderr.write('Active-documentation token-first gate failed (intentionally red in M3):\n');
  for (const hit of allHits) {
    process.stderr.write(`  ${hit.path}:${hit.line}  ${hit.api}  "${hit.snippet}"\n`);
  }
  process.stderr.write(
    '\n[hint] Active docs/skills must use token-first forms:\n' +
      '  world.addSystem(Update, {...})  — token first arg\n' +
      '  world.addSystems(Update, set, [...])  — token first arg\n' +
      '  world.configureSets(Update, {...})  — token first arg\n' +
      '  world.update(delta)  — explicit delta argument\n' +
      'Green certification belongs only to w71 (M5 final docs gate).\n',
  );
  process.exit(1);
}

process.stdout.write('Active-documentation token-first gate passed\n');
