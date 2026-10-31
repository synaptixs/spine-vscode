import * as assert from "node:assert/strict";
import { checked, type SpineCalls, SpineRefusal } from "../../src/calls";
import { RestrictedWorkspaceError } from "../../src/client";
import {
  type Intent,
  PLAN_TIMEOUT_MS,
  RequirementPlanner,
  type RequirementPrompts,
  requirementBlocker,
  SPEND_ACTION,
  sourceForFile,
  sourceTyped,
  spendText,
} from "../../src/requirements";

const REPO = "/work/shop";
const SOURCE = "file:///work/shop/docs/CART-9.md";

/**
 * A fake Spine 3.68.0 `sdlc_plan` from a source (SSPN-279). `extract: false` answers from the cache
 * and spends nothing; a plan of an uncached source derives (spending `cost`) and caches it; several
 * intents and no `intent_id` returns them and plans nothing; a cached source plans for $0.
 */
function fakeSpine(opts: { cached?: boolean; intents?: Intent[]; cost?: number; estimated?: boolean; warnings?: string[] } = {}) {
  const intents = opts.intents ?? [{ id: "CART-9", title: "Show the total with tax" }];
  const state = { cached: !!opts.cached, seen: [] as { args: Record<string, unknown>; timeoutMs?: number }[] };
  const calls: SpineCalls = {
    server: "local",
    remote: false,
    call: async (tool, args, callOpts) => {
      if (tool !== "sdlc_plan") throw new Error(`unexpected tool ${tool}`);
      state.seen.push({ args, timeoutMs: callOpts?.timeoutMs });
      if (args.extract === false) {
        return { source: args.source, cached: state.cached, intents: state.cached ? intents : [], spent_usd: 0 };
      }
      const derived = !state.cached;
      state.cached = true;
      const spent = derived ? (opts.cost ?? 0.0123) : 0;
      const head = { source: args.source, cached: !derived, spent_usd: spent, spent_estimated: !!opts.estimated, warnings: opts.warnings ?? [] };
      const chosen = (args.intent_id as string | undefined) ?? (intents.length === 1 ? intents[0].id : undefined);
      if (!chosen) return { ...head, intents, next: "several intents: plan one with intent_id" };
      // A refusal goes through `checked`, as the real seam's does (src/calls.ts).
      if (!intents.some((i) => i.id === chosen)) return checked({ error: `no intent ${chosen} in ${String(args.source)}` });
      return { ...head, intent_id: chosen, document: `# ${chosen}\n`, path: `${REPO}/.spine/plans/${chosen}-build.md` };
    },
  };
  return {
    calls,
    state,
    planned: () => state.seen.filter((s) => s.args.extract !== false),
  };
}

function prompts(answers: { confirm?: boolean; pick?: string } = {}) {
  const asked = { confirms: [] as string[], picks: [] as Intent[][], infos: [] as string[], warns: [] as string[] };
  const p: RequirementPrompts = {
    confirmSpend: async (message, action) => {
      assert.equal(action, SPEND_ACTION);
      asked.confirms.push(message);
      return answers.confirm ?? true;
    },
    pickIntent: async (_source, intents) => {
      asked.picks.push(intents);
      return answers.pick;
    },
    info: (m) => asked.infos.push(m),
    warn: (m) => asked.warns.push(m),
  };
  return { p, asked };
}

function planner(spine: ReturnType<typeof fakeSpine>, opts: { trusted?: boolean; blocker?: string; repo?: string | null } = {}) {
  const opened: string[] = [];
  const p = new RequirementPlanner({
    calls: () => spine.calls,
    repo: () => (opts.repo === null ? undefined : (opts.repo ?? REPO)),
    isTrusted: () => opts.trusted ?? true,
    blocker: () => opts.blocker,
    open: async (id) => {
      opened.push(id);
    },
  });
  return { p, opened };
}

