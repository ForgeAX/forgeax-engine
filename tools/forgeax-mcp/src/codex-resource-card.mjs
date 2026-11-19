import { basename, join } from 'node:path';
import { z } from 'zod';
import { OpenAIUiToolMetadataSchema } from '@openai/mcp-extensions/server';
import { RESOURCE_CARD_SLOTS, RESOURCE_VIEW_TOOL, RESOURCE_VIEW_URI } from './contract.ts';
import { resolveViewSource } from './codex-file-entry.mjs';

/** A resource card admits source paths; host metadata still owns instance routing. */
export const codexResourceCard = {
  ...RESOURCE_CARD_SLOTS[0],
  slots: RESOURCE_CARD_SLOTS.slice(1),
  inputSchema: z.object({
    paths: z.array(z.string().min(1).max(2048)).min(1).max(8),
    prepareBackend: z.boolean().optional(),
  }).strict(),
  metadata: { 'openai/ui': OpenAIUiToolMetadataSchema.parse({ preferredModelDisplayMode: 'inline' }) },
  async prepare({ paths }, signal) {
    const resources = [];
    for (const path of paths) {
      const result = await resolveViewSource(path, signal);
      if (!result.ok) return { isError: true, content: [{ type: 'text', text: result.error.hint }], structuredContent: result };
      const canonical = join(result.value.projectRoot, result.value.sourcePath);
      if (!resources.some(resource => resource.path === canonical))
        resources.push({ path: canonical, label: basename(canonical) });
    }
    return { content: [{ type: 'text', text: 'Use the resource buttons to open ForgeAX View and select an asset source.' }],
      structuredContent: { resources } };
  },
  resolve: resolveViewSource,
  direct: {
    tool: RESOURCE_VIEW_TOOL,
    uri: RESOURCE_VIEW_URI,
    inputSchema: z.object({ path: z.string().min(1).max(2048) }).strict(),
    metadata: { 'openai/ui': OpenAIUiToolMetadataSchema.parse({ preferredModelDisplayMode: 'fullscreen' }) },
    prepare: ({ path }, signal) => codexResourceCard.prepare({ paths: [path] }, signal),
  },
};
