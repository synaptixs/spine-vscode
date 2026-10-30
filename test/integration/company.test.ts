/**
 * Step E (SSPN-243, plan D57): the extension against a Spine that checks a company sign-in, with
 * VS Code running that sign-in (D19). Evidence, not a gate: started by name with Keycloak up
 * (test/keycloak/up.sh), and a person signs in when VS Code asks, so it never runs in CI.
 *
 * SPINE_COMPANY_ROLE says who will sign in:
 *   planner — the plan opens over the remote server and an approval is recorded under the
 *             planner's email, not a name the extension passed;
 *   reader  — the plan opens, Approve is disabled with Spine's reason, and an approval forced
 *             past the extension is refused by the server.
 * Findings and the extension host's environment go to files for the no-token check.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { sleep, spineApi, type SpineApiForTests } from "./helpers";

const ROLE = process.env.SPINE_COMPANY_ROLE!;
const ID = process.env.SPINE_PLAN_ID!;
const REPO = process.env.SPINE_SERVER_REPO!;
const EMAIL = process.env.SPINE_COMPANY_EMAIL!;
const findings: Record<string, unknown> = { vscode: vscode.version, role: ROLE };

const spineTools = () => vscode.lm.tools.map((t) => t.name).filter((n) => /_sdlc_/.test(n));

describe(`company sign-in through VS Code, as the ${ROLE} (SSPN-243 step E)`, () => {
  let api: SpineApiForTests;

  before(async () => {
    api = await spineApi();
  });

  after(() => {
    fs.writeFileSync(process.env.SPINE_COMPANY_OUT!, JSON.stringify(findings, null, 2));
    fs.writeFileSync(process.env.SPINE_ENV_OUT!, JSON.stringify(process.env, null, 2));
  });

  it("signs in through VS Code and lists the plans over the remote server", async function () {
    this.timeout(660_000);
    // The first call starts VS Code's servers, which is where VS Code asks to sign in. Until the
    // person has, the tools are not there: keep asking, and record what the wait looked like.
    const t0 = Date.now();
    const attempts: string[] = [];
    let listed: Awaited<ReturnType<SpineApiForTests["plans"]["list"]>> | undefined;
    while (!listed && Date.now() - t0 < 600_000) {
      try {
        listed = await api.plans.list();
      } catch (err) {
        const message = (err as Error).message;
        if (attempts.at(-1) !== message) attempts.push(message);
        await sleep(3000);
      }
    }
    findings.signIn = { ms: Date.now() - t0, distinctErrorsWhileWaiting: attempts };
    const tools = spineTools();
    findings.toolsAfterSignIn = tools;
    assert.ok(listed, `never listed the plans: ${attempts.join(" | ")}`);
    findings.listed = listed;
    assert.ok(listed.plans.some((p) => p.intent_id === ID), `${ID} is not listed`);
    // D49 with a real company server: exactly one server offers the approval tool.
    assert.equal(tools.filter((n) => n.endsWith("_sdlc_approve")).length, 1);
  });

  it("opens the plan from the remote server, bound to its digest", async () => {
    await vscode.commands.executeCommand("spine.openPlan", ID);
    const view = api.plans.current();
    assert.ok(view, "no plan is open");
    findings.opened = { ...view, document: `${view.document.length} chars` };
    assert.equal(view.remote, true);
    assert.equal(view.server, "company-spine");
    assert.match(view.digest, /^[0-9a-f]{16,}$/);
    assert.equal(view.approver, "", "on a remote server the sign-in names the approver, not the extension");
  });

  if (ROLE === "planner") {
    it("approves, and Spine records the signed-in person's email", async () => {
      const after = await api.plans.decide(ID, { reject: false });
      findings.decided = { state: after.state, approval: after.approval };
      assert.equal(after.state, "approved");
      assert.equal(after.approval?.decided_by, EMAIL);
      assert.equal(after.approval?.digest, api.plans.current()?.digest);
    });
  }

  if (ROLE === "reader") {
    it("cannot approve: Approve is disabled with Spine's reason", async () => {
      const view = api.plans.current()!;
      assert.equal(view.canDecide, false);
      assert.match(view.reason, /spine:plan/);
      await assert.rejects(api.plans.decide(ID, { reject: false }), /spine:plan/);
    });

    it("an approval forced past the extension is refused by the server", async () => {
      const view = api.plans.current()!;
      const name = spineTools().find((n) => n.endsWith("_sdlc_approve"))!;
      const result = await vscode.lm.invokeTool(name, {
        input: { repo_path: REPO, intent_id: ID, expected_digest: view.digest, reject: false, note: "" },
        toolInvocationToken: undefined,
      });
      const text = result.content.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : "")).join("");
      findings.forced = text;
      const answer = JSON.parse(text) as { error?: string; needs?: string };
      assert.equal(answer.needs, "spine:plan");
      // The reader's token also carries `spine:plan` in its scope claim: with a role map Spine
      // must ignore that and grant only what the reader's group maps to (Spine D26).
      assert.match(answer.error ?? "", /this token has \['spine:read'\]/);
    });
  }
});
