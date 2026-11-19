import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { getResourcePath, OpenAIFileEntrypointInputSchema, OpenAIUiToolMetadataSchema } from '@openai/mcp-extensions/server';
import { FILE_OPEN_TOOL, FILE_UI_URI, FILE_EXTENSIONS } from './contract.ts';

/** File selection enters the existing chat View; only the host supplies its path. */
export async function resolveViewFile(meta, signal) {
  let path;
  try { path = getResourcePath(meta); }
  catch { return { ok: false, error: { code: 'view-file-context-invalid', hint: 'The host file context is invalid.' } }; }
  if (!path || !isAbsolute(path)) return { ok: false, error: { code: 'view-file-context-missing', hint: 'The host did not supply an absolute file path.' } };
  return resolveViewSource(path, signal);
}

/** Both host file selection and explicit resource actions validate the same source. */
export async function resolveViewSource(path, signal) {
  const fail = (code, hint) => ({ ok: false, error: { code, hint } });
  if (typeof path !== 'string' || !isAbsolute(path))
    return fail('view-file-context-missing', 'Select an absolute asset source path.');
  if (!FILE_EXTENSIONS.some(extension => path.endsWith(extension)))
    return fail('view-file-unsupported', 'Open a .pack.json or .pack.ts asset source.');
  try {
    signal?.throwIfAborted();
    const file = await realpath(path);
    if (!(await stat(file)).isFile()) return fail('view-file-unavailable', 'The selected asset source is not a file.');
    let root = dirname(file);
    for (;;) {
      signal?.throwIfAborted();
      try {
        if ((await stat(join(root, 'forge.json'))).isFile())
          return { ok: true, value: { projectRoot: root, sourcePath: relative(root, file).replaceAll('\\', '/') } };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = dirname(root);
      if (parent === root) return fail('view-file-project-missing', 'The asset source has no enclosing ForgeAX project.');
      root = parent;
    }
  } catch (error) {
    signal?.throwIfAborted();
    return fail('view-file-unavailable', `The selected asset source is unavailable: ${error.code ?? 'read-failed'}.`);
  }
}

export const codexFileEntry = {
  tool: FILE_OPEN_TOOL,
  uri: FILE_UI_URI,
  inputSchema: OpenAIFileEntrypointInputSchema,
  metadata: { 'openai/ui': OpenAIUiToolMetadataSchema.parse({
    entrypoints: [{ type: 'file', extensions: [...FILE_EXTENSIONS] }],
    preferredModelDisplayMode: 'fullscreen',
  }) },
  resolve: resolveViewFile,
};
