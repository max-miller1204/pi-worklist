import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ProjectGoal, ProjectWorklist } from "../src/types.ts";

const execFileAsync = promisify(execFile);
const cliPath = resolve("src/cli.ts");

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function runCli(cwd: string, args: string[]): Promise<CliResult> {
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd });
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as CliResult & { code: number | null };
		return { code: failure.code ?? 1, stdout: failure.stdout, stderr: failure.stderr };
	}
}

async function tempGitRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-worklist-cli-"));
	await execFileAsync("git", ["init"], { cwd: root });
	return root;
}

async function readGoals(root: string): Promise<ProjectGoal[]> {
	const raw = await readFile(join(root, ".pi", "worklist.json"), "utf8");
	return (JSON.parse(raw) as ProjectWorklist).goals;
}

describe("project goal CLI", () => {
	it("adds, lists, updates, and activates goals through the shared store", async () => {
		const root = await tempGitRepo();

		const added = await runCli(root, ["project", "add", "Ship", "the", "CLI", "--", "External agent access"]);
		expect(added.code).toBe(0);
		expect(added.stdout).toContain("Added project goal");

		const goals = await readGoals(root);
		expect(goals).toHaveLength(1);
		expect(goals[0].title).toBe("Ship the CLI");
		expect(goals[0].description).toBe("External agent access");
		expect(goals[0].status).toBe("open");

		const listed = await runCli(root, ["project", "list"]);
		expect(listed.stdout).toContain(`[open] ${goals[0].id}: Ship the CLI`);
		expect(listed.stdout).not.toContain("External agent access");

		const shown = await runCli(root, ["project", "show", goals[0].id]);
		expect(shown.code).toBe(0);
		expect(shown.stdout).toContain(`${goals[0].id}: Ship the CLI`);
		expect(shown.stdout).toContain("status: open");
		expect(shown.stdout).toContain("External agent access");

		const missing = await runCli(root, ["project", "show", "goal-missing"]);
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("goal-missing was not found");

		const missingJson = await runCli(root, ["project", "show", "goal-missing", "--json"]);
		expect(missingJson.code).toBe(1);
		expect(missingJson.stdout).toBe("");
		expect(JSON.parse(missingJson.stderr)).toMatchObject({
			ok: false,
			scope: "project",
			action: "show",
			error: { code: "NOT_FOUND", retryable: false, details: { id: "goal-missing" } },
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});

		const updated = await runCli(root, ["project", "update", goals[0].id, "Ship", "it"]);
		expect(updated.code).toBe(0);
		expect((await readGoals(root))[0].title).toBe("Ship it");
		expect((await readGoals(root))[0].description).toBe("External agent access");

		const activated = await runCli(root, ["project", "set_active", goals[0].id]);
		expect(activated.code).toBe(0);
		expect((await readGoals(root))[0].status).toBe("active");
	});

	it("keeps a single active goal", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "First"]);
		await runCli(root, ["project", "add", "Second"]);
		const [first, second] = await readGoals(root);
		await runCli(root, ["project", "set_active", first.id]);
		await runCli(root, ["project", "set_active", second.id]);
		const goals = await readGoals(root);
		expect(goals.find((goal) => goal.id === first.id)?.status).toBe("open");
		expect(goals.find((goal) => goal.id === second.id)?.status).toBe("active");
	});

	it("emits stable machine-readable result envelopes with --json", async () => {
		const root = await tempGitRepo();
		const added = await runCli(root, ["project", "add", "--json", "Automate", "--", "Via Claude"]);
		const payload = JSON.parse(added.stdout) as {
			ok: boolean;
			scope: string;
			action: string;
			result: { goal: ProjectGoal; goals: ProjectGoal[] };
			meta: { changed: boolean; semanticNoOp: boolean; revisions?: { project?: string } };
		};
		expect(payload.ok).toBe(true);
		expect(payload.scope).toBe("project");
		expect(payload.action).toBe("add");
		expect(payload.result.goal.title).toBe("Automate");
		expect(payload.result.goals).toHaveLength(1);
		expect(payload.meta).toMatchObject({ changed: true, semanticNoOp: false, revisions: { project: "1" } });

		// Failures with --json print the full deterministic failure envelope on stderr.
		const refused = await runCli(root, ["project", "complete", payload.result.goal.id, "--json"]);
		expect(refused.code).toBe(3);
		expect(refused.stdout).toBe("");
		const errorPayload = JSON.parse(refused.stderr) as {
			ok: boolean;
			scope: string;
			action: string;
			error: { code: string; retryable: boolean };
			meta: { changed: boolean; semanticNoOp: boolean; changedFields: string[] };
		};
		expect(errorPayload).toMatchObject({
			ok: false,
			scope: "project",
			action: "complete",
			error: { code: "APPROVAL_REQUIRED", retryable: false },
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});
	});

	it("refuses lifecycle actions without --confirm and leaves the file untouched", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Guarded"]);
		const [goal] = await readGoals(root);
		for (const action of ["complete", "reopen", "archive", "delete"]) {
			// Each action shares the fixture goal, so the calls stay sequential.
			// pi-lens-ignore: await-in-loop
			const refused = await runCli(root, ["project", action, goal.id]);
			expect(refused.code).toBe(3);
			expect(refused.stderr).toContain("--confirm");
		}
		expect((await readGoals(root))[0].status).toBe("open");

		const completed = await runCli(root, ["project", "complete", goal.id, "--confirm"]);
		expect(completed.code).toBe(0);
		expect((await readGoals(root))[0].status).toBe("done");

		const blocked = await runCli(root, ["project", "set_active", goal.id]);
		expect(blocked.code).toBe(1);
		expect(blocked.stderr).toContain("must be reopened");
		expect(blocked.stderr).toContain(`pi-worklist project reopen ${goal.id} --confirm`);

		const blockedJson = await runCli(root, ["project", "set_active", goal.id, "--json"]);
		expect(blockedJson.code).toBe(1);
		expect(blockedJson.stdout).toBe("");
		expect(JSON.parse(blockedJson.stderr)).toMatchObject({
			ok: false,
			scope: "project",
			action: "set_active",
			error: { code: "VALIDATION_FAILED", details: { resolution: "reopen-project-goal" } },
			meta: { changed: false, semanticNoOp: false },
		});

		const deleted = await runCli(root, ["project", "delete", goal.id, "--confirm"]);
		expect(deleted.code).toBe(0);
		expect(await readGoals(root)).toHaveLength(0);
	});

	it("rejects the session scope and unknown input with usage errors", async () => {
		const root = await tempGitRepo();
		const session = await runCli(root, ["session", "add", "Nope"]);
		expect(session.code).toBe(2);
		expect(session.stderr).toContain("inside a Pi session");

		const unknown = await runCli(root, ["project", "explode"]);
		expect(unknown.code).toBe(2);

		const missingTitle = await runCli(root, ["project", "add"]);
		expect(missingTitle.code).toBe(2);

		const flagAsCwd = await runCli(root, ["project", "list", "--cwd", "--json"]);
		expect(flagAsCwd.code).toBe(2);
		expect(flagAsCwd.stderr).toContain("--cwd requires a directory");
	});

	it("fails cleanly outside a git repository and honors --cwd", async () => {
		const bare = await mkdtemp(join(tmpdir(), "pi-worklist-nogit-"));
		const helpOutside = await runCli(bare, ["project", "help"]);
		expect(helpOutside.code).toBe(0);
		expect(helpOutside.stdout).toContain("Usage: pi-worklist project");

		const outside = await runCli(bare, ["project", "list"]);
		expect(outside.code).toBe(1);
		expect(outside.stderr).toContain("git repository");

		const outsideJson = await runCli(bare, ["project", "list", "--json"]);
		expect(outsideJson.code).toBe(1);
		expect(outsideJson.stdout).toBe("");
		expect(JSON.parse(outsideJson.stderr)).toMatchObject({
			ok: false,
			scope: "project",
			action: "list",
			error: { code: "UNAVAILABLE", retryable: false, details: { resolution: "run-inside-git-repository" } },
			meta: { changed: false, semanticNoOp: false, changedFields: [] },
		});

		const root = await tempGitRepo();
		const viaCwd = await runCli(bare, ["project", "add", "From", "elsewhere", "--cwd", root]);
		expect(viaCwd.code).toBe(0);
		expect((await readGoals(root))[0].title).toBe("From elsewhere");
	});

	it("reports malformed files without overwriting them", async () => {
		const root = await tempGitRepo();
		await runCli(root, ["project", "add", "Existing"]);
		const path = join(root, ".pi", "worklist.json");
		const { writeFile } = await import("node:fs/promises");
		await writeFile(path, "not json\n");
		const result = await runCli(root, ["project", "add", "Another"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Malformed");
		expect(await readFile(path, "utf8")).toBe("not json\n");
	});
});
