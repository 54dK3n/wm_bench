import {
  issueCompetitionTeamSession,
  normalizeCompetitionTeamName,
  setTeamSessionCookie,
  verifyCompetitionPassword,
} from "@/lib/competition/auth";
import { findCompetitionTeamCredential, getCompetitionEnv } from "@/lib/competition/db";
import {
  CompetitionHttpError,
  jsonError,
  jsonResponse,
  readJsonObject,
  requireSameOrigin,
  requireStringField,
} from "@/lib/competition/http";
import {
  COMPETITION_SUBMISSION_SELECT,
  type CompetitionSubmissionRow,
  participantSubmissionSummaryFromRow,
} from "@/lib/competition/submissions";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    const payload = await readJsonObject(request);
    const rawTeamName = requireStringField(payload, "teamName", 80);
    const password = requireStringField(payload, "password", 128);
    const { teamNameKey } = normalizeCompetitionTeamName(rawTeamName);
    const credential = await findCompetitionTeamCredential(teamNameKey);
    const valid = await verifyCompetitionPassword(password, credential?.passwordHash);
    if (!credential || !valid) {
      throw new CompetitionHttpError(401, "invalid_credentials", "队伍名称或密码错误");
    }

    const issued = await issueCompetitionTeamSession(credential.id);
    const headers = new Headers();
    setTeamSessionCookie(headers, request, issued.secret.token);
    const team = {
      id: credential.id,
      teamName: credential.teamName,
      division: credential.division,
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
      latestSubmissionId: credential.latestSubmissionId,
    };
    const latestRow = credential.latestSubmissionId
      ? await getCompetitionEnv().DB.prepare(`
          SELECT ${COMPETITION_SUBMISSION_SELECT}
          FROM competition_submissions
          WHERE id = ? AND team_id = ?
          LIMIT 1
        `).bind(credential.latestSubmissionId, credential.id).first<CompetitionSubmissionRow>()
      : null;
    return jsonResponse({
      team,
      latestSubmission: latestRow ? participantSubmissionSummaryFromRow(latestRow) : null,
      expiresAt: issued.expiresAt,
    }, 200, headers);
  } catch (error) {
    return jsonError(error);
  }
}
