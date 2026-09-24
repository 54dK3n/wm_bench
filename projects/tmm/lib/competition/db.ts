import { env } from "cloudflare:workers";
import { normalizeLegacyCompetitionDivisionsInDatabase } from "./division-normalization";
import type { PlatformPrincipalUser } from "./platform-sso";
import { upsertPlatformCompetitionTeamInDatabase } from "./platform-team";
import type {
  CompetitionAdminCredential,
  CompetitionAdminSession,
  CompetitionDivision,
  CompetitionTeam,
  CompetitionTeamCredential,
  CompetitionTeamSession,
} from "./types";
import { normalizeCompetitionDivision } from "./types";

export interface CompetitionD1Result<Row = Record<string, unknown>> {
  results?: Row[];
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface CompetitionD1PreparedStatement {
  bind(...values: unknown[]): CompetitionD1PreparedStatement;
  first<Row = Record<string, unknown>>(column?: string): Promise<Row | null>;
  all<Row = Record<string, unknown>>(): Promise<CompetitionD1Result<Row>>;
  run<Row = Record<string, unknown>>(): Promise<CompetitionD1Result<Row>>;
}

export interface CompetitionD1Database {
  prepare(query: string): CompetitionD1PreparedStatement;
  batch<Row = Record<string, unknown>>(
    statements: CompetitionD1PreparedStatement[],
  ): Promise<CompetitionD1Result<Row>[]>;
}

export interface CompetitionEnv {
  DB: CompetitionD1Database;
  [binding: string]: unknown;
}

export type CompetitionDatabaseConflictCode =
  | "team_name_taken"
  | "admin_already_setup";

export class CompetitionDatabaseConflictError extends Error {
  readonly code: CompetitionDatabaseConflictCode;

