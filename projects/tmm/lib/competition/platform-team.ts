import type { CompetitionD1Database } from "./db";
import {
  divisionForPlatformGroup,
  type PlatformPrincipalUser,
} from "./platform-sso";
import { normalizeCompetitionDivision, type CompetitionTeam } from "./types";
import {
  COMPETITION_TEAM_WRITE_QUEUE_CAPACITY,
  CompetitionWorkQueue,
} from "./capacity";
import { CompetitionHttpError } from "./http";

const PLATFORM_PASSWORD_SENTINEL = "platform-sso$disabled";

interface CompetitionTeamRow {
  id: string;
  team_name: string;
  team_name_key: string;
  division: string;
  created_at: number;
  updated_at: number;
  latest_submission_id: string | null;
  platform_team_id: string | null;
}

const databaseWriteQueues = new WeakMap<object, CompetitionWorkQueue>();

function writeQueueFor(database: CompetitionD1Database): CompetitionWorkQueue {
  let queue = databaseWriteQueues.get(database as object);
  if (!queue) {
    queue = new CompetitionWorkQueue(1, COMPETITION_TEAM_WRITE_QUEUE_CAPACITY);
    databaseWriteQueues.set(database as object, queue);
  }
  return queue;
}

export function platformTeamNameKey(teamName: string): string {
  const normalized = teamName.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized) throw new TypeError("platform participant team name is required");
  return normalized.toLowerCase();
}

export async function upsertPlatformCompetitionTeamInDatabase(
  database: CompetitionD1Database,
  user: PlatformPrincipalUser,
  now = Date.now(),
): Promise<CompetitionTeam> {
  if (user.role !== "user" || !user.teamId || !user.teamName || !user.group) {
    throw new TypeError("platform participant team identity is required");
  }
  const platformTeamId = user.teamId;
  const teamName = user.teamName;
  const createdAt = Date.parse(user.createdAt);
  const safeCreatedAt = Number.isFinite(createdAt) ? createdAt : now;
  const division = divisionForPlatformGroup(user.group);
  const teamNameKey = platformTeamNameKey(teamName);
  const row = await findPlatformOrLegacyTeam(database, platformTeamId, teamNameKey);
  if (row && platformTeamIsCurrent(row, platformTeamId, teamName, division, teamNameKey)) {
    return teamFromPlatformRow(row);
  }
  const syncKey = `${platformTeamId}\u0000${teamNameKey}\u0000${division}`;
  const admission = writeQueueFor(database).enqueue(syncKey, async () => {
    const current = await findPlatformOrLegacyTeam(database, platformTeamId, teamNameKey);
    if (current && platformTeamIsCurrent(current, platformTeamId, teamName, division, teamNameKey)) {
      return teamFromPlatformRow(current);
    }
    return synchronizePlatformTeam(
      database,
      platformTeamId,
      teamName,
      division,
      teamNameKey,
      safeCreatedAt,
      now,
      current,
    );
  });
  if (!admission.accepted || !admission.promise) {
    throw new CompetitionHttpError(
      503,
      "team_sync_busy",
      "当前登录人数较多，队伍信息正在排队同步，请稍后重试",
    );
  }
  return admission.promise;
}

async function synchronizePlatformTeam(
  database: CompetitionD1Database,
  platformTeamId: string,
  teamName: string,
  division: CompetitionTeam["division"],
  teamNameKey: string,
  safeCreatedAt: number,
  now: number,
  existing: CompetitionTeamRow | null,
): Promise<CompetitionTeam> {
  let row = existing;
  if (!row) {
    await database.prepare(`
      INSERT INTO competition_teams (
        id, team_name, team_name_key, division, password_hash,
        created_at, updated_at, latest_submission_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT DO NOTHING
    `).bind(
      platformTeamId,
      teamName,
      teamNameKey,
      division,
      PLATFORM_PASSWORD_SENTINEL,
      safeCreatedAt,
      now,
    ).run();
    row = await findPlatformOrLegacyTeam(database, platformTeamId, teamNameKey);
  }
  if (!row) throw new Error("统一平台队伍同步后无法读取");

  if (row.platform_team_id !== platformTeamId) {
    await database.prepare(`
      INSERT INTO competition_platform_team_links (
        platform_team_id, workshop_team_id, linked_at, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(platform_team_id) DO UPDATE SET
        workshop_team_id = excluded.workshop_team_id,
        updated_at = excluded.updated_at
      WHERE competition_platform_team_links.workshop_team_id <> excluded.workshop_team_id
    `).bind(platformTeamId, row.id, now, now).run();
    row = { ...row, platform_team_id: platformTeamId };
  }

  if (
    row.team_name !== teamName
    || row.team_name_key !== teamNameKey
    || row.division !== division
  ) {
    await database.prepare(`
      UPDATE competition_teams
      SET team_name = ?, team_name_key = ?, division = ?, updated_at = ?
      WHERE id = ?
        AND (team_name <> ? OR team_name_key <> ? OR division <> ?)
    `).bind(
      teamName,
      teamNameKey,
      division,
      now,
      row.id,
      teamName,
      teamNameKey,
      division,
    ).run();
    row = {
      ...row,
      team_name: teamName,
      team_name_key: teamNameKey,
      division,
      updated_at: now,
    };
  }
  return teamFromPlatformRow(row);
}

function platformTeamIsCurrent(
  row: CompetitionTeamRow,
  platformTeamId: string,
  teamName: string,
  division: CompetitionTeam["division"],
  teamNameKey: string,
): boolean {
  return row.platform_team_id === platformTeamId
    && row.team_name === teamName
    && row.team_name_key === teamNameKey
    && row.division === division;
}

function teamFromPlatformRow(row: CompetitionTeamRow): CompetitionTeam {
  const division = normalizeCompetitionDivision(row.division);
  if (!division) throw new Error(`统一平台队伍包含无效组别：${row.division}`);
  return Object.freeze({
    id: row.id,
    teamName: row.team_name,
    division,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestSubmissionId: row.latest_submission_id,
  });
}

async function findPlatformOrLegacyTeam(
  database: CompetitionD1Database,
  platformTeamId: string,
  teamNameKey: string,
): Promise<CompetitionTeamRow | null> {
  const linked = await database.prepare(`
    SELECT t.id, t.team_name, t.team_name_key, t.division,
           t.created_at, t.updated_at, t.latest_submission_id,
           l.platform_team_id
    FROM competition_platform_team_links AS l
    INNER JOIN competition_teams AS t ON t.id = l.workshop_team_id
    WHERE l.platform_team_id = ?
    LIMIT 1
  `).bind(platformTeamId).first<CompetitionTeamRow>();
  if (linked) return linked;
  return database.prepare(`
    SELECT id, team_name, team_name_key, division, created_at, updated_at,
           latest_submission_id, NULL AS platform_team_id
    FROM competition_teams
    WHERE id = ? OR team_name_key = ?
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).bind(platformTeamId, teamNameKey, platformTeamId).first<CompetitionTeamRow>();
}
