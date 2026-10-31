/**
 * `npm run test:package`: build the real `.vsix` and refuse it if it holds anything a user should
 * not get (test/support/packageRules.ts). Prints what it read, so an empty package cannot pass.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { packageProblems } from "../support/packageRules";
import { buildVsix, listVsix } from "../support/vsix";

function main(): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spine-vsix-"));
  const file = buildVsix(dir);
  const entries = listVsix(file);
  const bytes = entries.reduce((n, e) => n + e.size, 0);
  console.log(`${path.basename(file)}: ${entries.length} files, ${bytes} bytes unpacked, ${fs.statSync(file).size} bytes packed`);
  const problems = packageProblems(entries);
  for (const p of problems) console.log(`  REFUSED ${p}`);
  return problems.length ? 1 : 0;
}

process.exit(main());
