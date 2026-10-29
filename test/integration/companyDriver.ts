/**
 * Step E's one-window run: VS Code shows no dialog in a test window and keeps no sign-in there,
 * so the company suite cannot run under `--extensionTestsPath`. Instead run.ts loads this as a
 * second development extension in a normal window. It runs the same mocha suite (index.ts) while
 * the person answers VS Code's sign-in, writes the outcome to SPINE_COMPANY_RESULT, and quits.
 */
import * as fs from "node:fs";
import * as vscode from "vscode";
import { run } from "./index";

export async function activate(): Promise<void> {
  const result = process.env.SPINE_COMPANY_RESULT;
  if (!result) return;
  let outcome = "passed";
  try {
    await run();
  } catch (err) {
    outcome = `failed: ${(err as Error).message}`;
  }
  fs.writeFileSync(result, outcome);
  await vscode.commands.executeCommand("workbench.action.quit");
}
