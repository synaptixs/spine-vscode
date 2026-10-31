/**
 * Requirements for the SSPN-246 suites: a throwaway checkout holding a Markdown requirement, and a
 * spec "derived" from it written into Spine's intake cache by the REAL Spine's own Python
 * (`save_plan` with the file's fingerprint, as `analyze_cached` leaves it), never as hand-written
 * JSON: a cache format that moves in Spine moves here too (D108). No model is called and nothing
 * is spent; each suite gets its own cache, named by `ORCHESTRATOR_INTAKE_CACHE_DIR`, the variable
 * the extension passes its server (D110), so nothing touches the person's own cache.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FIXTURE, GIT_NAME } from "./planFixture";
import { spinePython } from "./seedRuns";

export const REQUIREMENT_ID = "CART-9";
export const CRITERION = "cart_total includes tax at the shop's rate";

export interface IntakeCache {
  dir: string;
  env: Record<string, string>;
  dispose(): void;
}

export function intakeCache(): IntakeCache {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spine-vsx-intake-"));
  return { dir, env: { ORCHESTRATOR_INTAKE_CACHE_DIR: dir }, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export interface RequirementFixture {
  root: string;
  /** `docs/<id>.md` for each requirement written, by id. */
  files: Record<string, string>;
  dispose(): void;
}

/** Writes `docs/<id>.md` in `root`, a requirement holding `CRITERION`, and returns its path. */
export function writeRequirement(root: string, id: string = REQUIREMENT_ID): string {
  const file = path.join(root, "docs", `${id}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# ${id}\n\nThe checkout page shows the cart total with tax.\n\n## Acceptance criteria\n- ${CRITERION}\n`);
  return file;
}

/** A copy of the fixture as its own committed git repository, with one Markdown requirement per id. */
export function requirementFixture(ids: string[] = [REQUIREMENT_ID]): RequirementFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spine-vsx-reqs-")));
  fs.cpSync(FIXTURE, root, { recursive: true });
  const files: Record<string, string> = {};
  for (const id of ids) files[id] = writeRequirement(root, id);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", GIT_NAME);
  git("config", "user.email", "spine-test@example.invalid");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
  return { root, files, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const SEED = `
import json, sys
from orchestrator.intake.cache import save_plan, source_fingerprint
from orchestrator.intake.intents import Intent
from orchestrator.intake.service import BacklogPlan
from orchestrator.intake.source import SourceDocument
from orchestrator.intake.specs import FeatureSpec

s = json.loads(sys.argv[1])
ids, criterion = s["intents"], s["criterion"]
plan = BacklogPlan(
    documents=[SourceDocument(id=ids[0], title=ids[0], body="- " + criterion)],
    intents=[Intent(id=i, title=i + " title", description="d", acceptance_criteria=[criterion]) for i in ids],
    gaps=[],
    specs=[FeatureSpec(intent_id=i, title=i + ": show the cart total with tax", summary="cart_total in shop/cart.py has no tax.",
                       acceptance_criteria=[criterion]) for i in ids],
    blocked=False,
    truncated=False,
)
print(save_plan(s["source"], plan, fingerprint=source_fingerprint(s["source"])))
`;

/** Cache a spec for `source` holding `intents`, as a past extraction would have left it. */
export function seedIntake(cache: IntakeCache, source: string, intents: string[] = [REQUIREMENT_ID]): void {
  const [cmd, pre] = spinePython();
  execFileSync(cmd, [...pre, "-c", SEED, JSON.stringify({ source, intents, criterion: CRITERION })], {
    env: { ...process.env, ...cache.env },
    encoding: "utf8",
  });
}
