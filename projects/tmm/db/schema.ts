import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  COMPETITION_DIVISIONS,
  COMPETITION_SUBMISSION_STATUSES,
  type CompetitionDivision,
  type CompetitionSubmissionStatus,
} from "../lib/competition/types";

export const competitionTeams = sqliteTable(
  "competition_teams",
  {
    id: text("id").primaryKey(),
    teamName: text("team_name").notNull(),
    teamNameKey: text("team_name_key").notNull(),
    division: text("division", { enum: COMPETITION_DIVISIONS })
      .$type<CompetitionDivision>()
      .notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    latestSubmissionId: text("latest_submission_id"),
  },
  (table) => [
    uniqueIndex("competition_teams_team_name_key_unique").on(table.teamNameKey),
    index("competition_teams_latest_submission_idx").on(table.latestSubmissionId),
    check(
      "competition_teams_division_check",
      sql`${table.division} in ('primary', 'junior', 'senior')`,
    ),
  ],
);

export const competitionSessions = sqliteTable(
  "competition_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => competitionTeams.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("competition_sessions_team_idx").on(table.teamId),
    index("competition_sessions_expires_idx").on(table.expiresAt),
  ],
);

export const competitionAdminCredentials = sqliteTable(
  "competition_admin_credentials",
  {
    id: integer("id").primaryKey(),
    passwordHash: text("password_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    check("competition_admin_credentials_singleton_check", sql`${table.id} = 1`),
  ],
);

export const competitionAdminSessions = sqliteTable(
  "competition_admin_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    adminId: integer("admin_id")
      .notNull()
      .references(() => competitionAdminCredentials.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("competition_admin_sessions_expires_idx").on(table.expiresAt),
  ],
);

export const competitionSubmissions = sqliteTable(
  "competition_submissions",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => competitionTeams.id, { onDelete: "cascade" }),
    artifactKey: text("artifact_key"),
    artifactSha256: text("artifact_sha256"),
    artifactBytes: integer("artifact_bytes"),
    status: text("status", { enum: COMPETITION_SUBMISSION_STATUSES })
      .$type<CompetitionSubmissionStatus>()
      .notNull(),
    scoreMicros: integer("score_micros"),
    correctCount: integer("correct_count"),
    totalCount: integer("total_count"),
    metricsJson: text("metrics_json"),
    evaluationVersion: text("evaluation_version"),
    modelName: text("model_name"),
    submittedAt: integer("submitted_at").notNull(),
    scoredAt: integer("scored_at"),
    errorMessage: text("error_message"),
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (table) => [
    uniqueIndex("competition_submissions_team_idempotency_unique").on(
      table.teamId,
      table.idempotencyKey,
    ),
    index("competition_submissions_team_time_idx").on(
      table.teamId,
      table.submittedAt,
    ),
    index("competition_submissions_status_idx").on(table.status),
    check(
      "competition_submissions_status_check",
      sql`${table.status} in ('pending', 'uploaded', 'evaluating', 'scored', 'failed', 'rejected')`,
    ),
    check(
      "competition_submissions_artifact_bytes_check",
      sql`${table.artifactBytes} is null or ${table.artifactBytes} >= 0`,
    ),
    check(
      "competition_submissions_score_check",
      sql`${table.scoreMicros} is null or ${table.scoreMicros} >= 0`,
    ),
  ],
);

export const competitionEvaluationSets = sqliteTable(
  "competition_evaluation_sets",
  {
    division: text("division", { enum: COMPETITION_DIVISIONS })
      .$type<CompetitionDivision>()
      .primaryKey(),
    objectKey: text("object_key").notNull(),
    version: text("version").notNull(),
    sampleCount: integer("sample_count").notNull(),
    labelsJson: text("labels_json").notNull(),
    embeddingSize: integer("embedding_size").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    check(
      "competition_evaluation_sets_division_check",
      sql`${table.division} in ('primary', 'junior', 'senior')`,
    ),
    check(
      "competition_evaluation_sets_sample_count_check",
      sql`${table.sampleCount} >= 0`,
    ),
    check(
      "competition_evaluation_sets_embedding_size_check",
      sql`${table.embeddingSize} > 0`,
    ),
  ],
);

export type CompetitionTeamRow = typeof competitionTeams.$inferSelect;
export type NewCompetitionTeamRow = typeof competitionTeams.$inferInsert;
export type CompetitionSessionRow = typeof competitionSessions.$inferSelect;
export type CompetitionSubmissionRow = typeof competitionSubmissions.$inferSelect;
export type CompetitionEvaluationSetRow = typeof competitionEvaluationSets.$inferSelect;
