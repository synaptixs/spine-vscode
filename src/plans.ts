/**
 * Plan review in the editor (SSPN-243, D27, D28): **Spine: Open plan…** lists the folder's plans,
 * the chosen one opens as a read-only `spine-plan:` document beside its Markdown preview, and
 * Approve/Reject sit in that document's title bar, enabled only when Spine says this caller may
 * decide (the status line gives the reason when not). No webview of our own.
 *
 * The decisions themselves live in src/review.ts; this file only draws them.
 */
import * as vscode from "vscode";
import { PlanMovedError } from "./calls";
import { RestrictedWorkspaceError } from "./client";
import { type PlanReview, type PlanView, type Prompts, statusText } from "./review";

export const SCHEME = "spine-plan";
const CAN_DECIDE = "spine.planCanDecide";
const ACTIVE = "spine.planActive";

const planUri = (id: string) => vscode.Uri.from({ scheme: SCHEME, path: `/${id}.md` });
const idOf = (uri: vscode.Uri) => uri.path.replace(/^\//, "").replace(/\.md$/, "");

const prompts: Prompts = {
  confirm: async (message, action) => (await vscode.window.showInformationMessage(message, { modal: true }, action)) === action,
  note: async (id) =>
    vscode.window.showInputBox({
      title: `Reject ${id}`,
      prompt: "Why? The note is recorded with the rejection.",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : "A rejection needs a note."),
    }),
  info: (message) => void vscode.window.showInformationMessage(message),
  warn: (message) => void vscode.window.showWarningMessage(message),
};

export class SpinePlans implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly views = new Map<string, PlanView>();
  private active: string | undefined;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly review: () => PlanReview,
    private readonly onRestricted: () => void,
  ) {
    this.subscriptions = [
      this.changed,
      this.status,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      vscode.window.onDidChangeActiveTextEditor(() => this.showActive()),
      vscode.commands.registerCommand("spine.openPlan", (id?: string) => this.guarded(() => this.pickAndOpen(id))),
      vscode.commands.registerCommand("spine.approvePlan", (uri?: vscode.Uri) => this.guarded(() => this.decide(uri, false))),
      vscode.commands.registerCommand("spine.rejectPlan", (uri?: vscode.Uri) => this.guarded(() => this.decide(uri, true))),
    ];
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }

  /**
   * Spine's settings changed: an open plan's `can_approve` and server may no longer hold, so no
   * open plan can be decided on until it is opened again.
   */
  invalidate(): void {
    for (const [id, view] of this.views) {
      this.views.set(id, { ...view, canDecide: false, reason: "Spine's settings changed since this plan was opened: open it again" });
    }
    this.showActive();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.views.get(idOf(uri))?.document ?? "";
  }

  /** For the integration suites only: `activate` exposes it only when loaded from source (src/hooks.ts), never to users. */
  api() {
    return {
      list: () => this.review().list(),
      current: () => (this.active ? this.views.get(this.active) : undefined),
      decide: async (id: string, decision: { reject: boolean; note?: string }) => {
        const view = this.views.get(id);
        if (!view) throw new Error(`${id} is not open`);
        try {
          return this.store(await this.review().decide(view, decision));
        } catch (err) {
          if (!(err instanceof PlanMovedError)) throw err;
          this.store(await this.review().open(id));
          throw new Error(`the plan ${id} changed since you opened it: it is reopened, read it again`);
        }
      },
    };
  }

  private async pickAndOpen(id?: string): Promise<void> {
    if (!id) {
      const listed = await this.review().list();
      if (!listed.plans.length) {
        void vscode.window.showInformationMessage("Spine: this folder has no plans yet (sdlc_plan writes them).");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        listed.plans.map((p) => ({ label: p.intent_id, description: p.state, detail: p.decided_by ? `decided by ${p.decided_by}` : undefined })),
        {
          title: "Spine: Open plan",
          placeHolder: listed.truncated ? `showing ${listed.plans.length} of ${listed.count} plans` : `${listed.count} plans`,
        },
      );
      if (!picked) return;
      id = picked.label;
    }
    this.store(await this.review().open(id));
    const doc = await vscode.workspace.openTextDocument(planUri(id));
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand("markdown.showPreviewToSide", doc.uri);
    this.showActive();
  }

  private async decide(uri: vscode.Uri | undefined, reject: boolean): Promise<void> {
    const id = uri?.scheme === SCHEME ? idOf(uri) : this.active;
    const view = id ? this.views.get(id) : undefined;
    if (!view) {
      void vscode.window.showInformationMessage("Spine: open a plan first (Spine: Open plan…).");
      return;
    }
    const after = reject ? await this.review().reject(view, prompts) : await this.review().approve(view, prompts);
    if (after) this.store(after);
  }

  private store(view: PlanView): PlanView {
    this.views.set(view.intentId, view);
    this.active = view.intentId;
    this.changed.fire(planUri(view.intentId));
    this.showActive();
    return view;
  }

  /** The status line and the buttons follow the plan in front: its editor, or its preview. */
  private showActive(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.uri.scheme === SCHEME) this.active = idOf(doc.uri);
    const view = doc && doc.uri.scheme !== SCHEME ? undefined : this.active ? this.views.get(this.active) : undefined;
    void vscode.commands.executeCommand("setContext", CAN_DECIDE, view?.canDecide === true);
    void vscode.commands.executeCommand("setContext", ACTIVE, view !== undefined);
    if (!view) return this.status.hide();
    const { text, tooltip } = statusText(view);
    this.status.text = view.canDecide ? text : `${text} $(lock)`;
    this.status.tooltip = tooltip;
    this.status.show();
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
