import { requireAdminSession } from "@/lib/competition/auth";
import { ensureCompetitionSchema, getCompetitionEnv } from "@/lib/competition/db";
import { jsonError, jsonResponse } from "@/lib/competition/http";
import { getCompetitionStorage } from "@/lib/competition/storage";
import { scheduleCompetitionSubmissionEvaluation } from "@/lib/competition/submission-evaluation";
import type {
  CompetitionSubmissionRow,
  CompetitionTeamStanding,
} from "@/lib/competition/submissions";
import {
  normalizeCompetitionDivision,
  type CompetitionDivision,
  type CompetitionSubmissionStatus,
} from "@/lib/competition/types";

interface EvaluationRow {
  division: string;
  version: string;
  sample_count: number;
  labels_json: string;
  updated_at: number;
  object_key: string;
}

interface StandingRow {
  team_id: string;
  team_name: string;
  division: string;
  submission_id: string;
  status: CompetitionSubmissionStatus;
  model_name: string | null;
  submitted_at: number;
  scored_at: number | null;
  score_micros: number | null;
  correct_count: number | null;
  total_count: number | null;
  error_message: string | null;
  evaluation_version: string | null;
  artifact_key: string | null;
}

interface TeamCountRow {
  division: string;
  count: number;
}

function safeLabels(value: string): string[] {
  try {
    const labels = JSON.parse(value) as unknown;
    return Array.isArray(labels) && labels.every((label) => typeof label === "string") ? labels : [];
  } catch {
    return [];
  }
}

function storedDivision(value: string): CompetitionDivision {
  const division = normalizeCompetitionDivision(value);
  if (!division) throw new TypeError(`比赛数据库包含无效组别：${value}`);
  return division;
}

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdminSession(request);
    const competitionEnv = getCompetitionEnv();
    await ensureCompetitionSchema(competitionEnv);
    const database = competitionEnv.DB;
    const [evaluationResult, standingResult, teamCountResult] = await Promise.all([
      database.prepare(`
        SELECT division, version, sample_count, labels_json, updated_at, object_key
        FROM competition_evaluation_sets
        ORDER BY division
      `).all<EvaluationRow>(),
      database.prepare(`
        SELECT
          COALESCE(l.platform_team_id, t.id) AS team_id,
          t.team_name, t.division,
          s.id AS submission_id, s.status, s.model_name,
          s.submitted_at, s.scored_at, s.score_micros,
          s.correct_count, s.total_count, s.error_message,
          s.evaluation_version, s.artifact_key
        FROM competition_teams AS t
        LEFT JOIN competition_platform_team_links AS l
          ON l.workshop_team_id = t.id
        INNER JOIN competition_submissions AS s
          ON s.id = t.latest_submission_id AND s.team_id = t.id
        ORDER BY t.division ASC,
                 CASE WHEN s.status = 'scored' THEN 0 ELSE 1 END ASC,
                 COALESCE(s.score_micros, 0) DESC,
                 s.submitted_at ASC, t.team_name ASC
      `).all<StandingRow>(),
      database.prepare(`
        SELECT division, COUNT(*) AS count
        FROM competition_teams
        GROUP BY division
      `).all<TeamCountRow>(),
    ]);

    const leaderboards: Record<CompetitionDivision, CompetitionTeamStanding[]> = {
      primary: [],
      junior: [],
      senior: [],
    };
    const evaluationRows = (evaluationResult.results ?? []).map((row) => ({
      ...row,
      division: storedDivision(row.division),
    }));
    const evaluationByDivision = new Map(
      evaluationRows.map((row) => [row.division, row] as const),
    );
    const storage = getCompetitionStorage();
    let recoveryQueuedCount = 0;
    for (const row of standingResult.results ?? []) {
      const division = storedDivision(row.division);
      leaderboards[division].push({
        teamId: row.team_id,
        teamName: row.team_name,
        division,
        submissionId: row.submission_id,
        id: row.submission_id,
        status: row.status,
        modelName: row.model_name,
        submittedAt: row.submitted_at,
        scoredAt: row.scored_at,
        scoreMicros: row.score_micros,
        correctCount: row.correct_count,
        totalCount: row.total_count,
        errorMessage: row.error_message,
        evaluationVersion: row.evaluation_version,
      });
      const evaluation = evaluationByDivision.get(division);
      if (
        evaluation
        && row.evaluation_version === evaluation.version
        && ["pending", "uploaded", "evaluating"].includes(row.status)
      ) {
        const admission = scheduleCompetitionSubmissionEvaluation({
          database,
          storage,
          submission: {
            id: row.submission_id,
            team_id: row.team_id,
            status: row.status,
            model_name: row.model_name,
            submitted_at: row.submitted_at,
            scored_at: row.scored_at,
            score_micros: row.score_micros,
            correct_count: row.correct_count,
            total_count: row.total_count,
            error_message: row.error_message,
            evaluation_version: row.evaluation_version,
            artifact_key: row.artifact_key,
          } satisfies CompetitionSubmissionRow,
          evaluation: {
            division: evaluation.division,
            version: evaluation.version,
            objectKey: evaluation.object_key,
          },
          fallbackModelName: row.model_name ?? "未命名模型",
        });
        if (admission.accepted) recoveryQueuedCount += 1;
      }
    }
    const teamCounts: Record<CompetitionDivision, number> = { primary: 0, junior: 0, senior: 0 };
    for (const row of teamCountResult.results ?? []) {
      teamCounts[storedDivision(row.division)] += row.count;
    }
    return jsonResponse({
      evaluationSets: evaluationRows.map((row) => ({
        division: row.division,
        version: Number.parseInt(row.version, 10) || 0,
        sampleCount: row.sample_count,
        labels: safeLabels(row.labels_json),
        updatedAt: row.updated_at,
      })),
      leaderboards,
      teamCounts,
      recoveryQueuedCount,
    });
  } catch (error) {
    return jsonError(error);
  }
}
