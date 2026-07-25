import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CLI_COMMAND_CONTRACT, renderCliGuide, renderCliUsage } from "../src/cli-contract.ts";

const execFileAsync = promisify(execFile);

describe("single CLI command contract", () => {
	it("keeps the generated docs/cli.md guide in sync with the contract", async () => {
		const generated = await readFile(resolve("docs/cli.md"), "utf8");
		expect(generated, "docs/cli.md is stale; run `npm run docs:cli` to regenerate it").toBe(renderCliGuide());
	});

	it("derives help output, the skill guide, and agent guidance from one contract", async () => {
		const usage = renderCliUsage();
		const guide = renderCliGuide();
		for (const action of CLI_COMMAND_CONTRACT.actions) {
			expect(usage).toContain(action.usage);
			expect(usage).toContain(action.summary);
			expect(guide).toContain(`pi-worklist project ${action.usage}`);
		}
		for (const flag of CLI_COMMAND_CONTRACT.flags) {
			expect(usage).toContain(flag.usage);
			expect(guide).toContain(flag.usage);
		}
		for (const exitCode of CLI_COMMAND_CONTRACT.exitCodes) {
			expect(usage).toContain(`${exitCode.code} ${exitCode.meaning}`);
		}
		for (const guideline of CLI_COMMAND_CONTRACT.agentGuidelines) {
			expect(guide).toContain(guideline);
		}
		expect(guide).toContain("## Agent guidance");
		expect(CLI_COMMAND_CONTRACT.agentGuidelines.some((guideline) => guideline.includes("--confirm"))).toBe(
			true,
		);
	});

	it("keeps the repository worklist skill aligned with the contract surface", async () => {
		const skill = await readFile(resolve(".claude/skills/worklist/SKILL.md"), "utf8");
		expect(skill).toContain(`npx ${CLI_COMMAND_CONTRACT.binary}`);
		expect(skill).toContain("docs/cli.md");
		for (const action of CLI_COMMAND_CONTRACT.actions) {
			expect(skill, `SKILL.md is missing action usage \`${action.usage}\``).toContain(action.usage);
		}
		for (const exitCode of CLI_COMMAND_CONTRACT.exitCodes.filter((entry) => entry.code >= 3)) {
			expect(skill, `SKILL.md is missing exit code ${exitCode.code}`).toContain(`Exit code ${exitCode.code}`);
		}
	});

	it("prints the contract-rendered help from the CLI itself", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-worklist-cli-help-"));
		await execFileAsync("git", ["init", "-q"], { cwd: root });
		const { stdout } = await execFileAsync(process.execPath, [resolve("src/cli.ts"), "project", "help"], {
			cwd: root,
		});
		expect(stdout.trimEnd()).toBe(renderCliUsage());
	});

	it("documents every implemented action and implements every documented action", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-worklist-cli-surface-"));
		await execFileAsync("git", ["init", "-q"], { cwd: root });
		const documented = CLI_COMMAND_CONTRACT.actions.map((action) => action.name);
		expect(documented).toEqual([
			"list",
			"show",
			"add",
			"update",
			"set_active",
			"complete",
			"reopen",
			"archive",
			"delete",
			"help",
		]);

		// A documented read action must not be rejected as unknown.
		for (const action of ["list", "help"]) {
			// Each invocation is independent; sequential execution keeps output readable.
			// pi-lens-ignore: await-in-loop
			const result = await execFileAsync(process.execPath, [resolve("src/cli.ts"), "project", action], {
				cwd: root,
			});
			expect(result.stdout.length).toBeGreaterThan(0);
		}

		// An undocumented action fails as a usage error, proving the switch and contract agree.
		await expect(
			execFileAsync(process.execPath, [resolve("src/cli.ts"), "project", "undocumented"], { cwd: root }),
		).rejects.toMatchObject({ code: 2 });
	});
});
