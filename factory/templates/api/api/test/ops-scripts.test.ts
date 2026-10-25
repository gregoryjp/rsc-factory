import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const API = join(import.meta.dirname, "..");
const SCRIPTS = join(API, "..", "scripts");
const BACKUP = join(SCRIPTS, "db-backup.sh");
const RESTORE = join(SCRIPTS, "db-restore.sh");
const MIGRATE = join(API, "scripts", "migrate.mjs");

const temp = (): string => mkdtempSync(join(tmpdir(), "ops-"));

const runSh = (script: string, args: string[], env: Record<string, string>) => {
	const run = spawnSync("/bin/sh", [script, ...args], { encoding: "utf8", env });
	return { code: run.status, out: `${run.stdout}${run.stderr}` };
};

const stubBin = (calls: string): string => {
	const dir = temp();
	const stub = (name: string, body: string): void => {
		const path = join(dir, name);
		writeFileSync(path, `#!/bin/sh\n${body}\n`);
		chmodSync(path, 0o755);
	};
	stub(
		"pg_dump",
		`for arg in "$@"; do case "$arg" in --file=*) out="\${arg#--file=}";; esac; done
echo "pg_dump $*" >> "${calls}"
echo DUMP > "$out"`,
	);
	stub("pg_restore", `echo "pg_restore $*" >> "${calls}"`);
	return dir;
};

const SAFE_PATH = "/usr/bin:/bin";

describe("backup and restore scripts", () => {
	it("are valid POSIX shell", () => {
		for (const script of [BACKUP, RESTORE]) {
			expect(spawnSync("/bin/sh", ["-n", script]).status, script).toBe(0);
		}
	});

	it("backup refuses to run without a database url and without the postgres client", () => {
		const empty = temp();
		expect(runSh(BACKUP, [], { PATH: empty }).code).toBe(2);
		const missing = runSh(BACKUP, [], { PATH: empty, BACKUP_DATABASE_URL: "postgresql://x/y" });
		expect(missing.code).toBe(3);
		expect(missing.out).toContain("pg_dump not found");
	});

	it("backup writes a private, verified dump and never prints the url", () => {
		const calls = join(temp(), "calls.log");
		const bin = stubBin(calls);
		const dir = join(temp(), "backups");
		const result = runSh(BACKUP, [], {
			PATH: `${bin}:${SAFE_PATH}`,
			BACKUP_DATABASE_URL: "postgresql://user:SECRETPW@db/app",
			BACKUP_DIR: dir,
		});
		expect(result.code, result.out).toBe(0);
		const file = result.out.trim();
		expect(file).toMatch(/backup-\d{8}T\d{6}Z\.dump$/);
		expect(existsSync(file)).toBe(true);
		expect(existsSync(`${file}.partial`)).toBe(false);
		expect(statSync(file).mode & 0o077).toBe(0);
		expect(result.out).not.toContain("SECRETPW");
		const log = readFileSync(calls, "utf8");
		expect(log).toContain("pg_dump --format=custom --no-owner --no-privileges");
		expect(log).toContain("pg_restore --list");
	});

	it("backup falls back to the migrator url and prunes old dumps", () => {
		const bin = stubBin(join(temp(), "calls.log"));
		const dir = temp();
		const old = join(dir, "backup-20200101T000000Z.dump");
		writeFileSync(old, "old");
		const past = new Date(Date.now() - 40 * 86_400_000);
		spawnSync("touch", ["-d", past.toISOString(), old]);
		const result = runSh(BACKUP, [], {
			PATH: `${bin}:${SAFE_PATH}`,
			MIGRATION_DATABASE_URL: "postgresql://m/app",
			BACKUP_DIR: dir,
			BACKUP_KEEP_DAYS: "30",
		});
		expect(result.code, result.out).toBe(0);
		expect(existsSync(old)).toBe(false);
	});

	it("backup fails closed and leaves no partial file when pg_dump fails", () => {
		const bin = temp();
		const path = join(bin, "pg_dump");
		writeFileSync(
			path,
			`#!/bin/sh\nfor arg in "$@"; do case "$arg" in --file=*) echo partial > "\${arg#--file=}";; esac; done\nexit 1\n`,
		);
		chmodSync(path, 0o755);
		writeFileSync(join(bin, "pg_restore"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(bin, "pg_restore"), 0o755);
		const dir = temp();
		const result = runSh(BACKUP, [], {
			PATH: `${bin}:${SAFE_PATH}`,
			BACKUP_DATABASE_URL: "postgresql://x/y",
			BACKUP_DIR: dir,
		});
		expect(result.code).toBe(4);
		const leftovers = spawnSync("ls", [dir], { encoding: "utf8" }).stdout.trim();
		expect(leftovers).toBe("");
	});

	it("restore requires a file, an explicit confirmation and a target url", () => {
		const bin = stubBin(join(temp(), "calls.log"));
		const env = { PATH: `${bin}:${SAFE_PATH}` };
		const dump = join(temp(), "x.dump");
		writeFileSync(dump, "DUMP");
		expect(runSh(RESTORE, [], env).code).toBe(2);
		expect(runSh(RESTORE, [dump], { ...env, RESTORE_DATABASE_URL: "postgresql://x/y" }).code).toBe(
			2,
		);
		expect(runSh(RESTORE, [dump, "--confirm"], env).code).toBe(2);
		expect(
			runSh(RESTORE, [join(temp(), "missing.dump"), "--confirm"], {
				...env,
				RESTORE_DATABASE_URL: "postgresql://x/y",
			}).code,
		).toBe(2);
	});

	it("restore applies the archive in a single transaction and stops on the first error", () => {
		const calls = join(temp(), "calls.log");
		const bin = stubBin(calls);
		const dump = join(temp(), "x.dump");
		writeFileSync(dump, "DUMP");
		const result = runSh(RESTORE, [dump, "--confirm"], {
			PATH: `${bin}:${SAFE_PATH}`,
			RESTORE_DATABASE_URL: "postgresql://user:SECRETPW@db/restore_drill",
		});
		expect(result.code, result.out).toBe(0);
		expect(result.out).not.toContain("SECRETPW");
		const log = readFileSync(calls, "utf8");
		expect(log).toContain("--exit-on-error --single-transaction");
	});
});

describe("migrate script", () => {
	const dry = (env: Record<string, string>) => {
		const run = spawnSync(process.execPath, [MIGRATE, "deploy", "--dry-run"], {
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", ...env },
		});
		return { code: run.status, out: `${run.stdout}${run.stderr}` };
	};

	it("prefers MIGRATION_DATABASE_URL over DATABASE_URL", () => {
		const result = dry({
			MIGRATION_DATABASE_URL: "postgresql://migrator:MIGSECRET@db/app",
			DATABASE_URL: "postgresql://runtime:RUNSECRET@db/app",
		});
		expect(result.code).toBe(0);
		expect(result.out).toContain("MIGRATION_DATABASE_URL");
		expect(result.out).not.toMatch(/SECRET/);
	});

	it("falls back to DATABASE_URL and fails when neither is set", () => {
		expect(dry({ DATABASE_URL: "postgresql://u:p@db/app" }).out).toContain("DATABASE_URL");
		expect(dry({}).code).toBe(2);
		expect(dry({ MIGRATION_DATABASE_URL: "", DATABASE_URL: "" }).code).toBe(2);
	});

	it("rejects unknown commands", () => {
		const run = spawnSync(process.execPath, [MIGRATE, "reset"], {
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", DATABASE_URL: "postgresql://u:p@db/app" },
		});
		expect(run.status).toBe(2);
	});
});
