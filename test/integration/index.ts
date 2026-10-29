import * as path from "node:path";
import Mocha from "mocha";

/** Entry point VS Code calls inside the extension host; SPINE_SUITE picks the suite file. */
export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", timeout: 300_000, color: true });
  mocha.addFile(path.join(__dirname, `${process.env.SPINE_SUITE}.test.js`));
  await mocha.loadFilesAsync();
  await new Promise<void>((resolve, reject) =>
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve())),
  );
}
