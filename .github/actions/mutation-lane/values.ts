/**
 * How the lane reads what a repo wrote and quotes it back: an answer or the
 * problems in its place, a setting written as one string or several, and a
 * value set in a diagnostic as a span nothing in it can end. Three modules of
 * the lane read or quote the repo's text, `mutation-lane.ts`, `tests.ts` and
 * `report.ts`, so these sit apart from all three.
 */
import { isList, type Problem } from "../_lib/gate.ts";

/**
 * What a read gave, or what to tell the repo instead — the two kept apart the
 * way `Base` in `_lib/gate.ts` keeps them, because "here it is" and "there is
 * none to give you" are not one value with a hole in it.
 */
export type Answer<T> = { readonly value: T } | { readonly problems: readonly Problem[] };

/** A setting written as one string or a list of them, as both configs read here allow. */
export function strings(value: unknown): string[] {
  return (isList(value) ? value : [value]).filter(
    (each): each is string => typeof each === "string",
  );
}

/**
 * A value out of the repo's own source, as a code span it cannot end early. The
 * step summary is markdown, and a replacement carrying a backtick — every
 * template literal in the tree does — closes the span, leaving the rest of the
 * line to render as headings and table rows somebody wrote in a domain file.
 * The same statement `commanded` in `_lib/gate.ts` makes about annotations: the
 * text is not the gate author's to trust.
 *
 * CommonMark's own rule, rather than an escape: a span fenced by more backticks
 * than its longest run contains cannot be ended from inside, and a space either
 * side keeps a leading or trailing backtick from eating the fence.
 */
export function span(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const runs = [...flat.matchAll(/`+/g)].map((run) => run[0].length);
  const fence = "`".repeat(Math.max(0, ...runs) + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}
