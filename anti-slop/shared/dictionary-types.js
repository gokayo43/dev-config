/** @import { ESTree } from "@oxlint/plugins" */

const BUILT_INS = new Set([
  "Record",
  "Readonly",
  "Partial",
  "Required",
  "Pick",
  "Omit",
  "PropertyKey",
  "NonNullable",
]);
const TRANSPARENT_WRAPPERS = new Set(["Readonly", "Partial", "Required", "NonNullable"]);

/** @typedef {ReadonlyMap<string, ESTree.TSType>} TypeAliasEnvironment */

/**
 * @typedef {object} ResolvedType
 * @property {ESTree.TSType} type
 * @property {TypeAliasEnvironment} substitutions
 */

/**
 * @typedef {object} UnsafeDictionary
 * @property {"any" | "empty-object" | "object" | "union" | "unknown"} unsafeValue
 */

/** @typedef {"anonymous object" | "generic container" | "object" | "open dictionary" | "unknown"} WideningTargetKind */

/**
 * @typedef {object} WideningTarget
 * @property {WideningTargetKind} kind
 */

/**
 * @typedef {object} TypeEnvironment
 * @property {ReadonlyMap<string, ESTree.TSTypeAliasDeclaration>} aliases
 * @property {ReadonlyMap<string, readonly ESTree.TSInterfaceDeclaration[]>} interfaces
 * @property {ReadonlySet<string>} shadowedBuiltIns
 */

/**
 * @param {ESTree.Statement} statement
 * @returns {ESTree.Node | null}
 */
function declaredStatement(statement) {
  return statement.type === "ExportNamedDeclaration" ||
    statement.type === "ExportDefaultDeclaration"
    ? (statement.declaration ?? null)
    : statement;
}

/**
 * @param {ESTree.Program} program
 * @returns {TypeEnvironment}
 */
