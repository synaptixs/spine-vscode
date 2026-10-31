/**
 * Plan from requirement in the editor (SSPN-246, D103): **Spine: Plan from requirement…** in the
 * palette picks a workspace Markdown file or takes a pasted ticket or URL, and **Plan this
 * requirement** sits on a Markdown file's Explorer and editor context menus. Either way the plan
 * opens in the plan review (src/plans.ts), where Build waits on its approval (D75).
 *
 * The flow itself lives in src/requirements.ts; this file only draws it.
 */
import * as vscode from "vscode";
import { RestrictedWorkspaceError } from "./client";
import { type RequirementPlanner, type RequirementPrompts, sourceForFile, sourceTyped } from "./requirements";

const PASTE = "$(link) Paste a URL or ticket…";
/** Plans, dependencies and VCS folders hold Markdown that is not a requirement. */
const NOT_REQUIREMENTS = "{**/node_modules/**,**/.spine/**,**/.git/**,**/out/**}";
const MAX_FILES = 500;

const prompts: RequirementPrompts = {
  confirmSpend: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
  pickIntent: async (source, intents) =>
    (
      await vscode.window.showQuickPick(
        intents.map((i) => ({ label: i.id, description: i.title })),
        { title: `Spine: ${source} holds ${intents.length} intents`, placeHolder: "Which one should Spine plan?", ignoreFocusOut: true },
      )
    )?.label,
  info: (message) => void vscode.window.showInformationMessage(message),
  warn: (message) => void vscode.window.showWarningMessage(message),
};

export class SpineRequirements implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly planner: () => RequirementPlanner,
    private readonly onRestricted: () => void,
  ) {
    this.subscriptions = [
      vscode.commands.registerCommand("spine.planFromRequirement", () => this.guarded(() => this.pickAndPlan())),
      vscode.commands.registerCommand("spine.planThisRequirement", (uri?: vscode.Uri) =>
        this.guarded(() => this.planFile(uri ?? vscode.window.activeTextEditor?.document.uri)),
      ),
    ];
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }

  private async pickAndPlan(): Promise<void> {
    const files = await vscode.workspace.findFiles("**/*.md", NOT_REQUIREMENTS, MAX_FILES);
    const items: (vscode.QuickPickItem & { uri?: vscode.Uri })[] = [
      { label: PASTE, detail: "jira://…, confluence://…, notion://… or file://…" },
      ...files
        .map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "Spine: Plan from requirement",
      placeHolder: files.length >= MAX_FILES ? `a Markdown file (the first ${MAX_FILES}), or a ticket or URL` : "a Markdown file, or a ticket or URL",
      matchOnDetail: true,
    });
    if (!picked) return;
    if (picked.uri) return this.planFile(picked.uri);
    const typed = await vscode.window.showInputBox({
      title: "Spine: Plan from requirement",
      prompt: "The requirement's URL or ticket, as Spine reads it",
      placeHolder: "jira://PROJ-42",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : "Give a URL or ticket."),
    });
    if (typed === undefined) return;
    await this.plan(sourceTyped(typed));
  }

  private async planFile(uri: vscode.Uri | undefined): Promise<void> {
    if (!uri || uri.scheme !== "file" || !uri.path.toLowerCase().endsWith(".md")) {
      void vscode.window.showInformationMessage("Spine: Plan this requirement works on a Markdown file in this folder.");
      return;
    }
    await this.plan(sourceForFile(uri.fsPath));
  }

  private async plan(source: string): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Spine: planning ${source}…` },
      () => this.planner().plan(source, prompts),
    );
  }

  private async guarded(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      if (err instanceof RestrictedWorkspaceError) this.onRestricted();
      else void vscode.window.showErrorMessage(`Spine: ${(err as Error).message}`);
    }
  }
}
