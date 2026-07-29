/**
 * Writes every artifact generated from src/cli-contract.ts.
 *
 *   npm run docs         # write the files
 *   npm run docs:check   # exit 1 if a committed file is stale
 *
 * The committed files are also asserted byte-for-byte in test/cli-contract.test.ts,
 * so CI catches drift through `npm run check` even without the explicit check.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DOCS_PATH, renderCliGuide, renderSkillMarkdown, SKILL_PATH } from "../src/cli-contract.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const artifacts = [
	{ path: DOCS_PATH, render: renderCliGuide },
	{ path: SKILL_PATH, render: renderSkillMarkdown },
];
const check = process.argv.includes("--check");
const stale: string[] = [];

for (const artifact of artifacts) {
	const target = resolve(repoRoot, artifact.path);
	const expected = artifact.render();
	if (check) {
		// Each artifact is read independently; sequential execution keeps output readable.
		// pi-lens-ignore: await-in-loop
		const actual = await readFile(target, "utf8").catch(() => null);
		if (actual !== expected) {
			stale.push(artifact.path);
		}
		continue;
	}
	// pi-lens-ignore: await-in-loop
	await mkdir(dirname(target), { recursive: true });
	// pi-lens-ignore: await-in-loop
	await writeFile(target, expected, "utf8");
	process.stdout.write(`Wrote ${target}\n`);
}

if (check) {
	if (stale.length > 0) {
		process.stderr.write(
			`Stale generated file(s): ${stale.join(", ")}\nRun \`npm run docs\` and commit the result.\n`,
		);
		process.exit(1);
	}
	process.stdout.write("Generated files are up to date.\n");
}
