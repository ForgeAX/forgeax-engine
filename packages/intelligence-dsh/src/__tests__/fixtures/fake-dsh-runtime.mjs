import { appendFileSync } from 'node:fs';

const lifecyclePath = process.env.DSH_FAKE_LIFECYCLE;
if (lifecyclePath) appendFileSync(lifecyclePath, `started:${process.pid}\n`);
process.on('exit', () => {
  if (lifecyclePath) appendFileSync(lifecyclePath, `closed:${process.pid}\n`);
});

process.stdin.setEncoding('utf8');
let buffered = '';

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params });
}

function handle(request) {
  if (request.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: request.id,
      result: { serverInfo: { name: 'forgeax-fake-dsh-runtime', version: '0.1.0' } },
    });
    return;
  }
  if (request.method === 'session/prompt') {
    const sessionId = request.params.sessionId;
    const messageId = `message-${request.id}`;
    write({ jsonrpc: '2.0', id: request.id, result: { messageId } });
    queueMicrotask(() => {
      notify('session.event', {
        sessionId,
        event: { type: 'agent/inbox/spliced', data: { inserted: [{ id: messageId }] } },
      });
      notify('session.event', {
        sessionId,
        event: {
          type: 'assistant/chunk',
          data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' } },
        },
      });
      const text = request.params.contentBlocks?.[0]?.text;
      if (text === 'hang') return;
      notify('session.event', {
        sessionId,
        event: {
          type: 'assistant/message',
          data: {
            turn: 1,
            step: 1,
            message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
          },
        },
      });
      notify('session.status', { sessionId, status: 'idle' });
    });
    return;
  }
  if (request.method === 'shutdown') {
    write({ jsonrpc: '2.0', id: request.id, result: {} });
    setImmediate(() => process.exit(0));
  }
}

process.stdin.on('data', (chunk) => {
  buffered += chunk;
  while (true) {
    const newline = buffered.indexOf('\n');
    if (newline < 0) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
