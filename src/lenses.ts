/**
 * CodeLens and hover from Spine's graph: one `file_insights` call per open file (D13), cached until
 * something in the workspace is saved or changes on disk (D16), and an `explain_symbol` call per
 * hovered symbol (D17).
 *
 * The editor never waits on Spine: a file not answered yet shows "Spine: counting…" and the real
 * lenses arrive through `onDidChangeCodeLenses`. Spine answers for the saved files, so while a file
 * has unsaved edits each lens is placed by `locate`, near the line Spine named.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import type { SpineClient } from "./client";
import { capNote, type FileInsights, type FileSymbol, lensSymbols, lensText, locate } from "./insights";

export const COUNTING = "Spine: counting…";

interface Entry {
  generation: number;
  insights?: FileInsights;
  error?: string;
}

interface Explained {
  kind?: string;
  called_by_count?: number;
  calls_count?: number;
  calls?: string[];
  doc_count?: number;
  docs?: { doc?: string; title?: string; where?: string | null }[];
}

export class SpineLenses implements vscode.CodeLensProvider, vscode.HoverProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private generation = 0;
  private readonly files = new Map<string, Entry>();
  private readonly explained = new Map<string, Promise<Explained | undefined>>();

  constructor(
    private readonly client: () => SpineClient,
    private readonly root: () => vscode.Uri | undefined,
  ) {}

  /** Something in the workspace changed: every answer is for an older tree. */
  invalidate(): void {
    this.generation += 1;
    this.explained.clear();
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const rel = this.relative(doc.uri);
    if (!rel || !vscode.workspace.isTrusted) return [];
    const entry = this.files.get(rel);
    if (!entry || entry.generation !== this.generation) {
      this.fetch(rel);
      if (!entry?.insights) return [note(0, COUNTING)];
    }
    if (entry?.error) return [note(0, `Spine: ${entry.error}`)];
    const insights = entry?.insights;
    if (!insights) return [note(0, COUNTING)];
    const lines = doc.getText().split(/\r?\n/);
    const lenses = lensSymbols(insights).map((s) => {
      const line = locate(lines, s.name, s.line ?? 1);
      return new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: lensText(s),
        command: "spine.showCallers",
        arguments: [s.id, doc.uri, line],
        tooltip: "Show the callers the graph can type",
      });
    });
    const cap = capNote(insights);
    return cap ? [note(0, cap), ...lenses] : lenses;
  }

  async provideHover(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const rel = this.relative(doc.uri);
    const insights = rel ? this.files.get(rel)?.insights : undefined;
    const word = doc.getWordRangeAtPosition(position);
    if (!insights || !word) return undefined;
    const name = doc.getText(word);
    const lines = doc.getText().split(/\r?\n/);
    const symbol = lensSymbols(insights).find((s) => s.name === name && locate(lines, s.name, s.line ?? 1) === position.line);
    if (!symbol) return undefined;
    const explained = await this.explain(symbol.id);
    return explained ? new vscode.Hover(hoverText(symbol, explained), word) : undefined;
  }

  /** The callers of `id` the graph can type, as locations (shown in VS Code's references peek). */
  async callers(id: string): Promise<vscode.Location[]> {
    const root = this.root();
    if (!root) return [];
    const out = (await this.client().callTool("blast_radius", { repo_path: root.fsPath, symbol: id })) as {
      error?: string;
      matches?: { id: string; callers: { at: string }[] }[];
    };
    if (out.error) throw new Error(out.error);
    const match = out.matches?.find((m) => m.id === id);
    return (match?.callers ?? []).map((c) => {
      const [file, line] = splitAt(c.at);
      return new vscode.Location(vscode.Uri.joinPath(root, file), new vscode.Position(Math.max(line - 1, 0), 0));
    });
  }

  private fetch(rel: string): void {
    const root = this.root();
    const generation = this.generation;
    const pending = this.files.get(rel);
    if (!root || (pending && pending.generation === generation && !pending.insights && !pending.error)) return;
    this.files.set(rel, { generation, insights: pending?.insights });
    this.client()
      .callTool("file_insights", { repo_path: root.fsPath, path: rel })
      .then(
        (answer) => {
          const insights = answer as FileInsights;
          return insights.error ? { generation, error: insights.error } : { generation, insights };
        },
        (err: Error) => ({ generation, error: err.message.split("\n")[0] }),
      )
      .then((entry: Entry) => {
        if (entry.generation !== this.generation) return; // a newer tree is already being asked about
        this.files.set(rel, entry);
        this.changed.fire();
      });
  }

  private explain(id: string): Promise<Explained | undefined> {
    const key = `${this.generation}\0${id}`;
    let answer = this.explained.get(key);
    if (!answer) {
      const root = this.root();
      answer = root
        ? this.client()
            .callTool("explain_symbol", { repo_path: root.fsPath, symbol: id })
            .then(
              (out) => (out as { matches?: (Explained & { id: string })[] }).matches?.find((m) => m.id === id),
              () => undefined,
            )
        : Promise.resolve(undefined);
      this.explained.set(key, answer);
    }
    return answer;
  }

  private relative(uri: vscode.Uri): string | undefined {
    const root = this.root();
    if (!root || uri.scheme !== "file") return undefined;
    const rel = path.relative(root.fsPath, uri.fsPath);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : undefined;
  }
}

const note = (line: number, title: string) =>
  new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title, command: "" });

function splitAt(at: string): [string, number] {
  const i = at.lastIndexOf(":");
  return i > 0 ? [at.slice(0, i), Number(at.slice(i + 1)) || 1] : [at, 1];
}

/** Top N of M, never a list that implies it is complete (Invariant 7). */
function topOf(items: string[], total: number, n = 5): string {
  const head = items.slice(0, n).map((i) => `\`${i}\``).join(", ");
  return total > n ? `${head} — top ${n} of ${total}` : head;
}

function hoverText(s: FileSymbol, e: Explained): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${s.name}** — ${e.kind ?? s.kind} · Spine\n\n`);
  md.appendMarkdown(`Called by ${e.called_by_count ?? s.caller_count} (at least — the callers the graph can type)\n\n`);
  if (e.calls_count) md.appendMarkdown(`Calls ${e.calls_count}: ${topOf(e.calls ?? [], e.calls_count)}\n\n`);
  if (e.doc_count) {
    const docs = (e.docs ?? []).map((d) => d.title ?? d.doc ?? d.where ?? "?");
    md.appendMarkdown(`Docs ${e.doc_count}: ${topOf(docs, e.doc_count)}\n\n`);
  }
  md.appendMarkdown(lensText(s));
  return md;
}
