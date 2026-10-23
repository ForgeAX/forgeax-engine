// NODE_OPTIONS preload for the real startup probe: force closed stdin to be
// consumed when an interactive server installs its EOF shutdown listener.
process.stdin.on('newListener', event => {
  if (event === 'end') setImmediate(() => process.stdin.resume());
});
