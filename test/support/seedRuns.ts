/**
 * Parked runs for the contract tests, written by the REAL Spine's own Python (`RunStore`,
 * `raise_approval`), never as hand-written JSON: a record format that moves in Spine moves here too
 * (D81, D94). Each test gets its own store, named by `SPINE_RUN_STATE` and `SPINE_RUN_ARTIFACTS`, the
 * variables the extension passes its server (D88), so nothing touches the person's own runs.
 *
 * A "live" run is given the pid of a sleeping child of this process and a fresh heartbeat: that is
 * all Spine's liveness check reads.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SPINE_VERSION } from "../../src/launch";

export interface Seed {
  runId: string;
  intentId: string;
  repo: string;
  status: "running" | "parked" | "failed" | "done" | "abandoned";
  /** Give it a live process (a sleeping child) and a fresh heartbeat. */
  live?: boolean;
  /** Raise a pending approval of this kind and park on it. */
  kind?: string;
  digest?: string;
  spentUsd?: number;
  /** Write the `build.json` an editor start leaves, so a resume can rebuild its command. */
  fromEditor?: boolean;
  branch?: string;
}

export interface RunStoreDirs {
  base: string;
  state: string;
  artifacts: string;
  /** The environment the extension would pass its server for this store. */
  env: Record<string, string>;
  dispose(): void;
}

export function runStore(): RunStoreDirs {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "spine-vsx-runs-"));
  const state = path.join(base, "state");
  const artifacts = path.join(base, "artifacts");
  const sleepers: ChildProcess[] = [];
  live.set(base, sleepers);
  return {
    base,
    state,
    artifacts,
    env: { TMPDIR: os.tmpdir(), SPINE_RUN_STATE: state, SPINE_RUN_ARTIFACTS: artifacts },
    dispose: () => {
      for (const s of sleepers) s.kill();
      live.delete(base);
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

const live = new Map<string, ChildProcess[]>();

const SEED = `
import json, sys, time
from orchestrator.sdlc.runstate import RunStore, RunRecord
from orchestrator.sdlc.escalate import ApprovalStore, default_approval_dir, raise_approval

class Quiet:
    def notify_approval_raised(self, _request):
        return False

s = json.loads(sys.argv[1])
artifacts = s["artifacts"]
record = RunRecord(run_id=s["runId"], source="file://seed", repo=s["repo"], intent_id=s["intentId"],
                   started_at=time.time(), artifacts_dir=artifacts, spent_usd=s.get("spentUsd", 0.0),
                   phase=s.get("phase", "implement"), pid=s.get("pid", 0))
approval_id = ""
if s.get("kind"):
    a = raise_approval(run_id=s["runId"], issue_key="", title=s["kind"] + " for the contract test",
                       reason="seeded", store=ApprovalStore(root=default_approval_dir()), notifier=Quiet(),
                       kind=s["kind"], digest=s.get("digest", ""))
    approval_id = a.approval_id
record.status = s["status"]
record.approval_id = approval_id
record.parked_reason = "seeded park" if s["status"] == "parked" else ""
RunStore().save(record)
print(json.dumps({"approval_id": approval_id}))
`;

/** Spine's Python, the same release the extension pins (or SPINE_SEED_PYTHON for a local build). */
function python(): [string, string[]] {
  const own = process.env.SPINE_SEED_PYTHON;
  if (own) return [own, []];
  return ["uvx", ["--python", ">=3.12", "--from", `synaptixs-spine==${SPINE_VERSION}`, "python"]];
}

export function seed(store: RunStoreDirs, s: Seed): { approvalId: string } {
  const artifacts = path.join(store.artifacts, s.runId);
  fs.mkdirSync(artifacts, { recursive: true });
  if (s.fromEditor) fs.writeFileSync(path.join(artifacts, "build.json"), JSON.stringify({ branch: s.branch ?? "main" }));
  let pid = 0;
  if (s.live) {
    // Its own process group: Spine's Cancel ends the whole group of the run's pid.
    const sleeper = spawn("sleep", ["600"], { stdio: "ignore", detached: true });
    live.get(store.base)?.push(sleeper);
    pid = sleeper.pid ?? 0;
  }
  const [cmd, pre] = python();
  const out = execFileSync(cmd, [...pre, "-c", SEED, JSON.stringify({ ...s, artifacts, pid })], {
    env: { ...process.env, ...store.env },
    encoding: "utf8",
  });
  return { approvalId: (JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { approval_id: string }).approval_id };
}
