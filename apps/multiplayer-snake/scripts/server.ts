import { startServer } from '../src/server.ts';

const requestedPort = Number(process.env.FORGEAX_SNAKE_PORT ?? 8787);
if (!Number.isInteger(requestedPort) || requestedPort <= 0 || requestedPort > 65_535)
  throw new Error('FORGEAX_SNAKE_PORT must be an integer between 1 and 65535');

const server = await startServer(requestedPort);
console.log(`Snake authority listening on ws://localhost:${server.port}`);

let stopping = false;
const stop = async (exitCode = 0): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await server.close();
  process.exit(exitCode);
};

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
await new Promise<void>(() => {});
