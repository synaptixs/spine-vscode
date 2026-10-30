/**
 * A throwaway copy of the fixture with one build document in it, made by the REAL Spine's
 * `sdlc_plan` (deterministic, no model, nothing spent). The tracked fixture is never written: a
 * plan or an approval left in it would change every later run.
 *
 * The copy is its own git repository with a repo-local identity, because the local approver is
 * `git config user.name` and CI has no identity of its own.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SpineClient } from "../../src/client";
import { spineLaunch } from "../../src/launch";

export const FIXTURE = path.resolve(__dirname, "../../../test/fixture/.repo");
export const PLAN_ID = "CART-1";
export const GIT_NAME = "Spine Test";

export interface PlanFixture {
  root: string;
  intentId: string;
  planFile: string;
  dispose(): void;
}

/**
 * `commit`: commit the copy before planning, as a developer would. A build starts from the
 * branch's last commit and re-renders the plan there, so a plan made before that commit no
 * longer matches its approval and the build parks at the plan gate (SSPN-244).
 */
export async function planFixture(opts: { commit?: boolean } = {}): Promise<PlanFixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spine-vsx-plans-"));
  fs.cpSync(FIXTURE, root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", GIT_NAME);
  git("config", "user.email", "spine-test@example.invalid");
  if (opts.commit) {
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
  }
  const client = new SpineClient({ launch: spineLaunch(process.env.SPINE_SERVER_PATH, "plan"), isTrusted: () => true, cwd: root });
  try {
    const out = (await client.callTool("sdlc_plan", {
      repo_path: root,
      spec: {
        intent_id: PLAN_ID,
        title: "Show the cart total with tax",
        summary: "The checkout page shows the cart total including tax.",
        acceptance_criteria: ["cart_total returns the total including tax"],
      },
    })) as { error?: string };
    if (out.error) throw new Error(`sdlc_plan refused: ${out.error}`);
  } finally {
    await client.close();
  }
  const planFile = path.join(root, ".spine", "plans", `${PLAN_ID}-build.md`);
  if (!fs.existsSync(planFile)) throw new Error(`sdlc_plan wrote no ${planFile}`);
  return { root, intentId: PLAN_ID, planFile, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
