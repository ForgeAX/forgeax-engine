#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOP_LEVEL_SKIP = new Set(['demo-gallery', 'shared', 'preview', 'rhi-debug-viewer']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.forgeax', '.git']);

/**
 * @param {string} rootDir
 * @returns {string[]}
 */
export function scanMaterialPackages(rootDir) {
  /** @type {string[]} */
  const packs = [];

  /** @param {string} current */
  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.pack.json') || entry.name.endsWith('.pack.ts')) {
        packs.push(resolve(full));
      }
    }
  }

  walk(rootDir);
  return packs.sort();
}

/**
 * @typedef {object} DemoEntry
 * @property {string} route
 * @property {string} dir
 * @property {string} consumerRoot
 * @property {string} name
 * @property {string} title
 * @property {string} category
 * @property {string[]} materialPackages
 * @property {string} [bevyName]
 * @property {string} [bevyCategory]
 */

/**
 * @param {string} appsDir
 * @returns {DemoEntry[]}
 */
export function scanDemos(appsDir) {
  /** @type {DemoEntry[]} */
  const demos = [];

  /**
   * @param {string} dir
   * @param {string} category
   * @returns {boolean}
   */
  function tryRegister(dir, category) {
    const indexHtml = join(dir, 'index.html');
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(indexHtml) || !existsSync(pkgPath)) return false;

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      return false;
    }

    if (typeof pkg.scripts?.dev !== 'string') return false;

    const route = relative(appsDir, dir).split('\\').join('/');
    const resolvedCategory = route.split('/')[0] || category || 'other';
    const bevy = pkg.forgeax?.bevyExample;
    demos.push({
      route,
      dir: resolve(dir),
      consumerRoot: resolve(dir),
      name: typeof pkg.name === 'string' ? pkg.name : route,
      title:
        (typeof bevy?.title === 'string' && bevy.title) ||
        (typeof pkg.description === 'string' && pkg.description.split('.')[0]) ||
        basename(dir),
      category: resolvedCategory,
      materialPackages: scanMaterialPackages(dir),
      ...(typeof bevy?.name === 'string' ? { bevyName: bevy.name } : {}),
      ...(typeof bevy?.category === 'string' ? { bevyCategory: bevy.category } : {}),
    });
    return true;
  }

  /**
   * @param {string} currentDir
   * @param {string} category
   */
  function walk(currentDir, category) {
    if (tryRegister(currentDir, category)) return;

    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(currentDir, entry.name);
      if (currentDir === appsDir && TOP_LEVEL_SKIP.has(entry.name)) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(full, category);
    }
  }

  walk(appsDir, '');

  demos.sort((a, b) => {
    const cat = a.category.localeCompare(b.category);
    if (cat !== 0) return cat;
    return a.route.localeCompare(b.route);
  });

  return demos;
}

/**
 * @param {string} appsDir
 */
export function buildCatalog(appsDir) {
  const monorepoRoot = resolve(appsDir, '..');
  return {
    appsDir,
    monorepoRoot,
    hostedDemos: scanDemos(appsDir),
  };
}

/**
 * @param {string} appsDir
 * @returns {object}
 */
export function buildManifest(appsDir) {
  const catalog = buildCatalog(appsDir);
  const demos = catalog.hostedDemos;
  const categories = [...new Set(demos.map((d) => d.category || 'other'))].sort();
  return {
    generatedAt: new Date().toISOString(),
    count: demos.length,
    categories,
    demos: demos.map(
      ({ route, name, title, category, bevyName, bevyCategory, materialPackages }) => ({
        route,
        name,
        title,
        category: category || 'other',
        url: `/demos/${route}/`,
        ...(bevyName ? { bevyName } : {}),
        ...(bevyCategory ? { bevyCategory } : {}),
        ...(materialPackages.length > 0 ? { materialPackageCount: materialPackages.length } : {}),
      }),
    ),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const appsDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  console.log(JSON.stringify(buildManifest(appsDir), null, 2));
}
