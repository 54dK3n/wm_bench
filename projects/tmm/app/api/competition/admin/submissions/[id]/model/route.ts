import { requireAdminSession } from "@/lib/competition/auth";
import { ensureCompetitionSchema, getCompetitionEnv } from "@/lib/competition/db";
import { CompetitionHttpError, jsonError } from "@/lib/competition/http";
import { getCompetitionStorage } from "@/lib/competition/storage";

interface ArtifactRow {
  artifact_key: string | null;
  artifact_sha256: string | null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await requireAdminSession(request);
    const { id } = await params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new CompetitionHttpError(400, "invalid_submission", "提交编号无效。 ");
    }
    const competitionEnv = getCompetitionEnv();
    await ensureCompetitionSchema(competitionEnv);
    const row = await competitionEnv.DB.prepare(`
      SELECT artifact_key, artifact_sha256
      FROM competition_submissions
      WHERE id = ?
      LIMIT 1
    `).bind(id).first<ArtifactRow>();
    if (!row?.artifact_key) throw new CompetitionHttpError(404, "submission_not_found", "找不到该提交模型。 ");
    const stored = await getCompetitionStorage().get(row.artifact_key);
    if (!stored) throw new CompetitionHttpError(404, "artifact_not_found", "提交记录存在，但模型文件缺失。 ");
    return new Response(await stored.arrayBuffer(), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="submission-${id}.zip"`,
        "Content-Type": "application/zip",
        "X-Content-Type-Options": "nosniff",
        ...(row.artifact_sha256 ? { ETag: `"sha256-${row.artifact_sha256}"` } : {}),
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
