import { PLUGINS_OPERATION_DESCRIPTIONS } from './api.ts';

export const cliContributions = Object.freeze(
  PLUGINS_OPERATION_DESCRIPTIONS.map((description) => ({
    id: description.id,
    path: description.id.split('.'),
    summary: description.summary,
    operation: description.id,
  })),
);
