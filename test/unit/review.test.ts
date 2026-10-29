import * as assert from "node:assert/strict";
import { checked, PlanMovedError, type SpineCalls } from "../../src/calls";
import { RestrictedWorkspaceError } from "../../src/client";
import { PlanReview, type Prompts, statusText } from "../../src/review";

const ID = "INT-7";
const REPO = "/work/shop";

/**
 * A fake Spine holding one plan. `sdlc_approve` behaves as the real one does: it refuses an
 * `expected_digest` that is not the current one, and records nothing then.
 */
function fakeSpine(opts: { remote?: boolean; canApprove?: boolean; reason?: string; digest?: string; failReopen?: boolean } = {}) {
  const state = {
    text: "# Build document\n\n§1 Requirement\n",
    version: 1,
    approval: null as null | { decision: string; decided_by: string; digest: string; note: string; decided_at: string },
    seen: [] as { tool: string; args: Record<string, unknown> }[],
  };
  const digest = () => `digest-v${state.version}-0123456789abcdef`;
  const calls: SpineCalls = {
    server: opts.remote ? "company-spine" : "local",
    remote: !!opts.remote,
    call: async (tool, args) => {
      state.seen.push({ tool, args });
      if (tool === "sdlc_plan_document" && !args.intent_id) {
        return { plans: [{ intent_id: ID, state: "none", decided_by: "" }], count: 51, truncated: true };
      }
      if (tool === "sdlc_plan_document") {
        if (opts.failReopen && state.approval) throw new Error("connection closed");
        const st = !state.approval ? "none" : state.approval.digest !== digest() ? "stale" : state.approval.decision.toLowerCase();
        return {
          intent_id: ID,
          document: state.text,
          digest: opts.digest ?? digest(),
          state: st,
          approval: state.approval,
          can_approve: opts.canApprove ?? true,
          reason: opts.reason ?? "",
        };
      }
      if (tool === "sdlc_approve") {
        if (args.expected_digest && args.expected_digest !== digest()) {
          return checked({ error: "the plan has changed since it was read", expected_digest: args.expected_digest, digest: digest() });
        }
        state.approval = {
          decision: args.reject ? "REJECTED" : "APPROVED",
          decided_by: (args.decided_by as string) || "ada@example.com",
          digest: digest(),
          note: (args.note as string) ?? "",
          decided_at: "2026-10-29T18:00:00Z",
        };
        return { intent_id: ID, decision: state.approval.decision, decided_by: state.approval.decided_by };
      }
      throw new Error(`unexpected tool ${tool}`);
    },
  };
  return {
    calls,
    state,
    edit: () => {
      state.text += "\nedited\n";
      state.version += 1;
    },
    approvals: () => state.seen.filter((s) => s.tool === "sdlc_approve"),
  };
}

function review(spine: ReturnType<typeof fakeSpine>, opts: { trusted?: boolean; gitName?: string; repo?: string } = {}) {
  let asked = 0;
  const r = new PlanReview({
    calls: () => spine.calls,
    repo: () => ("repo" in opts ? opts.repo : REPO),
    isTrusted: () => opts.trusted ?? true,
    approverName: async () => {
      asked += 1;
      return opts.gitName ?? "Ada Lovelace";
    },
  });
  return { r, asked: () => asked };
}

function prompts(answers: { confirm?: boolean; note?: string } = {}) {
  const said = { confirm: [] as string[], info: [] as string[], warn: [] as string[], notes: 0 };
  const p: Prompts = {
    confirm: async (message) => {
      said.confirm.push(message);
      return answers.confirm ?? true;
    },
    note: async () => {
      said.notes += 1;
      return answers.note;
    },
    info: (m) => void said.info.push(m),
    warn: (m) => void said.warn.push(m),
  };
  return { p, said };
}

