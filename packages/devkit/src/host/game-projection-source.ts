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
`;
