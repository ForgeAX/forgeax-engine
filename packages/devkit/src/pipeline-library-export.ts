import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { RenderInspection } from '@forgeax/engine-render';

type PipelineLibraryInspection = NonNullable<RenderInspection['pipelineLibrary']>;
type PipelineLibraryManifest = NonNullable<RenderInspection['pipelineLibraryManifest']>;

import { liveDevControl } from './live-dev.js';

/** Read the actual renderer through the existing revision-fenced live control. */
export async function exportPipelineLibrary(
  root: string,
  args: {
    readonly revision: string;
    readonly output?: string;
  },
) {
  const response = (await liveDevControl(root, 'eval', {
    revision: args.revision,
    code: `const result = typeof execution !== 'undefined' && execution.inspectRenderer
      ? await execution.inspectRenderer({pipelineLibrary:true})
      : {ok:true,value:renderer.inspect({pipelineLibrary:true})};
    if (!result.ok) throw result.error;
    if (!result.value.pipelineLibraryManifest) throw new Error('Pipeline library export unavailable');
    return {manifest:result.value.pipelineLibraryManifest,inspection:result.value.pipelineLibrary,frame:result.value.frame};`,
  })) as {
    ok: boolean;
    error?: { code: string; hint: string };
    value?: {
      revision: string;
      result: {
        ok: boolean;
        error?: unknown;
        value?: {
          manifest: PipelineLibraryManifest;
          inspection: PipelineLibraryInspection;
          frame: unknown;
        };
      };
    };
  };
  if (!response.ok)
    return {
      ok: false as const,
      error: response.error ?? {
        code: 'pipeline-library-export-failed',
        hint: 'Live inspection returned no failure detail.',
      },
    };
  const value = response.value;
  if (value === undefined)
    return {
      ok: false as const,
      error: { code: 'pipeline-library-export-failed', hint: 'Live evaluation returned no value' },
    };
  const evaluated = value.result;
  if (!evaluated.ok || evaluated.value?.manifest.version !== 1)
    return {
      ok: false as const,
      error: {
        code: 'pipeline-library-export-failed',
        expected: 'a complete pipeline library from the active renderer',
        hint: 'Inspect the retained live evaluation failure.',
        detail: evaluated.error,
      },
    };
  const { manifest, inspection, frame } = evaluated.value;
  const output = resolve(root, args.output ?? '.forgeax/pipeline-library.json');
  const bytes = `${JSON.stringify(manifest)}\n`;
  const receipt = {
    revision: value.revision,
    output,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: Buffer.byteLength(bytes),
    inspection,
    frame,
    scope:
      'All observed ordinary RHI pipeline requests on the current WebGPU device. Synchronous creation does not prove native compilation completion. Unvisited gameplay/settings still require coverage.',
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
  await writeFile(`${output}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  return { ok: true as const, value: receipt };
}
