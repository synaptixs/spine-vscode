import * as vscode from "vscode";

export interface SpineApiForTests {
  readonly trusted: boolean;
  doctor(): Promise<unknown>;
  mcpDefinitions(): vscode.McpServerDefinition[];
}

export async function spineApi(): Promise<SpineApiForTests> {
  const ext = vscode.extensions.getExtension<SpineApiForTests>("synaptixs.spine-vscode");
  if (!ext) throw new Error("extension synaptixs.spine-vscode is not installed in the test host");
  const api = await ext.activate();
  if (!api) throw new Error("activate() returned no API");
  return api;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
