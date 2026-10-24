export {};

const rawArgs = process.argv.slice(2);

if (rawArgs[0] === '--__forgeax-backend') {
  const { runDevKitBackendProcess } = await import('./backend-process.js');
  if (!rawArgs[1] || !rawArgs[2])
    throw new Error('Backend process requires a root and startup claim');
  await runDevKitBackendProcess(rawArgs[1], rawArgs[2]);
  process.exit(0);
} else if (rawArgs[0] === '--__forgeax-live-daemon') {
  const root = rawArgs[1];
  const port = Number(rawArgs[2]);
  if (root === undefined || !Number.isInteger(port) || port <= 0) {
    process.exitCode = 2;
  } else {
    const lifetime = new AbortController();
    const stop = () => lifetime.abort();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
      const { runLiveDevDaemon } = await import('./live-dev.js');
      await runLiveDevDaemon(root, port, undefined, {
        snapshot: rawArgs[3] === 'snapshot',
        signal: lifetime.signal,
      });
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    }
    process.exit(0);
  }
} else if (rawArgs[0] === '--__forgeax-live-project') {
  const root = rawArgs[1];
  const generation = rawArgs[2];
  if (root === undefined || generation === undefined) process.exitCode = 2;
  else {
    const { runLiveProjectProcess } = await import('./live-dev.js');
    await runLiveProjectProcess(root, generation, rawArgs[3]);
  }
} else {
  const { runUnifiedCli } = await import('./unified-cli.js');
  const result = await runUnifiedCli(rawArgs, { presentation: 'compact' });
  const jsonFlag = [...rawArgs]
    .reverse()
    .find((arg) => arg === '--json' || arg.startsWith('--json='));
  if (jsonFlag !== undefined && jsonFlag !== '--json=false') {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.ok) {
    const value = result.value;
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Array.isArray(Reflect.get(value, 'nodes'))
    ) {
      const help = value as {
        readonly path?: string;
        readonly summary?: string;
        readonly nodes: readonly {
          readonly name: string;
          readonly summary?: string;
          readonly children?: readonly unknown[];
          readonly leaf?: unknown;
        }[];
        readonly leaf?: {
          readonly title: string;
          readonly realm: string;
          readonly inputSchema?: unknown;
          readonly outputSchema?: unknown;
          readonly inputDescription?: string;
          readonly outputDescription?: string;
          readonly capabilities: readonly string[];
          readonly errors: readonly string[];
          readonly example?: unknown;
        };
      };
      process.stdout.write(`${help.path === '' ? 'forgeax' : `forgeax ${help.path ?? ''}`}\n`);
      if (help.summary !== undefined) process.stdout.write(`  ${help.summary}\n`);
      // A tree marks only nodes with children; progressive help marks every non-leaf.
      const treeFlag = [...rawArgs]
        .reverse()
        .find((arg) => arg === '--tree' || arg.startsWith('--tree='));
      const tree = treeFlag !== undefined && treeFlag !== '--tree=false';
      const render = (nodes: readonly (typeof help.nodes)[number][], indent: string): void => {
        for (const node of nodes) {
          process.stdout.write(
            `${indent}${node.name}${node.children !== undefined || (!tree && node.leaf === undefined) ? ' …' : ''}${node.summary === undefined ? '' : `  ${node.summary}`}\n`,
          );
          if (node.children !== undefined)
            render(node.children as typeof help.nodes, `${indent}  `);
        }
      };
      render(help.nodes, '  ');
      if (help.leaf !== undefined) {
        const leaf = help.leaf;
        process.stdout.write(`  title: ${leaf.title}\n`);
        process.stdout.write(`  realm: ${leaf.realm}\n`);
        if (leaf.inputSchema !== undefined)
          process.stdout.write(`  input: ${JSON.stringify(leaf.inputSchema)}\n`);
        else if (leaf.inputDescription !== undefined)
          process.stdout.write(`  input: ${leaf.inputDescription}\n`);
        if (leaf.outputSchema !== undefined)
          process.stdout.write(`  output: ${JSON.stringify(leaf.outputSchema)}\n`);
        else if (leaf.outputDescription !== undefined)
          process.stdout.write(`  output: ${leaf.outputDescription}\n`);
        if (leaf.capabilities.length > 0)
          process.stdout.write(`  capabilities: ${leaf.capabilities.join(', ')}\n`);
        if (leaf.errors.length > 0) process.stdout.write(`  errors: ${leaf.errors.join(', ')}\n`);
        if (leaf.example !== undefined)
          process.stdout.write(`  example: ${JSON.stringify(leaf.example)}\n`);
      }
    } else if (value !== undefined) {
      process.stdout.write(`${JSON.stringify(value)}\n`);
      if (result.omitted !== undefined)
        process.stderr.write(
          `[forgeax] summarized ${result.omitted.fields.join(', ')}; rerun with ${result.omitted.flag} for the full value\n`,
        );
    }
  } else {
    process.stderr.write(
      `[forgeax] ${result.error?.code ?? 'cli-error'}: ${result.error?.hint ?? 'command failed'}\n`,
    );
  }
  if (!result.ok) process.exitCode = result.error?.code === 'cli-parse-error' ? 2 : 1;
}