describe("Plan from requirement (SSPN-246)", () => {
  describe("the source a pick names", () => {
    it("is a workspace Markdown file as a file:// source, its absolute path verbatim", () => {
      assert.equal(sourceForFile("/work/shop/docs/CART-9.md"), "file:///work/shop/docs/CART-9.md");
      assert.equal(sourceForFile("/work/my shop/req.md"), "file:///work/my shop/req.md");
    });

    it("refuses a relative path: Spine would resolve it from its own working directory", () => {
      assert.throws(() => sourceForFile("docs/CART-9.md"), /absolute/);
    });

    it("passes a pasted URL or ticket through as typed, trimmed", () => {
      assert.equal(sourceTyped("  jira://PROJ-42 \n"), "jira://PROJ-42");
      assert.equal(sourceTyped("confluence://12345"), "confluence://12345");
    });

    it("refuses an empty paste", () => {
      assert.throws(() => sourceTyped("   "), /URL or ticket/);
    });
  });

  it("the confirm names the source, the intake model, the checkout's .env, and that it spends (D105)", () => {
    const text = spendText(SOURCE, REPO);
    assert.match(text, /file:\/\/\/work\/shop\/docs\/CART-9\.md/);
    assert.match(text, /intake model/);
    assert.match(text, /\/work\/shop\/\.env/);
    assert.match(text, /spends tokens/);
  });

  describe("the flow", () => {
    it("plans a cached source with no confirm, for $0, and opens it for review", async () => {
      const spine = fakeSpine({ cached: true });
      const { p, opened } = planner(spine);
      const { p: ask, asked } = prompts();
      const done = await p.plan(SOURCE, ask);
      assert.deepEqual(done, { intentId: "CART-9", spentUsd: 0, cached: true, estimated: false });
      assert.equal(asked.confirms.length, 0);
      assert.deepEqual(opened, ["CART-9"]);
      assert.match(asked.infos.at(-1) ?? "", /CART-9.*\$0\b.*cached/);
    });

    it("asks first, spends only after the yes, and shows what it spent (D105)", async () => {
      const spine = fakeSpine({ cost: 0.0123 });
      const { p, opened } = planner(spine);
      const { p: ask, asked } = prompts({ confirm: true });
      const done = await p.plan(SOURCE, ask);
      assert.equal(asked.confirms.length, 1);
      assert.equal(asked.confirms[0], spendText(SOURCE, REPO));
      assert.deepEqual(done, { intentId: "CART-9", spentUsd: 0.0123, cached: false, estimated: false });
      assert.deepEqual(opened, ["CART-9"]);
      assert.match(asked.infos.at(-1) ?? "", /\$0\.0123/);
    });

    it("says when the spend is an estimate", async () => {
      const spine = fakeSpine({ cost: 0.5, estimated: true });
      const { p } = planner(spine);
      const { p: ask, asked } = prompts();
      await p.plan(SOURCE, ask);
      assert.match(asked.infos.at(-1) ?? "", /\$0\.5000 \(estimated\)/);
    });

    it("spends nothing and plans nothing when the confirm is declined", async () => {
      const spine = fakeSpine();
      const { p, opened } = planner(spine);
      const { p: ask } = prompts({ confirm: false });
      assert.equal(await p.plan(SOURCE, ask), undefined);
      assert.equal(spine.planned().length, 0);
      assert.deepEqual(opened, []);
    });

    it("asks which intent when a cached source holds several, then plans that one (D106)", async () => {
      const intents = [
        { id: "CART-9", title: "Show the total with tax" },
        { id: "CART-10", title: "Round the tax" },
      ];
      const spine = fakeSpine({ cached: true, intents });
      const { p, opened } = planner(spine);
      const { p: ask, asked } = prompts({ pick: "CART-10" });
      const done = await p.plan(SOURCE, ask);
      assert.deepEqual(asked.picks, [intents]);
      assert.equal(asked.confirms.length, 0);
      assert.equal(spine.planned().length, 1);
      assert.equal(spine.planned()[0].args.intent_id, "CART-10");
      assert.equal(done?.intentId, "CART-10");
      assert.deepEqual(opened, ["CART-10"]);
    });

    it("derives an uncached source once, asks which intent, and plans it from the cache with no second spend", async () => {
      const intents = [
        { id: "CART-9", title: "Show the total with tax" },
        { id: "CART-10", title: "Round the tax" },
      ];
      const spine = fakeSpine({ intents, cost: 0.02 });
      const { p, opened } = planner(spine);
      const { p: ask, asked } = prompts({ pick: "CART-9" });
      const done = await p.plan(SOURCE, ask);
      assert.equal(asked.confirms.length, 1);
      assert.deepEqual(asked.picks, [intents]);
      assert.deepEqual(
        spine.planned().map((s) => s.args.intent_id),
        [undefined, "CART-9"],
      );
      assert.deepEqual(done, { intentId: "CART-9", spentUsd: 0.02, cached: false, estimated: false });
      assert.deepEqual(opened, ["CART-9"]);
    });

    it("plans nothing when the pick is cancelled, and says the spec is kept", async () => {
      const intents = [
        { id: "CART-9", title: "a" },
        { id: "CART-10", title: "b" },
      ];
      const spine = fakeSpine({ intents });
      const { p, opened } = planner(spine);
      const { p: ask, asked } = prompts({ pick: undefined });
      assert.equal(await p.plan(SOURCE, ask), undefined);
      assert.equal(spine.planned().length, 1);
      assert.deepEqual(opened, []);
      assert.match(asked.infos.at(-1) ?? "", /cached/);
    });

    it("asks Spine first with extract: false, and gives every planning call room for a model", async () => {
      const spine = fakeSpine();
      const { p } = planner(spine);
      await p.plan(SOURCE, prompts().p);
      assert.deepEqual(spine.state.seen[0].args, { repo_path: REPO, source: SOURCE, extract: false });
      assert.ok(PLAN_TIMEOUT_MS >= 600_000);
      for (const s of spine.planned()) {
        assert.equal(s.timeoutMs, PLAN_TIMEOUT_MS);
        assert.equal(s.args.repo_path, REPO);
        assert.equal(s.args.source, SOURCE);
      }
    });

    it("shows Spine's warnings", async () => {
      const spine = fakeSpine({ cached: true, warnings: ["file:///x returned no text — the criteria are checked against the spec alone."] });
      const { p } = planner(spine);
      const { p: ask, asked } = prompts();
      await p.plan(SOURCE, ask);
      assert.deepEqual(asked.warns, ["Spine: file:///x returned no text — the criteria are checked against the spec alone."]);
    });

    it("raises Spine's refusal as Spine says it, and opens nothing", async () => {
      const spine = fakeSpine({ cached: true, intents: [{ id: "CART-9", title: "a" }, { id: "CART-10", title: "b" }] });
      const { p, opened } = planner(spine);
      await assert.rejects(p.plan(SOURCE, prompts({ pick: "NOPE-1" }).p), (err: unknown) => err instanceof SpineRefusal && /no intent NOPE-1/.test(err.message));
      assert.deepEqual(opened, []);
    });
  });

  describe("where it runs", () => {
    it("on this machine only: a remote spine.server is refused with the setting to change (D109)", () => {
      assert.match(requirementBlocker("company-spine", "plan") ?? "", /this machine only.*company-spine.*set spine\.server to local/);
    });

    it("at level plan or build, not pkg, where sdlc_plan is not served", () => {
      assert.equal(requirementBlocker("local", "plan"), undefined);
      assert.equal(requirementBlocker("local", "build"), undefined);
      assert.match(requirementBlocker("local", "pkg") ?? "", /set spine\.level to plan or build/);
    });

    it("calls nothing in Restricted Mode (D12)", async () => {
      const spine = fakeSpine();
      const { p } = planner(spine, { trusted: false });
      await assert.rejects(p.plan(SOURCE, prompts().p), RestrictedWorkspaceError);
      assert.equal(spine.state.seen.length, 0);
    });

    it("calls nothing when this window cannot plan here (a remote server, D109), and says why", async () => {
      const spine = fakeSpine();
      const { p } = planner(spine, { blocker: "Plan from requirement runs on this machine only: set spine.server to local" });
      await assert.rejects(p.plan(SOURCE, prompts().p), /set spine\.server to local/);
      assert.equal(spine.state.seen.length, 0);
    });

    it("calls nothing with no folder open", async () => {
      const spine = fakeSpine();
      const { p } = planner(spine, { repo: null });
      await assert.rejects(p.plan(SOURCE, prompts().p), /open a folder/);
      assert.equal(spine.state.seen.length, 0);
    });
  });
});
