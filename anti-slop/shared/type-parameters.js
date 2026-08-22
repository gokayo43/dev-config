/** @import { ESTree } from "@oxlint/plugins" */

/**
 * Where an `infer` binder sits, so the branch it is in scope for can be told
 * from the branch it is not: TypeScript binds it only in the true branch, and
 * the same name in the false branch is still whatever the file declared.
 * @typedef {object} InferBinder
 * @property {string} name
 * @property {number} start
 * @property {number} end
 */

/**
 * @typedef {object} TypeParameterScopes
 * @property {() => void} reset
 * @property {(node: ESTree.TSInferType) => void} record
 * @property {(node: ESTree.Node) => ReadonlySet<string>} at
 */

/**
 * The names bound as type parameters where a rule is looking.
 *
 * Every rule here that reads a type reference by name resolves it against the
 * file's module-level aliases. A type parameter takes that name for the whole
 * of the declaration binding it, so `type Value = unknown;` beside
 * `function f<Value>(x: Value)` puts two different `Value`s in one file, and a
 * rule that knows only the alias reads the parameter as `unknown` and reports
 * code that says nothing of the kind.
 *
 * The answer is handed to `resolveType` as the set of names already being
 * resolved, which is the stop that walk already has: a name it must not follow
 * to a definition is one question whether a cycle or a binder put it there.
 * @returns {TypeParameterScopes}
 */
export function createTypeParameterScopes() {
  /** @type {InferBinder[]} */
  let inferred = [];

  return {
    reset() {
      inferred = [];
    },

    // `infer` is legal only in a conditional's `extendsType`, which precedes
    // both branches in source order — so every binder is recorded before any
    // node that could be shadowed by it is visited, and no second pass is owed.
    record(node) {
      inferred.push({
        name: node.typeParameter.name.name,
        start: node.start,
        end: node.end,
      });
    },

    at(node) {
      /** @type {Set<string>} */
      const names = new Set();
      /** @type {ESTree.Node} */
      let descendant = node;
      /** @type {ESTree.Node} */
      let current = node;

      // Every chain reaches `Program`, which is where the module-level aliases
      // are and so the point past which nothing further can shadow one.
      while (current.type !== "Program") {
        if ("typeParameters" in current) {
          for (const parameter of current.typeParameters?.params ?? []) {
            names.add(parameter.name.name);
          }
        }
        // A mapped type's key is bound in the two positions that can read it,
        // and nowhere else — its own constraint is where the key is introduced.
        if (
          current.type === "TSMappedType" &&
          (descendant === current.nameType || descendant === current.typeAnnotation)
        ) {
          names.add(current.key.name);
        }
        if (current.type === "TSConditionalType" && descendant === current.trueType) {
          for (const binder of inferred) {
            if (
              binder.start >= current.extendsType.start &&
              binder.end <= current.extendsType.end
            ) {
              names.add(binder.name);
            }
          }
        }
        descendant = current;
        current = current.parent;
      }
      return names;
    },
  };
}
