import { execFile } from "node:child_process";
import { glob, mkdtemp, readFile } from "node:fs/promises";
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

function parseJson<T>(text: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error("Expected valid JSON in compiled CLI test", { cause: error });
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

	it("imports only declared dependencies, never a Pi peer", async () => {
		// `npx -y pi-worklist@latest` installs the package's own dependencies and nothing
		// else, so every module the bin reaches at runtime, including the terminal
		// board, must resolve without a Pi installation present.
		const manifest = parseJson<{
			dependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		}>(await readFile(resolve("package.json"), "utf8"));
		const allowed = new Set(Object.keys(manifest.dependencies ?? {}));
		expect(Object.keys(manifest.peerDependencies ?? {}).length).toBeGreaterThan(0);

		const compiled: string[] = [];
		for await (const file of glob("dist/**/*.js")) compiled.push(file);
		expect(compiled.length).toBeGreaterThan(0);

		const offenders: string[] = [];
		const sources = await Promise.all(compiled.map(async (file) => [file, await readFile(file, "utf8")]));
		for (const [file, source] of sources) {
			for (const match of source.matchAll(/(?:\bfrom|\brequire\()\s*["']([^"']+)["']/g)) {
				const specifier = match[1];
				if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
				const packageName = specifier.startsWith("@")
					? specifier.split("/").slice(0, 2).join("/")
					: specifier.split("/")[0];
				if (!allowed.has(packageName)) offenders.push(`${file} imports ${specifier}`);
			}
		}
		expect(offenders, "the compiled bin must not depend on an uninstalled peer").toEqual([]);
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

		const worklist = parseJson<{ goals: Array<{ id: string }> }>(
			await readFile(join(root, ".pi", "worklist.json"), "utf8"),
		);
		const goalId = worklist.goals[0]?.id;
		expect(goalId).toBeTruthy();

		const shown = await runCompiledCli(root, ["project", "show", `${goalId}`, "--json"]);
		expect(shown.code).toBe(0);
		const manifest = parseJson<{ version: string }>(await readFile(resolve("package.json"), "utf8"));
		expect(parseJson(shown.stdout)).toMatchObject({
			ok: true,
			action: "show",
			result: { goal: { id: goalId, description: "Full detail" } },
			meta: { cliVersion: manifest.version },
		});

		const refused = await runCompiledCli(root, ["project", "delete", `${goalId}`]);
		expect(refused.code).toBe(3);
	});

	it("ships the compiled bin in the published package", async () => {
		const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: resolve("."),
			maxBuffer: 10 * 1024 * 1024,
		});
		const [pack] = parseJson<Array<{ files: Array<{ path: string }> }>>(stdout);
		const paths = pack.files.map((file) => file.path);
		expect(paths).toContain("dist/cli.js");
		expect(paths).toContain("src/extension.ts");

		const packageJson = parseJson<{
			bin?: Record<string, string>;
			files: string[];
		}>(await readFile(resolve("package.json"), "utf8"));
		expect(packageJson.bin).toEqual({ "pi-worklist": "dist/cli.js" });
		expect(packageJson.files).toContain("dist");
	}, 60_000);
});
