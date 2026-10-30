import * as vscode from "vscode";
import type { PlanView } from "../../src/review";

export interface SpineApiForTests {
  readonly trusted: boolean;
  doctor(): Promise<unknown>;
  mcpDefinitions(): vscode.McpServerDefinition[];
  plans: {
    list(): Promise<{ plans: { intent_id: string; state: string }[]; count: number; truncated: boolean }>;
    current(): PlanView | undefined;
    decide(intentId: string, decision: { reject: boolean; note?: string }): Promise<PlanView>;
    build(): { enabled: boolean; blocker: string | undefined };
  };
  runs: {
    runs(): Promise<{ runId: string; status: string; actions: string[]; text: { label: string; description: string } }[]>;
    message(): string | undefined;
  };
}

export async function spineApi(): Promise<SpineApiForTests> {
  const ext = vscode.extensions.getExtension<SpineApiForTests>("synaptixs.spine-vscode");
  if (!ext) throw new Error("extension synaptixs.spine-vscode is not installed in the test host");
  const api = await ext.activate();
  if (!api) throw new Error("activate() returned no API");
  return api;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
