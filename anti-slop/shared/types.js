/** @import { ESTree } from "@oxlint/plugins" */

import { typeReferenceName, unwrapType } from "./syntax.js";

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

/** The built-ins that answer the same type they wrap, so a rule reads straight through them. */
const TRANSPARENT_WRAPPERS = new Set(["Readonly", "Partial", "Required", "NonNullable"]);

/** @typedef {ReadonlyMap<string, ESTree.TSType>} Substitutions */

/**
 * A type together with the state that reading it further depends on: the type
 * arguments in force where the walk stopped, and the aliases already entered on
 * the way — an alias reached a second time is a cycle, not a definition.
 * @typedef {object} ResolvedType
 * @property {ESTree.TSType} type
 * @property {Substitutions} substitutions
 * @property {ReadonlySet<string>} resolving
 */

/**
 * @typedef {object} UnsafeDictionary
 * @property {"any" | "empty-object" | "object" | "union" | "unknown"} unsafeValue
 */

/** @typedef {"anonymous object" | "generic container" | "object" | "open dictionary" | "unknown"} WideningTargetKind */

/**
 * @typedef {object} WideningTarget
 * @property {WideningTargetKind} kind
 * @property {ESTree.TSType} type
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
 * Every name a top-level declaration binds. A file that declares or imports
 * `Record` has taken the name, and every rule here that reads `Record<K, V>` as
 * a dictionary would otherwise be reading someone else's type.
 * @param {ESTree.Node} declaration
 * @returns {readonly string[]}
 */
function declaredNames(declaration) {
  if (declaration.type === "ImportDeclaration") {
    return declaration.specifiers.map((specifier) => specifier.local.name);
  }
  if (
    declaration.type === "TSTypeAliasDeclaration" ||
    declaration.type === "TSInterfaceDeclaration" ||
    declaration.type === "TSEnumDeclaration"
  ) {
    return [declaration.id.name];
  }
  return (declaration.type === "ClassDeclaration" || declaration.type === "FunctionDeclaration") &&
    declaration.id !== null
    ? [declaration.id.name]
    : [];
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
    if (declaration === null) continue;
    for (const name of declaredNames(declaration)) {
      if (BUILT_INS.has(name)) shadowedBuiltIns.add(name);
    }

    if (declaration.type === "TSTypeAliasDeclaration") {
      // A name declared twice is a file this cannot reason about, so it stops
      // being one of ours in exactly the way an imported name does.
      if (aliases.has(declaration.id.name)) shadowedBuiltIns.add(declaration.id.name);
      else aliases.set(declaration.id.name, declaration);
    } else if (declaration.type === "TSInterfaceDeclaration") {
      const declarations = interfaces.get(declaration.id.name) ?? [];
      declarations.push(declaration);
      interfaces.set(declaration.id.name, declarations);
    }
  }

  return { aliases, interfaces, shadowedBuiltIns };
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
  const unwrapped = unwrapType(type);
  return (
    unwrapped.type === "TSTypeReference" &&
    typeReferenceName(unwrapped) === name &&
    (unwrapped.typeArguments === null || unwrapped.typeArguments.params.length === 0)
  );
}

/**
 * @param {ESTree.TSType} type
 * @returns {boolean}
 */
