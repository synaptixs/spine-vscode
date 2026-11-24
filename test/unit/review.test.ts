import * as assert from "node:assert/strict";
import { checked, PlanMovedError, type SpineCalls } from "../../src/calls";
import { RestrictedWorkspaceError } from "../../src/client";
import { idOfPlanPath, intentOfSpecFile, planPath, PlanReview, type Prompts, specFile, statusText } from "../../src/review";

const ID = "INT-7";
const REPO = "/work/shop";

/**
 * A fake Spine holding one plan. `sdlc_approve` behaves as the real one does: it refuses an
 * `expected_digest` that is not the current one, and records nothing then.
 */
function fakeSpine(
  opts: { remote?: boolean; canApprove?: boolean; reason?: string; digest?: string; failReopen?: boolean; freshness?: { derived_at: string; derived_now: string; fresh: boolean } } = {},
) {
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
          ...(opts.freshness ?? {}),
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
      if (tool === "sdlc_plan" && args.spec) {
        // Deterministic and free: the document is re-rendered from the edited spec (B180).
        const spec = args.spec as { title?: string };
        if (!spec.title) return checked({ error: "spec.title: Field required", valid_fields: ["title", "summary", "scope"] });
        state.text = `# Build document\n\n§1 ${spec.title}\n`;
        state.version += 1;
        return { intent_id: ID, document: state.text, path: `${REPO}/.spine/plans/${ID}-build.md` };
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

describe("where a plan and its spec live (B180, SSPN-406, D127)", () => {
  it("the plan document is named as Spine names its file, and the id comes back from it", () => {
    assert.equal(planPath("intent-3f9a"), "/intent-3f9a-build.md");
    assert.equal(idOfPlanPath("/intent-3f9a-build.md"), "intent-3f9a");
  });

  it("the spec sits beside the plan, under .spine/plans", () => {
    assert.equal(specFile("/work/shop", "INT-7"), "/work/shop/.spine/plans/INT-7-spec.json");
    assert.equal(intentOfSpecFile("/work/shop/.spine/plans/INT-7-spec.json", "/work/shop"), "INT-7");
    assert.equal(intentOfSpecFile("/work/shop/.spine/plans/history/INT-7-spec.json", "/work/shop"), undefined);
    assert.equal(intentOfSpecFile("/work/other/.spine/plans/INT-7-spec.json", "/work/shop"), undefined);
    assert.equal(intentOfSpecFile("/work/shop/.spine/plans/INT-7-build.md", "/work/shop"), undefined);
  });
});

describe("a plan derived at another commit (B182, SSPN-408, D126)", () => {
  const stale = { derived_at: "bbcc994-dirty", derived_now: "4f2a1c0", fresh: false };
  const choosing = (answer: string | undefined) => {
    const asked: string[] = [];
    const said: string[] = [];
    const p: Prompts = {
      confirm: async () => true,
      choose: async (message, actions) => {
        asked.push(`${message} [${actions.join(" | ")}]`);
        return answer;
      },
      note: async () => "",
      info: (m) => void said.push(m),
      warn: (m) => void said.push(m),
    };
    return { p, asked, said };
  };
  const reviewOf = (spine: ReturnType<typeof fakeSpine>, spec = '{"intent_id": "INT-7", "title": "Kept spec"}') =>
    new PlanReview({ calls: () => spine.calls, repo: () => REPO, isTrusted: () => true, approverName: async () => "Ada", readFile: () => spec });

  it("reads where the plan was derived and whether that is still the checkout", async () => {
    const view = await reviewOf(fakeSpine({ freshness: stale })).open(ID);
    assert.deepEqual([view.derivedAt, view.derivedNow, view.fresh], ["bbcc994-dirty", "4f2a1c0", false]);
  });

  it("warns before approving, naming both commits and that the build will refuse it", async () => {
    const spine = fakeSpine({ freshness: stale });
    const r = reviewOf(spine);
    const { p, asked } = choosing("Approve anyway");
    const after = await r.approve(await r.open(ID), p);
    assert.match(asked[0], /derived at bbcc994-dirty.*checkout is now at 4f2a1c0.*build will refuse/s);
    assert.match(asked[0], /\[Approve anyway \| Re-plan \(\$0\)\]/);
    assert.equal(after?.state, "approved");
  });

  it("Re-plan ($0) renders the plan again from its kept spec and records no decision", async () => {
    const spine = fakeSpine({ freshness: stale });
    const r = reviewOf(spine);
    const { p, said } = choosing("Re-plan ($0)");
    const after = await r.approve(await r.open(ID), p);
    assert.deepEqual(spine.approvals(), []);
    assert.deepEqual(spine.state.seen.find((s) => s.tool === "sdlc_plan")?.args, { repo_path: REPO, spec: { intent_id: ID, title: "Kept spec" } });
    assert.match(after?.document ?? "", /Kept spec/);
    assert.match(said.at(-1) ?? "", /re-planned INT-7.*\$0.*read it, then approve/i);
  });

  it("records nothing when the warning is dismissed", async () => {
    const spine = fakeSpine({ freshness: stale });
    const r = reviewOf(spine);
    assert.equal(await r.approve(await r.open(ID), choosing(undefined).p), undefined);
    assert.deepEqual(spine.approvals(), []);
  });

  it("a fresh plan, or a server that says nothing about freshness, gets the plain confirm", async () => {
    for (const spine of [fakeSpine({ freshness: { derived_at: "4f2a1c0", derived_now: "4f2a1c0", fresh: true } }), fakeSpine()]) {
      const r = reviewOf(spine);
      const { p, asked } = choosing("Re-plan ($0)");
      const after = await r.approve(await r.open(ID), p);
      assert.equal(asked.length, 0);
      assert.equal(after?.state, "approved");
    }
  });

  it("the status tooltip says the plan is from another commit", async () => {
    const s = statusText(await reviewOf(fakeSpine({ freshness: stale })).open(ID));
    assert.match(s.tooltip, /Derived at bbcc994-dirty; the checkout is now at 4f2a1c0: re-plan before approving/);
  });
});

describe("re-planning from an edited spec (B180, D127)", () => {
  it("sends the edited spec to sdlc_plan (no model, $0) and reopens the plan; an earlier approval reads stale", async () => {
    const spine = fakeSpine();
    const r = new PlanReview({ calls: () => spine.calls, repo: () => REPO, isTrusted: () => true, approverName: async () => "Ada" });
    await r.decide(await r.open(ID), { reject: false });
    const after = await r.replan(ID, { intent_id: ID, title: "Narrower scope" }, REPO);
    const sent = spine.state.seen.find((s) => s.tool === "sdlc_plan");
    assert.deepEqual(sent?.args, { repo_path: REPO, spec: { intent_id: ID, title: "Narrower scope" } });
    assert.match(after.document, /Narrower scope/);
    assert.equal(after.state, "stale");
  });

  it("refuses a spec that names another intent: it would write another plan", async () => {
    const spine = fakeSpine();
    const r = new PlanReview({ calls: () => spine.calls, repo: () => REPO, isTrusted: () => true, approverName: async () => "Ada" });
    await assert.rejects(r.replan(ID, { intent_id: "INT-8", title: "x" }, REPO), /names intent INT-8, not INT-7/);
    assert.equal(spine.state.seen.length, 0);
  });

  it("refuses on a remote server: the spec file is on this machine", async () => {
    const spine = fakeSpine({ remote: true });
    const r = new PlanReview({ calls: () => spine.calls, repo: () => "/srv/shop", isTrusted: () => true, approverName: async () => "" });
    await assert.rejects(r.replan(ID, { intent_id: ID, title: "x" }, "/srv/shop"), /on the local server only/);
    assert.equal(spine.state.seen.length, 0);
  });

  it("shows Spine's own refusal of an invalid spec", async () => {
    const spine = fakeSpine();
    const r = new PlanReview({ calls: () => spine.calls, repo: () => REPO, isTrusted: () => true, approverName: async () => "Ada" });
    await assert.rejects(r.replan(ID, { intent_id: ID }, REPO), /spec\.title: Field required/);
  });

  it("re-plans in the spec's own folder, on that folder's Spine, whatever folder is in front (B178, review of #14)", async () => {
    const spine = fakeSpine();
    const via: (string | undefined)[] = [];
    const r = new PlanReview({
      calls: (repo?: string) => ({ ...spine.calls, call: (t, a, o) => (via.push(repo), spine.calls.call(t, a, o)) }),
      repo: () => "/work/other",
      isTrusted: () => true,
      approverName: async () => "Ada",
    });
    const after = await r.replan(ID, { intent_id: ID, title: "Narrower scope" }, REPO);
    assert.deepEqual(
      spine.state.seen.map((s) => [s.tool, s.args.repo_path]),
      [["sdlc_plan", REPO], ["sdlc_plan_document", REPO]],
    );
    assert.deepEqual(via, [REPO, REPO], "each call went to the Spine started in the spec's folder, with its .env");
    assert.equal(after.repo, REPO);
  });

  it("a spec whose intent_id was deleted is re-planned under its own id, not as `spec` (review of #14)", async () => {
    const spine = fakeSpine();
    const r = new PlanReview({ calls: () => spine.calls, repo: () => REPO, isTrusted: () => true, approverName: async () => "Ada" });
    await r.replan(ID, { title: "Narrower scope" }, REPO);
    const sent = spine.state.seen.find((s) => s.tool === "sdlc_plan");
    assert.deepEqual(sent?.args.spec, { title: "Narrower scope", intent_id: ID });
  });

  it("calls nothing in Restricted Mode", async () => {
    const spine = fakeSpine();
    const r = new PlanReview({ calls: () => spine.calls, repo: () => REPO, isTrusted: () => false, approverName: async () => "Ada" });
    await assert.rejects(r.replan(ID, { intent_id: ID, title: "x" }, REPO), RestrictedWorkspaceError);
    assert.equal(spine.state.seen.length, 0);
  });
});

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
    choose: async () => undefined,
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

    it("refuses a plan opened in another folder than Spine now points at (B178, D123)", async () => {
      const spine = fakeSpine();
      let repo = REPO;
      const r = new PlanReview({ calls: () => spine.calls, repo: () => repo, isTrusted: () => true, approverName: async () => "Ada" });
      const view = await r.open(ID);
      assert.equal(view.repo, REPO);
      repo = "/work/other";
      await assert.rejects(r.decide(view, { reject: false }), new RegExp(`opened in ${REPO}, and Spine now points at /work/other: open it again`));
      assert.deepEqual(spine.approvals(), []);
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
      assert.match(s.tooltip, /File: \/work\/shop\/\.spine\/plans\/INT-7-build\.md \(read-only here: change it with Edit spec…\)/);
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

describe("which folder's Spine a plan call reaches (B178, review of #14)", () => {
  it("opens, lists and decides on the Spine of the folder each call names", async () => {
    const spine = fakeSpine();
    const via: (string | undefined)[] = [];
    const r = new PlanReview({
      calls: (repo?: string) => ({ ...spine.calls, call: (t, a, o) => (via.push(repo), spine.calls.call(t, a, o)) }),
      repo: () => REPO,
      isTrusted: () => true,
      approverName: async () => "Ada",
    });
    await r.list();
    await r.decide(await r.open(ID), { reject: false });
    assert.ok(via.length >= 4 && via.every((v) => v === REPO), `every call bound to ${REPO}: ${JSON.stringify(via)}`);
  });

  it("a plan opened in one folder is not built from another (the same check a decision makes)", async () => {
    const spine = fakeSpine();
    let repo = REPO;
    const r = new PlanReview({ calls: () => spine.calls, repo: () => repo, isTrusted: () => true, approverName: async () => "Ada" });
    const view = await r.open(ID);
    r.assertHere(view);
    repo = "/work/other";
    assert.throws(() => r.assertHere(view), /opened in \/work\/shop, and Spine now points at \/work\/other: open it again/);
  });
});