  constructor(code: CompetitionDatabaseConflictCode, message: string) {
    super(message);
    this.name = "CompetitionDatabaseConflictError";
    this.code = code;
  }
}

export interface CreateCompetitionTeamWithSessionInput {
  id: string;
  teamName: string;
  teamNameKey: string;
  division: CompetitionDivision;
  passwordHash: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
}

export interface CreateCompetitionSessionInput {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
}

const COMPETITION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS competition_teams (
    id TEXT PRIMARY KEY NOT NULL,
    team_name TEXT NOT NULL,
    team_name_key TEXT NOT NULL,
    division TEXT NOT NULL CHECK (division IN ('primary', 'junior', 'senior')),
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    latest_submission_id TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS competition_teams_team_name_key_unique
    ON competition_teams(team_name_key)`,
  `CREATE INDEX IF NOT EXISTS competition_teams_latest_submission_idx
    ON competition_teams(latest_submission_id)`,
  `CREATE TABLE IF NOT EXISTS competition_platform_team_links (
    platform_team_id TEXT PRIMARY KEY NOT NULL,
    workshop_team_id TEXT NOT NULL UNIQUE
      REFERENCES competition_teams(id) ON DELETE CASCADE,
    linked_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS competition_platform_team_links_workshop_idx
    ON competition_platform_team_links(workshop_team_id)`,
  `CREATE TABLE IF NOT EXISTS competition_sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    team_id TEXT NOT NULL REFERENCES competition_teams(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS competition_sessions_team_idx
    ON competition_sessions(team_id)`,
  `CREATE INDEX IF NOT EXISTS competition_sessions_expires_idx
    ON competition_sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS competition_admin_credentials (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS competition_admin_sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    admin_id INTEGER NOT NULL REFERENCES competition_admin_credentials(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS competition_admin_sessions_expires_idx
    ON competition_admin_sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS competition_submissions (
    id TEXT PRIMARY KEY NOT NULL,
    team_id TEXT NOT NULL REFERENCES competition_teams(id) ON DELETE CASCADE,
    artifact_key TEXT,
    artifact_sha256 TEXT,
    artifact_bytes INTEGER CHECK (artifact_bytes IS NULL OR artifact_bytes >= 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'uploaded', 'evaluating', 'scored', 'failed', 'rejected')),
    score_micros INTEGER CHECK (score_micros IS NULL OR score_micros >= 0),
    correct_count INTEGER,
    total_count INTEGER,
    metrics_json TEXT,
    evaluation_version TEXT,
    model_name TEXT,
    submitted_at INTEGER NOT NULL,
    scored_at INTEGER,
    error_message TEXT,
    idempotency_key TEXT NOT NULL,
    UNIQUE (team_id, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS competition_submissions_team_time_idx
    ON competition_submissions(team_id, submitted_at)`,
  `CREATE INDEX IF NOT EXISTS competition_submissions_status_idx
    ON competition_submissions(status)`,
  `CREATE TABLE IF NOT EXISTS competition_evaluation_sets (
    division TEXT PRIMARY KEY NOT NULL CHECK (division IN ('primary', 'junior', 'senior')),
    object_key TEXT NOT NULL,
    version TEXT NOT NULL,
    sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
    labels_json TEXT NOT NULL,
    embedding_size INTEGER NOT NULL CHECK (embedding_size > 0),
    updated_at INTEGER NOT NULL
  )`,
] as const;

const schemaReadiness = new WeakMap<object, Promise<void>>();

export function getCompetitionEnv(): CompetitionEnv {
  const bindings = env as unknown as Record<string, unknown>;
  const database = bindings.DB;
  if (
    typeof database !== "object" ||
    database === null ||
    typeof (database as Partial<CompetitionD1Database>).prepare !== "function" ||
    typeof (database as Partial<CompetitionD1Database>).batch !== "function"
  ) {
    throw new Error("比赛数据库暂不可用：缺少 Cloudflare D1 `DB` 绑定");
  }
  return bindings as unknown as CompetitionEnv;
}

export async function ensureCompetitionSchema(
  competitionEnv: CompetitionEnv = getCompetitionEnv(),
): Promise<void> {
  const database = competitionEnv.DB;
  const cached = schemaReadiness.get(database as object);
  if (cached) return cached;

  const readiness = database.batch(
    COMPETITION_SCHEMA_STATEMENTS.map((statement) => database.prepare(statement)),
  )
    .then(() => normalizeLegacyCompetitionDivisionsInDatabase(database))
    .catch((error) => {
      schemaReadiness.delete(database as object);
      throw error;
    });
  schemaReadiness.set(database as object, readiness);
  return readiness;
}

export async function upsertPlatformCompetitionTeam(
  user: PlatformPrincipalUser,
  now = Date.now(),
): Promise<CompetitionTeam> {
  const competitionEnv = getCompetitionEnv();
  await ensureCompetitionSchema(competitionEnv);
  return upsertPlatformCompetitionTeamInDatabase(competitionEnv.DB, user, now);
}

export async function createCompetitionTeamWithSession(
  input: CreateCompetitionTeamWithSessionInput,
): Promise<CompetitionTeam> {
  const competitionEnv = getCompetitionEnv();
  await ensureCompetitionSchema(competitionEnv);
  const database = competitionEnv.DB;

  try {
    await database.batch([
      database.prepare(`
        INSERT INTO competition_teams (
          id, team_name, team_name_key, division, password_hash,
          created_at, updated_at, latest_submission_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `).bind(
        input.id,
        input.teamName,
        input.teamNameKey,
        input.division,
        input.passwordHash,
        input.createdAt,
        input.createdAt,
      ),
      database.prepare(`
        INSERT INTO competition_sessions (token_hash, team_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).bind(input.tokenHash, input.id, input.createdAt, input.expiresAt),
    ]);
  } catch (error) {
    const message = errorText(error).toLowerCase();
    if (
      message.includes("competition_teams.team_name_key") ||
      message.includes("competition_teams_team_name_key_unique")
    ) {
      throw new CompetitionDatabaseConflictError(
        "team_name_taken",
        "该队伍名称已被注册",
      );
    }
    throw error;
  }

  return {
    id: input.id,
    teamName: input.teamName,
    division: input.division,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    latestSubmissionId: null,
  };
}

export async function findCompetitionTeamCredential(
  teamNameKey: string,
): Promise<CompetitionTeamCredential | null> {
  const competitionEnv = getCompetitionEnv();
  await ensureCompetitionSchema(competitionEnv);
  const row = await competitionEnv.DB.prepare(`
    SELECT id, team_name, team_name_key, division, password_hash,
           created_at, updated_at, latest_submission_id
    FROM competition_teams
    WHERE team_name_key = ?
    LIMIT 1
  `).bind(teamNameKey).first<CompetitionTeamCredentialRow>();
  return row ? credentialFromRow(row) : null;
}

export async function createCompetitionTeamSession(
  teamId: string,
  input: CreateCompetitionSessionInput,
): Promise<void> {
  const competitionEnv = getCompetitionEnv();
  await ensureCompetitionSchema(competitionEnv);
  const database = competitionEnv.DB;
  await database.batch([
    database.prepare("DELETE FROM competition_sessions WHERE expires_at <= ?")
      .bind(input.createdAt),
    database.prepare(`
      INSERT INTO competition_sessions (token_hash, team_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).bind(input.tokenHash, teamId, input.createdAt, input.expiresAt),
  ]);
}

export async function findCompetitionTeamSession(
  tokenHash: string,
  now = Date.now(),
): Promise<CompetitionTeamSession | null> {
  const competitionEnv = getCompetitionEnv();
  await ensureCompetitionSchema(competitionEnv);
  const row = await competitionEnv.DB.prepare(`
    SELECT t.id, t.team_name, t.division, t.created_at, t.updated_at,
           t.latest_submission_id, s.expires_at
    FROM competition_sessions AS s
    INNER JOIN competition_teams AS t ON t.id = s.team_id
    WHERE s.token_hash = ? AND s.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, now).first<CompetitionTeamSessionRow>();
  if (!row) return null;
  return {
    team: teamFromRow(row),
    expiresAt: row.expires_at,
  };
}

export async function deleteCompetitionTeamSession(tokenHash: string): Promise<void> {
  const competitionEnv = getCompetitionEnv();
  await ensureCompetitionSchema(competitionEnv);
  await competitionEnv.DB.prepare(
    "DELETE FROM competition_sessions WHERE token_hash = ?",
  ).bind(tokenHash).run();
}

export async function isCompetitionAdminSetup(): Promise<boolean> {
  return (await findCompetitionAdminCredential()) !== null;
}

export async function findCompetitionAdminCredential(): Promise<CompetitionAdminCredential | null> {
  const competitionEnv = getCompetitionEnv();
  await ensureCompetitionSchema(competitionEnv);
  const row = await competitionEnv.DB.prepare(`
    SELECT password_hash, created_at, updated_at
    FROM competition_admin_credentials
    WHERE id = 1
    LIMIT 1
  `).first<CompetitionAdminCredentialRow>();
  return row ? {
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

export async function setupCompetitionAdminWithSession(
  passwordHash: string,
  input: CreateCompetitionSessionInput,
): Promise<CompetitionAdminSession> {
  const competitionEnv = getCompetitionEnv();
  await ensureCompetitionSchema(competitionEnv);
  const database = competitionEnv.DB;
  try {
    await database.batch([
      database.prepare(`
        INSERT INTO competition_admin_credentials (id, password_hash, created_at, updated_at)
        VALUES (1, ?, ?, ?)
      `).bind(passwordHash, input.createdAt, input.createdAt),
      database.prepare(`
        INSERT INTO competition_admin_sessions (
          token_hash, admin_id, created_at, expires_at
        ) VALUES (?, 1, ?, ?)
      `).bind(input.tokenHash, input.createdAt, input.expiresAt),
    ]);
  } catch (error) {
    const message = errorText(error).toLowerCase();
    if (
      message.includes("competition_admin_credentials") &&
      (message.includes("unique") || message.includes("primary key"))
    ) {
      throw new CompetitionDatabaseConflictError(
        "admin_already_setup",
        "管理员密码已经设置",
      );
    }
    throw error;
  }
  return { adminId: 1, expiresAt: input.expiresAt };
}

export async function createCompetitionAdminSession(
  input: CreateCompetitionSessionInput,
): Promise<CompetitionAdminSession> {
  const competitionEnv = getCompetitionEnv();
  await ensureCompetitionSchema(competitionEnv);
  const database = competitionEnv.DB;
  await database.batch([
    database.prepare("DELETE FROM competition_admin_sessions WHERE expires_at <= ?")
      .bind(input.createdAt),
    database.prepare(`
      INSERT INTO competition_admin_sessions (
        token_hash, admin_id, created_at, expires_at
      ) VALUES (?, 1, ?, ?)
    `).bind(input.tokenHash, input.createdAt, input.expiresAt),
  ]);
  return { adminId: 1, expiresAt: input.expiresAt };
}

export async function findCompetitionAdminSession(
  tokenHash: string,
  now = Date.now(),
): Promise<CompetitionAdminSession | null> {
  const competitionEnv = getCompetitionEnv();
  await ensureCompetitionSchema(competitionEnv);
  const row = await competitionEnv.DB.prepare(`
    SELECT s.admin_id, s.expires_at
    FROM competition_admin_sessions AS s
    INNER JOIN competition_admin_credentials AS c ON c.id = s.admin_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND c.id = 1
    LIMIT 1
  `).bind(tokenHash, now).first<CompetitionAdminSessionRow>();
  return row ? { adminId: 1, expiresAt: row.expires_at } : null;
}

export async function deleteCompetitionAdminSession(tokenHash: string): Promise<void> {
  const competitionEnv = getCompetitionEnv();
  await ensureCompetitionSchema(competitionEnv);
  await competitionEnv.DB.prepare(
    "DELETE FROM competition_admin_sessions WHERE token_hash = ?",
  ).bind(tokenHash).run();
}

interface CompetitionTeamCredentialRow {
  id: string;
  team_name: string;
  team_name_key: string;
  division: string;
  password_hash: string;
  created_at: number;
  updated_at: number;
  latest_submission_id: string | null;
}

interface CompetitionTeamSessionRow {
  id: string;
  team_name: string;
  division: string;
  created_at: number;
  updated_at: number;
  latest_submission_id: string | null;
  expires_at: number;
}

interface CompetitionAdminCredentialRow {
  password_hash: string;
  created_at: number;
  updated_at: number;
}

interface CompetitionAdminSessionRow {
  admin_id: number;
  expires_at: number;
}

function credentialFromRow(row: CompetitionTeamCredentialRow): CompetitionTeamCredential {
  return {
    ...teamFromRow(row),
    teamNameKey: row.team_name_key,
    passwordHash: row.password_hash,
  };
}

function teamFromRow(row: CompetitionTeamSessionRow | CompetitionTeamCredentialRow): CompetitionTeam {
  const division = normalizeCompetitionDivision(row.division);
  if (!division) throw new Error(`比赛队伍包含无效组别：${row.division}`);
  return {
    id: row.id,
    teamName: row.team_name,
    division,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestSubmissionId: row.latest_submission_id,
  };
}

function errorText(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    } else {
      messages.push(String(current));
      break;
    }
  }
  return messages.join("\n");
}
