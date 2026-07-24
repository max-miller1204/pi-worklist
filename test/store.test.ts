import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	createEmptyWorklist,
	isProjectWorklist,
	mutateProjectWorklist,
	readProjectWorklist,
} from "../src/project-store.ts";

const execFileAsync = promisify(execFile);

async function tempPath() {
	const root = await mkdtemp(join(tmpdir(), "pi-worklist-"));
	return join(root, ".pi", "worklist.json");
}

describe("project store", () => {
	it("treats a missing file as an empty worklist", async () => {
		const result = await readProjectWorklist(await tempPath());
		expect(result).toEqual({ data: createEmptyWorklist() });
	});

	it("reads legacy worklists at revision zero and persists revision one on mutation", async () => {
		const path = await tempPath();
		await mkdir(join(path, ".."), { recursive: true });
		const legacyValue = { version: 1, goals: [] };
		const legacy = `${JSON.stringify(legacyValue, null, 2)}\n`;
		await writeFile(path, legacy);

		expect(isProjectWorklist(legacyValue)).toBe(true);
		const readResult = await readProjectWorklist(path);
		expect(readResult).toEqual({ data: { version: 1, revision: 0, goals: [] } });
		expect(await readFile(path, "utf8")).toBe(legacy);

		const mutation = await mutateProjectWorklist(path, (worklist) => ({ worklist, result: "migrated" }), {
			expectedRevision: "0",
		});
		expect(mutation).toEqual({ data: "migrated", revision: 1 });
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, revision: 1, goals: [] });
	});

	it("refuses to overwrite malformed data", async () => {
		const path = await tempPath();
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, "not json\n");
		const result = await mutateProjectWorklist(path, (worklist) => ({ worklist, result: true }));
		expect(result.error).toContain("Malformed");
		expect(await readFile(path, "utf8")).toBe("not json\n");
	});

	it("serializes concurrent read-modify-write operations across processes", async () => {
		const path = await tempPath();
		const fixture = resolve("test/fixtures/mutate.ts");
		await Promise.all(
			Array.from({ length: 12 }, (_, index) => execFileAsync(process.execPath, [fixture, path, `g${index}`])),
		);
		const result = await readProjectWorklist(path);
		expect(result.error).toBeUndefined();
		expect(result.data.goals).toHaveLength(12);
		expect(result.data.revision).toBe(12);
	});

	it("checks expected revisions inside the cross-process lock", async () => {
		const path = await tempPath();
		const fixture = resolve("test/fixtures/mutate.ts");
		const attempts = await Promise.allSettled([
			execFileAsync(process.execPath, [fixture, path, "first", "0"]),
			execFileAsync(process.execPath, [fixture, path, "second", "0"]),
		]);

		expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
		const rejected = attempts.filter((attempt) => attempt.status === "rejected");
		expect(rejected).toHaveLength(1);
		expect(String(rejected[0]?.reason.stderr)).toContain("ProjectRevisionConflictError");
		const result = await readProjectWorklist(path);
		expect(result.data.revision).toBe(1);
		expect(result.data.goals).toHaveLength(1);
	});
});
