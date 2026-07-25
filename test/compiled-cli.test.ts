import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const compiledCliPath = resolve("dist/cli.js");

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function runCompiledCli(cwd: string, args: string[]): Promise<CliResult> {
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [compiledCliPath, ...args], { cwd });
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as CliResult & { code: number | null };
		return { code: failure.code ?? 1, stdout: failure.stdout, stderr: failure.stderr };
	}
}

describe("compiled pi-worklist CLI bin", () => {
	beforeAll(async () => {
		await execFileAsync("npm", ["run", "build"], { cwd: resolve(".") });
	}, 60_000);

	it("compiles to plain JavaScript with an executable entry point", async () => {
		const compiled = await readFile(compiledCliPath, "utf8");
		expect(compiled.startsWith("#!/usr/bin/env node")).toBe(true);
		// Node refuses TypeScript under node_modules; the bin must not need type stripping.
		expect(compiled).not.toContain('from "./application-service.ts"');
		expect(compiled).toContain('from "./application-service.js"');
	});

	it("runs the full goal lifecycle from the compiled bin", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-worklist-compiled-cli-"));
		await execFileAsync("git", ["init", "-q"], { cwd: root });

		const added = await runCompiledCli(root, ["project", "add", "Compiled goal", "--", "Full detail"]);
		expect(added.code).toBe(0);
		expect(added.stdout).toContain("Added project goal");

		const listed = await runCompiledCli(root, ["project", "list"]);
		expect(listed.code).toBe(0);
		expect(listed.stdout).toContain("Compiled goal");

		const worklist = JSON.parse(await readFile(join(root, ".pi", "worklist.json"), "utf8")) as {
			goals: Array<{ id: string }>;
		};
		const goalId = worklist.goals[0]?.id;
		expect(goalId).toBeTruthy();

		const shown = await runCompiledCli(root, ["project", "show", `${goalId}`, "--json"]);
		expect(shown.code).toBe(0);
		expect(JSON.parse(shown.stdout)).toMatchObject({
			ok: true,
			action: "show",
			result: { goal: { id: goalId, description: "Full detail" } },
		});

		const refused = await runCompiledCli(root, ["project", "delete", `${goalId}`]);
		expect(refused.code).toBe(3);
	});

	it("ships the compiled bin in the published package", async () => {
		const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: resolve("."),
			maxBuffer: 10 * 1024 * 1024,
		});
		const [pack] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
		const paths = pack.files.map((file) => file.path);
		expect(paths).toContain("dist/cli.js");
		expect(paths).toContain("src/extension.ts");

		const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
			bin?: Record<string, string>;
			files: string[];
		};
		expect(packageJson.bin).toEqual({ "pi-worklist": "./dist/cli.js" });
		expect(packageJson.files).toContain("dist");
	}, 60_000);
});
