/**
 * What Spine says about one file (`file_insights`), and the words a lens shows for it (D15).
 * No `vscode` import, so the wording is unit-tested directly.
 *
 * The wording rules are the contract: `caller_count` is a floor (callers the graph can type), so
 * it reads "at least"; a Python function with untraced same-named calls is never shown as having
 * none; a language that does not track untraced calls says so in Spine's own words.
 */

export interface UnresolvedCalls {
  count: number;
  shown: number;
  declared: number;
  sites: { caller: string; at: string; receiver: string }[];
}

export interface FileSymbol {
  id: string;
  name: string;
  kind: string;
  line: number | null;
  caller_count: number;
  interface_caller_count: number;
  instantiated_via_type_count?: number;
  target_covered: boolean;
  untested_in_reach: number;
  untested_truncated: boolean;
  unresolved_calls?: UnresolvedCalls | null;
  unresolved_calls_note?: string;
}

export interface FileInsights {
  file: string;
  found: boolean;
  symbol_count: number;
  shown: number;
  truncated: boolean;
  symbols: FileSymbol[];
  note?: string;
  error?: string;
}

/** Lenses shown per file; the rest are counted on a first-line lens (Invariant 7: top N of M). */
export const MAX_LENSES = 30;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function lensText(s: FileSymbol): string {
  const untraced = s.unresolved_calls?.count ?? 0;
  const through = s.interface_caller_count;
  const created = s.instantiated_via_type_count ?? 0;
  // "0 callers" would read as "nothing calls this"; with other reach it is only the typed floor
  const parts = [
    s.caller_count === 0 && (untraced || through || created)
      ? "0 typed callers"
      : `${plural(s.caller_count, "caller", "callers")} (at least)`,
  ];
  if (through) parts.push(`${through} through an interface`);
  if (created) parts.push(`${created} creations of its type`);
  if (s.untested_in_reach) parts.push(`${s.untested_in_reach}${s.untested_truncated ? "+" : ""} untested in reach`);
  if (s.unresolved_calls === null) parts.push(`untraced calls ${s.unresolved_calls_note ?? "not tracked"}`);
  else if (untraced) parts.push(plural(untraced, "possible untraced call", "possible untraced calls"));
  return parts.join(" · ");
}

export function capNote(insights: FileInsights, cap = MAX_LENSES): string | undefined {
  if (insights.symbol_count <= cap) return undefined;
  return `Spine: showing ${cap} of ${insights.symbol_count} functions and classes`;
}

/**
 * The 0-based line where `name` is declared in the current text: Spine's line (1-based, from the
 * saved file) if the name is on it, else the nearest line within `window` that names it as a word,
 * else Spine's line. Keeps lenses on their symbols while unsaved edits move lines a little.
 */
export function locate(lines: readonly string[], name: string, line: number, window = 20): number {
  const at = Math.min(Math.max(line - 1, 0), Math.max(lines.length - 1, 0));
  const word = new RegExp(`(^|[^\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w$])`);
  for (let d = 0; d <= window; d++) {
    for (const i of d === 0 ? [at] : [at - d, at + d]) {
      if (i >= 0 && i < lines.length && word.test(lines[i])) return i;
    }
  }
  return at;
}

/** The symbols that get a lens: the first MAX_LENSES, in Spine's line order. */
export function lensSymbols(insights: FileInsights): FileSymbol[] {
  return insights.symbols.slice(0, MAX_LENSES);
}
