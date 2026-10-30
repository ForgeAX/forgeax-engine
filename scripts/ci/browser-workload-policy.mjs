import ts from 'typescript';

const propertyName = (name) =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText();

function objectFields(node) {
  return new Map(
    node.properties
      .filter(
        (property) =>
          ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property),
      )
      .map((property) => [propertyName(property.name), property]),
  );
}

function shadowCreation(node, ast) {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  const fields = objectFields(node);
  const component = fields.get('component')?.initializer?.getText(ast).split('.').at(-1);
  const data = fields.get('data')?.initializer;
  if (
    !['DirectionalLight', 'SpotLight', 'PointLightShadow'].includes(component) ||
    !data ||
    !ts.isObjectLiteralExpression(data)
  )
    return undefined;
  const workload = objectFields(data);
  const castShadow = workload.get('castShadow');
  if (
    component !== 'PointLightShadow' &&
    (castShadow === undefined || castShadow.initializer?.kind === ts.SyntaxKind.FalseKeyword)
  )
    return undefined;
  return { component, workload };
}

/** Creation literals must own their shadow workload instead of inheriting product defaults. */
export function implicitShadowWorkloads(file, text) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const violations = [];
  const visit = (node) => {
    const shadow = shadowCreation(node, ast);
    if (shadow) {
      const required =
        shadow.component === 'DirectionalLight' ? ['mapSize', 'cascadeCount'] : ['mapSize'];
      for (const field of required)
        if (!shadow.workload.has(field))
          violations.push(
            `${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${shadow.component} requires explicit ${field}`,
          );
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return violations;
}
