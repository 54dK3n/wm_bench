import type { CompetitionDivision, CompetitionSubmissionStatus } from "./types";

export interface CompetitionSubmissionSummary {
  id: string;
  status: CompetitionSubmissionStatus;
  modelName: string | null;
  submittedAt: number;
  scoredAt: number | null;
  scoreMicros: number | null;
  correctCount: number | null;
  totalCount: number | null;
  errorMessage: string | null;
  evaluationVersion: string | null;
}

export interface CompetitionParticipantSubmissionSummary {
  id: string;
  status: "submitted";
  submittedAt: number;
}

export interface CompetitionSubmissionRow {
  id: string;
  team_id: string;
  status: CompetitionSubmissionStatus;
  model_name: string | null;
  submitted_at: number;
  scored_at: number | null;
  score_micros: number | null;
  correct_count: number | null;
  total_count: number | null;
  error_message: string | null;
  evaluation_version: string | null;
  artifact_key?: string | null;
  artifact_sha256?: string | null;
  artifact_bytes?: number | null;
  metrics_json?: string | null;
  idempotency_key?: string;
}

export interface CompetitionTeamStanding extends CompetitionSubmissionSummary {
  teamId: string;
  teamName: string;
  division: CompetitionDivision;
  submissionId: string;
}

export function submissionSummaryFromRow(row: CompetitionSubmissionRow): CompetitionSubmissionSummary {
  return {
    id: row.id,
    status: row.status,
    modelName: row.model_name,
    submittedAt: row.submitted_at,
    scoredAt: row.scored_at,
    scoreMicros: row.score_micros,
    correctCount: row.correct_count,
    totalCount: row.total_count,
    errorMessage: row.error_message,
    evaluationVersion: row.evaluation_version,
  };
}

export function participantSubmissionSummaryFromRow(
  row: CompetitionSubmissionRow,
): CompetitionParticipantSubmissionSummary {
  return {
    id: row.id,
    status: "submitted",
    submittedAt: row.submitted_at,
  };
}

export const COMPETITION_SUBMISSION_SELECT = `
  id, team_id, status, model_name, submitted_at, scored_at,
  score_micros, correct_count, total_count, error_message,
  evaluation_version, artifact_key, artifact_sha256, artifact_bytes,
  metrics_json, idempotency_key
`;
