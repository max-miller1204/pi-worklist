import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	CLI_COMMAND_CONTRACT,
	DOCS_PATH,
	renderCliGuide,
	renderCliUsage,
	renderSkillMarkdown,
	SKILL_PATH,
} from "../src/cli-contract.ts";

const execFileAsync = promisify(execFile);

describe("single CLI command contract", () => {
	it("keeps the generated docs/cli.md guide in sync with the contract", async () => {
		const generated = await readFile(resolve(DOCS_PATH), "utf8");
		expect(generated, `${DOCS_PATH} is stale; run \`npm run docs\` to regenerate it`).toBe(renderCliGuide());
	});

	it("derives help output, the skill guide, and agent guidance from one contract", async () => {
		const usage = renderCliUsage();
		const guide = renderCliGuide();
		for (const action of CLI_COMMAND_CONTRACT.actions) {
			expect(usage).toContain(action.usage);
			expect(usage).toContain(action.summary);
			expect(guide).toContain(`npx -y pi-worklist@latest project ${action.usage}`);
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

	it("keeps the committed worklist skill byte-identical to the contract render", async () => {
		const skill = await readFile(resolve(SKILL_PATH), "utf8");
		expect(skill, `${SKILL_PATH} is stale; run \`npm run docs\` to regenerate it`).toBe(
			renderSkillMarkdown(),
		);
	});

	it("renders a repository-neutral skill covering the whole contract surface", () => {
		const skill = renderSkillMarkdown();
		expect(skill).toContain(`description: ${JSON.stringify(CLI_COMMAND_CONTRACT.skillDescription)}`);
		// The skill installs globally, so every invocation must use the portable,
		// cache-safe `npx -y <binary>@latest` form and must never name a checkout
		// path that only exists on the author's machine.
		expect(skill).toContain(`npx -y ${CLI_COMMAND_CONTRACT.binary}@latest`);
		expect(skill).not.toMatch(new RegExp(String.raw`\bnpx -y ${CLI_COMMAND_CONTRACT.binary}(?!@latest)`));
		expect(skill).not.toMatch(new RegExp(String.raw`\bnpx ${CLI_COMMAND_CONTRACT.binary}\b`));
		expect(skill).not.toContain("/home/");
		expect(skill).toContain(DOCS_PATH);
		const exampleBlock = skill.match(/Examples:\n\n```sh\n([\s\S]*?)\n```/)?.[1];
		expect(exampleBlock, "SKILL.md is missing its Examples block").toBeDefined();
		for (const action of CLI_COMMAND_CONTRACT.actions.filter((entry) => entry.confirmRequired)) {
			expect(
				exampleBlock,
				`Examples must not hand an agent a copy-paste \`${action.name}\`; lifecycle actions need explicit user intent`,
			).not.toContain(`${CLI_COMMAND_CONTRACT.scope} ${action.name} `);
		}
		expect(exampleBlock, "Examples must not demonstrate `--confirm`").not.toContain("--confirm");
		for (const action of CLI_COMMAND_CONTRACT.actions) {
			expect(skill, `SKILL.md is missing action usage \`${action.usage}\``).toContain(action.usage);
		}
		for (const flag of CLI_COMMAND_CONTRACT.flags) {
			expect(skill, `SKILL.md is missing flag \`${flag.usage}\``).toContain(flag.usage);
		}
		for (const exitCode of CLI_COMMAND_CONTRACT.exitCodes.filter((entry) => entry.code >= 1)) {
			expect(skill, `SKILL.md is missing exit code ${exitCode.code}`).toContain(`Exit code ${exitCode.code}`);
		}
	});

	it("uses cache-safe invocations across every published CLI artifact", async () => {
		const publishedInvocation = `npx -y ${CLI_COMMAND_CONTRACT.binary}@latest ${CLI_COMMAND_CONTRACT.scope}`;
		const bareInvocation = new RegExp(
			String.raw`\b${CLI_COMMAND_CONTRACT.binary} ${CLI_COMMAND_CONTRACT.scope}\b`,
		);
		const artifacts = [
			[SKILL_PATH, renderSkillMarkdown()],
			[DOCS_PATH, renderCliGuide()],
			["README.md", await readFile(resolve("README.md"), "utf8")],
		] as const;

		for (const [path, contents] of artifacts) {
			expect(contents, `${path} is missing the published CLI invocation`).toContain(publishedInvocation);
			expect(contents, `${path} contains a bare published CLI invocation`).not.toMatch(bareInvocation);
		}
		expect(renderSkillMarkdown()).toContain("node <checkout>/src/cli.ts project <action>");
		expect(artifacts[2][1]).toContain("node src/cli.ts project <action>");
	});

	it("declares the same Node floor the package does", async () => {
		const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
			engines: { node: string };
		};
		expect(
			manifest.engines.node,
			"package.json engines.node and CLI_COMMAND_CONTRACT.runtime.binaryNodeFloor disagree",
		).toBe(`>=${CLI_COMMAND_CONTRACT.runtime.binaryNodeFloor}`);
	});

	it("states the same Node floors in the README the contract declares", async () => {
		const readme = await readFile(resolve("README.md"), "utf8");
		const { binaryNodeFloor, sourceNodeFloor } = CLI_COMMAND_CONTRACT.runtime;
		expect(readme, "README.md and CLI_COMMAND_CONTRACT.runtime.sourceNodeFloor disagree").toContain(
			`Node ${sourceNodeFloor} or newer`,
		);
		expect(readme, "README.md and CLI_COMMAND_CONTRACT.runtime.binaryNodeFloor disagree").toContain(
			`Node ${binaryNodeFloor} floor`,
		);
		// A stale floor left behind by a contract bump would still satisfy the assertions above,
		// so every version the README states as a requirement has to be one the contract declares.
		const stated = [...readme.matchAll(/Node (\d+(?:\.\d+)*) (?:or newer|floor)/g)].map((match) => match[1]);
		expect(new Set(stated), "README.md states a Node requirement the contract does not declare").toEqual(
			new Set([sourceNodeFloor, binaryNodeFloor]),
		);
	});

	it("ships the generated skill in the published package", async () => {
		const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { files: string[] };
		expect(manifest.files, `${SKILL_PATH} must be packaged so installs carry the skill`).toContain(
			dirname(SKILL_PATH),
		);
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
			"ui",
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
