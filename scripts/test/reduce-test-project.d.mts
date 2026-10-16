import type quality from './render-quality.json';

export function reduceTestProject(root: string, overrides?: Partial<typeof quality>): Promise<void>;
