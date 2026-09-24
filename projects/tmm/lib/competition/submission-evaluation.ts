import type { CompetitionD1Database } from "./db";
import type { CompetitionEvaluationSet } from "./evaluation-format";
import {
  type CompetitionEvaluationReference,
  loadCompetitionEvaluationSet,
} from "./evaluation-cache";
import { scoreCompetitionModel } from "./scoring";
import type { CompetitionObjectStorage } from "./storage";
import { ProjectValidationError } from "../project/validation";
import {
  COMPETITION_SUBMISSION_SELECT,
  type CompetitionSubmissionRow,
} from "./submissions";
import {
  COMPETITION_SCORING_CONCURRENCY,
  COMPETITION_SCORING_QUEUE_CAPACITY,
  CompetitionWorkQueue,
  type CompetitionQueueAdmission,
  type CompetitionQueueSnapshot,
} from "./capacity";
import { getRequestExecutionContext } from "vinext/shims/request-context";

const scoringQueue = new CompetitionWorkQueue(
  COMPETITION_SCORING_CONCURRENCY,
  COMPETITION_SCORING_QUEUE_CAPACITY,
);

export interface CompetitionSubmissionEvaluationJob {
  readonly database: CompetitionD1Database;
  readonly storage: CompetitionObjectStorage;
  readonly submission: CompetitionSubmissionRow;
  readonly evaluation: CompetitionEvaluationReference;
  readonly fallbackModelName: string;
}

export function competitionScoringQueueSnapshot(): CompetitionQueueSnapshot {
  return scoringQueue.snapshot();
}

export function scheduleCompetitionSubmissionEvaluation(
  job: CompetitionSubmissionEvaluationJob,
): CompetitionQueueAdmission<CompetitionSubmissionRow> {
  const key = `${job.submission.id}\u0000${job.evaluation.version}`;
  const admission = scoringQueue.enqueue(key, async () => {
    const current = await job.database.prepare(`
      SELECT ${COMPETITION_SUBMISSION_SELECT}
      FROM competition_submissions
      WHERE id = ?
      LIMIT 1
    `).bind(job.submission.id).first<CompetitionSubmissionRow>();
    if (!current) throw new Error("待评测提交不存在。");
    if (
      current.evaluation_version !== job.evaluation.version
      || ["scored", "failed", "rejected"].includes(current.status)
    ) return current;

    let evaluation: CompetitionEvaluationSet;
    let storedBytes: Uint8Array | null;
    try {
      [evaluation, storedBytes] = await Promise.all([
        loadCompetitionEvaluationSet(job.storage, job.evaluation),
        readSubmissionArtifact(job.storage, current.artifact_key),
      ]);
    } catch (error) {
      await deferCompetitionSubmissionEvaluation(
        job.database,
        job.submission.id,
        job.evaluation.version,
      );
      throw error;
    }
    return scoreAndFinalizeCompetitionSubmission(
      job.database,
      job.submission.id,
      storedBytes,
      evaluation,
      job.evaluation.version,
      current.model_name ?? job.fallbackModelName,
    );
  });
  if (admission.promise) keepCompetitionEvaluationAlive(admission.promise, key);
  return admission;
}

function keepCompetitionEvaluationAlive(
  promise: Promise<CompetitionSubmissionRow>,
  key: string,
): void {
  const guarded = promise.catch((error: unknown) => {
    console.error(`Competition evaluation job ${key} was deferred`, error);
  });
  const executionContext = getRequestExecutionContext();
  if (executionContext) executionContext.waitUntil(guarded);
  else void guarded;
}

async function readSubmissionArtifact(
  storage: CompetitionObjectStorage,
  artifactKey: string | null | undefined,
): Promise<Uint8Array | null> {
  if (!artifactKey) return null;
  const stored = await storage.get(artifactKey);
  return stored ? new Uint8Array(await stored.arrayBuffer()) : null;
}

async function deferCompetitionSubmissionEvaluation(
  database: CompetitionD1Database,
  submissionId: string,
  evaluationVersion: string,
): Promise<void> {
  await database.prepare(`
    UPDATE competition_submissions
    SET status = 'pending', scored_at = NULL,
        error_message = '评测资源暂时不可用，系统将在下次访问时自动重试。'
    WHERE id = ? AND evaluation_version = ?
      AND status IN ('pending', 'uploaded', 'evaluating')
  `).bind(submissionId, evaluationVersion).run();
}

function scoringErrorMessage(error: unknown): {
  status: "rejected" | "failed";
  message: string;
} {
  if (
    error instanceof TypeError
    || error instanceof RangeError
    || error instanceof ProjectValidationError
  ) {
    return {
      status: "rejected",
      message: error.message.slice(0, 500) || "模型不符合比赛格式。",
    };
  }
  console.error("Competition model scoring failed", error);
  return {
    status: "failed",
    message: "评测过程中发生内部错误，本次提交按 0 分记录。",
  };
}

export async function scoreAndFinalizeCompetitionSubmission(
  database: CompetitionD1Database,
  submissionId: string,
  bytes: Uint8Array | null,
  evaluation: CompetitionEvaluationSet,
  evaluationVersion: string,
  fallbackModelName: string,
): Promise<CompetitionSubmissionRow> {
  await database.prepare(`
    UPDATE competition_submissions
    SET status = 'evaluating', score_micros = NULL, correct_count = NULL,
        total_count = NULL, metrics_json = NULL, scored_at = NULL,
        error_message = NULL
    WHERE id = ? AND evaluation_version = ?
  `).bind(submissionId, evaluationVersion).run();

  let finalStatus: "scored" | "rejected" | "failed" = "scored";
  let scoreMicros = 0;
  let correctCount = 0;
  let totalCount = evaluation.sampleLabelIndexes.length;
  let metricsJson: string | null = null;
  let modelName = fallbackModelName.slice(0, 160);
  let errorMessage: string | null = null;
  try {
    if (!bytes) throw new Error("提交模型文件缺失。");
    const score = await scoreCompetitionModel(bytes, evaluation);
    scoreMicros = score.scoreMicros;
    correctCount = score.correctCount;
    totalCount = score.totalCount;
    modelName = score.modelName.slice(0, 160);
    metricsJson = JSON.stringify({
      evaluatorVersion: score.evaluatorVersion,
      rankingMetric: score.rankingMetric,
      labels: score.labels,
      accuracy: score.accuracy,
      macroF1: score.macroF1,
      balancedAccuracy: score.balancedAccuracy,
      confusionMatrix: score.confusionMatrix,
      perClass: score.perClass,
    });
  } catch (error) {
    const result = scoringErrorMessage(error);
    finalStatus = result.status;
    errorMessage = result.message;
  }

  await database.prepare(`
    UPDATE competition_submissions
    SET status = ?, score_micros = ?, correct_count = ?, total_count = ?,
        metrics_json = ?, model_name = ?, scored_at = ?, error_message = ?
    WHERE id = ? AND evaluation_version = ?
  `).bind(
    finalStatus,
    scoreMicros,
    correctCount,
    totalCount,
    metricsJson,
    modelName,
    Date.now(),
    errorMessage,
    submissionId,
    evaluationVersion,
  ).run();

  const row = await database.prepare(`
    SELECT ${COMPETITION_SUBMISSION_SELECT}
    FROM competition_submissions
    WHERE id = ?
    LIMIT 1
  `).bind(submissionId).first<CompetitionSubmissionRow>();
  if (!row) throw new Error("提交结果写入后无法读取。");
  return row;
}
