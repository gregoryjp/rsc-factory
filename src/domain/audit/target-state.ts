export type TargetState = {
	head: string;
	status: string;
	files: Record<string, string>;
};

export type FileChange = { path: string; change: "added" | "removed" | "modified" };

export type StateDiff = {
	headChanged: boolean;
	statusChanged: boolean;
	files: FileChange[];
};

export const diffTargetState = (before: TargetState, after: TargetState): StateDiff => {
	const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
	const files = paths.flatMap((path): FileChange[] => {
		const was = before.files[path];
		const now = after.files[path];
		if (was === now) return [];
		if (was === undefined) return [{ path, change: "added" }];
		if (now === undefined) return [{ path, change: "removed" }];
		return [{ path, change: "modified" }];
	});
	return {
		headChanged: before.head !== after.head,
		statusChanged: before.status !== after.status,
		files,
	};
};

export const isStateUnchanged = (diff: StateDiff): boolean =>
	!diff.headChanged && !diff.statusChanged && diff.files.length === 0;
