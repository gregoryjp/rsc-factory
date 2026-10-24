export type Migration = { version: number; name: string; sql: string };

export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "initial_schema",
		sql: `
CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	authorized_path TEXT NOT NULL,
	preset TEXT,
	policy_version TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE runs (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id),
	input_hash TEXT NOT NULL,
	input_path TEXT NOT NULL,
	state TEXT NOT NULL,
	delivery_target TEXT,
	cost_limit_usd REAL,
	version INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX idx_runs_project_hash ON runs(project_id, input_hash);

CREATE TABLE tasks (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id),
	title TEXT NOT NULL,
	acceptance TEXT NOT NULL,
	state TEXT NOT NULL,
	attempt INTEGER NOT NULL DEFAULT 0,
	version INTEGER NOT NULL,
	lease_owner TEXT,
	lease_expires_at INTEGER,
	heartbeat_at INTEGER,
	base_commit TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_run_state ON tasks(run_id, state);

CREATE TABLE task_dependencies (
	task_id TEXT NOT NULL REFERENCES tasks(id),
	depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
	PRIMARY KEY (task_id, depends_on_task_id)
);
CREATE INDEX idx_task_dependencies_dep ON task_dependencies(depends_on_task_id);

CREATE TABLE attempts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id TEXT NOT NULL REFERENCES tasks(id),
	number INTEGER NOT NULL,
	owner TEXT NOT NULL,
	outcome TEXT NOT NULL DEFAULT 'running',
	provider TEXT,
	model TEXT,
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	cost_usd REAL,
	error TEXT
);
CREATE INDEX idx_attempts_task ON attempts(task_id);

CREATE TABLE events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL REFERENCES runs(id),
	seq INTEGER NOT NULL,
	task_id TEXT,
	type TEXT NOT NULL,
	ts INTEGER NOT NULL,
	payload TEXT NOT NULL,
	UNIQUE (run_id, seq)
);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`,
	},
	{
		version: 2,
		name: "planning_schema",
		sql: `
ALTER TABLE runs ADD COLUMN target_path TEXT;
ALTER TABLE runs ADD COLUMN target_kind TEXT;
ALTER TABLE runs ADD COLUMN preset_ids TEXT NOT NULL DEFAULT '[]';

CREATE TABLE requirements (
	run_id TEXT NOT NULL REFERENCES runs(id),
	id TEXT NOT NULL,
	spec_version INTEGER NOT NULL,
	text TEXT NOT NULL,
	acceptance TEXT NOT NULL,
	priority TEXT NOT NULL,
	source_ref TEXT NOT NULL,
	PRIMARY KEY (run_id, id, spec_version)
);

CREATE TABLE assumptions (
	run_id TEXT NOT NULL REFERENCES runs(id),
	id TEXT NOT NULL,
	spec_version INTEGER NOT NULL,
	statement TEXT NOT NULL,
	reason TEXT NOT NULL,
	impact TEXT NOT NULL,
	reversible INTEGER NOT NULL,
	requirement_ids TEXT NOT NULL,
	PRIMARY KEY (run_id, id, spec_version)
);

CREATE TABLE contradictions (
	run_id TEXT NOT NULL REFERENCES runs(id),
	id TEXT NOT NULL,
	spec_version INTEGER NOT NULL,
	requirement_ids TEXT NOT NULL,
	description TEXT NOT NULL,
	critical INTEGER NOT NULL,
	PRIMARY KEY (run_id, id, spec_version)
);

CREATE TABLE decisions (
	run_id TEXT NOT NULL REFERENCES runs(id),
	id TEXT NOT NULL,
	version INTEGER NOT NULL,
	title TEXT NOT NULL,
	context TEXT NOT NULL,
	decision TEXT NOT NULL,
	alternatives TEXT NOT NULL,
	PRIMARY KEY (run_id, id, version)
);

CREATE TABLE artifacts (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id),
	kind TEXT NOT NULL,
	subject TEXT NOT NULL DEFAULT '',
	version INTEGER NOT NULL,
	path TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	producer TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	UNIQUE (run_id, kind, subject, version),
	UNIQUE (run_id, path)
);

CREATE TABLE role_attempts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL REFERENCES runs(id),
	role TEXT NOT NULL,
	number INTEGER NOT NULL,
	repair INTEGER NOT NULL,
	model TEXT NOT NULL,
	prompt_file TEXT NOT NULL,
	prompt_hash TEXT NOT NULL,
	outcome TEXT NOT NULL,
	cost_usd REAL,
	error TEXT,
	started_at INTEGER NOT NULL,
	ended_at INTEGER
);
CREATE INDEX idx_role_attempts_run ON role_attempts(run_id, role);

CREATE TABLE task_meta (
	task_id TEXT PRIMARY KEY REFERENCES tasks(id),
	run_id TEXT NOT NULL REFERENCES runs(id),
	key TEXT NOT NULL,
	requirement_ids TEXT NOT NULL,
	risk TEXT NOT NULL,
	model_risk TEXT NOT NULL,
	risk_reasons TEXT NOT NULL,
	expected_paths TEXT NOT NULL,
	blocked_reason TEXT,
	UNIQUE (run_id, key)
);
`,
	},
	{
		version: 3,
		name: "run_provider_mode",
		sql: "ALTER TABLE runs ADD COLUMN provider_mode TEXT;",
	},
	{
		version: 4,
		name: "checks_schema",
		sql: `
CREATE TABLE checks (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id),
	task_id TEXT REFERENCES tasks(id),
	argv TEXT NOT NULL,
	cwd TEXT NOT NULL,
	exit_code INTEGER NOT NULL,
	duration_ms INTEGER NOT NULL,
	commit_sha TEXT NOT NULL,
	log_path TEXT NOT NULL,
	log_sha256 TEXT NOT NULL,
	isolated INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_checks_run ON checks(run_id, created_at);
`,
	},
	{
		version: 5,
		name: "task_builds",
		sql: `
CREATE TABLE task_builds (
	task_id TEXT PRIMARY KEY REFERENCES tasks(id),
	run_id TEXT NOT NULL REFERENCES runs(id),
	phase TEXT NOT NULL,
	base_commit TEXT NOT NULL,
	red_commit TEXT,
	head_commit TEXT,
	pre_merge_commit TEXT,
	integration_commit TEXT,
	test_files TEXT NOT NULL,
	red_repairs INTEGER NOT NULL,
	repairs INTEGER NOT NULL,
	requires_review INTEGER NOT NULL,
	protected_paths TEXT NOT NULL,
	blocked_reason TEXT,
	last_check_id TEXT,
	updated_at INTEGER NOT NULL
);
CREATE INDEX idx_task_builds_run ON task_builds(run_id);
`,
	},
	{
		version: 6,
		name: "reviews_findings_retries",
		sql: `
ALTER TABLE task_builds ADD COLUMN reviewed_commit TEXT;
CREATE TABLE reviews (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id),
	task_id TEXT NOT NULL REFERENCES tasks(id),
	cycle INTEGER NOT NULL,
	round INTEGER NOT NULL,
	area TEXT NOT NULL,
	commit_sha TEXT NOT NULL,
	spec_version INTEGER NOT NULL,
	verdict TEXT NOT NULL,
	reason TEXT,
	carried INTEGER NOT NULL,
	acks TEXT NOT NULL,
	output TEXT NOT NULL,
	artifact_id TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_reviews_task ON reviews(task_id, cycle, round);
CREATE TABLE findings (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id),
	task_id TEXT NOT NULL REFERENCES tasks(id),
	cycle INTEGER NOT NULL,
	round INTEGER NOT NULL,
	commit_sha TEXT NOT NULL,
	uid TEXT NOT NULL,
	severity TEXT NOT NULL,
	confidence TEXT NOT NULL,
	title TEXT NOT NULL,
	file TEXT,
	line_start INTEGER,
	line_end INTEGER,
	impact TEXT NOT NULL,
	recommendation TEXT NOT NULL,
	requirement_ids TEXT NOT NULL,
	sources TEXT NOT NULL,
	conflicts_with TEXT NOT NULL,
	status TEXT NOT NULL,
	refutation TEXT,
	created_at INTEGER NOT NULL,
	UNIQUE (task_id, cycle, commit_sha, uid)
);
CREATE INDEX idx_findings_run ON findings(run_id);
CREATE TABLE task_retries (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL REFERENCES runs(id),
	task_id TEXT NOT NULL REFERENCES tasks(id),
	reason TEXT NOT NULL,
	note TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_task_retries_task ON task_retries(task_id);
`,
	},
	{
		version: 7,
		name: "budget_ledger",
		sql: `
ALTER TABLE runs ADD COLUMN budget_usd REAL NOT NULL DEFAULT 15;
ALTER TABLE role_attempts ADD COLUMN failure_class TEXT;
ALTER TABLE role_attempts ADD COLUMN try_number INTEGER NOT NULL DEFAULT 1;
CREATE TABLE budget_entries (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL REFERENCES runs(id),
	kind TEXT NOT NULL CHECK (kind IN ('reservation', 'charge', 'release')),
	role TEXT NOT NULL,
	attempt_id INTEGER,
	reservation_id INTEGER,
	amount_usd REAL NOT NULL,
	basis TEXT NOT NULL CHECK (basis IN ('reservation', 'reported', 'unknown_reservation')),
	created_at INTEGER NOT NULL
);
CREATE INDEX idx_budget_entries_run ON budget_entries(run_id, kind);
CREATE INDEX idx_budget_entries_reservation ON budget_entries(reservation_id);
`,
	},
];
