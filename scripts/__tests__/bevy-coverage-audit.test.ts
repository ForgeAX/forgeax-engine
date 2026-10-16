// bevy-coverage-audit.test.ts — fixture-driven tests for the Bevy↔forgeax
// coverage instrument (scripts/bevy-coverage-audit.mjs).
//
// The friction this script fixes: "which Bevy examples does forgeax already
// cover?" was unanswerable except by hand (a §2-Derive violation). These tests
// pin the derived-coverage contract that would have caught that friction:
//
//   (a) happy      => joins self-declared forgeax.bevyExample against the Bevy
//                     Cargo.toml SSOT; exit 0; JSON reports covered/shelved/total,
//                     hidden examples excluded.
//   (b) degrade    => Bevy checkout absent (CI / fresh worktree) => exit 0 with a
//                     [note], forgeax-side declared map only. NEVER a hard red.
//   (c) unknown    => a declared name not in the Bevy SSOT => exit 1 +
//                     'bevy-example-unknown' (structured [reason]/[rerun]/[hint]).
//   (d) badstatus  => status outside {implemented,partial,shelved} => exit 1 +
//                     'bevy-example-status-unknown'.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');
const audit = resolve(repoRoot, 'scripts/bevy-coverage-audit.mjs');
const fx = resolve(__dirname, 'fixtures/bevy-coverage');
const fixtureBevy = resolve(fx, 'bevy/Cargo.toml');
const fixtureRoadmap = resolve(fx, 'roadmap.md');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): RunResult {
  const r = spawnSync('node', [audit, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('bevy-coverage-audit.mjs', () => {
  it('(a) happy: derives coverage from Cargo.toml SSOT joined against self-declared fields', () => {
    const root = resolve(fx, 'happy');
    const r = run(['--root', root, '--bevy', fixtureBevy, '--json']);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.bevyCheckout).toBe('present');
    // fixture Bevy has 3 visible demos across 3 categories + 1 hidden (excluded).
    const cats = out.categories;
    expect(cats['2D Rendering'].total).toBe(1);
    expect(cats['2D Rendering'].covered).toBe(1); // app-a implements sprite
    expect(cats['3D Rendering'].total).toBe(1);
    expect(cats['3D Rendering'].covered).toBe(0); // bloom_3d untouched
    expect(cats['3D Rendering'].uncovered).toContain('3D Bloom');
    expect(cats.glTF.shelved).toBe(1); // app-b shelved load_gltf
    // hidden hello_world must not appear as its own category
    expect(cats['(uncategorized)']).toBeUndefined();
    expect(out.declared).toHaveLength(2); // app-none declares nothing
  });

  it('(b) degrade: Bevy checkout absent => exit 0, [note], declared-only (never a hard red)', () => {
    const root = resolve(fx, 'happy');
    const r = run(['--root', root, '--bevy', resolve(fx, 'does/not/exist/Cargo.toml')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[note]');
    expect(r.stdout).toContain('Bevy checkout absent');
    expect(r.stdout).toMatch(/sprite/); // still shows the self-declared map
  });

  it('(c) unknown: a declared name absent from the Bevy SSOT => exit 1 + bevy-example-unknown', () => {
    const root = resolve(fx, 'unknown');
    const r = run(['--root', root, '--bevy', fixtureBevy]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('bevy-example-unknown');
    expect(r.stderr).toContain('[reason]');
    expect(r.stderr).toContain('[rerun]');
    expect(r.stderr).toContain('[hint]');
    expect(r.stderr).toMatch(/not_a_real_demo/);
  });

  it('(d) badstatus: status outside the closed set => exit 1 + bevy-example-status-unknown', () => {
    const root = resolve(fx, 'malformed');
    const r = run(['--root', root, '--bevy', fixtureBevy]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('bevy-example-status-unknown');
    expect(r.stderr).toMatch(/implemented, partial, shelved/);
  });

  it('(e) unknown category: fails instead of reporting a plausible empty 0/0 audit', () => {
    const root = resolve(fx, 'happy');
    const r = run(['--root', root, '--bevy', fixtureBevy, '--category', 'animation']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('bevy-category-unknown');
    expect(r.stderr).toContain('[reason]');
    expect(r.stderr).toContain('[rerun]');
    expect(r.stderr).toContain('[hint]');
  });

  it('(f) roadmap overlay: counts exact shelved rows without creating fake app packages', () => {
    const root = resolve(fx, 'happy');
    const r = run(['--root', root, '--bevy', fixtureBevy, '--roadmap', fixtureRoadmap, '--json']);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    const cats = JSON.parse(r.stdout).categories;
    expect(cats['3D Rendering'].shelved).toBe(1); // roadmap marks bloom_3d
    expect(cats['3D Rendering'].uncovered).toHaveLength(0);
    expect(cats['2D Rendering'].covered).toBe(1); // app metadata wins over roadmap text
    expect(cats['2D Rendering'].shelved).toBe(0);
    expect(JSON.parse(r.stdout).roadmapAuthorityConflicts).toEqual([
      { app: '@fixture/app-a', name: 'sprite', status: 'implemented' },
    ]);
  });

  it('(g) roadmap routes: reports missing feedback files without changing coverage', () => {
    const root = resolve(fx, 'happy');
    const r = run(['--root', root, '--bevy', fixtureBevy, '--roadmap', fixtureRoadmap, '--json']);
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.roadmapRoutes.total).toBe(2);
    expect(out.roadmapRoutes.missing).toEqual(['feedbacks/missing.md']);
    expect(out.categories['3D Rendering'].shelved).toBe(1);
  });

  it('(h) strict routes: fails closed when a shelved route is missing', () => {
    const root = resolve(fx, 'happy');
    const r = run([
      '--root',
      root,
      '--bevy',
      fixtureBevy,
      '--roadmap',
      fixtureRoadmap,
      '--strict-routes',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('bevy-roadmap-route-missing');
  });

  it('(i) strict authority: fails closed when app metadata masks a shelved roadmap row', () => {
    const root = resolve(fx, 'happy');
    const r = run([
      '--root',
      root,
      '--bevy',
      fixtureBevy,
      '--roadmap',
      fixtureRoadmap,
      '--strict-authority',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('bevy-coverage-authority-conflict');
  });
});
