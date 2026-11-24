/**
 * Plan review in the editor (SSPN-243, D27, D28): **Spine: Open plan…** lists the folder's plans,
 * the chosen one opens as a read-only `spine-plan:` document beside its Markdown preview, and
 * Approve/Reject sit in that document's title bar, enabled only when Spine says this caller may
 * decide (the status line gives the reason when not). No webview of our own. **Build** sits beside
 * them (SSPN-244, D93), enabled only on an approved plan where this window can build.
 *
 * The decisions themselves live in src/review.ts; this file only draws them.
 */
import * as fs from "node:fs";
import * as vscode from "vscode";
import { PlanMovedError } from "./calls";
import { RestrictedWorkspaceError } from "./client";
import { idOfPlanPath, planFile, planPath, type PlanReview, type PlanView, type Prompts, specFile, staleMessage, statusText } from "./review";

export const SCHEME = "spine-plan";
const CAN_DECIDE = "spine.planCanDecide";
const CAN_BUILD = "spine.planCanBuild";
const ACTIVE = "spine.planActive";

const planUri = (id: string) => vscode.Uri.from({ scheme: SCHEME, path: planPath(id) });
const idOf = (uri: vscode.Uri) => idOfPlanPath(uri.path);

const prompts: Prompts = {
  confirm: async (message, action) => (await vscode.window.showInformationMessage(message, { modal: true }, action)) === action,
  note: async (id) =>
    vscode.window.showInputBox({
      title: `Reject ${id}`,
      prompt: "Why? The note is recorded with the rejection.",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : "A rejection needs a note."),
    }),
  choose: async (message, actions) => vscode.window.showWarningMessage(message, { modal: true }, ...actions),
  info: (message) => void vscode.window.showInformationMessage(message),
  warn: (message) => void vscode.window.showWarningMessage(message),
};

