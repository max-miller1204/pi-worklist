import { mutateProjectWorklist } from "../../src/project-store.ts";

const [path, id] = process.argv.slice(2);
if (!path || !id) throw new Error("path and id are required");
const timestamp = new Date().toISOString();
const result = await mutateProjectWorklist(path, (worklist) => ({
	worklist: {
		...worklist,
		goals: [...worklist.goals, { id, title: id, status: "open", createdAt: timestamp, updatedAt: timestamp }],
	},
	result: id,
}));
if (result.error) throw new Error(result.error);
