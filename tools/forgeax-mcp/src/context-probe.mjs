import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Opt-in diagnostics: retain field names and directory locators, never tokens or content. */
export function summarizeContext(value) {
  const fields = [];
  const directories = [];
  const visit = (item, path, depth) => {
    if (fields.length >= 160 || depth > 5) return;
    if (Array.isArray(item)) {
      fields.push({ path, type: 'array' });
      for (const [index, child] of item.slice(0, 8).entries()) visit(child, `${path}[${index}]`, depth + 1);
      return;
    }
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        const childPath = path ? `${path}.${key}` : key;
        fields.push({ path: childPath, type: child === null ? 'null' : typeof child });
        if (/token|secret|authorization|cookie|content|text|prompt|transcript|payload/i.test(key)) continue;
        if (typeof child === 'string' && /^(cwd|workingDirectory|workspaceDirectory|projectRoot|workspaceRoot|directory|uri)$/i.test(key)) {
          if (child.startsWith('/') || child.startsWith('file:')) directories.push({ path: childPath, value: child.slice(0, 2048) });
        }
        visit(child, childPath, depth + 1);
      }
    }
  };
  visit(value, '', 0);
  return { fields, directories };
}

export function createContextProbe() {
  const file = process.env.FORGEAX_CONTEXT_PROBE;
  const seen = new Set();
  let writing = Promise.resolve();
  return {
    enabled: !!file,
    record(event, value) {
      if (!file || seen.has(event)) return writing;
      seen.add(event);
      const record = { event, pid: process.pid, processDirectory: process.cwd(), ...summarizeContext(value) };
      writing = writing.then(async () => {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      }).catch(error => process.stderr.write(`Context probe could not write evidence: ${error.code ?? 'unknown'}\n`));
      return writing;
    },
  };
}
