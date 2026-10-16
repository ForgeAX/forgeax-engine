console.log(
  JSON.stringify({
    schemaVersion: 'hello-taa-browser-smoke/1',
    cwd: process.cwd(),
    status: 'unavailable',
    acceptance: 'fail-closed',
    requiredVisualFailure: false,
  }),
);
console.error('provider launch diagnostic');
process.exit(1);