export class SpinePlans implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly views = new Map<string, PlanView>();
  private active: string | undefined;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  /**
   * Spec files opened with Edit spec…, by path: saving one re-plans its intent (B180, D127), in the
   * folder the file is in, whatever folder is in front (review of #14).
   */
  private readonly editing = new Map<string, { id: string; repo: string }>();
  private readonly subscriptions: vscode.Disposable[];

  /**
   * `buildBlocker` says why this window cannot build (level, server, trust), or `undefined`;
   * `onBuild` starts a build of an approved plan (src/runs.ts, SSPN-244).
   */
  constructor(
    private readonly review: () => PlanReview,
    private readonly onRestricted: () => void,
    private readonly buildBlocker: () => string | undefined = () => "builds are not wired here",
    private readonly onBuild: (intentId: string) => Promise<void> = async () => {},
  ) {
    this.subscriptions = [
      this.changed,
      this.status,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      vscode.window.onDidChangeActiveTextEditor(() => this.showActive()),
      vscode.commands.registerCommand("spine.openPlan", (id?: string) => this.guarded(() => this.pickAndOpen(id))),
      vscode.commands.registerCommand("spine.approvePlan", (uri?: vscode.Uri) => this.guarded(() => this.decide(uri, false))),
      vscode.commands.registerCommand("spine.rejectPlan", (uri?: vscode.Uri) => this.guarded(() => this.decide(uri, true))),
      vscode.commands.registerCommand("spine.buildPlan", (uri?: vscode.Uri) => this.guarded(() => this.build(uri))),
      vscode.commands.registerCommand("spine.editSpec", (uri?: vscode.Uri) => this.guarded(() => this.editSpec(uri))),
      vscode.commands.registerCommand("spine.revealPlanFile", (uri?: vscode.Uri) => this.guarded(() => this.revealPlanFile(uri))),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const editing = this.editing.get(doc.uri.fsPath);
        if (editing) void this.guarded(() => this.replan(editing.id, editing.repo, doc));
      }),
      // A closed spec is no longer being edited here: a later save elsewhere must not re-plan.
      vscode.workspace.onDidCloseTextDocument((doc) => void this.editing.delete(doc.uri.fsPath)),
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
      /** What the Build button shows for the plan in front (SSPN-244, D93). */
      build: () => {
        const view = this.active ? this.views.get(this.active) : undefined;
        const blocker = this.buildBlocker();
        return { enabled: view?.state === "approved" && !blocker, blocker };
      },
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

  private viewFor(uri: vscode.Uri | undefined): PlanView | undefined {
    const id = uri?.scheme === SCHEME ? idOf(uri) : this.active;
    const view = id ? this.views.get(id) : undefined;
    if (!view) void vscode.window.showInformationMessage("Spine: open a plan first (Spine: Open plan…).");
    return view;
  }

  /**
   * B180, D127: the plan is rendered from its spec, and the build gate renders it again from that
   * spec, so the spec is what a person edits. It opens as the real file; saving it re-plans.
   */
  private async editSpec(uri: vscode.Uri | undefined): Promise<void> {
    const view = this.viewFor(uri);
    if (!view) return;
    if (view.remote) throw new Error(`Edit spec works on the local server only: ${view.intentId}'s spec is on ${view.server}`);
    const file = specFile(view.repo, view.intentId);
    if (!fs.existsSync(file)) {
      throw new Error(`Spine kept no spec for ${view.intentId} (planned before specs were kept): plan it again from its requirement`);
    }
    this.editing.set(file, { id: view.intentId, repo: view.repo });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
    void vscode.window.showInformationMessage(
      `Spine: edit ${view.intentId}'s title, summary, scope or acceptance criteria, then save. Spine re-plans it for $0, with no model. ` +
        "The plan's file list comes from the code graph: change the scope or criteria to move it.",
    );
  }

  private async replan(intentId: string, repo: string, doc: vscode.TextDocument): Promise<void> {
    let spec: Record<string, unknown>;
    try {
      spec = JSON.parse(doc.getText()) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`${intentId}'s spec is not valid JSON, so it was not re-planned: ${(err as Error).message}`);
    }
    const before = this.views.get(intentId)?.state;
    const after = this.store(
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Spine: re-planning ${intentId}…` }, () =>
        this.review().replan(intentId, spec, repo),
      ),
    );
    const decided = before === "approved" || before === "rejected" ? ` Its ${before === "approved" ? "approval" : "rejection"} no longer holds: read it and decide again.` : "";
    void vscode.window.showInformationMessage(`Spine: re-planned ${intentId} from its edited spec, for $0.${after.state === "stale" ? decided : ""}`);
  }

  private async revealPlanFile(uri: vscode.Uri | undefined): Promise<void> {
    const view = this.viewFor(uri);
    if (!view) return;
    if (view.remote) throw new Error(`${view.intentId}'s plan file is on ${view.server}, not on this machine`);
    await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(planFile(view.repo, view.intentId)));
  }

  private async build(uri: vscode.Uri | undefined): Promise<void> {
    const id = uri?.scheme === SCHEME ? idOf(uri) : this.active;
    const view = id ? this.views.get(id) : undefined;
    if (!view) {
      void vscode.window.showInformationMessage("Spine: open a plan first (Spine: Open plan…).");
      return;
    }
    if (view.state !== "approved") {
      void vscode.window.showWarningMessage(`Spine: ${view.intentId} is ${view.state}: only an approved plan is built.`);
      return;
    }
    // Builds run in the folder in use: a plan approved in another folder is not this folder's (B178).
    this.review().assertHere(view);
    // B182: the build derives the plan again; one from another commit parks at its gate.
    if (view.fresh === false) {
      const choice = await vscode.window.showWarningMessage(
        `${staleMessage(view)} A build now would park at the plan gate.`,
        { modal: true },
        "Re-plan ($0)",
        "Build anyway",
      );
      if (choice === "Re-plan ($0)") {
        this.store(await this.review().replanFromKept(view.intentId, view.repo));
        void vscode.window.showInformationMessage(`Spine: re-planned ${view.intentId} for $0. Read it, approve it, then build.`);
        return;
      }
      if (choice !== "Build anyway") return;
    }
    await this.onBuild(view.intentId);
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
    const blocker = this.buildBlocker();
    void vscode.commands.executeCommand("setContext", CAN_DECIDE, view?.canDecide === true);
    void vscode.commands.executeCommand("setContext", CAN_BUILD, view?.state === "approved" && !blocker);
    void vscode.commands.executeCommand("setContext", ACTIVE, view !== undefined);
    if (!view) return this.status.hide();
    const { text, tooltip } = statusText(view);
    this.status.text = view.canDecide ? text : `${text} $(lock)`;
    // A disabled title-bar button cannot say why, so the status line does (D93).
    const build = view.state !== "approved" ? "Build: only an approved plan is built." : blocker ? `Build is off: ${blocker}.` : "";
    this.status.tooltip = build ? `${tooltip}\n${build}` : tooltip;
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