describe("PlanReview", () => {
  describe("opening a plan", () => {
    it("shows what Spine answered, with the approver the record will name", async () => {
      const spine = fakeSpine();
      const view = await review(spine).r.open(ID);
      assert.equal(view.intentId, ID);
      assert.equal(view.document, spine.state.text);
      assert.equal(view.digest, "digest-v1-0123456789abcdef");
      assert.equal(view.state, "none");
      assert.equal(view.approver, "Ada Lovelace");
      assert.equal(view.canDecide, true);
      assert.equal(view.reason, "");
      assert.deepEqual(spine.state.seen, [{ tool: "sdlc_plan_document", args: { repo_path: REPO, intent_id: ID } }]);
    });

    it("cannot decide, with Spine's reason, when the server says this caller may not approve", async () => {
      const view = await review(fakeSpine({ canApprove: false, reason: "approving needs scope 'spine:plan'" })).r.open(ID);
      assert.equal(view.canDecide, false);
      assert.equal(view.reason, "approving needs scope 'spine:plan'");
    });

    it("cannot decide locally when git names nobody, and says how to fix it", async () => {
      const view = await review(fakeSpine(), { gitName: "  " }).r.open(ID);
      assert.equal(view.canDecide, false);
      assert.match(view.reason, /git config user\.name/);
    });

    it("on a remote server asks git for no name: the sign-in names the approver", async () => {
      const spine = fakeSpine({ remote: true });
      const { r, asked } = review(spine);
      const view = await r.open(ID);
      assert.equal(view.remote, true);
      assert.equal(view.server, "company-spine");
      assert.equal(view.approver, "");
      assert.equal(view.canDecide, true);
      assert.equal(asked(), 0);
    });

    it("cannot decide on a plan Spine gave no digest for: an empty one would bind nothing (review item 5)", async () => {
      const spine = fakeSpine({ digest: "" });
      const { r } = review(spine);
      const view = await r.open(ID);
      assert.equal(view.canDecide, false);
      assert.match(view.reason, /no digest/);
      await assert.rejects(r.decide({ ...view, canDecide: true }, { reject: false }), /no digest/);
      assert.deepEqual(spine.approvals(), []);
    });

    it("on a remote server needs the repository's path there, not this machine's (review item 3)", async () => {
      const spine = fakeSpine({ remote: true });
      await assert.rejects(review(spine, { repo: undefined }).r.open(ID), /spine\.serverRepo .*company-spine/);
      await assert.rejects(review(fakeSpine(), { repo: undefined }).r.open(ID), /open a folder/);
      assert.deepEqual(spine.state.seen, []);
    });

    it("lists the folder's plans, bounded", async () => {
      const listed = await review(fakeSpine()).r.list();
      assert.deepEqual(listed.plans, [{ intent_id: ID, state: "none", decided_by: "" }]);
      assert.equal(listed.count, 51);
      assert.equal(listed.truncated, true);
    });
  });

  describe("deciding", () => {
    it("approves the digest that was shown, under the git name", async () => {
      const spine = fakeSpine();
      const { r } = review(spine);
      const view = await r.open(ID);
      const after = await r.decide(view, { reject: false });
      assert.deepEqual(spine.approvals().map((s) => s.args), [
        { repo_path: REPO, intent_id: ID, expected_digest: view.digest, decided_by: "Ada Lovelace", note: "", reject: false },
      ]);
      assert.equal(after.state, "approved");
      assert.equal(after.approval?.decided_by, "Ada Lovelace");
    });

    it("names nobody on a remote server", async () => {
      const spine = fakeSpine({ remote: true });
      const { r } = review(spine);
      await r.decide(await r.open(ID), { reject: false });
      assert.equal(spine.approvals()[0].args.decided_by, "");
      assert.equal(spine.approvals()[0].args.expected_digest, "digest-v1-0123456789abcdef");
    });

    it("refuses before calling Spine when this caller cannot decide", async () => {
      const spine = fakeSpine({ canApprove: false, reason: "this server shows level 'pkg'" });
      const { r } = review(spine);
      await assert.rejects(r.decide(await r.open(ID), { reject: false }), /this server shows level 'pkg'/);
      assert.deepEqual(spine.approvals(), []);
    });

    it("needs a note to reject", async () => {
      const spine = fakeSpine();
      const { r } = review(spine);
      const view = await r.open(ID);
      await assert.rejects(r.decide(view, { reject: true }), /note/);
      await assert.rejects(r.decide(view, { reject: true, note: "   " }), /note/);
      assert.deepEqual(spine.approvals(), []);
      const after = await r.decide(view, { reject: true, note: "the design misses the tax rule" });
      assert.equal(after.state, "rejected");
      assert.equal(spine.approvals()[0].args.note, "the design misses the tax rule");
      assert.equal(spine.approvals()[0].args.reject, true);
    });

    it("refuses a plan opened on another server than Spine is now", async () => {
      const local = fakeSpine();
      const remote = fakeSpine({ remote: true });
      let now = local.calls;
      const r = new PlanReview({ calls: () => now, repo: () => REPO, isTrusted: () => true, approverName: async () => "Ada" });
      const view = await r.open(ID);
      now = remote.calls;
      await assert.rejects(r.decide(view, { reject: false }), /opened on local, and Spine is now company-spine: open it again/);
      assert.deepEqual(local.approvals(), []);
      assert.deepEqual(remote.approvals(), []);
    });

    it("says a decision was recorded when the plan cannot be reopened after it (review item 6)", async () => {
      const spine = fakeSpine({ failReopen: true });
      const { r } = review(spine);
      await assert.rejects(r.decide(await r.open(ID), { reject: false }), /recorded .*could not reopen the plan: connection closed/);
      assert.equal(spine.state.approval?.decision, "APPROVED");
    });

    it("refuses a plan edited after it was read, and records nothing", async () => {
      const spine = fakeSpine();
      const { r } = review(spine);
      const view = await r.open(ID);
      spine.edit();
      await assert.rejects(r.decide(view, { reject: false }), PlanMovedError);
      assert.equal(spine.state.approval, null);
    });
  });

  describe("in Restricted Mode", () => {
    it("calls nothing, local or remote", async () => {
      for (const remote of [false, true]) {
        const spine = fakeSpine({ remote });
        const { r } = review(spine, { trusted: false });
        await assert.rejects(r.list(), RestrictedWorkspaceError);
        await assert.rejects(r.open(ID), RestrictedWorkspaceError);
        assert.deepEqual(spine.state.seen, []);
      }
    });

    it("refuses a decision on a plan opened before trust was withdrawn, local or remote", async () => {
      for (const remote of [false, true]) {
        const spine = fakeSpine({ remote });
        let trusted = true;
        const r = new PlanReview({ calls: () => spine.calls, repo: () => REPO, isTrusted: () => trusted, approverName: async () => "Ada" });
        const view = await r.open(ID);
        trusted = false;
        await assert.rejects(r.decide(view, { reject: false }), RestrictedWorkspaceError);
        assert.deepEqual(spine.approvals(), []);
      }
    });
  });

  describe("the approve and reject commands", () => {
    it("locally confirms who is approving before the call", async () => {
      const spine = fakeSpine();
      const { r } = review(spine);
      const { p, said } = prompts();
      const after = await r.approve(await r.open(ID), p);
      assert.match(said.confirm[0], /approving as Ada Lovelace/);
      assert.equal(after?.state, "approved");
      assert.equal(said.info.length, 1);
      assert.match(said.info[0], /recorded as Ada Lovelace/);
    });

    it("calls nothing when the confirmation is declined", async () => {
      const spine = fakeSpine();
      const { r } = review(spine);
      assert.equal(await r.approve(await r.open(ID), prompts({ confirm: false }).p), undefined);
      assert.deepEqual(spine.approvals(), []);
    });

    it("on a remote server says the approval is a signed record, not a gate", async () => {
      const spine = fakeSpine({ remote: true });
      const { r } = review(spine);
      const { p, said } = prompts();
      await r.approve(await r.open(ID), p);
      assert.match(said.confirm[0], /signed record, not a gate/);
      assert.match(said.confirm[0], /company-spine/);
      assert.match(said.confirm[0], /the server records who approves/i);
      assert.ok(!/names you/.test(said.confirm[0]), "a shared-token server names nobody: the confirm must not promise it");
      assert.match(said.info[0], /signed record, not a gate/);
      assert.match(said.info[0], /recorded as ada@example\.com/);
    });

    it("reopens a plan that moved, and says it changed since it was opened", async () => {
      const spine = fakeSpine();
      const { r } = review(spine);
      const { p, said } = prompts();
      const view = await r.open(ID);
      spine.edit();
      const reopened = await r.approve(view, p);
      assert.match(said.warn[0], /changed since you opened it/);
      assert.deepEqual(said.info, []);
      assert.equal(reopened?.digest, "digest-v2-0123456789abcdef");
      assert.equal(reopened?.document, spine.state.text);
      assert.equal(spine.state.approval, null);
    });

    it("asks for a note to reject, and calls nothing when it is cancelled", async () => {
      const spine = fakeSpine();
      const { r } = review(spine);
      assert.equal(await r.reject(await r.open(ID), prompts({ note: undefined }).p), undefined);
      assert.deepEqual(spine.approvals(), []);
      const after = await r.reject(await r.open(ID), prompts({ note: "not this sprint" }).p);
      assert.equal(after?.state, "rejected");
    });

    it("tells a person who cannot decide why, and calls nothing", async () => {
      const spine = fakeSpine({ canApprove: false, reason: "approving needs scope 'spine:plan'" });
      const { r } = review(spine);
      const { p, said } = prompts();
      assert.equal(await r.approve(await r.open(ID), p), undefined);
      assert.match(said.warn[0], /spine:plan/);
      assert.deepEqual(said.confirm, []);
      assert.deepEqual(spine.approvals(), []);
    });
  });

  describe("the status line", () => {
    it("names the state, the approver, a short digest, the server and who decides", async () => {
      const spine = fakeSpine();
      const { r } = review(spine);
      const approved = await r.decide(await r.open(ID), { reject: false });
      const s = statusText(approved);
      assert.match(s.text, /INT-7/);
      assert.match(s.text, /approved by Ada Lovelace/);
      assert.match(s.text, /digest-v/);
      assert.ok(!s.text.includes("0123456789abcdef"), "the digest is shortened");
      assert.match(s.tooltip, /local/);
      assert.match(s.tooltip, /approving as Ada Lovelace/);
    });

    it("says when a plan changed after its decision", async () => {
      const spine = fakeSpine();
      const { r } = review(spine);
      await r.decide(await r.open(ID), { reject: false });
      spine.edit();
      assert.match(statusText(await r.open(ID)).text, /changed since it was approved by Ada Lovelace/);
    });

    it("gives the reason a person cannot decide", async () => {
      const s = statusText(await review(fakeSpine({ canApprove: false, reason: "needs spine:plan" })).r.open(ID));
      assert.match(s.tooltip, /cannot decide: needs spine:plan/);
    });

    it("on a remote server names it, the sign-in, and that a decision is a record, not a gate", async () => {
      const s = statusText(await review(fakeSpine({ remote: true })).r.open(ID));
      assert.match(s.tooltip, /company-spine/);
      assert.match(s.tooltip, /signed in through VS Code/);
      assert.match(s.tooltip, /signed record, not a gate/);
    });
  });
});
