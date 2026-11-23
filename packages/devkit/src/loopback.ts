import { once } from 'node:events';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer, type Server } from 'node:net';

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

/** Vite treats port zero as its default port; ask the OS for a loopback port. */
export async function materializeViteDevPort(port = 0): Promise<number> {
  return port === 0 ? probeLoopbackPort(port) : port;
}

export async function probeLoopbackPort(port: number): Promise<number> {
  const reservation = createServer();
  await once(reservation.listen(port, '127.0.0.1'), 'listening');
  const address = reservation.address();
  await closeServer(reservation);
  if (address === null || typeof address === 'string' || address.port === 0)
    throw new Error('OS did not assign an ephemeral loopback port');
  return address.port;
}

type JsonReply = readonly [status: number, body: unknown];

interface LoopbackJsonService {
  readonly host?: '127.0.0.1' | 'localhost' | undefined;
  readonly bearerToken: string;
  readonly route: (path: string) => string | undefined;
  readonly missingRoute: unknown;
  readonly rejectedToken: unknown;
  readonly invalidRequest: (cause: unknown) => unknown;
  readonly run: (route: string, body: unknown) => JsonReply | Promise<JsonReply>;
  readonly maxBodyBytes?: number;
}

export async function readLoopbackJson(
  request: IncomingMessage,
  {
    maxBytes = Infinity,
    emptyObject = false,
  }: { maxBytes?: number | undefined; emptyObject?: boolean } = {},
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  if (bytes.length > maxBytes) throw new Error('request body is too large');
  const text = bytes.toString('utf8');
  return emptyObject && text.trim().length === 0 ? {} : JSON.parse(text);
}

export function writeLoopbackJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  trailingNewline = false,
): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  const encoded = JSON.stringify(body);
  response.end(trailingNewline ? `${encoded}\n` : encoded);
}

/** Own the socket and authenticate admitted POST routes before reading their bodies. */
export async function serveLoopbackJson(options: LoopbackJsonService) {
  const host = options.host ?? '127.0.0.1';
  const server = createHttpServer(async (request, response) => {
    const route = request.method === 'POST' ? options.route(request.url ?? '') : undefined;
    if (route === undefined) return writeLoopbackJson(response, 404, options.missingRoute);
    if (request.headers.authorization !== `Bearer ${options.bearerToken}`)
      return writeLoopbackJson(response, 401, options.rejectedToken);
    try {
      const result = await options.run(
        route,
        await readLoopbackJson(request, { maxBytes: options.maxBodyBytes }),
      );
      writeLoopbackJson(response, ...result);
    } catch (cause) {
      writeLoopbackJson(response, 400, options.invalidRequest(cause));
    }
  });
  await once(server.listen(0, host), 'listening');
  let closed = false;
  const close = async (retire?: () => void) => {
    if (closed) return;
    closed = true;
    await closeServer(server);
    retire?.();
  };
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await close();
    throw new Error('loopback service did not expose a TCP address');
  }
  return { origin: `http://${host}:${address.port}`, close };
}
