import type { CompetitionD1Database } from "./db";

/*
 * The workshop has always used three evaluation divisions internally, while
 * an older shared-principal contract split primary school into two group ids.
 * These statements make imported or pre-release D1 rows converge on the
 * three persisted values without deleting teams, submissions, or model data.
 */
const LEGACY_DIVISION_NORMALIZATION_STATEMENTS = [
  `UPDATE OR IGNORE competition_teams
   SET division = 'primary'
   WHERE division IN ('primary_low', 'primary_high')`,
  `UPDATE OR IGNORE competition_teams
   SET division = 'senior'
   WHERE division = 'high'`,
  `INSERT OR IGNORE INTO competition_evaluation_sets (
     division, object_key, version, sample_count, labels_json,
     embedding_size, updated_at
   )
   SELECT 'primary', object_key, version, sample_count, labels_json,
          embedding_size, updated_at
   FROM competition_evaluation_sets
   WHERE division IN ('primary_low', 'primary_high')
   ORDER BY updated_at DESC,
            CASE division WHEN 'primary_high' THEN 0 ELSE 1 END
   LIMIT 1`,
  `DELETE FROM competition_evaluation_sets
   WHERE division IN ('primary_low', 'primary_high')
     AND EXISTS (
       SELECT 1 FROM competition_evaluation_sets AS canonical
       WHERE canonical.division = 'primary'
     )`,
  `INSERT OR IGNORE INTO competition_evaluation_sets (
     division, object_key, version, sample_count, labels_json,
     embedding_size, updated_at
   )
   SELECT 'senior', object_key, version, sample_count, labels_json,
          embedding_size, updated_at
   FROM competition_evaluation_sets
   WHERE division = 'high'
   ORDER BY updated_at DESC
   LIMIT 1`,
  `DELETE FROM competition_evaluation_sets
   WHERE division = 'high'
     AND EXISTS (
       SELECT 1 FROM competition_evaluation_sets AS canonical
       WHERE canonical.division = 'senior'
     )`,
] as const;

export async function normalizeLegacyCompetitionDivisionsInDatabase(
  database: CompetitionD1Database,
): Promise<void> {
  await database.batch(
    LEGACY_DIVISION_NORMALIZATION_STATEMENTS.map((statement) => database.prepare(statement)),
  );
}