function isNeverType(type) {
  return unwrapType(type).type === "TSNeverKeyword";
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
 * A type argument reduced through whatever the caller already substituted, so
 * an alias applied to another alias's parameter carries a type rather than a
 * name that means nothing where it lands.
 * @param {ESTree.TSType} type
 * @param {Substitutions} base
 * @param {ReadonlySet<string>} [resolving]
 * @returns {ESTree.TSType}
 */
function resolvedSubstitutionArgument(type, base, resolving = new Set()) {
  const unwrapped = unwrapType(type);
  if (unwrapped.type !== "TSTypeReference") return type;
  const name = typeReferenceName(unwrapped);
  if (name === null || resolving.has(name)) return type;
  const substitution = base.get(name);
  if (substitution === undefined) return type;
  return resolvedSubstitutionArgument(substitution, base, new Set([...resolving, name]));
}

/**
 * The type arguments an alias reference binds, on top of what was already in
 * force. Nothing when the reference leaves a parameter with neither an argument
 * nor a default, since the alias's body is then not a type at all.
 * @param {ESTree.TSTypeAliasDeclaration} alias
 * @param {ESTree.TSTypeReference} type
 * @param {Substitutions} base
 * @returns {Substitutions | null}
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
 * What a type finally stands for. Parentheses and `readonly` come off, a type
 * parameter becomes its argument, a transparent built-in becomes what it wraps,
 * and an alias becomes its definition under the arguments the reference bound —
 * repeatedly, until none of those applies. It stops at whatever is left: a
 * keyword, a literal, `Record`, an interface's name, a name this file does not
 * declare, or an alias already being resolved, which is a cycle.
 *
 * This is the one walk: "is this unknown", "what does this dictionary hold" and
 * "how broad is this target" are switches over the node it stops at, and a new
 * question about a type is another switch rather than another walk.
 * @param {ESTree.TSType} type
 * @param {TypeEnvironment} environment
 * @param {Substitutions} [substitutions]
 * @param {ReadonlySet<string>} [resolving]
 * @returns {ResolvedType}
 */
export function resolveType(type, environment, substitutions = new Map(), resolving = new Set()) {
  const unwrapped = unwrapType(type);
  /** @type {ResolvedType} */
  const stopped = { type: unwrapped, substitutions, resolving };
  if (unwrapped.type !== "TSTypeReference") return stopped;
  const name = typeReferenceName(unwrapped);
  if (name === null) return stopped;

  const substitution = substitutions.get(name);
  if (substitution !== undefined) {
    return isUnappliedReferenceTo(substitution, name)
      ? stopped
      : resolveType(substitution, environment, substitutions, resolving);
  }

  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
    const wrapped = unwrapped.typeArguments?.params[0];
    return wrapped === undefined
      ? stopped
      : resolveType(wrapped, environment, substitutions, resolving);
  }

  const alias = environment.aliases.get(name);
  if (alias === undefined || resolving.has(name)) return stopped;
  const applied = aliasSubstitution(alias, unwrapped, substitutions);
  return applied === null
    ? stopped
    : resolveType(alias.typeAnnotation, environment, applied, new Set([...resolving, name]));
}

/**
 * Which escape hatch a value type is, when it is one. A union counts if any
 * member does; an intersection only when every member does, since one concrete
 * member is a contract the others cannot widen — except `any`, which erases it.
 * @param {ESTree.TSType} type
 * @param {TypeEnvironment} environment
 * @param {Substitutions} substitutions
 * @param {ReadonlySet<string>} resolving
 * @returns {UnsafeDictionary["unsafeValue"] | null}
 */
function unsafeDirectValue(type, environment, substitutions, resolving) {
  const resolved = resolveType(type, environment, substitutions, resolving);
  const node = resolved.type;
  /** @param {ESTree.TSType} each */
  const unsafeMember = (each) =>
    unsafeDirectValue(each, environment, resolved.substitutions, resolved.resolving);

  if (node.type === "TSUnknownKeyword") return "unknown";
  if (node.type === "TSAnyKeyword") return "any";
  if (node.type === "TSObjectKeyword") return "object";
  if (node.type === "TSTypeLiteral") {
    return isEffectivelyEmptyTypeLiteral(node) ? "empty-object" : null;
  }
  if (node.type === "TSUnionType") {
    return node.types.some((each) => unsafeMember(each) !== null) ? "union" : null;
  }
  if (node.type === "TSIntersectionType") {
    const unsafeMembers = node.types.map(unsafeMember);
    if (unsafeMembers.includes("any")) return "any";
    return unsafeMembers.length > 0 && unsafeMembers.every((each) => each !== null)
      ? (unsafeMembers[0] ?? null)
      : null;
  }
  if (node.type !== "TSTypeReference") return null;
  const name = typeReferenceName(node);
  const declarations = name === null ? undefined : environment.interfaces.get(name);
  return declarations !== undefined && isEffectivelyEmptyInterface(declarations)
    ? "empty-object"
    : null;
}

/**
 * The value types a dictionary contract carries, each with the state needed to
 * read it further. Nothing when the type is not a dictionary at all.
 * @param {ESTree.TSType} type
 * @param {TypeEnvironment} environment
 * @param {Substitutions} substitutions
 * @param {ReadonlySet<string>} resolving
 * @returns {readonly ResolvedType[]}
 */
