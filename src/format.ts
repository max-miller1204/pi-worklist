export function compactDescription(description: string): string {
	return description.replace(/\s+/g, " ").trim();
}
