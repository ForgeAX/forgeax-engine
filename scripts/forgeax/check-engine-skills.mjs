import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  publicEngineFacadeSubpaths,
  publicEngineMembers,
} from '../../packages/engine/scripts/public-facades.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skillsRoot = resolve(root, 'skills');
const failures = [];
const headingCache = new Map();
const execFileAsync = promisify(execFile);

const publicFacadeSubpaths = publicEngineFacadeSubpaths(await publicEngineMembers(root));

function fail(file, message) {
  failures.push(`${relative(root, file)}: ${message}`);
}

function parseFrontmatter(file, source) {
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    fail(file, 'missing YAML frontmatter');
    return undefined;
  }
  const lines = match[1].split('\n');
  const nameLine = lines.find((line) => line.startsWith('name:'));
  const descriptionIndex = lines.findIndex((line) => line.startsWith('description:'));
  const name = nameLine?.slice('name:'.length).trim();
  if (descriptionIndex < 0) return { name, description: undefined };

  const first = lines[descriptionIndex].slice('description:'.length).trim();
  if (first !== '>-' && first !== '|-') return { name, description: first };
  const descriptionLines = [];
  for (const line of lines.slice(descriptionIndex + 1)) {
    if (!/^\s+/.test(line)) break;
    descriptionLines.push(line.trim());
  }
  const folded = descriptionLines.join(' ');
  return { name, description: folded };
}

async function markdownFiles(directory, insideReferences = false) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(path, insideReferences || entry.name === 'references')));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.md') &&
      (entry.name === 'SKILL.md' || insideReferences)
    ) {
      files.push(path);
    }
  }
  return files;
}

async function headingSlugs(file) {
  const cached = headingCache.get(file);
  if (cached) return cached;
  const slugs = new Set();
  const counts = new Map();
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1]
      .replace(/<[^>]*>/g, '')
      .replace(/[`*~]/g, '')
      .toLocaleLowerCase('en-US')
      .trim()
      .replace(/[^\p{Letter}\p{Number}\p{Mark}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  headingCache.set(file, slugs);
  return slugs;
}

async function checkLinks(file, source) {
  for (const match of source.matchAll(/\]\(([^)\s]+)(?:\s+['"][^)]*['"])?\)/g)) {
    const raw = match[1].replace(/^<|>$/g, '');
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(raw)) continue;
    const [pathAndQuery, fragment] = raw.split('#', 2);
    const pathText = pathAndQuery.split('?', 1)[0];
    let decoded;
    try {
      decoded = decodeURIComponent(pathText);
    } catch {
      fail(file, `invalid encoded link: ${raw}`);
      continue;
    }
    const target = decoded === '' ? file : resolve(dirname(file), decoded);
    try {
      await stat(target);
    } catch {
      fail(file, `broken relative link: ${raw}`);
      continue;
    }
    if (fragment && target.endsWith('.md')) {
      const decodedFragment = decodeURIComponent(fragment).toLocaleLowerCase('en-US');
      if (!(await headingSlugs(target)).has(decodedFragment)) {
        fail(file, `broken heading link: ${raw}`);
      }
    }
  }
}

function checkPublicFacadeImports(file, source) {
  for (const match of source.matchAll(/`@forgeax\/engine\/([^`\s]+)`/g)) {
    const subpath = match[1];
    if (subpath.includes('<')) continue;
    if (!publicFacadeSubpaths.has(subpath)) {
      fail(file, `public umbrella import has no generated facade: @forgeax/engine/${subpath}`);
    }
  }
}

function checkDocumentationImports(file, source) {
  for (const match of source.matchAll(
    /\b(?:from|import)\s*(?:type\s*)?(?:\(\s*)?['"](@forgeax\/engine-[^'"]+)['"]/g,
  )) {
    fail(file, `documentation example leaks physical package: ${match[1]}`);
  }
  for (const token of [
    'templates/game-empty',
    'templates/game-default',
    'templates/game-brotato-3d',
    'forge.json#entry',
    'package.json#forgeax.assets',
    'executionEntry',
  ]) {
    if (source.includes(token)) fail(file, `documentation retains retired contract: ${token}`);
  }
}

const skillDirectories = (await readdir(skillsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name));

for (const entry of skillDirectories) {
  const skillFile = resolve(skillsRoot, entry.name, 'SKILL.md');
  let source;
  try {
    source = await readFile(skillFile, 'utf8');
  } catch {
    fail(skillFile, 'missing SKILL.md');
    continue;
  }

  const frontmatter = parseFrontmatter(skillFile, source);
  if (frontmatter?.name !== entry.name) {
    fail(skillFile, `frontmatter name must equal directory name ${entry.name}`);
  }
  if (!frontmatter?.description) {
    fail(skillFile, 'description is required');
  } else {
    if (frontmatter.description.length > 240) {
      fail(
        skillFile,
        `description is ${frontmatter.description.length} characters; maximum is 240`,
      );
    }
    if (!/(?:^|\. )Use when\b/.test(frontmatter.description)) {
      fail(skillFile, 'description must use "<scope>. Use when <trigger>."');
    }
  }
  if (/(?:Baseline:|\u57fa\u7ebf:|\u540c\u6b65\u81f3:)/u.test(source)) {
    fail(skillFile, 'move historical baselines out of the action entrypoint');
  }
}

for (const file of await markdownFiles(skillsRoot)) {
  const source = await readFile(file, 'utf8');
  await checkLinks(file, source);
  checkPublicFacadeImports(file, source);
  if (file === resolve(skillsRoot, 'forgeax-engine-sdk/references/feature-catalog.md')) {
    const baseline = source.match(/Generation baseline commit:\s*`([0-9a-f]{40})`/u)?.[1];
    if (baseline === undefined) {
      fail(file, 'missing full capability baseline commit');
    } else {
      try {
        await execFileAsync('git', ['merge-base', '--is-ancestor', baseline, 'HEAD'], {
          cwd: root,
        });
      } catch {
        fail(file, `capability baseline is not an ancestor of HEAD: ${baseline}`);
      }
    }
  }
}

const projectDocumentation = [
  resolve(root, 'AGENTS.md'),
  resolve(root, 'packages/project/README.md'),
  resolve(root, 'packages/plugin/README.md'),
  resolve(root, 'packages/devkit/README.md'),
  resolve(root, 'packages/pack/README.md'),
  resolve(root, 'packages/scene/README.md'),
  resolve(root, 'packages/engine/README.md'),
];
for (const file of projectDocumentation) {
  const source = await readFile(file, 'utf8');
  await checkLinks(file, source);
  checkPublicFacadeImports(file, source);
  checkDocumentationImports(file, source);
}

for (const file of [
  resolve(root, 'templates/AGENTS.md'),
  resolve(skillsRoot, 'forgeax-engine-sdk/SDK-AGENTS.md'),
  resolve(skillsRoot, 'forgeax-engine-sdk/SDK-README.md'),
]) {
  checkPublicFacadeImports(file, await readFile(file, 'utf8'));
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`engine-skills-ok: ${skillDirectories.length} skills`);
}
