/** Optional lexical-name recovery. The caller supplies its pinned TypeScript parser. */
export function createSourceFunctionNameResolver(ts) {
  const cache = new Map();
  const isFunction = (node) =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);
  const propertyName = (node, source) => {
    if (!node) return null;
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node))
      return node.text;
    return node.getText(source).length <= 100 ? node.getText(source) : null;
  };
  return ({ file, text, line, column }) => {
    if (
      typeof text !== 'string' ||
      !Number.isSafeInteger(line) ||
      line < 1 ||
      !Number.isSafeInteger(column) ||
      column < 1
    )
      return null;
    let entry = cache.get(file);
    if (!entry || entry.text !== text) {
      const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      // Invalid or unsupported original text must not turn a raw name into a guessed name.
      if (source.parseDiagnostics.length) return null;
      // Resolve only unique, literal, same-module constants. Any other declaration
      // with that identifier is a conservative shadowing rejection.
      const bindings = new Map();
      const collect = (node) => {
        if (
          node.name &&
          ts.isIdentifier(node.name) &&
          (ts.isVariableDeclaration(node) ||
            ts.isParameter(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isBindingElement(node) ||
            ts.isImportSpecifier(node) ||
            ts.isImportClause(node) ||
            ts.isNamespaceImport(node))
        ) {
          const rows = bindings.get(node.name.text) ?? [];
          rows.push(node);
          bindings.set(node.name.text, rows);
        }
        ts.forEachChild(node, collect);
      };
      collect(source);
      const systemName = (property) => {
        const object = property?.parent,
          call = object?.parent;
        if (
          !object ||
          !ts.isObjectLiteralExpression(object) ||
          !call ||
          !ts.isCallExpression(call) ||
          call.arguments[0] !== object ||
          !ts.isIdentifier(call.expression) ||
          call.expression.text !== 'defineSystem'
        )
          return null;
        const names = object.properties.filter((p) => propertyName(p.name, source) === 'name');
        if (
          names.length !== 1 ||
          !ts.isPropertyAssignment(names[0]) ||
          object.properties.some((p) => ts.isSpreadAssignment(p))
        )
          return null;
        let value = names[0].initializer;
        if (ts.isIdentifier(value)) {
          const declarations = bindings.get(value.text);
          if (declarations?.length !== 1) return null;
          const declaration = declarations[0],
            list = declaration.parent;
          if (
            !ts.isVariableDeclaration(declaration) ||
            !ts.isVariableDeclarationList(list) ||
            !(list.flags & ts.NodeFlags.Const) ||
            !ts.isVariableStatement(list.parent) ||
            list.parent.parent !== source
          )
            return null;
          value = declaration.initializer;
        }
        return value && ts.isStringLiteral(value) ? value.text : null;
      };
      const functions = [];
      const boundFunction = (node) => {
        let name = ts.isConstructorDeclaration(node)
          ? 'constructor'
          : propertyName(node.name, source);
        let start = node.getStart(source);
        const parent = node.parent;
        if (
          !name &&
          parent &&
          parent.initializer === node &&
          (ts.isVariableDeclaration(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isPropertyAssignment(parent))
        ) {
          name = propertyName(parent.name, source);
          start = parent.getStart(source);
        }
        if (
          !name &&
          parent &&
          ts.isBinaryExpression(parent) &&
          parent.right === node &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          const left = parent.left;
          if (ts.isIdentifier(left) || ts.isPropertyAccessExpression(left)) {
            name = left.getText(source);
            start = parent.getStart(source);
          }
        }
        return { name, start };
      };
      const qualifiedMethodName = (node, name) => {
        if (
          name &&
          (ts.isMethodDeclaration(node) ||
            ts.isConstructorDeclaration(node) ||
            ts.isGetAccessorDeclaration(node) ||
            ts.isSetAccessorDeclaration(node))
        ) {
          const owner = node.parent;
          if ((ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) && owner.name)
            name = `${owner.name.text}.${name}`;
          if (ts.isGetAccessorDeclaration(node)) name = 'get ' + name;
          if (ts.isSetAccessorDeclaration(node)) name = 'set ' + name;
        }
        return name;
      };
      const functionIdentity = (node) => {
        let { name, start } = boundFunction(node);
        name = qualifiedMethodName(node, name);
        if (name === 'fn')
          name = systemName(ts.isMethodDeclaration(node) ? node : node.parent) ?? name;
        return { start, end: node.end, name };
      };
      const visit = (node) => {
        if (isFunction(node) && node.body) functions.push(functionIdentity(node));
        ts.forEachChild(node, visit);
      };
      visit(source);
      entry = { text, source, functions };
      cache.set(file, entry);
    }
    const starts = entry.source.getLineStarts();
    if (line > starts.length) return null;
    const position = starts[line - 1] + column - 1;
    const lineEnd = line < starts.length ? starts[line] : text.length + 1;
    if (position >= lineEnd || position > text.length) return null;
    let found;
    for (const fn of entry.functions)
      if (
        fn.start <= position &&
        position < fn.end &&
        (!found || fn.end - fn.start < found.end - found.start)
      )
        found = fn;
    return found?.name ?? null;
  };
}