export function createTypeEnvironment(program) {
  /** @type {Map<string, ESTree.TSTypeAliasDeclaration>} */
  const aliases = new Map();
  /** @type {Map<string, ESTree.TSInterfaceDeclaration[]>} */
  const interfaces = new Map();
  /** @type {Set<string>} */
  const shadowedBuiltIns = new Set();

  for (const statement of program.body) {
    const declaration = declaredStatement(statement);
    if (declaration?.type === "ImportDeclaration") {
      for (const specifier of declaration.specifiers) {
        if (BUILT_INS.has(specifier.local.name)) shadowedBuiltIns.add(specifier.local.name);
      }
      continue;
    }

    if (declaration?.type === "TSTypeAliasDeclaration") {
      const existing = aliases.get(declaration.id.name);
      if (existing === undefined) aliases.set(declaration.id.name, declaration);
      else shadowedBuiltIns.add(declaration.id.name);
      if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
      continue;
    }

    if (declaration?.type === "TSInterfaceDeclaration") {
      const declarations = interfaces.get(declaration.id.name) ?? [];
      declarations.push(declaration);
      interfaces.set(declaration.id.name, declarations);
      if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
      continue;
    }

    if (declaration?.type === "TSEnumDeclaration") {
      if (BUILT_INS.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
      continue;
    }

    if (
      (declaration?.type === "ClassDeclaration" || declaration?.type === "FunctionDeclaration") &&
      declaration.id !== null &&
      BUILT_INS.has(declaration.id.name)
    ) {
      shadowedBuiltIns.add(declaration.id.name);
    }
  }

  return { aliases, interfaces, shadowedBuiltIns };
}

/**
 * @param {ESTree.TSTypeReference} type
 * @returns {string | null}
 */
function typeReferenceName(type) {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

/**
 * @param {string} name
 * @param {TypeEnvironment} environment
 * @returns {boolean}
 */
function isBuiltIn(name, environment) {
  return BUILT_INS.has(name) && !environment.shadowedBuiltIns.has(name);
}

/**
 * @param {ESTree.TSType} type
 * @param {string} name
 * @returns {boolean}
 */
function isUnappliedReferenceTo(type, name) {
  const unwrapped = unwrapTransparentType(type);
  return (
    unwrapped.type === "TSTypeReference" &&
    typeReferenceName(unwrapped) === name &&
    (unwrapped.typeArguments === null || unwrapped.typeArguments.params.length === 0)
  );
}

/**
 * @param {ESTree.TSType} type
 * @returns {ESTree.TSType}
 */
function unwrapTransparentType(type) {
  let current = type;
  while (
    current.type === "TSParenthesizedType" ||
    (current.type === "TSTypeOperator" && current.operator === "readonly")
  ) {
    current = current.typeAnnotation;
  }
  return current;
}

/**
 * @param {ESTree.TSType} type
 * @returns {boolean}
 */
function isNeverType(type) {
  return unwrapTransparentType(type).type === "TSNeverKeyword";
}

/**
 * @param {ESTree.TSSignature} member
 * @returns {boolean}
 */
function isEffectivelyEmptyMember(member) {
  return (
    member.type === "TSPropertySignature" &&
    member.optional &&
    member.typeAnnotation !== null &&
    isNeverType(member.typeAnnotation.typeAnnotation)
  );
}

/**
 * @param {ESTree.TSTypeLiteral} type
 * @returns {boolean}
 */
function isEffectivelyEmptyTypeLiteral(type) {
  return type.members.length === 0 || type.members.every(isEffectivelyEmptyMember);
}

/**
 * @param {readonly ESTree.TSInterfaceDeclaration[]} declarations
 * @returns {boolean}
 */
function isEffectivelyEmptyInterface(declarations) {
  if (declarations.length !== 1) return false;
  const [type] = declarations;
  return (
    type !== undefined &&
    type.extends.length === 0 &&
    (type.body.body.length === 0 || type.body.body.every(isEffectivelyEmptyMember))
  );
}

/**
 * @param {ESTree.TSType} type
 * @param {TypeAliasEnvironment} base
 * @param {ReadonlySet<string>} [resolving]
 * @returns {ESTree.TSType}
 */
function resolvedSubstitutionArgument(type, base, resolving = new Set()) {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type !== "TSTypeReference") return type;
  const name = typeReferenceName(unwrapped);
  if (name === null || resolving.has(name)) return type;
  const substitution = base.get(name);
  if (substitution === undefined) return type;
  const nextResolving = new Set(resolving);
  nextResolving.add(name);
  return resolvedSubstitutionArgument(substitution, base, nextResolving);
}

/**
 * @param {ESTree.TSTypeAliasDeclaration} alias
 * @param {ESTree.TSTypeReference} type
 * @param {TypeAliasEnvironment} base
 * @returns {TypeAliasEnvironment | null}
 */
function aliasSubstitution(alias, type, base) {
  const parameters = alias.typeParameters?.params ?? [];
  const typeArguments = type.typeArguments?.params ?? [];
  const next = new Map(base);
  for (const [index, parameter] of parameters.entries()) {
    const argument = typeArguments[index] ?? parameter.default;
    if (argument === null) return null;
    next.set(parameter.name.name, resolvedSubstitutionArgument(argument, next));
  }
  return next;
}

/**
 * @param {ESTree.TSType} type
 * @param {TypeEnvironment} environment
 * @param {TypeAliasEnvironment} substitutions
 * @param {ReadonlySet<string>} resolvingAliases
 * @returns {UnsafeDictionary["unsafeValue"] | null}
 */
function unsafeDirectValue(type, environment, substitutions, resolvingAliases) {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type === "TSUnknownKeyword") return "unknown";
  if (unwrapped.type === "TSAnyKeyword") return "any";
  if (unwrapped.type === "TSObjectKeyword") return "object";
  if (unwrapped.type === "TSTypeLiteral" && isEffectivelyEmptyTypeLiteral(unwrapped)) {
    return "empty-object";
  }
  if (unwrapped.type === "TSUnionType") {
    return unwrapped.types.some(
      (member) => unsafeDirectValue(member, environment, substitutions, resolvingAliases) !== null,
    )
      ? "union"
      : null;
  }
  if (unwrapped.type === "TSIntersectionType") {
    const unsafeMembers = unwrapped.types.map((member) =>
      unsafeDirectValue(member, environment, substitutions, resolvingAliases),
    );
    if (unsafeMembers.includes("any")) return "any";
    return unsafeMembers.length > 0 && unsafeMembers.every((member) => member !== null)
      ? (unsafeMembers[0] ?? null)
      : null;
  }
  if (unwrapped.type !== "TSTypeReference") return null;
  const name = typeReferenceName(unwrapped);
  if (name === null) return null;
  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? null
      : unsafeDirectValue(wrapped, environment, substitutions, resolvingAliases);
  }
  const substitution = substitutions.get(name);
  if (substitution !== undefined) {
    return isUnappliedReferenceTo(substitution, name)
      ? null
      : unsafeDirectValue(substitution, environment, substitutions, resolvingAliases);
  }
  const interfaceDeclarations = environment.interfaces.get(name);
  if (interfaceDeclarations !== undefined) {
    return isEffectivelyEmptyInterface(interfaceDeclarations) ? "empty-object" : null;
  }
  const alias = environment.aliases.get(name);
  if (alias === undefined || resolvingAliases.has(name)) return null;
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
  if (nextSubstitutions === null) return null;
  const nextResolving = new Set(resolvingAliases);
  nextResolving.add(name);
  return unsafeDirectValue(alias.typeAnnotation, environment, nextSubstitutions, nextResolving);
}

