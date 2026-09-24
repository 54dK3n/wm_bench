import { requireAdminSession } from "@/lib/competition/auth";
import { ensureCompetitionSchema, getCompetitionEnv } from "@/lib/competition/db";
import {
  type CompetitionEvaluationSet,
  validateCompetitionEvaluationSet,
} from "@/lib/competition/evaluation-format";
import { primeCompetitionEvaluationCache } from "@/lib/competition/evaluation-cache";
import {
  CompetitionHttpError,
  jsonError,
  jsonResponse,
  readJsonObject,
  requireSameOrigin,
} from "@/lib/competition/http";
import { getCompetitionStorage } from "@/lib/competition/storage";
import { scheduleCompetitionSubmissionEvaluation } from "@/lib/competition/submission-evaluation";
import {
  COMPETITION_SUBMISSION_SELECT,
  type CompetitionSubmissionRow,
} from "@/lib/competition/submissions";

const MAX_EVALUATION_REQUEST_BYTES = 16 * 1024 * 1024;

interface CurrentEvaluationRow {
  object_key: string;
  version: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request): Promise<Response> {
  let discardCandidate: (() => Promise<void>) | null = null;
  try {
    requireSameOrigin(request);
    await requireAdminSession(request);
    const payload = await readJsonObject(request, MAX_EVALUATION_REQUEST_BYTES);
    let evaluation: CompetitionEvaluationSet;
    try {
      evaluation = validateCompetitionEvaluationSet(payload.evaluationSet);
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        throw new CompetitionHttpError(400, "invalid_evaluation_set", error.message);
      }
      throw error;
    }
    const competitionEnv = getCompetitionEnv();
    await ensureCompetitionSchema(competitionEnv);
    const database = competitionEnv.DB;
    const storage = getCompetitionStorage();

    const current = await database.prepare(`
      SELECT object_key, version
      FROM competition_evaluation_sets
      WHERE division = ?
      LIMIT 1
    `).bind(evaluation.division).first<CurrentEvaluationRow>();

    const versionNumber = Math.max(0, Number.parseInt(current?.version ?? "0", 10) || 0) + 1;
    const version = String(versionNumber);
    const updatedAt = Date.now();
    const serialized = JSON.stringify(evaluation);
    const fingerprint = await sha256Hex(serialized);
    const uploadId = crypto.randomUUID().replace(/-/g, "");
    const objectKey = `competition/evaluation/${evaluation.division}/v${versionNumber}-${fingerprint}-${uploadId}.json`;
    await storage.put(objectKey, new TextEncoder().encode(serialized), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        division: evaluation.division,
        version: String(versionNumber),
        fingerprint,
      },
    });
    discardCandidate = () => storage.delete(objectKey);
    await database.prepare(`
      INSERT INTO competition_evaluation_sets (
        division, object_key, version, sample_count, labels_json,
        embedding_size, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(division) DO UPDATE SET
        object_key = excluded.object_key,
        version = excluded.version,
        sample_count = excluded.sample_count,
        labels_json = excluded.labels_json,
        embedding_size = excluded.embedding_size,
        updated_at = excluded.updated_at
      WHERE competition_evaluation_sets.object_key = ?
    `).bind(
      evaluation.division,
      objectKey,
      version,
      evaluation.sampleLabelIndexes.length,
      JSON.stringify(evaluation.labels),
      evaluation.embeddingSize,
      updatedAt,
      current?.object_key ?? "",
    ).run();
    const saved = await database.prepare(`
      SELECT object_key, version
      FROM competition_evaluation_sets
      WHERE division = ?
      LIMIT 1
    `).bind(evaluation.division).first<CurrentEvaluationRow>();
    if (saved?.object_key !== objectKey || saved.version !== version) {
      throw new CompetitionHttpError(
        409,
        "evaluation_conflict",
        "测试集刚被其他管理员更新，请刷新后重试。",
      );
    }
    discardCandidate = null;
    const evaluationReference = {
      division: evaluation.division,
      version,
      objectKey,
    };
    primeCompetitionEvaluationCache(storage, evaluationReference, evaluation);

    // Capture one immutable latest-submission snapshot. New submissions created
    // after this query already read the new evaluation version and score
    // themselves, while these exact rows are the only rows this replacement
    // mutates and re-scores.
    const latestSubmissions = await database.prepare(`
      SELECT ${COMPETITION_SUBMISSION_SELECT}
      FROM competition_submissions
      WHERE id IN (
        SELECT latest_submission_id
        FROM competition_teams
        WHERE division = ? AND latest_submission_id IS NOT NULL
      )
        AND EXISTS (
          SELECT 1 FROM competition_teams
          WHERE competition_teams.id = competition_submissions.team_id
            AND competition_teams.latest_submission_id = competition_submissions.id
            AND competition_teams.division = ?
        )
      ORDER BY submitted_at ASC, id ASC
    `).bind(evaluation.division, evaluation.division).all<CompetitionSubmissionRow>();
    const snapshot = latestSubmissions.results ?? [];
    for (let offset = 0; offset < snapshot.length; offset += 50) {
      await database.batch(snapshot.slice(offset, offset + 50).map((submission) => database.prepare(`
        UPDATE competition_submissions
        SET status = 'evaluating', score_micros = NULL, correct_count = NULL,
            total_count = NULL, metrics_json = NULL, evaluation_version = ?,
            scored_at = NULL, error_message = NULL
        WHERE id = ? AND team_id = ?
          AND EXISTS (
            SELECT 1 FROM competition_evaluation_sets
            WHERE division = ? AND version = ? AND object_key = ?
          )
      `).bind(
        version,
        submission.id,
        submission.team_id,
        evaluation.division,
        version,
        objectKey,
      )));
    }

    let rescoreQueuedCount = 0;
    let rescoreDeferredCount = 0;
    for (const submission of snapshot) {
      const admission = scheduleCompetitionSubmissionEvaluation({
        database,
        storage,
        submission: { ...submission, evaluation_version: version, status: "evaluating" },
        evaluation: evaluationReference,
        fallbackModelName: submission.model_name ?? "未命名模型",
      });
      if (admission.accepted) rescoreQueuedCount += 1;
      else rescoreDeferredCount += 1;
    }

    const stillCurrent = await database.prepare(`
      SELECT object_key, version
      FROM competition_evaluation_sets
      WHERE division = ?
      LIMIT 1
    `).bind(evaluation.division).first<CurrentEvaluationRow>();
    if (stillCurrent?.object_key !== objectKey || stillCurrent.version !== version) {
      throw new CompetitionHttpError(
        409,
        "evaluation_conflict",
        "测试集已被更新为更高版本，请刷新查看最新结果。",
      );
    }

    return jsonResponse({
      evaluationSet: {
        division: evaluation.division,
        version: versionNumber,
        sampleCount: evaluation.sampleLabelIndexes.length,
        labels: evaluation.labels,
        updatedAt,
      },
      rescoredSubmissionCount: 0,
      rescoreFailedCount: 0,
      rescoreQueuedCount,
      rescoreDeferredCount,
    }, 201);
  } catch (error) {
    if (discardCandidate) await discardCandidate().catch(() => undefined);
    return jsonError(error);
  }
}
