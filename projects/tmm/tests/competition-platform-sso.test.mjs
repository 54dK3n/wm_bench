import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const validationServer = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "silent",
  root: projectRoot,
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

after(async () => validationServer.close());

const ssoModule = await validationServer.ssrLoadModule("/lib/competition/platform-sso.ts");
const authenticationModule = await validationServer.ssrLoadModule(
  "/lib/competition/platform-authentication.ts",
);
const teamModule = await validationServer.ssrLoadModule("/lib/competition/platform-team.ts");
const divisionNormalizationModule = await validationServer.ssrLoadModule(
  "/lib/competition/division-normalization.ts",
);
const adminOverviewSource = fs.readFileSync(
  new URL("../app/api/competition/admin/overview/route.ts", import.meta.url),
  "utf8",
);
const competitionPortalSource = fs.readFileSync(
  new URL("../app/competition/CompetitionPortal.tsx", import.meta.url),
  "utf8",
);
const competitionAdminSource = fs.readFileSync(
  new URL("../app/competition/admin/CompetitionAdmin.tsx", import.meta.url),
  "utf8",
);
const nextConfigSource = fs.readFileSync(
  new URL("../next.config.ts", import.meta.url),
  "utf8",
);

const secret = "workshop-platform-sso-test-secret-32-bytes-minimum";
const now = Date.parse("2026-08-28T00:00:00.000Z");

