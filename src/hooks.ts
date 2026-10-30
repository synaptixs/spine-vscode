/**
 * Whether `activate` hands out the plan-review hooks the integration suites drive (D51). Never
 * to an installed extension, which runs in Production mode. In Test and Development mode the
 * extension is loaded from source by someone running it. Development is included for step E's
 * company sign-in run: VS Code shows no dialog in a test window and keeps no sign-in there (its
 * storage is in memory), so that run happens in a normal window where a person can sign in.
 *
 * `production` is `vscode.ExtensionMode.Production`, passed in so this file needs no `vscode`.
 */
export function exposesTestHooks(mode: number, production: number): boolean {
  return mode !== production;
}
