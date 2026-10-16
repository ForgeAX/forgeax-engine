import { access, lstat, readdir, readlink, symlink } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), '../..');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function linkTemplateAgents(root = repositoryRoot) {
  const templatesRoot = resolve(root, 'templates');
  const shared = resolve(templatesRoot, 'AGENTS.md');
  await access(shared);
  const linked = [];
  const unchanged = [];
  for (const entry of await readdir(templatesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const templateRoot = resolve(templatesRoot, entry.name);
    if (!(await exists(resolve(templateRoot, 'forge.json')))) continue;
    const target = resolve(templateRoot, 'AGENTS.md');
    const expected = relative(templateRoot, shared);
    try {
      const info = await lstat(target);
      if (!info.isSymbolicLink() || (await readlink(target)) !== expected) {
        throw new Error(`template-agents-conflict: ${target}`);
      }
      unchanged.push(entry.name);
    } catch (cause) {
      if (
        cause !== null &&
        typeof cause === 'object' &&
        'code' in cause &&
        cause.code === 'ENOENT'
      ) {
        await symlink(expected, target, 'file');
        linked.push(entry.name);
        continue;
      }
      throw cause;
    }
  }
  return { linked, unchanged };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const result = await linkTemplateAgents();
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}