function dictionaryValueTypes(type, environment, substitutions, resolving) {
  const resolved = resolveType(type, environment, substitutions, resolving);
  const node = resolved.type;
  /** @param {ESTree.TSType} value */
  const carried = (value) => ({
    type: value,
    substitutions: resolved.substitutions,
    resolving: resolved.resolving,
  });

  if (node.type === "TSTypeLiteral") {
    return node.members.flatMap((member) =>
      member.type === "TSIndexSignature" ? [carried(member.typeAnnotation.typeAnnotation)] : [],
    );
  }
  if (node.type === "TSMappedType") {
    return node.typeAnnotation === null ? [] : [carried(node.typeAnnotation)];
  }
  if (node.type !== "TSTypeReference") return [];
  const name = typeReferenceName(node);
  if (name === null || !isBuiltIn(name, environment)) return [];

  if (name === "Record") {
    const value = node.typeArguments?.params[1];
    return value === undefined ? [] : [carried(value)];
  }
  if (name === "Pick" || name === "Omit") {
    const source = node.typeArguments?.params[0];
    return source === undefined
      ? []
      : dictionaryValueTypes(source, environment, resolved.substitutions, resolved.resolving);
  }
  return [];
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
  for (const value of dictionaryValueTypes(type, environment, new Map(), new Set())) {
    const unsafeValue = unsafeDirectValue(value.type, environment, value.substitutions, new Set());
    if (unsafeValue !== null) return { unsafeValue };
  }
  return null;
}

/**
 * @param {ESTree.TSTypeLiteral} type
 * @returns {WideningTarget | null}
 */
function literalTarget(type) {
  if (type.members.some((member) => member.type === "TSIndexSignature")) {
    return { kind: "open dictionary", type };
  }
  return type.members.length > 0 ? { kind: "anonymous object", type } : null;
}

/**
 * What an alias reference is, as a widening target. A generic alias is reported
 * for what it contains, because applying one is how a dictionary gets written
 * without the word; a plain alias is a name someone chose, so only the broad
 * keywords it finally resolves to count against it — a named contract over a
 * shape is the thing this rule tells people to introduce.
 * @param {ESTree.TSTypeAliasDeclaration} alias
 * @param {ESTree.TSTypeReference} reference
 * @param {string} name
 * @param {TypeEnvironment} environment
 * @returns {WideningTarget | null}
 */
function aliasTarget(alias, reference, name, environment) {
  const substitutions = aliasSubstitution(alias, reference, new Map());
  if (substitutions === null) return null;
  const resolving = new Set([name]);

  if ((alias.typeParameters?.params.length ?? 0) > 0) {
    return dictionaryValueTypes(alias.typeAnnotation, environment, substitutions, resolving)
      .length > 0
      ? { kind: "generic container", type: reference }
      : null;
  }

  const { type } = resolveType(alias.typeAnnotation, environment, substitutions, resolving);
  if (type.type === "TSUnknownKeyword") return { kind: "unknown", type };
  return type.type === "TSObjectKeyword" ? { kind: "object", type } : null;
}

/**
 * How broad a target type is, for a value that already has a type. The arms
 * above the alias lookup are about what the author wrote — an anonymous object
 * and a bare `Record` are targets in a way the same thing behind a name is not.
 * @param {ESTree.TSType} type
 * @param {TypeEnvironment} environment
 * @returns {WideningTarget | null}
 */
export function classifyWideningTarget(type, environment) {
  const node = unwrapType(type);
  if (node.type === "TSUnknownKeyword") return { kind: "unknown", type: node };
  if (node.type === "TSObjectKeyword") return { kind: "object", type: node };
  if (node.type === "TSTypeLiteral") return literalTarget(node);
  if (node.type === "TSMappedType") return { kind: "open dictionary", type: node };
  if (node.type !== "TSTypeReference") return null;
  const name = typeReferenceName(node);
  if (name === null) return null;

  if (TRANSPARENT_WRAPPERS.has(name) && isBuiltIn(name, environment)) {
    const wrapped = node.typeArguments?.params[0];
    return wrapped === undefined ? null : classifyWideningTarget(wrapped, environment);
  }
  if (name === "Record" && isBuiltIn(name, environment))
    return { kind: "open dictionary", type: node };

  const alias = environment.aliases.get(name);
  return alias === undefined ? null : aliasTarget(alias, node, name, environment);
}
