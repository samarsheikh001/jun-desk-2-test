// `npm run deploy`: build, apply D1 migrations and deploy, in the right order.
//
// Upgrades: migrate first, then deploy, so new code never runs against an old schema.
// First deploy: the database doesn't exist until `wrangler deploy` provisions it,
// so deploy first, then migrate. (The Deploy to Cloudflare button provisions before
// building, so it takes the upgrade path.)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function wrangler(args: string[], capture = false): { status: number; stdout: string } {
  const result = spawnSync("npx", ["wrangler", ...args], {
    shell: process.platform === "win32",
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

function run(args: string[]): void {
  if (wrangler(args).status !== 0) process.exit(1);
}

// wrangler.jsonc allows comments; strip them (outside strings) before parsing.
const jsonc = readFileSync("wrangler.jsonc", "utf8").replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? "");
const config = JSON.parse(jsonc) as { d1_databases?: { binding: string; database_name?: string; database_id?: string }[] };
const db = config.d1_databases?.find((d) => d.binding === "DB");
if (!db?.database_name) throw new Error("wrangler.jsonc needs a D1 binding named DB with a database_name");

const list = wrangler(["d1", "list", "--json"], true);
if (list.status !== 0) process.exit(1);
const exists = (JSON.parse(list.stdout) as { name: string; uuid: string }[]).some(
  (d) => d.name === db.database_name || d.uuid === db.database_id,
);

// `wrangler deploy` uploads the Vite output in dist/ as it is: build first, or a stale bundle ships.
if (spawnSync("npx", ["vite", "build"], { shell: process.platform === "win32", stdio: "inherit" }).status !== 0) process.exit(1);

const migrate = ["d1", "migrations", "apply", "DB", "--remote"];
if (exists) {
  run(migrate);
  run(["deploy"]);
} else {
  console.log(`D1 database "${db.database_name}" doesn't exist yet: deploying first so it gets provisioned.`);
  run(["deploy"]);
  run(migrate);
}
