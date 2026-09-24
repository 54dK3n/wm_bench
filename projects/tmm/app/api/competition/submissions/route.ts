import { requireTeamSession } from "@/lib/competition/auth";
import {
  ensureCompetitionSchema,
  getCompetitionEnv,
} from "@/lib/competition/db";
import {
  CompetitionHttpError,
  jsonError,
  jsonResponse,
  readMultipartFormData,
  requireSameOrigin,
} from "@/lib/competition/http";
import { MAX_COMPETITION_MODEL_BYTES } from "@/lib/competition/scoring";
import { getCompetitionStorage } from "@/lib/competition/storage";
import { scheduleCompetitionSubmissionEvaluation } from "@/lib/competition/submission-evaluation";
import {
  COMPETITION_SUBMISSION_SELECT,
  participantSubmissionSummaryFromRow,
  type CompetitionSubmissionRow,
} from "@/lib/competition/submissions";

interface EvaluationSetRow {
  division: string;
  object_key: string;
  version: string;
}

const MAX_COMPETITION_UPLOAD_BYTES = MAX_COMPETITION_MODEL_BYTES + 256 * 1024;
const ACTIVE_SUBMISSION_STATUSES = new Set(["pending", "uploaded", "evaluating"]);

function isUploadedFile(value: FormDataEntryValue | null): value is File {
  return value !== null
    && typeof value !== "string"
    && typeof value.name === "string"
    && typeof value.arrayBuffer === "function";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    const requestReceivedAt = Date.now();
    const requestSubmissionId = crypto.randomUUID();
    const { team } = await requireTeamSession(request);
    const competitionEnv = getCompetitionEnv();
    await ensureCompetitionSchema(competitionEnv);
    const database = competitionEnv.DB;
    const storage = getCompetitionStorage();

    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(idempotencyKey)) {
      throw new CompetitionHttpError(400, "invalid_idempotency_key", "模型提交缺少有效的幂等标识。 ");
    }

    const evaluationRow = await database.prepare(`
      SELECT division, object_key, version
      FROM competition_evaluation_sets
      WHERE division = ?
      LIMIT 1
    `).bind(team.division).first<EvaluationSetRow>();
    if (!evaluationRow) {
      throw new CompetitionHttpError(409, "evaluation_not_ready", "管理员尚未配置本组测试集，暂不能提交模型。 ");
    }
    let existing = await database.prepare(`
      SELECT ${COMPETITION_SUBMISSION_SELECT}
      FROM competition_submissions
      WHERE team_id = ? AND idempotency_key = ?
      LIMIT 1
    `).bind(team.id, idempotencyKey).first<CompetitionSubmissionRow>();
    if (existing) {
      if (
        !ACTIVE_SUBMISSION_STATUSES.has(existing.status)
        || team.latestSubmissionId !== existing.id
      ) {
        return jsonResponse({ submission: participantSubmissionSummaryFromRow(existing) });
      }
      if (existing.evaluation_version !== evaluationRow.version) {
        await database.prepare(`
          UPDATE competition_submissions
          SET status = 'evaluating', score_micros = NULL, correct_count = NULL,
              total_count = NULL, metrics_json = NULL, evaluation_version = ?,
              scored_at = NULL, error_message = NULL
          WHERE id = ? AND team_id = ? AND evaluation_version = ?
            AND EXISTS (
              SELECT 1 FROM competition_evaluation_sets
              WHERE division = ? AND version = ? AND object_key = ?
            )
        `).bind(
          evaluationRow.version,
          existing.id,
          team.id,
          existing.evaluation_version,
          team.division,
          evaluationRow.version,
          evaluationRow.object_key,
        ).run();
        const refreshed = await database.prepare(`
          SELECT ${COMPETITION_SUBMISSION_SELECT}
          FROM competition_submissions
          WHERE id = ? AND team_id = ?
          LIMIT 1
        `).bind(existing.id, team.id).first<CompetitionSubmissionRow>();
        if (!refreshed || refreshed.evaluation_version !== evaluationRow.version) {
          throw new CompetitionHttpError(
            409,
            "evaluation_changed",
            "测试集刚刚发生变化，请重新提交模型。 ",
          );
        }
        existing = refreshed;
      }
      const queued = scheduleCompetitionSubmissionEvaluation({
        database,
        storage,
        submission: existing,
        evaluation: {
          division: evaluationRow.division,
          version: evaluationRow.version,
          objectKey: evaluationRow.object_key,
        },
        fallbackModelName: existing.model_name ?? "未命名模型",
      });
      return jsonResponse({
        submission: participantSubmissionSummaryFromRow(existing),
        evaluationQueued: queued.accepted,
      });
    }

    const form = await readMultipartFormData(request, MAX_COMPETITION_UPLOAD_BYTES);
    const file = form.get("model");
    if (!isUploadedFile(file)) throw new CompetitionHttpError(400, "model_required", "请选择要提交的识物模型。 ");
    if (file.size < 1 || file.size > MAX_COMPETITION_MODEL_BYTES) {
      throw new CompetitionHttpError(413, "model_too_large", "比赛模型必须小于 2 MiB。 ");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const artifactSha256 = await sha256Hex(bytes);
    const submissionId = requestSubmissionId;
    const submittedAt = requestReceivedAt;
    const artifactKey = `competition/submissions/${team.id}/${submissionId}-${artifactSha256}.zip`;

    try {
      await storage.put(artifactKey, bytes, {
        httpMetadata: { contentType: "application/zip" },
        customMetadata: { teamId: team.id, submissionId, sha256: artifactSha256 },
      });
      await database.batch([
        database.prepare(`
          INSERT INTO competition_submissions (
            id, team_id, artifact_key, artifact_sha256, artifact_bytes, status,
            score_micros, correct_count, total_count, metrics_json,
            evaluation_version, model_name, submitted_at, scored_at,
            error_message, idempotency_key
          )
          SELECT ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL,
                 evaluation.version, ?, ?, NULL, NULL, ?
          FROM competition_evaluation_sets AS evaluation
          WHERE evaluation.division = ?
            AND evaluation.version = ?
            AND evaluation.object_key = ?
        `).bind(
          submissionId,
          team.id,
          artifactKey,
          artifactSha256,
          bytes.byteLength,
          file.name.slice(0, 160),
          submittedAt,
          idempotencyKey,
          team.division,
          evaluationRow.version,
          evaluationRow.object_key,
        ),
        database.prepare(`
          UPDATE competition_teams
          SET latest_submission_id = ?, updated_at = ?
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM competition_submissions AS submitted
              WHERE submitted.id = ? AND submitted.team_id = competition_teams.id
            )
            AND (
              latest_submission_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM competition_submissions AS current,
                     competition_submissions AS submitted
                WHERE current.id = competition_teams.latest_submission_id
                  AND submitted.id = ?
                  AND (
                    submitted.submitted_at > current.submitted_at
                    OR (
                      submitted.submitted_at = current.submitted_at
                      AND submitted.rowid > current.rowid
                    )
                  )
              )
            )
        `).bind(submissionId, submittedAt, team.id, submissionId, submissionId),
      ]);
    } catch (error) {
      await storage.delete(artifactKey).catch(() => undefined);
      const concurrent = await database.prepare(`
        SELECT ${COMPETITION_SUBMISSION_SELECT}
        FROM competition_submissions
        WHERE team_id = ? AND idempotency_key = ?
        LIMIT 1
      `).bind(team.id, idempotencyKey).first<CompetitionSubmissionRow>();
      if (concurrent) return jsonResponse({ submission: participantSubmissionSummaryFromRow(concurrent) });
      throw error;
    }
    const inserted = await database.prepare(`
      SELECT ${COMPETITION_SUBMISSION_SELECT}
      FROM competition_submissions
      WHERE id = ?
      LIMIT 1
    `)
      .bind(submissionId)
      .first<CompetitionSubmissionRow>();
    if (!inserted) {
      await storage.delete(artifactKey).catch(() => undefined);
      throw new CompetitionHttpError(
        409,
        "evaluation_changed",
        "测试集刚刚发生变化，请重新提交模型。 ",
      );
    }
    const queued = scheduleCompetitionSubmissionEvaluation({
      database,
      storage,
      submission: inserted,
      evaluation: {
        division: evaluationRow.division,
        version: evaluationRow.version,
        objectKey: evaluationRow.object_key,
      },
      fallbackModelName: file.name,
    });
    return jsonResponse({
      submission: participantSubmissionSummaryFromRow(inserted),
      evaluationQueued: queued.accepted,
    }, 201);
  } catch (error) {
    return jsonError(error);
  }
}
