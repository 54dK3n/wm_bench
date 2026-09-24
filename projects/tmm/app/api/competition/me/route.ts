import { requireTeamSession } from "@/lib/competition/auth";
import { getCompetitionEnv } from "@/lib/competition/db";
import { jsonError, jsonResponse } from "@/lib/competition/http";
import { getCompetitionStorage } from "@/lib/competition/storage";
import { scheduleCompetitionSubmissionEvaluation } from "@/lib/competition/submission-evaluation";
import {
  COMPETITION_SUBMISSION_SELECT,
  type CompetitionSubmissionRow,
  participantSubmissionSummaryFromRow,
} from "@/lib/competition/submissions";

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await requireTeamSession(request);
    const latestRow = session.team.latestSubmissionId
      ? await getCompetitionEnv().DB.prepare(`
          SELECT ${COMPETITION_SUBMISSION_SELECT}
          FROM competition_submissions
          WHERE id = ? AND team_id = ?
          LIMIT 1
        `).bind(session.team.latestSubmissionId, session.team.id).first<CompetitionSubmissionRow>()
      : null;
    if (latestRow && ["pending", "uploaded", "evaluating"].includes(latestRow.status)) {
      const evaluationRow = await getCompetitionEnv().DB.prepare(`
        SELECT division, object_key, version
        FROM competition_evaluation_sets
        WHERE division = ? AND version = ?
        LIMIT 1
      `).bind(session.team.division, latestRow.evaluation_version).first<{
        division: string;
        object_key: string;
        version: string;
      }>();
      if (evaluationRow) {
        scheduleCompetitionSubmissionEvaluation({
          database: getCompetitionEnv().DB,
          storage: getCompetitionStorage(),
          submission: latestRow,
          evaluation: {
            division: evaluationRow.division,
            version: evaluationRow.version,
            objectKey: evaluationRow.object_key,
          },
          fallbackModelName: latestRow.model_name ?? "未命名模型",
        });
      }
    }
    return jsonResponse({
      team: session.team,
      user: session.platformUser ?? null,
      latestSubmission: latestRow ? participantSubmissionSummaryFromRow(latestRow) : null,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    return jsonError(error);
  }
}