/**
 * @param {ESTree.TSType} type
 * @param {TypeEnvironment} environment
 * @param {TypeAliasEnvironment} substitutions
 * @param {ReadonlySet<string>} resolvingAliases
 * @returns {readonly ResolvedType[]}
 */
function dictionaryValueTypes(type, environment, substitutions, resolvingAliases) {
  const unwrapped = unwrapTransparentType(type);

  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.flatMap((member) =>
      member.type === "TSIndexSignature"
        ? [{ type: member.typeAnnotation.typeAnnotation, substitutions }]
        : [],
    );
  }

  if (unwrapped.type === "TSMappedType") {
    return unwrapped.typeAnnotation === null
      ? []
      : [{ type: unwrapped.typeAnnotation, substitutions }];
  }

  if (unwrapped.type !== "TSTypeReference") return [];
  const name = typeReferenceName(unwrapped);
  if (name === null) return [];

  const substitution = substitutions.get(name);
  if (substitution !== undefined) {
    return isUnappliedReferenceTo(substitution, name)
      ? []
      : dictionaryValueTypes(substitution, environment, substitutions, resolvingAliases);
  }

  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? []
      : dictionaryValueTypes(wrapped, environment, substitutions, resolvingAliases);
  }

  if (name === "Record" && isBuiltIn(name, environment)) {
    const value = unwrapped.typeArguments?.params[1] ?? null;
    return value === null ? [] : [{ type: value, substitutions }];
  }

  if ((name === "Pick" || name === "Omit") && isBuiltIn(name, environment)) {
    const source = unwrapped.typeArguments?.params[0];
    return source === undefined
      ? []
      : dictionaryValueTypes(source, environment, substitutions, resolvingAliases);
  }

  const alias = environment.aliases.get(name);
  if (alias === undefined || resolvingAliases.has(name)) return [];
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
  if (nextSubstitutions === null) return [];
  const nextResolving = new Set(resolvingAliases);
  nextResolving.add(name);
  return dictionaryValueTypes(alias.typeAnnotation, environment, nextSubstitutions, nextResolving);
}

/**
 * @param {ESTree.TSType} valueType
 * @param {TypeEnvironment} environment
 * @returns {UnsafeDictionary | null}
 */
export function classifyUnsafeDictionaryValue(valueType, environment) {
  const unsafeValue = unsafeDirectValue(valueType, environment, new Map(), new Set());
  return unsafeValue === null ? null : { unsafeValue };
}

/**
 * @param {ESTree.TSType} type
 * @param {TypeEnvironment} environment
 * @returns {UnsafeDictionary | null}
 */
