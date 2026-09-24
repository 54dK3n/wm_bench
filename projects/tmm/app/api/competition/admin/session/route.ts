import { getAdminSession } from "@/lib/competition/auth";
import { isCompetitionAdminSetup } from "@/lib/competition/db";
import { jsonError, jsonResponse } from "@/lib/competition/http";

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await getAdminSession(request);
    const configured = session ? true : await isCompetitionAdminSetup();
    return jsonResponse({
      authenticated: session !== null,
      setupRequired: session ? false : !configured,
      expiresAt: session?.expiresAt ?? null,
      user: session?.platformUser ?? null,
    });
  } catch (error) {
    return jsonError(error);
  }
}
