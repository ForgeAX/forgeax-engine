import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';

const app = createMcpExpressApp();
app.post('/trailing', (request, response) => {
  request.once('end', () => response.json(request.body));
  process.send({ parsed: true });
});
app.post('/plain', (request, response) => response.json(request.body));
const server = app.listen(0, '127.0.0.1', () => {
  process.send({ port: server.address().port });
});
