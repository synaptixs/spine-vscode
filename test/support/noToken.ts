/**
 * The no-token check (SSPN-243 exit criterion; plan D58): after a signed-in run, nothing the
 * person or the extension leaves behind may hold a token: not settings, not logs, not VS Code's
 * state, not the extension host's environment. VS Code keeps the session in the OS keychain;
 * this proves it stayed there.
 *
 * It looks for two shapes. A JWT (`eyJ…` header and payload, both base64url JSON) covers OIDC
 * access, ID and Keycloak refresh tokens. A bearer header covers an opaque token in a request
 * log. Reports name the file and the shape, never the token. They also count what was read, so a
 * scan of the wrong folder (zero files) cannot pass for a clean one.
 *
 *   node out/test/support/noToken.js <dir|file>… [--env <json file>]
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface Hit {
  where: string;
  kind: string;
  preview: string;
}

export interface Scan {
  hits: Hit[];
  files: number;
  bytes: number;
}

const SHAPES: [string, RegExp][] = [
  ["jwt", /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g],
  // 20+ token characters after "Bearer": a `Bearer realm="…"` challenge is not a token.
  ["bearer", /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
];

export function scanText(text: string, where: string): Hit[] {
  const hits: Hit[] = [];
  for (const [kind, shape] of SHAPES) {
    for (const match of text.matchAll(shape)) hits.push({ where, kind, preview: `${match[0].slice(0, 10)}… (${match[0].length} chars)` });
  }
  return hits;
}

/** Every file under `root`, binary ones too (read as latin1 so no byte is lost); symlinks are not followed. */
export function scanTree(root: string): Scan {
  const scan: Scan = { hits: [], files: 0, bytes: 0 };
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const body = fs.readFileSync(full);
        scan.files += 1;
        scan.bytes += body.length;
        scan.hits.push(...scanText(body.toString("latin1"), path.relative(root, full)));
      }
    }
  };
  if (fs.statSync(root).isDirectory()) walk(root);
  else {
    const body = fs.readFileSync(root);
    scan.files = 1;
    scan.bytes = body.length;
    scan.hits = scanText(body.toString("latin1"), path.basename(root));
  }
  return scan;
}

export function scanEnv(env: Record<string, string | undefined>, where: string): Hit[] {
  return Object.entries(env).flatMap(([name, value]) => (value ? scanText(value, `${where}: ${name}`) : []));
}

function main(argv: string[]): number {
  const envAt = argv.indexOf("--env");
  const envFile = envAt >= 0 ? argv[envAt + 1] : undefined;
  const roots = argv.filter((_, i) => envAt < 0 || (i !== envAt && i !== envAt + 1));
  const hits: Hit[] = [];
  let files = 0;
  for (const root of roots) {
    const scan = scanTree(root);
    console.log(`${root}: ${scan.files} files, ${scan.bytes} bytes, ${scan.hits.length} token-shaped strings`);
    files += scan.files;
    hits.push(...scan.hits.map((h) => ({ ...h, where: path.join(root, h.where) })));
  }
  if (envFile) {
    const env = JSON.parse(fs.readFileSync(envFile, "utf8")) as Record<string, string>;
    const found = scanEnv(env, "env");
    console.log(`${envFile}: ${Object.keys(env).length} variables, ${found.length} token-shaped values`);
    hits.push(...found);
  }
  for (const h of hits) console.log(`  TOKEN ${h.kind} in ${h.where}: ${h.preview}`);
  if (files === 0) {
    console.log("nothing was read: a scan of zero files proves nothing");
    return 2;
  }
  return hits.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
