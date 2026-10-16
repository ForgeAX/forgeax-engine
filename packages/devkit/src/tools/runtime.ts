import {
  createToolRuntime,
  type ToolContribution,
  type ToolRuntime,
} from '@forgeax/engine-tool-runtime';
import { createPreviewContributions } from './preview-contributions.js';

export function createDevkitToolRuntime<TArgs, TResult>(
  contributions: readonly ToolContribution<TArgs, TResult>[],
): ToolRuntime;
export function createDevkitToolRuntime(contributions: readonly unknown[]): ToolRuntime;
export function createDevkitToolRuntime(contributions: readonly unknown[]): ToolRuntime {
  return createToolRuntime(contributions);
}

export function createPreviewToolRuntime(): ToolRuntime {
  return createToolRuntime(createPreviewContributions());
}