test("Vinext permits the controlled Cloudflare acceptance origin", () => {
  assert.match(nextConfigSource, /allowedDevOrigins\s*:\s*\[\s*["']\*\.trycloudflare\.com["']\s*\]/);
});

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function signPrincipal(user, overrides = {}) {
  const payload = {
    schemaVersion: "chenlong.platform-principal/v1",
    audience: "workshop",
    issuedAt: now,
    expiresAt: now + 30_000,
    user,
    ...overrides,
  };
  const encoded = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  const signedPart = `v1.${encoded}`;
  const signature = crypto.createHmac("sha256", secret).update(signedPart, "utf8").digest("base64url");
  return `${signedPart}.${signature}`;
}

function platformUser(overrides = {}) {
  return {
    id: "usr_11111111111111111111111111111111",
    username: "team.member",
    displayName: "队员一",
    role: "user",
    teamId: "tea_22222222222222222222222222222222",
    teamName: "星火实验队",
    group: "junior",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function adminUser() {
  return platformUser({
    id: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    username: "platform.admin",
    displayName: "平台管理员",
    role: "admin",
    teamId: null,
    teamName: null,
    group: null,
  });
}

test("workshop accepts a correctly signed platform principal", async () => {
  const principal = await ssoModule.verifyPlatformPrincipal(
    signPrincipal(platformUser()),
    secret,
    now + 1_000,
  );
  assert.equal(principal.audience, "workshop");
  assert.equal(principal.user.teamId, "tea_22222222222222222222222222222222");
  assert.equal(principal.user.group, "junior");
});

test("participant and administrator score views show exactly three group names", () => {
  for (const source of [competitionPortalSource, competitionAdminSource]) {
    assert.match(source, /name:\s*["']小学组["']/u);
    assert.match(source, /name:\s*["']初中组["']/u);
    assert.match(source, /name:\s*["']高中组["']/u);
    assert.doesNotMatch(source, /小学组（1-6年级）|小学组（1-3年级）|小学组（4-6年级）/u);
  }
});

test("workshop accepts the three canonical competition groups", async () => {
  const expectedDivisions = {
    primary: "primary",
    junior: "junior",
    high: "senior",
  };
  for (const [group, division] of Object.entries(expectedDivisions)) {
    const principal = await ssoModule.verifyPlatformPrincipal(
      signPrincipal(platformUser({ group })),
      secret,
      now + 1_000,
    );
    assert.equal(principal.user.group, group);
    assert.equal(ssoModule.divisionForPlatformGroup(principal.user.group), division);
  }
});

test("workshop normalizes both former primary groups into one primary identity", async () => {
  for (const group of [
    "primary_low",
    "primary_high",
    "primary_school",
    "小学组（1-3年级）",
    "小学组（4-6年级）",
  ]) {
    const principal = await ssoModule.verifyPlatformPrincipal(
      signPrincipal(platformUser({ group })),
      secret,
      now + 1_000,
    );
    assert.equal(principal.user.group, "primary");
    assert.equal(ssoModule.divisionForPlatformGroup(principal.user.group), "primary");
  }
});

test("workshop rejects a participant principal without a recognized group", async () => {
  for (const group of [null, "", "unknown_group"]) {
    await assert.rejects(
      ssoModule.verifyPlatformPrincipal(
        signPrincipal(platformUser({ group })),
        secret,
        now + 1_000,
      ),
      /participant team identity is invalid/u,
    );
  }
});

test("workshop rejects expired, wrong-audience, and forged principals", async () => {
  await assert.rejects(
    ssoModule.verifyPlatformPrincipal(signPrincipal(platformUser()), secret, now + 30_000),
    /invalid or expired/,
  );
  await assert.rejects(
    ssoModule.verifyPlatformPrincipal(
      signPrincipal(platformUser(), { audience: "blockly" }),
      secret,
      now + 1_000,
    ),
    /invalid or expired/,
  );
  const forged = `${signPrincipal(platformUser()).slice(0, -1)}A`;
  await assert.rejects(
    ssoModule.verifyPlatformPrincipal(forged, secret, now + 1_000),
    /signature is invalid/,
  );
});

test("platform participant principal becomes a team session without issuing a local cookie", async () => {
  const expectedTeam = {
    id: "legacy-team-id",
    teamName: "星火实验队",
    division: "junior",
    createdAt: 1,
    updatedAt: 2,
    latestSubmissionId: "submission-9",
  };
  let upsertedUser = null;
  let legacyCalled = false;
  const request = new Request("https://workshop.example.test/api/competition/me", {
    headers: { [ssoModule.PLATFORM_PRINCIPAL_HEADER]: signPrincipal(platformUser()) },
  });
  const session = await authenticationModule.resolvePlatformAwareTeamSession(request, {
    platformSsoSecret: secret,
    now: now + 1_000,
    upsertPlatformTeam: async (user) => {
      upsertedUser = user;
      return expectedTeam;
    },
    legacySession: async () => {
      legacyCalled = true;
      return null;
    },
  });
  assert.equal(legacyCalled, false);
  assert.equal(upsertedUser.teamId, platformUser().teamId);
  assert.equal(session.team, expectedTeam);
  assert.equal(session.platformUser.id, platformUser().id);
  assert.equal(session.expiresAt, now + 30_000);
});

test("platform admin principal becomes an admin session and a participant cannot", async () => {
  const adminRequest = new Request("https://workshop.example.test/api/competition/admin/session", {
    headers: { [ssoModule.PLATFORM_PRINCIPAL_HEADER]: signPrincipal(adminUser()) },
  });
  const adminSession = await authenticationModule.resolvePlatformAwareAdminSession(adminRequest, {
    platformSsoSecret: secret,
    now: now + 1_000,
    legacySession: async () => null,
  });
  assert.equal(adminSession.adminId, 1);
  assert.equal(adminSession.platformUser.role, "admin");

  const participantRequest = new Request(adminRequest.url, {
    headers: { [ssoModule.PLATFORM_PRINCIPAL_HEADER]: signPrincipal(platformUser()) },
  });
  assert.equal(await authenticationModule.resolvePlatformAwareAdminSession(participantRequest, {
    platformSsoSecret: secret,
    now: now + 1_000,
    legacySession: async () => ({ adminId: 1, expiresAt: now + 999_999 }),
  }), null);
});

test("a request without a platform header falls back to the existing local session", async () => {
  const legacy = {
    team: {
      id: "legacy-team-id",
      teamName: "旧队伍",
      division: "primary",
      createdAt: 1,
      updatedAt: 1,
      latestSubmissionId: null,
    },
    expiresAt: now + 99_000,
  };
  let upsertCalled = false;
  const resolved = await authenticationModule.resolvePlatformAwareTeamSession(
    new Request("https://workshop.example.test/api/competition/me"),
    {
      platformSsoSecret: secret,
      now,
      upsertPlatformTeam: async () => {
        upsertCalled = true;
        throw new Error("should not run");
      },
      legacySession: async () => legacy,
    },
  );
  assert.equal(resolved, legacy);
  assert.equal(upsertCalled, false);
});

test("an invalid platform header never falls back to a local cookie session", async () => {
  let legacyCalled = false;
  const request = new Request("https://workshop.example.test/api/competition/me", {
    headers: { [ssoModule.PLATFORM_PRINCIPAL_HEADER]: "v1.invalid.forged" },
  });
  await assert.rejects(
    authenticationModule.resolvePlatformAwareTeamSession(request, {
      platformSsoSecret: secret,
      now,
      upsertPlatformTeam: async () => { throw new Error("should not run"); },
      legacySession: async () => {
        legacyCalled = true;
        return null;
      },
    }),
    (error) => error?.status === 401 && error?.code === "invalid_platform_principal",
  );
  assert.equal(legacyCalled, false);
});

test("a platform header without a configured secret fails closed instead of using a local cookie", async () => {
  let legacyCalled = false;
  const request = new Request("https://workshop.example.test/api/competition/me", {
    headers: { [ssoModule.PLATFORM_PRINCIPAL_HEADER]: signPrincipal(platformUser()) },
  });
  await assert.rejects(
    authenticationModule.resolvePlatformAwareTeamSession(request, {
      platformSsoSecret: undefined,
      now,
      upsertPlatformTeam: async () => { throw new Error("should not run"); },
      legacySession: async () => {
        legacyCalled = true;
        return null;
      },
    }),
    (error) => error?.status === 503 && error?.code === "platform_sso_unavailable",
  );
  assert.equal(legacyCalled, false);
});

test("workshop admin standings expose the canonical platform team id for linked legacy rows", () => {
  assert.match(adminOverviewSource, /COALESCE\(l\.platform_team_id, t\.id\) AS team_id/u);
  assert.match(adminOverviewSource, /LEFT JOIN competition_platform_team_links AS l/u);
  assert.match(adminOverviewSource, /ON l\.workshop_team_id = t\.id/u);
});

test("D1 normalization merges former primary divisions without losing teams or evaluation data", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE competition_teams (
      id TEXT PRIMARY KEY NOT NULL,
      division TEXT NOT NULL
    );
    CREATE TABLE competition_evaluation_sets (
      division TEXT PRIMARY KEY NOT NULL,
      object_key TEXT NOT NULL,
      version TEXT NOT NULL,
      sample_count INTEGER NOT NULL,
      labels_json TEXT NOT NULL,
      embedding_size INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO competition_teams VALUES
      ('team-low', 'primary_low'),
      ('team-high-primary', 'primary_high'),
      ('team-junior', 'junior'),
      ('team-high-school', 'high');
    INSERT INTO competition_evaluation_sets VALUES
      ('primary_low', 'evaluation-low.json', '1', 10, '["橙子","非橙子"]', 4, 100),
      ('primary_high', 'evaluation-high.json', '2', 20, '["橙子","非橙子"]', 4, 200),
      ('high', 'evaluation-senior.json', '3', 30, '["橙子","非橙子"]', 4, 300);
  `);
  const d1 = {
    prepare(query) {
      return {
        bind() { throw new Error("normalization statements must not use dynamic bindings"); },
        async run() {
          database.prepare(query).run();
          return { success: true };
        },
      };
    },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };

  await divisionNormalizationModule.normalizeLegacyCompetitionDivisionsInDatabase(d1);
  await divisionNormalizationModule.normalizeLegacyCompetitionDivisionsInDatabase(d1);

  assert.deepEqual(
    database.prepare("SELECT id, division FROM competition_teams ORDER BY id").all().map((row) => ({ ...row })),
    [
      { id: "team-high-primary", division: "primary" },
      { id: "team-high-school", division: "senior" },
      { id: "team-junior", division: "junior" },
      { id: "team-low", division: "primary" },
    ],
  );
  assert.deepEqual(
    database.prepare("SELECT division, object_key FROM competition_evaluation_sets ORDER BY division").all()
      .map((row) => ({ ...row })),
    [
      { division: "primary", object_key: "evaluation-high.json" },
      { division: "senior", object_key: "evaluation-senior.json" },
    ],
  );
  database.close();
});

class FakeD1 {
  constructor(rows = []) {
    this.rows = rows.map((row) => ({ ...row }));
    this.links = [];
    this.runCount = 0;
  }

  prepare(query) {
    const normalized = query.replace(/\s+/gu, " ").trim();
    const rows = this.rows;
    const findLink = (platformTeamId) => this.links.find(
      (item) => item.platform_team_id === platformTeamId,
    );
    const addLink = (link) => this.links.push(link);
    const countRun = () => { this.runCount += 1; };
    return {
      values: [],
      bind(...values) {
        this.values = values;
        return this;
      },
      async run() {
        countRun();
        if (normalized.startsWith("INSERT INTO competition_teams")) {
          const [id, teamName, teamNameKey, division, passwordHash, createdAt, updatedAt] = this.values;
          if (!rows.some((row) => row.id === id || row.team_name_key === teamNameKey)) {
            rows.push({
              id,
              team_name: teamName,
              team_name_key: teamNameKey,
              division,
              password_hash: passwordHash,
              created_at: createdAt,
              updated_at: updatedAt,
              latest_submission_id: null,
            });
          }
        } else if (normalized.startsWith("INSERT INTO competition_platform_team_links")) {
          const [platformTeamId, workshopTeamId, linkedAt, updatedAt] = this.values;
          const existing = findLink(platformTeamId);
          if (existing) Object.assign(existing, { workshop_team_id: workshopTeamId, updated_at: updatedAt });
          else addLink({
            platform_team_id: platformTeamId,
            workshop_team_id: workshopTeamId,
            linked_at: linkedAt,
            updated_at: updatedAt,
          });
        } else if (normalized.startsWith("UPDATE competition_teams")) {
          const [teamName, teamNameKey, division, updatedAt, id] = this.values;
          const row = rows.find((item) => item.id === id);
          if (row) Object.assign(row, {
            team_name: teamName,
            team_name_key: teamNameKey,
            division,
            updated_at: updatedAt,
          });
        } else {
          throw new Error(`unexpected run query: ${normalized}`);
        }
        return { success: true };
      },
      async first() {
        if (normalized.includes("FROM competition_platform_team_links AS l")) {
          const link = findLink(this.values[0]);
          const row = link ? rows.find((item) => item.id === link.workshop_team_id) ?? null : null;
          return row ? { ...row, platform_team_id: link.platform_team_id } : null;
        }
        if (normalized.includes("WHERE id = ? OR team_name_key = ?")) {
          const [id, teamNameKey] = this.values;
          const row = rows.find((item) => item.id === id)
            ?? rows.find((item) => item.team_name_key === teamNameKey)
            ?? null;
          return row ? { ...row, platform_team_id: null } : null;
        }
        if (normalized.includes("WHERE id = ?")) {
          return rows.find((row) => row.id === this.values[0]) ?? null;
        }
        throw new Error(`unexpected first query: ${normalized}`);
      },
      async all() { return { success: true, results: [] }; },
    };
  }

  async batch() { return []; }
}

test("D1 platform team upsert is idempotent and preserves the latest submission", async () => {
  const database = new FakeD1();
  const created = await teamModule.upsertPlatformCompetitionTeamInDatabase(
    database,
    platformUser(),
    now,
  );
  assert.equal(created.id, platformUser().teamId);
  assert.equal(created.division, "junior");
  assert.equal(database.rows.length, 1);
  database.rows[0].latest_submission_id = "submission-existing";

  const updated = await teamModule.upsertPlatformCompetitionTeamInDatabase(
    database,
    platformUser({ teamName: "星火实验队（更新）", group: "high" }),
    now + 2_000,
  );
  assert.equal(database.rows.length, 1);
  assert.equal(updated.teamName, "星火实验队（更新）");
  assert.equal(updated.division, "senior");
  assert.equal(updated.latestSubmissionId, "submission-existing");

  const writesBeforeUnchangedRequest = database.runCount;
  const unchanged = await teamModule.upsertPlatformCompetitionTeamInDatabase(
    database,
    platformUser({ teamName: "星火实验队（更新）", group: "high" }),
    now + 4_000,
  );
  assert.equal(unchanged.latestSubmissionId, "submission-existing");
  assert.equal(database.runCount, writesBeforeUnchangedRequest, "unchanged SSO requests must not write D1");
});

test("D1 platform synchronization rewrites a former primary division in place", async () => {
  const user = platformUser({ group: "primary" });
  const database = new FakeD1([{
    id: user.teamId,
    team_name: user.teamName,
    team_name_key: "星火实验队",
    division: "primary_high",
    password_hash: "platform-sso$disabled",
    created_at: now - 10_000,
    updated_at: now - 10_000,
    latest_submission_id: "submission-primary-history",
  }]);

  const team = await teamModule.upsertPlatformCompetitionTeamInDatabase(database, user, now);
  assert.equal(team.division, "primary");
  assert.equal(team.latestSubmissionId, "submission-primary-history");
  assert.equal(database.rows[0].division, "primary");
  assert.equal(database.links[0].platform_team_id, user.teamId);
});

test("D1 reuses a same-name legacy team so its submission history is retained", async () => {
  const database = new FakeD1([{
    id: "legacy-team-with-history",
    team_name: "星火实验队",
    team_name_key: "星火实验队",
    division: "primary",
    password_hash: "legacy-password-hash",
    created_at: now - 999_000,
    updated_at: now - 999_000,
    latest_submission_id: "legacy-submission-7",
  }]);
  const team = await teamModule.upsertPlatformCompetitionTeamInDatabase(
    database,
    platformUser(),
    now,
  );
  assert.equal(database.rows.length, 1);
  assert.equal(team.id, "legacy-team-with-history");
  assert.equal(team.latestSubmissionId, "legacy-submission-7");
  assert.equal(team.division, "junior");
  assert.equal(database.rows[0].password_hash, "legacy-password-hash");

  const renamed = await teamModule.upsertPlatformCompetitionTeamInDatabase(
    database,
    platformUser({ teamName: "星火实验队新名称", group: "high" }),
    now + 5_000,
  );
  assert.equal(database.rows.length, 1);
  assert.equal(renamed.id, "legacy-team-with-history");
  assert.equal(renamed.teamName, "星火实验队新名称");
  assert.equal(renamed.latestSubmissionId, "legacy-submission-7");
  assert.equal(database.links[0].platform_team_id, platformUser().teamId);
  assert.equal(database.links[0].workshop_team_id, "legacy-team-with-history");
});

test("D1 platform synchronization accepts 500 different teams through its bounded writer", async () => {
  const database = new FakeD1();
  const teams = await Promise.all(Array.from({ length: 500 }, (_, index) => (
    teamModule.upsertPlatformCompetitionTeamInDatabase(
      database,
      platformUser({
        id: `usr_capacity_${String(index).padStart(4, "0")}`,
        username: `capacity.${index}`,
        displayName: `容量用户 ${index}`,
        teamId: `team-capacity-${String(index).padStart(4, "0")}`,
        teamName: `容量测试队 ${String(index).padStart(4, "0")}`,
      }),
      now + index,
    )
  )));
  assert.equal(teams.length, 500);
  assert.equal(new Set(teams.map(({ id }) => id)).size, 500);
  assert.equal(database.rows.length, 500);
  assert.equal(database.links.length, 500);
});
