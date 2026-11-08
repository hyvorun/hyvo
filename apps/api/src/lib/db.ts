import type { DerivedSummary, RunSummary } from "@hyvo/schema";

/** A `runs` row as stored in D1. */
export interface RunRow {
  run_id: string;
  hash: string;
  published_at: string;
  featured: number;
  listed: number;
  summary_json: string;
  artifact_key: string;
}

const COLUMNS = "run_id, hash, published_at, featured, listed, summary_json, artifact_key";

export function toSummary(row: RunRow): RunSummary {
  const derived = JSON.parse(row.summary_json) as DerivedSummary;
  return { ...derived, publishedAt: row.published_at, featured: row.featured === 1 };
}

export async function findRun(db: D1Database, runId: string): Promise<RunRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM runs WHERE run_id = ?`).bind(runId).first<RunRow>();
}

export interface NewRun {
  derived: DerivedSummary;
  publishedAt: string;
  featured: boolean;
  listed: boolean;
  artifactKey: string;
  sizeBytes: number;
}

/** Insert a run; `only` makes it conditional on an earlier statement of the same batch. */
export function insertRunStatement(
  db: D1Database,
  row: NewRun,
  only?: { where: string; args: unknown[] },
): D1PreparedStatement {
  const { derived } = row;
  return db
    .prepare(
      `INSERT INTO runs (run_id, hash, title, created_at, published_at, status, featured, listed, summary_json, artifact_key, size_bytes)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${only ? `WHERE ${only.where}` : ""}`,
    )
    .bind(
      derived.runId,
      derived.hash,
      derived.title,
      derived.createdAt,
      row.publishedAt,
      derived.status,
      row.featured ? 1 : 0,
      row.listed ? 1 : 0,
      JSON.stringify(derived),
      row.artifactKey,
      row.sizeBytes,
      ...(only?.args ?? []),
    );
}

export async function insertRun(db: D1Database, row: NewRun): Promise<void> {
  await insertRunStatement(db, row).run();
}

/** Listed runs, newest first; `after` is the last row of the previous page. */
export async function listRuns(
  db: D1Database,
  limit: number,
  after: { publishedAt: string; runId: string } | null,
): Promise<RunRow[]> {
  const where = after ? "AND (published_at, run_id) < (?, ?)" : "";
  const statement = db.prepare(
    `SELECT ${COLUMNS} FROM runs WHERE listed = 1 ${where} ORDER BY published_at DESC, run_id DESC LIMIT ?`,
  );
  const bound = after ? statement.bind(after.publishedAt, after.runId, limit) : statement.bind(limit);
  return (await bound.all<RunRow>()).results;
}

/** Listed runs, newest first, by a piece of their title and their status. */
export async function searchRuns(
  db: D1Database,
  filter: { limit: number; titleContains?: string | undefined; status?: string | undefined },
): Promise<RunRow[]> {
  const where = ["listed = 1"];
  const args: unknown[] = [];
  if (filter.titleContains) {
    where.push("title LIKE ? ESCAPE '\\'");
    args.push(`%${filter.titleContains.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  const rows = await db
    .prepare(`SELECT ${COLUMNS} FROM runs WHERE ${where.join(" AND ")} ORDER BY published_at DESC, run_id DESC LIMIT ?`)
    .bind(...args, filter.limit)
    .all<RunRow>();
  return rows.results;
}

/** The latest featured listed run, else the latest listed run. */
export async function featuredRun(db: D1Database): Promise<RunRow | null> {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM runs WHERE listed = 1 ORDER BY featured DESC, published_at DESC, run_id DESC LIMIT 1`,
    )
    .first<RunRow>();
}

export async function getKv(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export function setKvStatement(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value);
}

export async function setKv(db: D1Database, key: string, value: string): Promise<void> {
  await setKvStatement(db, key, value).run();
}
