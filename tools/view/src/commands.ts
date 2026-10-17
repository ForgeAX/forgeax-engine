export const viewStartFrontendConfigSchema = {
  type: 'object',
  properties: {
    layout: { type: 'object', properties: { responsiveAutoTuck: { type: 'boolean' } }, additionalProperties: false },
  },
  additionalProperties: false,
} as const;

const properties = {
  root: { type: 'string' },
  project: { type: 'string', description: 'Project to open when the returned URL is visited; defaults to the backend root when it contains forge.json.' },
  frontendConfig: viewStartFrontendConfigSchema,
};
const ownerProperties = {
  root: { type: 'string' },
};
const projectOpenProperties = {
  root: { type: 'string' },
  project: { type: 'string' },
};
export const contract = {
  schemaVersion: '1.0.0',
  commands: [
    {
      id: 'view.start',
      path: ['view', 'start'],
      title: 'Start View',
      summary: 'Serve the optional View interface on an already-running Engine backend.',
      realm: 'host',
      argsSchema: JSON.stringify({ type: 'object', properties, additionalProperties: false }),
      executor: '@forgeax/view/command-executor',
      exportName: 'start',
    },
    {
      id: 'view.status',
      path: ['view', 'status'],
      title: 'View owner status',
      summary: 'Read the View interface status on the Engine backend.',
      realm: 'host',
      argsSchema: JSON.stringify({ type: 'object', properties: ownerProperties, additionalProperties: false }),
      executor: '@forgeax/view/command-executor',
      exportName: 'status',
    },
    {
      id: 'view.stop',
      path: ['view', 'stop'],
      title: 'Stop View',
      summary: 'Close View connections and release View plugins; preserve the Engine backend.',
      realm: 'host',
      argsSchema: JSON.stringify({ type: 'object', properties: ownerProperties, additionalProperties: false }),
      executor: '@forgeax/view/command-executor',
      exportName: 'stop',
    },
    {
      id: 'view.project.open',
      path: ['view', 'project', 'open'],
      title: 'Open View project',
      summary: 'Open a project on the running View and return its headed document URL.',
      realm: 'host',
      argsSchema: JSON.stringify({ type: 'object', properties: projectOpenProperties, additionalProperties: false }),
      executor: '@forgeax/view/command-executor',
      exportName: 'projectOpen',
    },
    {
      id: 'view.workspace.call',
      path: ['view', 'workspace', 'call'],
      title: 'Call View workspace API',
      summary: 'Call an operation on the running View workspace.',
      realm: 'host',
      argsSchema: JSON.stringify({ type: 'object', properties: {
        root: { type: 'string' }, operation: { type: 'string' }, args: { type: 'object' },
      }, required: ['operation'], additionalProperties: false }),
    },
  ],
} as const;

// CLI discovery reads only the contract. The executor activates the live plugin.
export default { name: 'forgeax.view.commands', apply() {} };