export function classifyUnsafeDictionary(type, environment) {
  for (const valueType of dictionaryValueTypes(type, environment, new Map(), new Set())) {
    const unsafeValue = unsafeDirectValue(
      valueType.type,
      environment,
      valueType.substitutions,
      new Set(),
    );
    if (unsafeValue !== null) return { unsafeValue };
  }
  return null;
}

/**
 * @param {ESTree.TSType} type
 * @param {TypeEnvironment} environment
 * @param {TypeAliasEnvironment} substitutions
 * @param {ReadonlySet<string>} resolvingAliases
 * @returns {boolean}
 */
function resolvesToDictionary(type, environment, substitutions, resolvingAliases) {
  return dictionaryValueTypes(type, environment, substitutions, resolvingAliases).length > 0;
}

/**
 * @param {ESTree.TSType} type
 * @param {TypeEnvironment} environment
 * @returns {WideningTarget | null}
 */
export function classifyWideningTarget(type, environment) {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
  if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
  if (unwrapped.type === "TSTypeLiteral") {
    return unwrapped.members.some((member) => member.type === "TSIndexSignature")
      ? { kind: "open dictionary" }
      : unwrapped.members.length > 0
        ? { kind: "anonymous object" }
        : null;
  }
  if (unwrapped.type === "TSMappedType") return { kind: "open dictionary" };
  if (unwrapped.type !== "TSTypeReference") return null;
  const name = typeReferenceName(unwrapped);
  if (name === null) return null;
  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined ? null : classifyWideningTarget(wrapped, environment);
  }
  if (name === "Record" && isBuiltIn(name, environment)) return { kind: "open dictionary" };
  const alias = environment.aliases.get(name);
  if (alias === undefined) return null;
  if ((alias.typeParameters?.params.length ?? 0) > 0) {
    const generic = aliasSubstitution(alias, unwrapped, new Map());
    return generic !== null &&
      resolvesToDictionary(alias.typeAnnotation, environment, generic, new Set([name]))
      ? { kind: "generic container" }
      : null;
  }
  const substitutions = aliasSubstitution(alias, unwrapped, new Map());
  if (substitutions === null) return null;
  return classifyAliasBroadTarget(
    alias.typeAnnotation,
    environment,
    substitutions,
    new Set([name]),
  );
}

/**
 * @param {ESTree.TSType} type
 * @param {TypeEnvironment} environment
 * @param {TypeAliasEnvironment} substitutions
 * @param {ReadonlySet<string>} resolvingAliases
 * @returns {WideningTarget | null}
 */
function classifyAliasBroadTarget(type, environment, substitutions, resolvingAliases) {
  const unwrapped = unwrapTransparentType(type);
  if (unwrapped.type === "TSUnknownKeyword") return { kind: "unknown" };
  if (unwrapped.type === "TSObjectKeyword") return { kind: "object" };
  if (unwrapped.type !== "TSTypeReference") return null;
  const name = typeReferenceName(unwrapped);
  if (name === null) return null;
  const substitution = substitutions.get(name);
  if (substitution !== undefined) {
    return classifyAliasBroadTarget(substitution, environment, substitutions, resolvingAliases);
  }
  const alias = environment.aliases.get(name);
  if (alias === undefined || resolvingAliases.has(name)) return null;
  const nextSubstitutions = aliasSubstitution(alias, unwrapped, substitutions);
  if (nextSubstitutions === null) return null;
  const nextResolving = new Set(resolvingAliases);
  nextResolving.add(name);
  return classifyAliasBroadTarget(
    alias.typeAnnotation,
    environment,
    nextSubstitutions,
    nextResolving,
  );
}

/**
 * @param {ESTree.Expression} expression
 * @returns {boolean}
 */
export function isKnownEvidenceExpression(expression) {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSSatisfiesExpression"
  ) {
    current = current.expression;
  }
  return (
    current.type === "ObjectExpression" ||
    current.type === "ArrayExpression" ||
    current.type === "ArrowFunctionExpression" ||
    current.type === "ClassExpression" ||
    current.type === "FunctionExpression" ||
    current.type === "NewExpression" ||
    current.type === "Literal" ||
    current.type === "TemplateLiteral" ||
    current.type === "UnaryExpression"
  );
}
