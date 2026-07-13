import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { createEmptyWorklist, mutateProjectWorklist, readProjectWorklist } from "../src/project-store.ts";

async function tempPath() {
	const root = await mkdtemp(join(tmpdir(), "pi-worklist-"));
	return join(root, ".pi", "worklist.json");
}

describe("project store", () => {
	it("treats a missing file as an empty worklist", async () => {
		const result = await readProjectWorklist(await tempPath());
		expect(result).toEqual({ data: createEmptyWorklist() });
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
	});
});
