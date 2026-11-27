/** One generation owns the same game-defined read/action registrations on every Host. */
export const gameProjectionSource = `const gameProjectionDefinitions = new Map();
function registerGameProjection(kind, definition) {
  if (gameProjectionDefinitions.has(definition.id)) {
    throw new Error('forgeax: duplicate game projection id ' + definition.id);
  }
  const entry = { kind, definition };
  gameProjectionDefinitions.set(definition.id, entry);
  return () => {
    if (gameProjectionDefinitions.get(definition.id) === entry) {
      gameProjectionDefinitions.delete(definition.id);
    }
  };
}
const gameProjection = {
  registerAction: (definition) => registerGameProjection('action', definition),
  registerRead: (definition) => registerGameProjection('read', definition),
};
function listGameProjection() {
  return { reads: Array.from(gameProjectionDefinitions.entries()).filter(([, entry]) => entry.kind === 'read').map(([id]) => id) };
}
async function readGameProjection(id) {
  const entry = gameProjectionDefinitions.get(id);
  if (entry?.kind !== 'read') throw new Error('forgeax: game read projection not found ' + id);
  return entry.definition.read();
}
`;
