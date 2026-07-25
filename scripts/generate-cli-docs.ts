import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderCliGuide } from "../src/cli-contract.ts";

const target = resolve(import.meta.dirname, "..", "docs", "cli.md");
await writeFile(target, renderCliGuide(), "utf8");
process.stdout.write(`Wrote ${target}\n`);
