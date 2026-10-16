#!/usr/bin/env node
// M1 grep gate: old names (SceneNode, LocalNodeId, LocalNodeIdBrand, SceneAsset.nodes)
// must be absent from packages/ + apps/ source. Exemptions: "glTF node" / "glTF spec"
// in comments and prose (AC-02).
//
// feat-20260608-gltf-runtime-textured-scene-and-scene-entity-renam M1/w1.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const roots = ['packages', 'apps'];

// Pattern 1: bare word-boundary match for identifiers
// \bSceneNode\b  |  \bLocalNodeId\b  |  LocalNodeIdBrand  |  SceneAsset\.nodes
const idPat = /\bSceneNode\b|\bLocalNodeId\b|LocalNodeIdBrand|SceneAsset\.nodes/g;

// Pattern 2: lines that mention "glTF node" or "glTF spec" -- exempt (AC-02)
const exemptPat = /glTF\s+(node|spec)/i;

function walk(dir) {
  /** @type {{ path: string; file: string; line: number; hit: string; content: string }[]} */
  const hits = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return hits;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      hits.push(...walk(p));
    } else if (p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.md') || p.endsWith('.mjs')) {
      const content = readFileSync(p, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        // Check for "glTF node" / "glTF spec" exemptions first
        if (exemptPat.test(line)) {
          // Still check if the line ALSO has one of the identifier patterns
          // that isn't part of the exempt phrase. Strip the known exempt
          // substrings, then re-test.
          const stripped = line.replace(/\bglTF\s+(node|spec)\b/gi, '');
          const m = stripped.match(idPat);
          if (m) {
            hits.push({ path: p, file: name, line: i + 1, hit: m[0], content: line.trim() });
          }
          continue;
        }
        const m = line.match(idPat);
        if (m) {
          hits.push({ path: p, file: name, line: i + 1, hit: m[0], content: line.trim() });
        }
      }
    }
  }
  return hits;
}

const allHits = [];
for (const root of roots) {
  allHits.push(...walk(root));
}

if (allHits.length > 0) {
  process.stderr.write(`M1 rename grep gate FAIL: ${allHits.length} old-name hit(s) found:\n`);
  for (const h of allHits) {
    process.stderr.write(`  ${h.path}:${h.line}: ${h.hit}  |  ${h.content}\n`);
  }
  process.stderr.write(
    '[hint] rename targets: SceneNode -> SceneEntity, LocalNodeId -> LocalEntityId, ' +
      'LocalNodeIdBrand -> LocalEntityIdBrand, SceneAsset.nodes -> SceneAsset.entities. ' +
      'Exemptions: lines containing "glTF node" / "glTF spec" (AC-02).\n',
  );
  process.exit(1);
}

process.stdout.write(
  'M1 rename grep gate OK: 0 old-name hits (SceneNode/LocalNodeId/LocalNodeIdBrand ' +
    '/ SceneAsset.nodes) in packages/ + apps/\n',
);
