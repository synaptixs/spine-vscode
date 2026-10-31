/**
 * What this editor really gives an extension (SSPN-284, D117–D121). The same `.vsix` runs in VS
 * Code and in Cursor; Cursor 3.27.14 is VS Code 1.128.0 underneath, but its extension host (read
 * on 2026-10-31) stubs two of the features Spine uses:
 *  - `lm.registerMcpServerDefinitionProvider` only logs "not supported in Cursor", so Cursor's agent
 *    never sees the Spine server this extension offers;
 *  - `lm.tools` is always empty, `lm.invokeTool` always rejects, and `workbench.mcp.startServer` is
 *    not a command, so there is no MCP connection of the editor's own for remote review (D19).
 * Detection is by behaviour where there is one to read (the command list). A stubbed provider is a
 * function like the real one, so only the editor's name tells them apart.
 *
 * No `vscode` import: the unit suite drives this file directly.
 */

/** Starts the editor's MCP servers; the remote path needs it (src/extension.ts, D8 probe). */
export const START_SERVERS = "workbench.mcp.startServer";

/** Editors whose `registerMcpServerDefinitionProvider` is measured to be a stub. */
const STUBBED_DEFINITION_PROVIDER = new Set(["Cursor"]);

/** Where Spine's own guide adds the server to Cursor by hand or by install link. */
const CURSOR_GUIDE = "https://github.com/synaptixs/spine/blob/main/AGENT_GUIDE.md#cursor";

export interface EditorFeatures {
  readonly name: string;
  /** VS Code's chat gets the local Spine server from this extension. */
  readonly mcpDefinitions: boolean;
}

/** `appName` is `vscode.env.appName`; `hasDefinitionProvider` whether `vscode.lm` has the function at all. */
export function editorFeatures(probe: { appName: string; hasDefinitionProvider: boolean }): EditorFeatures {
  return {
    name: probe.appName,
    mcpDefinitions: probe.hasDefinitionProvider && !STUBBED_DEFINITION_PROVIDER.has(probe.appName),
  };
}

/** Whether the editor has an MCP connection of its own that remote review can call through. */
export async function remoteServersSupported(hasInvokeTool: boolean, commands: () => Thenable<string[]>): Promise<boolean> {
  return hasInvokeTool && (await commands()).includes(START_SERVERS);
}

export function remoteRefusal(editor: string): string {
  return `remote plan review needs VS Code's MCP sign-in, which ${editor} does not give extensions: set spine.server to local, or use VS Code`;
}

/** The one-time notice where the editor's agent cannot get Spine from here (D118); `shown` once it was. */
export function mcpNotice(features: EditorFeatures, shown: boolean): string | undefined {
  if (features.mcpDefinitions || shown) return undefined;
  return (
    `${features.name} does not take MCP servers from extensions, so its agent does not see Spine from here: ` +
    `add Spine to ${features.name} as ${CURSOR_GUIDE} shows. The lenses, plans and runs here work as they are.`
  );
}
