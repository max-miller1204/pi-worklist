import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface GitRootResult {
	root: string | null;
	isGit: boolean;
	error?: string;
}

export function resolveGitRoot(cwd: string): GitRootResult {
	try {
		const raw = execSync("git rev-parse --show-toplevel", {
			cwd,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10000,
		});
		const top = raw.trim();
		if (!top) return { root: null, isGit: false, error: "not a git repository" };
		const canonical = realpathSync(top);
		return { root: canonical, isGit: true };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { root: null, isGit: false, error: message };
	}
}

export function getWorklistPath(gitRoot: string): string {
	return resolve(gitRoot, ".pi", "worklist.json");
}
