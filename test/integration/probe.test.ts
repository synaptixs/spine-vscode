/**
 * D8 probe (evidence, not a gate): can the extension's own calls go through VS Code's MCP
 * connection — the route where VS Code runs a remote server's sign-in and keeps the session?
 * Records which MCP commands exist, whether MCP tools appear in `vscode.lm.tools`, and whether
 * `vscode.lm.invokeTool` reaches them outside a chat request. Writes JSON to SPINE_PROBE_OUT.
 */
import * as fs from "node:fs";
import * as vscode from "vscode";
import { sleep, spineApi } from "./helpers";

describe("D8 probe", () => {
  it("records how MCP tools reach an extension", async () => {
    await spineApi();
    const findings: Record<string, unknown> = { vscode: vscode.version };
    findings.mcpCommands = (await vscode.commands.getCommands(true)).filter((c) => /mcp/i.test(c)).sort();
    findings.toolsAtStart = vscode.lm.tools.map((t) => t.name);
    const tried: Record<string, string> = {};
    // Extension-provided servers load lazily: VS Code calls activateCollections() only from the
    // "MCP: List Servers" quick pick or chat. Open it, then close it, to see if that is enough.
    if (process.env.SPINE_PROBE_ACTIVATE) {
      void vscode.commands.executeCommand("workbench.mcp.listServer");
      await sleep(3000);
      await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
      tried["workbench.mcp.listServer"] = "opened and closed";
    }
    // VS Code 1.142's own signature: startServer(serverId | "*", { waitForLiveTools, autoTrustChanges, ... }).
    const t0 = Date.now();
    try {
      const outcome = await Promise.race([
        vscode.commands.executeCommand("workbench.mcp.startServer", "*", { waitForLiveTools: true, autoTrustChanges: true }).then(() => "ran"),
        sleep(90_000).then(() => "timed out after 90 s"),
      ]);
      tried["workbench.mcp.startServer *"] = `${outcome} in ${Date.now() - t0} ms`;
    } catch (err) {
      tried["workbench.mcp.startServer *"] = `error: ${(err as Error).message}`;
    }
    findings.commandsTried = tried;
    let spineTools: string[] = [];
    for (let i = 0; i < 10 && spineTools.length === 0; i++) {
      spineTools = vscode.lm.tools.map((t) => t.name).filter((n) => /doctor|blast_radius/.test(n));
      if (spineTools.length === 0) await sleep(2000);
    }
    findings.toolsAfterWait = vscode.lm.tools.map((t) => t.name);
    findings.spineTools = spineTools;
    const invoked: Record<string, string> = {};
    for (const name of spineTools.filter((n) => /doctor/.test(n))) {
      try {
        const result = await vscode.lm.invokeTool(name, { input: {}, toolInvocationToken: undefined });
        invoked[name] = result.content
          .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : `[${(part as object).constructor.name}]`))
          .join("")
          .slice(0, 400);
      } catch (err) {
        invoked[name] = `error: ${(err as Error).message}`;
      }
    }
    findings.invoked = invoked;
    fs.writeFileSync(process.env.SPINE_PROBE_OUT!, JSON.stringify(findings, null, 2));
  });
});
