"use strict";

(() => {
  const teamScoreRules = globalThis.ChenlongAdminTeamScores;
  if (!teamScoreRules) throw new Error("队伍最高分汇总规则没有加载");
  const RECORDS_ENDPOINT = "/api/v1/admin/records";
  const USERS_ENDPOINT = "/api/v1/admin/users";
  const MAP_CONFIG_ENDPOINT = "/api/v1/admin/map-config";
  const MAP_POOLS_ENDPOINT = "/api/v1/admin/map-pools";
  const MAP_CHALLENGES = Object.freeze([
    Object.freeze({ taskId: "R2-GYI-MVP-01", label: "广阳岛综合任务1", variantCount: 8 }),
    Object.freeze({ taskId: "R2-GYI-MVP-02", label: "广阳岛综合任务2", variantCount: 10 }),
    Object.freeze({ taskId: "R2-GYI-MVP-03", label: "广阳岛综合任务3", variantCount: 12 })
  ]);
  const RANKING_ENDPOINT = "/api/v1/admin/competitions/2026-r2-gyi-local-screening.1/ranked-evaluation/ranking";
  const RANKING_SCHEMA_VERSION = "chenlong.ranked-ranking/v1";
  const RANKED_COMPETITION_ID = "2026-r2-gyi-local-screening.1";
  const RECORDS_SCHEMA_VERSION = "chenlong.records/v1";
  const ADMIN_USERS_SCHEMA_VERSION = "chenlong.admin-users/v1";
  const ADMIN_USER_UPDATE_SCHEMA_VERSION = "chenlong.admin-user-update/v1";
  const MAP_CONFIG_SCHEMA_VERSION = "chenlong.guangyang-map-config/v1";
  const MAP_LAYOUT_SCHEMA_VERSION = "chenlong.guangyang-map-layout/v2";
  const MAP_UPDATE_SCHEMA_VERSION = "chenlong.guangyang-map-config-update/v1";
  const MAP_POOLS_SCHEMA_VERSION = "chenlong.guangyang-map-pools-admin/v1";
  const GUANGYANG_MAP_ID = "guangyang-island";
  const GUANGYANG_BASE_MAP_VERSION = "2026.08-source-png-3d.3";
  const RECORD_DETAIL_SCHEMA_VERSION = "chenlong.record-detail/v1";
  const VERIFICATION_REPORT_SCHEMA_VERSION = "chenlong.verification-report/v1";
  const SCORE_MAXIMUM = 100;
  const MAX_RECORDS = 10000;
  const RECORD_PAGE_SIZE = 500;
  const RECORDS_PER_PAGE = 20;
  const USERS_PER_PAGE = 20;
  const MAX_USERS = 10000;
  const MAX_RECORD_BYTES = 40 * 1024 * 1024;
  const MAX_SOURCE_CODE_CHARACTERS = 128 * 1024;
  const MAX_VERIFICATION_REPORT_CHARACTERS = 1024 * 1024;
  const SUBMISSION_ID_PATTERN = /^sub_[a-f0-9]{32}$/;
  const SESSION_ID_PATTERN = /^ses_[a-f0-9]{32}$/;
  const RUN_ID_PATTERN = /^run_[a-f0-9]{32}$/;
  const USER_ID_PATTERN = /^usr_[a-f0-9]{32}$/;
  const INTERNAL_TEAM_ID_PATTERN = /^tea_[a-f0-9]{32}$/;
  const SHA256_PATTERN = /^[a-f0-9]{64}$/;
  const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
  const TEAM_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
  const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
  const GROUP_LABELS = Object.freeze({
    primary: "小学组",
    junior: "初中组",
    high: "高中组"
  });
  const MAP_LIMITS = Object.freeze({ x: Object.freeze([-20, 20]), z: Object.freeze([-12, 12]) });
  const MAP_WORLD_UNITS_PER_METER = 8;
  const MAP_CM_PER_WORLD_UNIT = 100 / MAP_WORLD_UNITS_PER_METER;
  const MAP_CM_LIMITS = Object.freeze({
    x: Object.freeze(MAP_LIMITS.x.map(value => value * MAP_CM_PER_WORLD_UNIT)),
    z: Object.freeze(MAP_LIMITS.z.map(value => value * MAP_CM_PER_WORLD_UNIT))
  });
  const MAP_IMAGE = Object.freeze({
    naturalWidth: 1387, naturalHeight: 860,
    cropX: 26, cropY: 24, cropWidth: 1295, cropHeight: 777,
    worldWidth: 40, worldDepth: 24
  });
  const MAP_CHALLENGE_LAYOUT_SIZES = Object.freeze({
    "R2-GYI-MVP-01": Object.freeze({ checkpoints: 4, targets: 1, distractors: 1, obstacles: 1 }),
    "R2-GYI-MVP-02": Object.freeze({ checkpoints: 6, targets: 2, distractors: 2, obstacles: 2 }),
    "R2-GYI-MVP-03": Object.freeze({ checkpoints: 8, targets: 3, distractors: 3, obstacles: 3 })
  });
  const DEFAULT_MAP_LAYOUT = Object.freeze({
    schemaVersion: MAP_LAYOUT_SCHEMA_VERSION,
    checkpoints: Object.freeze([
      Object.freeze([-2.4865, -2.4556]), Object.freeze([7.1815, -3.2587]),
      Object.freeze([6.471, 0.4479]), Object.freeze([4.4324, 6.8726])
    ]),
    targets: Object.freeze([Object.freeze([-9.8687, -6.7181])]),
    storage: Object.freeze([-10.7336, -8.0772]),
    distractors: Object.freeze([Object.freeze([-8.0772, 5.4826])]),
    obstacles: Object.freeze([Object.freeze([-10.9498, 2.0849])])
  });
  const RECORD_SUMMARY_KEYS = Object.freeze([
    "id", "submissionId", "sessionId", "runId", "ownerUserId", "teamId", "taskId",
    "taskName", "score", "scoreMaximum", "status", "verification", "recordState", "savedAt", "submittedAt",
    "receivedAt", "challengeDigest", "recordSha256", "recordByteLength", "authoritative", "user", "capabilityUsage",
    "autonomyMode", "aiAutonomyVerified"
  ]);
  const PUBLIC_USER_KEYS = Object.freeze([
    "id", "username", "displayName", "teamName", "group", "role", "createdAt"
  ]);
  const ADMIN_LIST_USER_KEYS = Object.freeze([
    ...PUBLIC_USER_KEYS, "officialUserId", "officialTeamId"
  ]);
  const OFFICIAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const VERIFICATION_SUMMARY_KEYS = Object.freeze([
    "status", "reasonCodes", "visionStatus", "verificationScope"
  ]);
  const state = {
    records: [], usernameQuery: "", teamQuery: "", taskId: "all", group: "all", status: "all", autonomyMode: "all",
    scoreSort: "score-desc", teamRecordMode: "all", recordPage: 1, teamChallengeBestPage: 1,
    loading: false, loaded: false, recordsLoadError: null,
    users: [], usersLoaded: false, userLoading: false, usersLoadError: null, userUsernameQuery: "", userTeamQuery: "",
    userGroup: "all", userRole: "all", userPage: 1, userDrafts: new Map(), userSaving: new Set(),
    mapTaskId: MAP_CHALLENGES[0].taskId, mapVariantId: "map-01",
    mapPools: [], mapAssignments: [], mapPoolsLoading: false,
    mapEnvelope: null, mapDraft: null, mapLoaded: false, mapLoading: false, mapSaving: false,
    mapOperationId: 0, mapEditorExpanded: false, mapSelectedKey: "checkpoints-0", mapDraggingKey: null,
    mapEditorSignature: "",
    mapInvalidInputs: new Set(), mapMarkerElements: new Map(), mapInputElements: new Map(),
    rankingEntries: [], rankingLoading: false,
    rankingQuery: "", completionFilter: "all", validityFilter: "all", safetyFilter: "all"
  };
  const tableBody = document.querySelector("#adminRecordsTableBody");
  const tableWrap = document.querySelector("#adminRecordTableWrap");
  const loadingState = document.querySelector("#adminRecordsLoading");
  const emptyState = document.querySelector("#adminRecordsEmpty");
  const errorState = document.querySelector("#adminRecordsError");
  const errorMessageElement = document.querySelector("#adminRecordsErrorMessage");
  const recordsPagination = optionalQuerySelector("#adminRecordsPagination");
  const recordsRange = optionalQuerySelector("#adminRecordsRange");
  const recordsPageStatus = optionalQuerySelector("#adminRecordsPageStatus");
  const recordsPrevPage = optionalQuerySelector("#adminRecordsPrevPage");
  const recordsNextPage = optionalQuerySelector("#adminRecordsNextPage");
  const teamChallengeBestLoading = optionalQuerySelector("#adminTeamChallengeBestLoading");
  const teamChallengeBestError = optionalQuerySelector("#adminTeamChallengeBestError");
  const teamChallengeBestErrorMessage = optionalQuerySelector("#adminTeamChallengeBestErrorMessage");
  const teamChallengeBestTableWrap = optionalQuerySelector("#adminTeamChallengeBestTableWrap");
  const teamChallengeBestBody = optionalQuerySelector("#adminTeamChallengeBestBody");
  const teamChallengeBestPagination = optionalQuerySelector("#adminTeamChallengeBestPagination");
  const teamChallengeBestRange = optionalQuerySelector("#adminTeamChallengeBestRange");
  const teamChallengeBestPageStatus = optionalQuerySelector("#adminTeamChallengeBestPageStatus");
  const teamChallengeBestPrevPage = optionalQuerySelector("#adminTeamChallengeBestPrevPage");
  const teamChallengeBestNextPage = optionalQuerySelector("#adminTeamChallengeBestNextPage");
  const exportTeamChallengeBestButton = optionalQuerySelector("#exportTeamChallengeBestButton");
  const exportRecordsButton = document.querySelector("#exportAdminRecordsButton");
  const notice = document.querySelector("#adminNotice");
  const usernameFilter = document.querySelector("#adminUsernameFilter");
  const teamFilter = document.querySelector("#adminTeamFilter");
  const taskFilter = document.querySelector("#adminTaskFilter");
  const groupFilter = document.querySelector("#adminGroupFilter");
  const statusFilter = document.querySelector("#adminStatusFilter");
  const autonomyModeFilter = document.querySelector("#adminAutonomyModeFilter");
  const scoreSort = document.querySelector("#adminScoreSort");
  const teamRecordMode = document.querySelector("#adminTeamRecordMode");
  const dialog = document.querySelector("#adminRecordDetailDialog");
  const detailContent = document.querySelector("#adminRecordDetailContent");
  const rankingLoadingState = document.querySelector("#adminRankingLoading");
  const rankingPendingState = document.querySelector("#adminRankingPending");
  const rankingEmptyState = document.querySelector("#adminRankingEmpty");
  const rankingErrorState = document.querySelector("#adminRankingError");
  const rankingErrorMessage = document.querySelector("#adminRankingErrorMessage");
  const rankingTableWrap = document.querySelector("#adminRankingTableWrap");
  const rankingTableBody = document.querySelector("#adminRankingTableBody");
  const refreshRankingButton = document.querySelector("#refreshAdminRankingButton");
  const rankingSearch = document.querySelector("#adminRankingSearch");
  const rankingCompletionFilter = document.querySelector("#adminRankingCompletionFilter");
  const rankingValidityFilter = document.querySelector("#adminRankingValidityFilter");
  const rankingSafetyFilter = document.querySelector("#adminRankingSafetyFilter");
  const usersTableBody = document.querySelector("#adminUsersTableBody");
  const usersTableWrap = document.querySelector("#adminUsersTableWrap");
  const usersLoadingState = document.querySelector("#adminUsersLoading");
  const usersEmptyState = document.querySelector("#adminUsersEmpty");
  const usersErrorState = document.querySelector("#adminUsersError");
  const usersErrorMessage = document.querySelector("#adminUsersErrorMessage");
  const usersNotice = document.querySelector("#adminUsersNotice");
  const userUsernameFilter = document.querySelector("#adminUserUsernameFilter");
  const userTeamFilter = document.querySelector("#adminUserTeamFilter");
  const userGroupFilter = document.querySelector("#adminUserGroupFilter");
  const userRoleFilter = document.querySelector("#adminUserRoleFilter");
  const refreshUsersButton = document.querySelector("#refreshAdminUsersButton");
  const exportUsersButton = document.querySelector("#exportAdminUsersButton");
  const usersPagination = optionalQuerySelector("#adminUsersPagination");
  const usersRange = optionalQuerySelector("#adminUsersRange");
  const usersPageStatus = optionalQuerySelector("#adminUsersPageStatus");
  const usersPrevPage = optionalQuerySelector("#adminUsersPrevPage");
  const usersNextPage = optionalQuerySelector("#adminUsersNextPage");
  const mapVersion = document.querySelector("#adminMapVersion");
  const mapChallengeSelect = optionalQuerySelector("#adminMapChallengeSelect");
  const mapVariantSelect = optionalQuerySelector("#adminMapVariantSelect");
  const mapAssignmentTableBody = optionalQuerySelector("#adminMapAssignmentTableBody");
  const mapAssignmentEmpty = optionalQuerySelector("#adminMapAssignmentEmpty");
  const mapAssignmentWrap = optionalQuerySelector("#adminMapAssignmentWrap");
  const mapRevision = document.querySelector("#adminMapRevision");
  const mapUpdatedAt = document.querySelector("#adminMapUpdatedAt");
  const mapNotice = document.querySelector("#adminMapNotice");
  const mapEditorBody = document.querySelector("#adminMapEditorBody");
  const mapLoadingState = document.querySelector("#adminMapLoading");
  const mapErrorState = document.querySelector("#adminMapError");
  const mapErrorMessage = document.querySelector("#adminMapErrorMessage");
  const mapWorkspace = document.querySelector("#adminMapWorkspace");
  const mapStage = document.querySelector("#adminMapStage");
  const mapMarkers = document.querySelector("#adminMapMarkers");
  const mapPointList = document.querySelector("#adminMapPointList");
  const mapActions = document.querySelector("#adminMapActions");
  const mapDraftStatus = document.querySelector("#adminMapDraftStatus");
  const refreshMapButton = document.querySelector("#refreshAdminMapButton");
  const toggleMapEditorButton = document.querySelector("#toggleAdminMapEditorButton");
  const restoreMapButton = document.querySelector("#restoreAdminMapButton");
  const saveMapButton = document.querySelector("#saveAdminMapButton");
  const adminSectionTabs = typeof document.querySelectorAll === "function"
    ? [...document.querySelectorAll("[data-admin-section]")]
    : [];
  const adminSectionPanels = Object.freeze({
    records: optionalQuerySelector("#adminRecordsSection"),
    users: optionalQuerySelector("#adminUsersSection"),
    maps: optionalQuerySelector("#adminMapsSection")
  });

  function selectAdminSection(section) {
    const selected = Object.hasOwn(adminSectionPanels, section) ? section : "records";
    for (const tab of adminSectionTabs) {
      const active = tab.dataset.adminSection === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const [name, panel] of Object.entries(adminSectionPanels)) {
      if (panel) panel.hidden = name !== selected;
    }
  }

  function mapConfigEndpoint(taskId = state.mapTaskId, variant = state.mapVariantId) {
    return `${MAP_CONFIG_ENDPOINT}/${encodeURIComponent(taskId)}/${encodeURIComponent(variant)}`;
  }

  function selectedMapChallenge() {
    return MAP_CHALLENGES.find(item => item.taskId === state.mapTaskId) || MAP_CHALLENGES[0];
  }

  function mapVariantLabel(value = state.mapVariantId) {
    const number = Number(String(value).slice(4));
    return Number.isSafeInteger(number) && number > 0 ? `地图 ${number}` : "地图";
  }

  function populateMapVariantSelect() {
    if (!mapVariantSelect) return;
    const challenge = selectedMapChallenge();
    mapVariantSelect.replaceChildren();
    for (let number = 1; number <= challenge.variantCount; number += 1) {
      const option = document.createElement("option");
      option.value = `map-${String(number).padStart(2, "0")}`;
      option.textContent = `地图 ${number}`;
      mapVariantSelect.append(option);
    }
    if (![...mapVariantSelect.children].some(option => option.value === state.mapVariantId)) {
      state.mapVariantId = "map-01";
    }
    mapVariantSelect.value = state.mapVariantId;
  }

  function optionalQuerySelector(selector) {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function text(value, fallback = "—") {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return fallback;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function hasExactKeys(value, expectedKeys) {
    if (!isPlainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  }

  function compatibleDataError(message = "管理记录服务返回的数据格式不兼容。") {
    const error = new Error(message);
    error.code = "INCOMPATIBLE_ADMIN_RECORD_DATA";
    return error;
  }

  function validVisibleText(value, maximum, { nullable = false } = {}) {
    if (nullable && value === null) return true;
    if (typeof value !== "string" || value !== value.trim() || value !== value.normalize("NFC")) return false;
    const length = [...value].length;
    return length >= 1 && length <= maximum && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
  }

  function normalizeSearchText(value) {
    return String(value || "").trim().normalize("NFC").toLocaleLowerCase("zh-CN");
  }

  const rankingOrder = [
    ["batchScore", "desc"], ["completedCount", "desc"], ["validCount", "desc"],
    ["minScore", "desc"], ["meanScore", "desc"], ["invalidCount", "asc"],
    ["missingCount", "asc"], ["timeoutCount", "asc"], ["collisionCount", "asc"],
    ["outOfBoundsCount", "asc"]
  ];
  const rankingFields = rankingOrder.map(([field]) => field);
  const qualityFields = [
    "slotCount", "finalizedCount", "completedCount", "validCount", "invalidCount",
    "timeoutCount", "missingCount", "collisionCount", "outOfBoundsCount"
  ];

  function validRankingScore(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
  }

  function validRankingCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function validIsoTimestamp(value) {
    if (typeof value !== "string") return false;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  }

  function validRankingTuple(value) {
    return hasExactKeys(value, rankingFields) && rankingFields.every(field => (
      ["batchScore", "minScore", "meanScore"].includes(field)
        ? validRankingScore(value[field])
        : validRankingCount(value[field])
    ));
  }

  function normalizeAdminRankingEntry(value) {
    if (!hasExactKeys(value, [
      "rank", "anonymousParticipantId", "score", "quality", "ranking",
      "participant", "teamId", "createdAt", "finalizationReason"
    ])
      || !Number.isSafeInteger(value.rank) || value.rank < 1
      || !/^participant_[a-f0-9]{32}$/.test(value.anonymousParticipantId || "")
      || !hasExactKeys(value.participant, ["id", "username", "displayName", "teamName"])
      || !/^usr_[a-f0-9]{32}$/.test(value.participant.id || "")
      || typeof value.participant.username !== "string" || !value.participant.username
      || typeof value.participant.displayName !== "string" || !value.participant.displayName
      || (value.participant.teamName !== null
        && (typeof value.participant.teamName !== "string" || !value.participant.teamName.trim()))
      || !/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(value.teamId || "")
      || !validIsoTimestamp(value.createdAt)
      || !["all_slots_reported", "closed_with_missing"].includes(value.finalizationReason)
      || !hasExactKeys(value.score, ["value", "mean", "minimum", "maximum"])
      || ![value.score.value, value.score.mean, value.score.minimum].every(validRankingScore)
      || value.score.maximum !== 100
      || !hasExactKeys(value.quality, qualityFields)
      || !qualityFields.every(field => validRankingCount(value.quality[field]))
      || value.quality.slotCount !== 5 || value.quality.finalizedCount !== 5
      || value.quality.validCount + value.quality.invalidCount
        + value.quality.timeoutCount + value.quality.missingCount !== 5
      || value.quality.completedCount > 5
      || !validRankingTuple(value.ranking)) {
      throw new Error("筛选排名条目不兼容");
    }
    return {
      rank: value.rank,
      participant: {
        id: value.participant.id,
        username: value.participant.username,
        displayName: value.participant.displayName,
        teamName: value.participant.teamName
      },
      teamId: value.teamId,
      createdAt: value.createdAt,
      finalizationReason: value.finalizationReason,
      score: { ...value.score },
      quality: { ...value.quality }
    };
  }

  function normalizeAdminRankingResponse(payload, expectedOffset) {
    if (!hasExactKeys(payload, [
      "schemaVersion", "authoritative", "competition", "scope", "order", "tiePolicy",
      "stableTieBreak", "pagination", "entries"
    ])
      || payload.schemaVersion !== RANKING_SCHEMA_VERSION
      || payload.authoritative !== false
      || !hasExactKeys(payload.competition, ["competitionId", "displayName", "purpose", "scoreMaximum"])
      || payload.competition.competitionId !== RANKED_COMPETITION_ID
      || payload.competition.displayName !== "筛选五局（本地参考）"
      || payload.competition.purpose !== "ranked"
      || payload.competition.scoreMaximum !== 100
      || payload.scope !== "admin"
      || payload.tiePolicy !== "competition-ranking-on-public-order-fields"
      || payload.stableTieBreak !== "server-private-stable-key"
      || !Array.isArray(payload.order) || payload.order.length !== rankingOrder.length
      || !payload.order.every((item, index) => hasExactKeys(item, ["field", "direction"])
        && item.field === rankingOrder[index][0] && item.direction === rankingOrder[index][1])
      || !hasExactKeys(payload.pagination, ["offset", "limit", "returned", "total"])
      || payload.pagination.offset !== expectedOffset
      || !Number.isSafeInteger(payload.pagination.limit) || payload.pagination.limit < 1
      || payload.pagination.limit > 100
      || !Number.isSafeInteger(payload.pagination.returned) || payload.pagination.returned < 0
      || !Number.isSafeInteger(payload.pagination.total) || payload.pagination.total < 0
      || !Array.isArray(payload.entries)
      || payload.pagination.returned !== payload.entries.length
      || payload.entries.length > payload.pagination.limit) {
      throw new Error("筛选排名响应不兼容");
    }
    const entries = payload.entries.map(normalizeAdminRankingEntry);
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index].rank < entries[index - 1].rank) {
        throw new Error("筛选排名顺序不兼容");
      }
    }
    return { entries, pagination: { ...payload.pagination } };
  }

  function normalizeStatus(value) {
    const status = String(value || "unknown").trim().toLowerCase();
    return ["verified", "partial", "invalid", "error", "completed", "pending", "failed"].includes(status) ? status : "unknown";
  }

  function statusLabel(value, deterministicStatus = "unknown") {
    const status = normalizeStatus(value);
    return ({
      verified: "确定性校验通过",
      partial: deterministicStatus === "incomplete" ? "确定性校验不完整" : "旧版校验不完整",
      invalid: "校验失败",
      error: "校验出错",
      completed: "已完成",
      pending: "处理中",
      failed: "处理失败",
      unknown: "状态未知"
    })[status];
  }

  function normalizeVerification(value, fallbackStatus = "unknown") {
    const verification = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const deterministicCandidate = verification.verificationScope?.deterministic?.status;
    const deterministicStatus = ["complete", "incomplete"].includes(deterministicCandidate)
      ? deterministicCandidate
      : "unknown";
    const visionCandidate = verification.visionStatus ?? verification.verificationScope?.vision;
    const visionStatus = ["not_used", "not_recomputed", "matched"].includes(visionCandidate)
      ? visionCandidate
      : "unknown";
    const reasonCodes = [];
    const seen = new Set();
    if (Array.isArray(verification.reasonCodes)) {
      for (const code of verification.reasonCodes) {
        if (reasonCodes.length >= 12) break;
        if (typeof code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(code) || seen.has(code)) continue;
        seen.add(code);
        reasonCodes.push(code);
      }
    }
    return {
      status: normalizeStatus(verification.status ?? fallbackStatus),
      deterministicStatus,
      visionStatus,
      reasonCodes
    };
  }

  function deterministicScopeLabel(status) {
    return ({
      complete: "完整：控制、物理、交互、任务、规则与计分均已重算",
      incomplete: "不完整：确定性重算未覆盖全部范围",
      unknown: "旧版报告未声明确定性校验范围"
    })[status] || "旧版报告未声明确定性校验范围";
  }

  function visionScopeLabel(status) {
    return ({
      not_used: "未使用视觉识别，无需重算",
      not_recomputed: "视觉识别结果未重算",
      matched: "视觉识别结果已重算并匹配",
      unknown: "旧版报告未声明视觉校验范围"
    })[status] || "旧版报告未声明视觉校验范围";
  }

  function reasonCodesLabel(reasonCodes) {
    const labels = {
      legacy_telemetry_only: "旧版遥测记录",
      legacy_vehicle_replay_only: "旧版车辆回放记录",
      unsupported_record_schema: "记录版本不受支持",
      verification_failed: "记录与重算结果不一致",
      legacy_telemetry_invalid: "旧版遥测记录无效",
      recomputation_incomplete: "确定性重算未完成",
      vision_detections_not_recomputed: "视觉识别结果未重算",
      score_not_recomputed: "成绩未重算",
      external_termination_not_recomputed: "外部结束条件未重算",
      recorded_result_missing: "原始成绩缺失",
      recorded_result_incomplete: "原始成绩字段不完整",
      invalid_record: "运行记录无效"
    };
    return reasonCodes.length ? reasonCodes.map(code => labels[code] || code).join("；") : "无额外说明";
  }

  function verificationStatusNode(record) {
    const wrapper = document.createElement("div");
    wrapper.className = "verification-status-stack";
    const badge = document.createElement("span");
    badge.className = "status-badge";
    badge.dataset.status = record.status;
    badge.textContent = statusLabel(record.status, record.deterministicStatus);
    wrapper.append(badge);
    if (record.status === "verified" && record.visionStatus === "not_recomputed") {
      const hint = document.createElement("small");
      hint.className = "verification-scope-hint";
      hint.textContent = "视觉未重算";
      wrapper.append(hint);
    }
    return wrapper;
  }

  function capabilityUsageNode(usage) {
    const wrapper = document.createElement("div");
    wrapper.className = "capability-badges";
    const capabilities = [
      ["navigationSensors", "导航传感"],
      ["roadControls", "道路控制"],
      ["vision", "视觉感知"]
    ];
    for (const [key, label] of capabilities) {
      if (!usage[key]) continue;
      const badge = document.createElement("span");
      badge.className = "capability-badge";
      badge.dataset.capability = key;
      badge.textContent = label;
      wrapper.append(badge);
    }
    if (!wrapper.children.length) {
      const none = document.createElement("span");
      none.className = "capability-none";
      none.textContent = "—";
      wrapper.append(none);
    }
    return wrapper;
  }

  function capabilityUsageLabel(usage) {
    const labels = [];
    if (usage.navigationSensors) labels.push("导航传感");
    if (usage.roadControls) labels.push("道路控制");
    if (usage.vision) labels.push("视觉感知");
    return labels.length ? labels.join("、") : "未使用";
  }

  function validateReasonCodes(value, maximum = 12) {
    if (!Array.isArray(value) || value.length > maximum) return false;
    const seen = new Set();
    for (const code of value) {
      if (typeof code !== "string" || !REASON_CODE_PATTERN.test(code) || seen.has(code)) return false;
      seen.add(code);
    }
    return true;
  }

  function validatePublicUser(value, expectedOwnerUserId) {
    if (value === null) {
      if (expectedOwnerUserId !== null) {
        throw compatibleDataError("正式提交记录缺少对应的账户信息。");
      }
      return null;
    }
    const isAdministrator = value?.role === "admin";
    if (!hasExactKeys(value, PUBLIC_USER_KEYS)
      || !USER_ID_PATTERN.test(value.id || "")
      || value.id !== expectedOwnerUserId
      || !USERNAME_PATTERN.test(value.username || "")
      || !validVisibleText(value.displayName, 64)
      || !validVisibleText(value.teamName, 64, { nullable: true })
      || !["user", "admin"].includes(value.role)
      || (isAdministrator
        ? (value.teamName !== null || value.group !== null)
        : !Object.hasOwn(GROUP_LABELS, value.group))
      || !validIsoTimestamp(value.createdAt)) {
      throw compatibleDataError("正式提交记录中的账户信息格式不兼容。");
    }
    return value;
  }

  function normalizeAdminUser(value) {
    const user = validatePublicUser(value, value?.id);
    if (user === null) throw compatibleDataError("用户管理条目的格式不兼容。");
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      teamName: user.teamName,
      group: user.group,
      role: user.role,
      createdAt: user.createdAt
    };
  }

  function normalizeAdminListUser(value) {
    if (!hasExactKeys(value, ADMIN_LIST_USER_KEYS)) {
      throw compatibleDataError("用户管理条目的格式不兼容。");
    }
    const officialUserId = value.officialUserId;
    const officialTeamId = value.officialTeamId;
    const hasOfficialUserId = officialUserId !== null;
    const hasOfficialTeamId = officialTeamId !== null;
    if (hasOfficialUserId !== hasOfficialTeamId
      || (hasOfficialUserId && (typeof officialUserId !== "string"
        || typeof officialTeamId !== "string"
        || !OFFICIAL_ID_PATTERN.test(officialUserId)
        || !OFFICIAL_ID_PATTERN.test(officialTeamId)))
      || (value.role === "admin" && hasOfficialUserId)) {
      throw compatibleDataError("用户管理条目中的官网身份信息格式不兼容。");
    }
    return normalizeAdminUser({
      id: value.id,
      username: value.username,
      displayName: value.displayName,
      teamName: value.teamName,
      group: value.group,
      role: value.role,
      createdAt: value.createdAt
    });
  }

  function validateAdminUsersResponse(payload) {
    if (!hasExactKeys(payload, ["schemaVersion", "users", "authoritative"])
      || payload.schemaVersion !== ADMIN_USERS_SCHEMA_VERSION
      || payload.authoritative !== false
      || !Array.isArray(payload.users)
      || payload.users.length > MAX_USERS) {
      throw compatibleDataError("用户列表响应格式不兼容。");
    }
    const seenIds = new Set();
    const seenUsernames = new Set();
    return payload.users.map(value => {
      const user = normalizeAdminListUser(value);
      const normalizedUsername = normalizeSearchText(user.username);
      if (seenIds.has(user.id) || seenUsernames.has(normalizedUsername)) {
        throw compatibleDataError("用户列表包含重复账号。");
      }
      seenIds.add(user.id);
      seenUsernames.add(normalizedUsername);
      return user;
    });
  }

  function validateAdminUserUpdateResponse(payload, expectedUser, expectedTeamName, expectedGroup) {
    if (!hasExactKeys(payload, ["schemaVersion", "user", "changed", "authoritative"])
      || payload.schemaVersion !== ADMIN_USER_UPDATE_SCHEMA_VERSION
      || typeof payload.changed !== "boolean"
      || payload.authoritative !== false) {
      throw compatibleDataError("用户修改回执格式不兼容。");
    }
    const user = normalizeAdminUser(payload.user);
    if (user.id !== expectedUser.id
      || user.username !== expectedUser.username
      || user.displayName !== expectedUser.displayName
      || user.role !== expectedUser.role
      || user.createdAt !== expectedUser.createdAt
      || user.teamName !== expectedTeamName
      || user.group !== expectedGroup) {
      throw compatibleDataError("用户修改回执与本次操作不一致，页面未采纳该结果。");
    }
    return { user, changed: payload.changed };
  }

  function normalizeMapPoint(value, label) {
    if (!Array.isArray(value) || value.length !== 2
      || !value.every(coordinate => typeof coordinate === "number" && Number.isFinite(coordinate))
      || value[0] < MAP_LIMITS.x[0] || value[0] > MAP_LIMITS.x[1]
      || value[1] < MAP_LIMITS.z[0] || value[1] > MAP_LIMITS.z[1]) {
      throw compatibleDataError(`${label}坐标格式不兼容。`);
    }
    return [value[0], value[1]];
  }

  function normalizeMapLayout(value) {
    const sizes = MAP_CHALLENGE_LAYOUT_SIZES[state.mapTaskId];
    if (!sizes
      || !hasExactKeys(value, ["schemaVersion", "checkpoints", "targets", "storage", "distractors", "obstacles"])
      || value.schemaVersion !== MAP_LAYOUT_SCHEMA_VERSION
      || !Array.isArray(value.checkpoints)
      || value.checkpoints.length !== sizes.checkpoints
      || !Array.isArray(value.targets) || value.targets.length !== sizes.targets
      || !Array.isArray(value.distractors) || value.distractors.length !== sizes.distractors
      || !Array.isArray(value.obstacles) || value.obstacles.length !== sizes.obstacles) {
      throw compatibleDataError("地图布局格式不兼容。原有地图未被页面替换。");
    }
    return {
      schemaVersion: MAP_LAYOUT_SCHEMA_VERSION,
      checkpoints: value.checkpoints.map((point, index) => normalizeMapPoint(point, `途径点 ${index + 1}`)),
      targets: value.targets.map((point, index) => normalizeMapPoint(point, `目标物 ${index + 1}`)),
      storage: normalizeMapPoint(value.storage, "目标点"),
      distractors: value.distractors.map((point, index) => normalizeMapPoint(point, `混淆物 ${index + 1}`)),
      obstacles: value.obstacles.map((point, index) => normalizeMapPoint(point, `障碍物 ${index + 1}`))
    };
  }

  function validateMapConfigResponse(payload) {
    if (!hasExactKeys(payload, [
      "schemaVersion", "authoritative", "mapId", "baseMapVersion", "mapVersion",
      "revision", "updatedAt", "digest", "layout"
    ])
      || payload.schemaVersion !== MAP_CONFIG_SCHEMA_VERSION
      || payload.authoritative !== false
      || payload.mapId !== GUANGYANG_MAP_ID
      || payload.baseMapVersion !== GUANGYANG_BASE_MAP_VERSION
      || !Number.isSafeInteger(payload.revision)
      || payload.revision < 0
      || !SHA256_PATTERN.test(payload.digest || "")
      || (payload.revision === 0 ? payload.updatedAt !== null : !validIsoTimestamp(payload.updatedAt))) {
      throw compatibleDataError("地图配置响应格式不兼容。原有地图未被页面替换。");
    }
    const expectedVersion = payload.revision === 0
      ? payload.baseMapVersion
      : `${payload.baseMapVersion}@map-r${payload.revision}-${payload.digest.slice(0, 12)}`;
    if (payload.mapVersion !== expectedVersion) {
      throw compatibleDataError("地图版本回执不兼容。原有地图未被页面替换。");
    }
    return {
      schemaVersion: MAP_CONFIG_SCHEMA_VERSION,
      authoritative: false,
      mapId: payload.mapId,
      baseMapVersion: payload.baseMapVersion,
      mapVersion: payload.mapVersion,
      revision: payload.revision,
      updatedAt: payload.updatedAt,
      digest: payload.digest,
      layout: normalizeMapLayout(payload.layout)
    };
  }

  function validateAdminMapPoolsResponse(payload) {
    if (!hasExactKeys(payload, ["schemaVersion", "pools", "assignments", "authoritative"])
      || payload.schemaVersion !== MAP_POOLS_SCHEMA_VERSION
      || payload.authoritative !== false
      || !Array.isArray(payload.pools)
      || !Array.isArray(payload.assignments)) {
      throw compatibleDataError("地图池响应格式不兼容。原有地图和分配列表未被替换。");
    }
    const pools = payload.pools.map(pool => {
      if (!hasExactKeys(pool, ["taskId", "displayName", "variantCount", "variants"])
        || !TASK_ID_PATTERN.test(pool.taskId || "")
        || !validVisibleText(pool.displayName, 64)
        || !Number.isSafeInteger(pool.variantCount)
        || !Array.isArray(pool.variants)) throw compatibleDataError("地图池任务数据格式不兼容。");
      const expected = MAP_CHALLENGES.find(item => item.taskId === pool.taskId);
      if (!expected || pool.variantCount !== expected.variantCount
        || pool.variants.length !== expected.variantCount) {
        throw compatibleDataError("地图池数量与比赛规则不一致。");
      }
      const variants = pool.variants.map((variant, index) => {
        if (!hasExactKeys(variant, [
          "variantId", "variantNumber", "revision", "updatedAt", "digest", "mapVersion"
        ])
          || variant.variantId !== `map-${String(index + 1).padStart(2, "0")}`
          || variant.variantNumber !== index + 1
          || !Number.isSafeInteger(variant.revision) || variant.revision < 0
          || (variant.revision === 0 ? variant.updatedAt !== null : !validIsoTimestamp(variant.updatedAt))
          || !SHA256_PATTERN.test(variant.digest || "")
          || typeof variant.mapVersion !== "string" || !variant.mapVersion) {
          throw compatibleDataError("地图池版本数据格式不兼容。");
        }
        return { ...variant };
      });
      return { taskId: pool.taskId, displayName: pool.displayName, variantCount: pool.variantCount, variants };
    });
    if (pools.length !== MAP_CHALLENGES.length
      || MAP_CHALLENGES.some(challenge => !pools.some(pool => pool.taskId === challenge.taskId))) {
      throw compatibleDataError("地图池任务列表不完整。");
    }
    const assignments = payload.assignments.map(assignment => {
      if (!hasExactKeys(assignment, ["teamId", "teamName", "members", "maps"])
        || !INTERNAL_TEAM_ID_PATTERN.test(assignment.teamId || "")
        || !validVisibleText(assignment.teamName, 64)
        || !Array.isArray(assignment.members)
        || !Array.isArray(assignment.maps)
        || assignment.maps.length !== MAP_CHALLENGES.length) {
        throw compatibleDataError("队伍地图分配数据格式不兼容。");
      }
      const members = assignment.members.map(member => {
        if (!hasExactKeys(member, ["userId", "username", "displayName"])
          || !USER_ID_PATTERN.test(member.userId || "")
          || !USERNAME_PATTERN.test(member.username || "")
          || !validVisibleText(member.displayName, 64)) {
          throw compatibleDataError("队伍成员数据格式不兼容。");
        }
        return { ...member };
      });
      const maps = assignment.maps.map(map => {
        const challenge = MAP_CHALLENGES.find(item => item.taskId === map?.taskId);
        if (!hasExactKeys(map, ["taskId", "variantId", "variantNumber"])
          || !challenge
          || map.variantId !== `map-${String(map.variantNumber).padStart(2, "0")}`
          || !Number.isSafeInteger(map.variantNumber)
          || map.variantNumber < 1 || map.variantNumber > challenge.variantCount) {
          throw compatibleDataError("队伍地图编号数据格式不兼容。");
        }
        return { ...map };
      });
      return {
        teamId: assignment.teamId,
        teamName: assignment.teamName,
        members,
        maps
      };
    });
    return { pools, assignments };
  }

  function cloneMapLayout(layout) {
    return {
      schemaVersion: MAP_LAYOUT_SCHEMA_VERSION,
      checkpoints: layout.checkpoints.map(point => [...point]),
      targets: layout.targets.map(point => [...point]),
      storage: [...layout.storage],
      distractors: layout.distractors.map(point => [...point]),
      obstacles: layout.obstacles.map(point => [...point])
    };
  }

  function renderMapAssignments() {
    if (!mapAssignmentTableBody || !mapAssignmentWrap || !mapAssignmentEmpty) return;
    mapAssignmentTableBody.replaceChildren();
    const assignments = [...state.mapAssignments].sort((left, right) => (
      left.teamName.localeCompare(right.teamName, "zh-CN")
    ));
    for (const assignment of assignments) {
      const row = document.createElement("tr");
      appendCell(row, "队伍", assignment.teamName);
      appendCell(row, "账号", assignment.members.map(member => member.username).join("、"));
      for (const challenge of MAP_CHALLENGES) {
        const map = assignment.maps.find(item => item.taskId === challenge.taskId);
        appendCell(row, challenge.label, map ? `地图 ${map.variantNumber}` : "—");
      }
      mapAssignmentTableBody.append(row);
    }
    mapAssignmentWrap.hidden = assignments.length === 0;
    mapAssignmentEmpty.hidden = assignments.length !== 0;
  }

  async function loadMapPools() {
    if (state.mapPoolsLoading) return;
    state.mapPoolsLoading = true;
    try {
      const payload = await requestJson(MAP_POOLS_ENDPOINT);
      const result = validateAdminMapPoolsResponse(payload);
      state.mapPools = result.pools;
      state.mapAssignments = result.assignments;
      populateMapVariantSelect();
      renderMapAssignments();
    } catch (error) {
      if (!state.mapPools.length) {
        state.mapAssignments = [];
        renderMapAssignments();
      }
      showMapNotice(`地图池读取失败：${error instanceof Error ? error.message : "请稍后重试。"}`, "error");
    } finally {
      state.mapPoolsLoading = false;
    }
  }

  function mapLayoutsEqual(left, right) {
    return Boolean(left && right) && JSON.stringify(left) === JSON.stringify(right);
  }

  function validateVerificationSummary(value) {
    if (!hasExactKeys(value, VERIFICATION_SUMMARY_KEYS)
      || !hasExactKeys(value.verificationScope, ["deterministic", "vision"])
      || !hasExactKeys(value.verificationScope.deterministic, ["status"])
      || !validateReasonCodes(value.reasonCodes)
      || !["verified", "partial", "invalid", "error", "unknown"].includes(value.status)
      || !["complete", "incomplete", "unknown"].includes(value.verificationScope.deterministic.status)
      || !["not_used", "not_recomputed", "matched", "unknown"].includes(value.visionStatus)
      || value.verificationScope.vision !== value.visionStatus) {
      throw compatibleDataError("正式提交记录中的校验摘要格式不兼容。");
    }
    return {
      status: value.status,
      deterministicStatus: value.verificationScope.deterministic.status,
      visionStatus: value.visionStatus,
      reasonCodes: [...value.reasonCodes]
    };
  }

  function normalizeRecord(value) {
    if (!hasExactKeys(value, RECORD_SUMMARY_KEYS)
      || !SUBMISSION_ID_PATTERN.test(value.id || "")
      || value.submissionId !== value.id
      || !SESSION_ID_PATTERN.test(value.sessionId || "")
      || !RUN_ID_PATTERN.test(value.runId || "")
      || (value.ownerUserId !== null && !USER_ID_PATTERN.test(value.ownerUserId || ""))
      || !TEAM_ID_PATTERN.test(value.teamId || "")
      || !TASK_ID_PATTERN.test(value.taskId || "")
      || !validVisibleText(value.taskName, 256)
      || !(value.score === null || (typeof value.score === "number" && Number.isFinite(value.score)
        && value.score >= 0 && value.score <= SCORE_MAXIMUM))
      || value.scoreMaximum !== SCORE_MAXIMUM
      || value.recordState !== "submitted"
      || !validIsoTimestamp(value.savedAt)
      || !validIsoTimestamp(value.submittedAt)
      || Date.parse(value.savedAt) > Date.parse(value.submittedAt)
      || !validIsoTimestamp(value.receivedAt)
      || value.receivedAt !== value.savedAt
      || !SHA256_PATTERN.test(value.challengeDigest || "")
      || !SHA256_PATTERN.test(value.recordSha256 || "")
      || !Number.isSafeInteger(value.recordByteLength)
      || value.recordByteLength < 1
      || value.recordByteLength > MAX_RECORD_BYTES
      || !hasExactKeys(value.capabilityUsage, ["navigationSensors", "roadControls", "vision"])
      || typeof value.capabilityUsage.navigationSensors !== "boolean"
      || typeof value.capabilityUsage.roadControls !== "boolean"
      || typeof value.capabilityUsage.vision !== "boolean"
      || !["standard", "ai"].includes(value.autonomyMode)
      || typeof value.aiAutonomyVerified !== "boolean"
      || value.authoritative !== false) {
      throw compatibleDataError("正式提交记录条目的格式不兼容。");
    }
    const verificationSummary = validateVerificationSummary(value.verification);
    if (value.status !== verificationSummary.status) {
      throw compatibleDataError("正式提交记录与校验摘要的状态不一致。");
    }
    const owner = validatePublicUser(value.user, value.ownerUserId);
    const username = owner?.username || "旧记录用户";
    const teamName = owner?.teamName || "未填写队伍";
    const teamGroupingKey = owner?.teamName
      ? `team:${normalizeSearchText(owner.teamName)}`
      : `legacy:${value.ownerUserId || owner?.username || value.id}`;
    return {
      raw: value,
      id: value.id,
      submissionId: value.submissionId,
      sessionId: value.sessionId,
      ownerUserId: value.ownerUserId,
      username,
      ownerName: owner?.displayName || username,
      teamName,
      group: owner?.group || "primary",
      teamGroupingKey,
      teamId: value.teamId,
      taskId: value.taskId,
      taskName: value.taskName,
      score: value.score,
      scoreMaximum: value.scoreMaximum,
      status: verificationSummary.status,
      deterministicStatus: verificationSummary.deterministicStatus,
      visionStatus: verificationSummary.visionStatus,
      reasonCodes: verificationSummary.reasonCodes,
      capabilityUsage: { ...value.capabilityUsage },
      autonomyMode: value.autonomyMode,
      aiAutonomyVerified: value.aiAutonomyVerified,
      savedAt: value.savedAt,
      submittedAt: value.submittedAt
    };
  }

  function validateRecordsResponse(payload) {
    const paged = hasExactKeys(payload, ["schemaVersion", "records", "authoritative", "pagination"]);
    if ((!paged && !hasExactKeys(payload, ["schemaVersion", "records", "authoritative"]))
      || payload.schemaVersion !== RECORDS_SCHEMA_VERSION
      || payload.authoritative !== false
      || !Array.isArray(payload.records)
      || payload.records.length > MAX_RECORDS) {
      throw compatibleDataError("正式提交记录列表响应格式不兼容。");
    }
    if (paged && (!hasExactKeys(payload.pagination, ["page", "pageSize", "total", "totalPages", "hasNext"])
      || !Number.isSafeInteger(payload.pagination.page) || payload.pagination.page < 1
      || !Number.isSafeInteger(payload.pagination.pageSize) || payload.pagination.pageSize < 1
      || !Number.isSafeInteger(payload.pagination.total) || payload.pagination.total < 0 || payload.pagination.total > MAX_RECORDS
      || !Number.isSafeInteger(payload.pagination.totalPages) || payload.pagination.totalPages < 1
      || typeof payload.pagination.hasNext !== "boolean")) throw compatibleDataError("正式提交记录分页信息不兼容。");
    const seenIds = new Set();
    return payload.records.map((item, sourceIndex) => {
      const record = normalizeRecord(item);
      if (seenIds.has(record.id)) throw compatibleDataError("正式提交记录列表包含重复编号。");
      seenIds.add(record.id);
      return { ...record, sourceIndex };
    });
  }

  function validateVerificationReport(value) {
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch (_error) {
      throw compatibleDataError("正式校验报告格式不兼容。");
    }
    if (!isPlainObject(value)
      || typeof serialized !== "string"
      || serialized.length > MAX_VERIFICATION_REPORT_CHARACTERS
      || value.schemaVersion !== VERIFICATION_REPORT_SCHEMA_VERSION
      || value.authoritative !== false
      || !["verified", "partial", "invalid", "error"].includes(value.status)) {
      throw compatibleDataError("正式校验报告格式不兼容。");
    }
    if (value.status !== "error" && (!validateReasonCodes(value.reasonCodes, 64)
      || !hasExactKeys(value.verificationScope, ["deterministic", "vision"])
      || !isPlainObject(value.verificationScope.deterministic)
      || !["complete", "incomplete"].includes(value.verificationScope.deterministic.status)
      || !["not_used", "not_recomputed", "matched"].includes(value.visionStatus)
      || value.verificationScope.vision !== value.visionStatus)) {
      throw compatibleDataError("正式校验报告的状态范围不兼容。");
    }
    return value;
  }

  function validateRecordDetailResponse(payload, requestedRecordId) {
    if (!hasExactKeys(payload, ["schemaVersion", "record", "session", "manifest", "verification", "sourceCode", "authoritative"])
      || payload.schemaVersion !== RECORD_DETAIL_SCHEMA_VERSION
      || payload.authoritative !== false
      || !isPlainObject(payload.session)
      || !isPlainObject(payload.manifest)
      || typeof payload.sourceCode !== "string"
      || payload.sourceCode.length > MAX_SOURCE_CODE_CHARACTERS) {
      throw compatibleDataError("正式提交记录详情响应格式不兼容。");
    }
    const record = normalizeRecord(payload.record);
    if (record.id !== requestedRecordId) {
      throw compatibleDataError("正式提交记录详情与请求编号不一致。");
    }
    const verification = validateVerificationReport(payload.verification);
    if (verification.status !== record.status) {
      throw compatibleDataError("正式提交记录详情与校验报告状态不一致。");
    }
    return { record, verification, sourceCode: payload.sourceCode };
  }

  function formatDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(date);
  }

  function scoreText(score) {
    return Number.isFinite(score) ? score.toFixed(1) : "—";
  }

  function csvCell(value) {
    let text = value === null || value === undefined ? "" : String(value);
    // A CSV opened by spreadsheet software must not turn account or team text
    // into a formula. Keep the visible value while forcing it to plain text.
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function csvFileName(prefix) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `${prefix}-${timestamp}.csv`;
  }

  function downloadCsv(fileName, header, rows) {
    if (typeof Blob !== "function" || typeof URL?.createObjectURL !== "function") {
      throw new Error("当前浏览器不支持本地文件导出。");
    }
    const content = `\uFEFF${[header, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = fileName;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }

  function exportUsers() {
    if (!state.usersLoaded) {
      showUsersNotice("用户列表尚未加载完成，暂时不能导出。", "error");
      return;
    }
    const users = usersForCurrentView();
    const rows = users.map(user => [
      user.username,
      user.displayName,
      user.teamName || "",
      user.group ? GROUP_LABELS[user.group] : "",
      user.role === "admin" ? "管理员" : "普通用户",
      user.createdAt
    ]);
    try {
      downloadCsv(csvFileName("广阳岛-用户清单"),
        ["用户名", "显示名称", "队伍名称", "参赛分组", "角色", "注册时间"], rows);
      showUsersNotice(`已导出当前筛选的 ${rows.length} 条用户数据。`);
    } catch (error) {
      showUsersNotice(`导出失败：${error instanceof Error ? error.message : "浏览器暂不支持导出。"}`, "error");
    }
  }

  function exportRecords() {
    if (!state.loaded) {
      showNotice("正式提交记录尚未加载完成，暂时不能导出。", "error");
      return;
    }
    const records = recordsForCurrentView();
    const rows = records.map(record => [
      record.id,
      record.username,
      record.ownerName,
      record.teamName,
      GROUP_LABELS[record.group],
      record.taskId,
      record.taskName,
      record.score === null ? "" : record.score,
      record.scoreMaximum,
      statusLabel(record.status, record.deterministicStatus),
      capabilityUsageLabel(record.capabilityUsage),
      record.aiAutonomyVerified ? "AI 自主（闭环已验证）" : (record.autonomyMode === "ai" ? "AI 自主" : "常规"),
      record.reasonCodes.join("; "),
      record.submittedAt
    ]);
    try {
      downloadCsv(csvFileName("广阳岛-正式提交记录"), [
        "记录编号", "用户名", "显示名称", "队伍名称", "参赛分组", "任务编号", "任务名称",
        "得分", "满分", "校验状态", "能力标记", "运行方式", "校验原因", "提交时间"
      ], rows);
      showNotice(`已导出当前筛选、排序后的 ${rows.length} 条正式提交记录。`);
    } catch (error) {
      showNotice(`导出失败：${error instanceof Error ? error.message : "浏览器暂不支持导出。"}`, "error");
    }
  }

  function teamGroupLabel(group) {
    return group === "mixed" ? "分组不一致" : (GROUP_LABELS[group] || "—");
  }

  function exportTeamChallengeBest() {
    if (!state.loaded || !state.usersLoaded) {
      showNotice("队伍汇总尚未加载完成，暂时不能导出。", "error");
      return;
    }
    const rows = teamChallengeBestRows().map(team => [
      team.teamName,
      teamGroupLabel(team.group),
      ...MAP_CHALLENGES.map(challenge => team.scores[challenge.taskId] ?? ""),
      team.totalScore
    ]);
    try {
      downloadCsv(csvFileName("广阳岛-各队三项最高分"),
        ["队伍名称", "所在小组", "任务1最高分", "任务2最高分", "任务3最高分", "三项总分"], rows);
      showNotice(`已导出 ${rows.length} 支队伍的三项最高分汇总。`);
    } catch (error) {
      showNotice(`导出失败：${error instanceof Error ? error.message : "浏览器暂不支持导出。"}`, "error");
    }
  }

  async function requestJson(url, { method = "GET", body } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = (response.headers.get("content-type") || "").toLowerCase().includes("application/json")
      ? await response.json().catch(() => null)
      : null;
    if (response.status === 401) {
      window.location.replace(`/login.html?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
      return new Promise(() => {});
    }
    if (response.status === 403) {
      window.location.replace("/records.html?forbidden=1");
      return new Promise(() => {});
    }
    if (!response.ok) {
      const message = payload?.error?.message;
      const error = new Error(typeof message === "string" ? message : `请求失败（HTTP ${response.status}）`);
      error.code = typeof payload?.error?.code === "string" ? payload.error.code : "REQUEST_FAILED";
      throw error;
    }
    if (payload?.authoritative !== false) throw new Error("服务返回了无法识别的管理响应");
    return payload;
  }

  function setLoadState(name) {
    loadingState.hidden = name !== "loading";
    emptyState.hidden = name !== "empty";
    errorState.hidden = name !== "error";
    tableWrap.hidden = name !== "table";
    if (recordsPagination) recordsPagination.hidden = name !== "table";
  }

  function showNotice(message, kind = "normal") {
    notice.textContent = message;
    notice.dataset.kind = kind;
    notice.hidden = !message;
  }

  function setUsersLoadState(name) {
    usersLoadingState.hidden = name !== "loading";
    usersEmptyState.hidden = name !== "empty";
    usersErrorState.hidden = name !== "error";
    usersTableWrap.hidden = name !== "table";
    if (usersPagination) usersPagination.hidden = name !== "table";
  }

  function showUsersNotice(message, kind = "normal") {
    usersNotice.textContent = message;
    usersNotice.dataset.kind = kind;
    usersNotice.hidden = !message;
  }

  function setRankingLoadState(name) {
    rankingLoadingState.hidden = name !== "loading";
    rankingPendingState.hidden = true;
    rankingEmptyState.hidden = name !== "empty";
    rankingErrorState.hidden = name !== "error";
    rankingTableWrap.hidden = name !== "table";
  }

  function rankingScoreText(value) {
    return validRankingScore(value) ? `${value.toFixed(2)} / 100` : "— / 100";
  }

  function rankingReadErrorMessage(error) {
    if (["BATCH_RECEIPT_EVIDENCE_CORRUPTED", "BATCH_FINALIZATION_EVIDENCE_CONFLICT"]
      .includes(String(error?.code || ""))) {
      return "归档证据异常，已停止发布/推进，请管理员检查存档。";
    }
    return error instanceof Error ? error.message : "请稍后重试。";
  }

  function rankingParticipantNode(entry) {
    const wrapper = document.createElement("div");
    wrapper.className = "record-id";
    const strong = document.createElement("strong");
    strong.textContent = entry.participant.teamName || entry.participant.displayName;
    const identity = document.createElement("code");
    identity.textContent = entry.participant.username;
    wrapper.append(strong, identity);
    return wrapper;
  }

  function updateRankingMetrics() {
    const entries = state.rankingEntries;
    document.querySelector("#adminRankingParticipants").textContent = String(entries.length);
    document.querySelector("#adminRankingFinalized").textContent = String(entries.length);
    document.querySelector("#adminRankingBestScore").textContent = entries.length
      ? rankingScoreText(entries[0].score.value)
      : "— / 100";
    document.querySelector("#adminRankingCollisionFree").textContent = String(
      entries.filter(entry => entry.quality.collisionCount === 0).length
    );
  }

  function renderRankingTable() {
    const query = state.rankingQuery.trim().toLocaleLowerCase("zh-CN");
    const visible = state.rankingEntries.filter(entry => {
      const quality = entry.quality;
      const completionMatches = state.completionFilter === "all"
        || (state.completionFilter === "complete" && quality.completedCount === 5)
        || (state.completionFilter === "incomplete" && quality.completedCount < 5);
      const problemCount = quality.invalidCount + quality.timeoutCount + quality.missingCount;
      const validityMatches = state.validityFilter === "all"
        || (state.validityFilter === "all-valid" && quality.validCount === 5)
        || (state.validityFilter === "has-problem" && problemCount > 0);
      const safetyMatches = state.safetyFilter === "all"
        || (state.safetyFilter === "collision-free" && quality.collisionCount === 0)
        || (state.safetyFilter === "has-collision" && quality.collisionCount > 0);
      const haystack = `${entry.participant.username} ${entry.participant.displayName} ${entry.participant.teamName || ""} ${entry.teamId}`
        .toLocaleLowerCase("zh-CN");
      return completionMatches && validityMatches && safetyMatches && (!query || haystack.includes(query));
    });

    rankingTableBody.replaceChildren();
    if (!state.rankingEntries.length) {
      setRankingLoadState("empty");
      return;
    }
    setRankingLoadState("table");
    visible.forEach(entry => {
      const row = document.createElement("tr");
      const rank = document.createElement("span");
      rank.className = "ranking-position";
      rank.textContent = `第 ${entry.rank} 名`;
      appendCell(row, "名次", rank);
      appendCell(row, "用户", rankingParticipantNode(entry));

      const score = document.createElement("span");
      score.className = "score-value";
      score.textContent = rankingScoreText(entry.score.value);
      appendCell(row, "总分 / 100", score);
      appendCell(row, "完成局 / 5", `${entry.quality.completedCount} / 5`);
      appendCell(row, "有效局 / 5", `${entry.quality.validCount} / 5`);
      appendCell(row, "最低分 / 100", rankingScoreText(entry.score.minimum));
      appendCell(row, "碰撞", entry.quality.collisionCount);
      appendCell(row, "越界", entry.quality.outOfBoundsCount);

      const abnormal = document.createElement("div");
      abnormal.className = "ranking-quality-stack";
      const total = entry.quality.invalidCount + entry.quality.timeoutCount + entry.quality.missingCount;
      const totalNode = document.createElement("span");
      totalNode.textContent = String(total);
      const detail = document.createElement("small");
      detail.textContent = `无效 ${entry.quality.invalidCount} · 超时 ${entry.quality.timeoutCount} · 缺局 ${entry.quality.missingCount}`;
      abnormal.append(totalNode, detail);
      appendCell(row, "异常局", abnormal);
      rankingTableBody.append(row);
    });

    if (!visible.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 9;
      cell.className = "records-state";
      cell.textContent = "没有符合当前筛选条件的账号；服务端综合名次没有改变。";
      row.append(cell);
      rankingTableBody.append(row);
    }
  }

  async function loadAdminRanking() {
    if (state.rankingLoading) return;
    state.rankingLoading = true;
    refreshRankingButton.disabled = true;
    [rankingSearch, rankingCompletionFilter, rankingValidityFilter, rankingSafetyFilter]
      .forEach(control => { control.disabled = true; });
    setRankingLoadState("loading");
    try {
      const entries = [];
      const participantIds = new Set();
      let offset = 0;
      let expectedTotal = null;
      while (true) {
        const payload = await requestJson(`${RANKING_ENDPOINT}?offset=${offset}&limit=100`);
        const page = normalizeAdminRankingResponse(payload, offset);
        if (expectedTotal === null) expectedTotal = page.pagination.total;
        else if (page.pagination.total !== expectedTotal) throw new Error("筛选排名读取期间已变化，请刷新重试");
        for (const entry of page.entries) {
          if (participantIds.has(entry.participant.id)) throw new Error("筛选排名包含重复账号");
          if (entries.length && entry.rank < entries.at(-1).rank) throw new Error("筛选排名顺序不兼容");
          participantIds.add(entry.participant.id);
          entries.push(entry);
        }
        offset += page.entries.length;
        if (offset >= expectedTotal) break;
        if (!page.entries.length || offset > 10000) throw new Error("筛选排名数量超出页面读取范围");
      }
      state.rankingEntries = entries;
      updateRankingMetrics();
      renderRankingTable();
    } catch (error) {
      rankingErrorMessage.textContent = rankingReadErrorMessage(error);
      setRankingLoadState("error");
    } finally {
      state.rankingLoading = false;
      refreshRankingButton.disabled = false;
      const label = refreshRankingButton.querySelector("span");
      if (label) label.textContent = "刷新筛选排名";
      [rankingSearch, rankingCompletionFilter, rankingValidityFilter, rankingSafetyFilter]
        .forEach(control => { control.disabled = false; });
    }
  }

  function userDraftFor(user) {
    let draft = state.userDrafts.get(user.id);
    if (!draft) {
      draft = { teamName: user.teamName || "", group: user.group };
      state.userDrafts.set(user.id, draft);
    }
    return draft;
  }

  function userDraftIsDirty(user, draft = userDraftFor(user)) {
    return draft.teamName !== (user.teamName || "") || draft.group !== user.group;
  }

  function usersForCurrentView() {
    const usernameQuery = normalizeSearchText(state.userUsernameQuery);
    const teamQuery = normalizeSearchText(state.userTeamQuery);
    return state.users.filter(user => {
      const isParticipant = user.role === "user";
      const usernameMatches = !usernameQuery || normalizeSearchText(user.username).includes(usernameQuery);
      const teamMatches = !teamQuery || (isParticipant && normalizeSearchText(user.teamName).includes(teamQuery));
      const groupMatches = state.userGroup === "all" || (isParticipant && user.group === state.userGroup);
      const roleMatches = state.userRole === "all" || user.role === state.userRole;
      return usernameMatches && teamMatches && groupMatches && roleMatches;
    });
  }

  function updateUserMetrics() {
    document.querySelector("#adminUserMetricTotal").textContent = String(state.users.length);
    document.querySelector("#adminUserMetricPrimary").textContent = String(
      state.users.filter(user => user.group === "primary").length
    );
    document.querySelector("#adminUserMetricJunior").textContent = String(
      state.users.filter(user => user.group === "junior").length
    );
    document.querySelector("#adminUserMetricHigh").textContent = String(
      state.users.filter(user => user.group === "high").length
    );
    document.querySelector("#adminUserMetricAdmins").textContent = String(
      state.users.filter(user => user.role === "admin").length
    );
  }

  function clampUserPage(userCount) {
    const totalPages = Math.max(1, Math.ceil(userCount / USERS_PER_PAGE));
    const requestedPage = Number.isSafeInteger(state.userPage) ? state.userPage : 1;
    state.userPage = Math.min(Math.max(requestedPage, 1), totalPages);
    return totalPages;
  }

  function updateUserPagination(userCount, totalPages) {
    const start = userCount ? ((state.userPage - 1) * USERS_PER_PAGE) + 1 : 0;
    const end = userCount ? Math.min(state.userPage * USERS_PER_PAGE, userCount) : 0;
    if (usersRange) usersRange.textContent = `第 ${start}–${end} 条，共 ${userCount} 条`;
    if (usersPageStatus) usersPageStatus.textContent = `第 ${state.userPage} 页，共 ${totalPages} 页`;
    if (usersPrevPage) usersPrevPage.disabled = state.userPage <= 1;
    if (usersNextPage) usersNextPage.disabled = state.userPage >= totalPages;
  }

  function userRoleNode(role) {
    const badge = document.createElement("span");
    badge.className = "status-badge";
    badge.dataset.status = role;
    badge.textContent = role === "admin" ? "管理员" : "普通用户";
    return badge;
  }

  function appendGroupOption(select, value) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = GROUP_LABELS[value];
    select.append(option);
  }

  function syncUserEditRow(userId, row) {
    const user = state.users.find(item => item.id === userId);
    if (!user || !row || user.role === "admin") return;
    const draft = userDraftFor(user);
    const teamInput = row.querySelector('[data-user-field="teamName"]');
    const groupSelect = row.querySelector('[data-user-field="group"]');
    const saveButton = row.querySelector("button[data-user-save-id]");
    const editStatus = row.querySelector("[data-user-edit-status]");
    const teamDirty = draft.teamName !== (user.teamName || "");
    const groupDirty = draft.group !== user.group;
    const dirty = teamDirty || groupDirty;
    const saving = state.userSaving.has(user.id);
    if (teamInput) teamInput.dataset.dirty = String(teamDirty);
    if (groupSelect) groupSelect.dataset.dirty = String(groupDirty);
    if (saveButton) {
      saveButton.disabled = saving || !dirty;
      const label = saveButton.querySelector("span");
      if (label) label.textContent = saving ? "保存中…" : (dirty ? "确认修改" : "已是最新");
    }
    if (editStatus) editStatus.textContent = dirty ? "有尚未保存的修改" : "";
  }

  function renderUsersTable() {
    const visible = usersForCurrentView();
    const totalPages = clampUserPage(visible.length);
    const pageStart = (state.userPage - 1) * USERS_PER_PAGE;
    const pageUsers = visible.slice(pageStart, pageStart + USERS_PER_PAGE);
    updateUserPagination(visible.length, totalPages);
    usersTableBody.replaceChildren();
    if (!state.users.length) {
      setUsersLoadState("empty");
      return;
    }
    setUsersLoadState("table");
    pageUsers.forEach(user => {
      const row = document.createElement("tr");
      row.dataset.userRowId = user.id;
      appendCell(row, "用户名", stacked(user.username, user.displayName));

      if (user.role === "admin") {
        appendCell(row, "队伍名", "—");
        appendCell(row, "分组", "—");
      } else {
        const draft = userDraftFor(user);
        const saving = state.userSaving.has(user.id);
        const teamInput = document.createElement("input");
        teamInput.type = "text";
        teamInput.maxLength = 64;
        teamInput.autocomplete = "off";
        teamInput.value = draft.teamName;
        teamInput.placeholder = "修改将同步整队";
        teamInput.disabled = saving;
        teamInput.dataset.userId = user.id;
        teamInput.dataset.userField = "teamName";
        teamInput.setAttribute("aria-label", `修改 ${user.username} 所在队伍的队伍名，会同步同队成员`);
        appendCell(row, "队伍名", teamInput);

        const groupSelect = document.createElement("select");
        groupSelect.disabled = saving;
        groupSelect.dataset.userId = user.id;
        groupSelect.dataset.userField = "group";
        groupSelect.setAttribute("aria-label", `修改 ${user.username} 的参赛分组`);
        Object.keys(GROUP_LABELS).forEach(value => appendGroupOption(groupSelect, value));
        groupSelect.value = draft.group;
        appendCell(row, "分组", groupSelect);
      }

      appendCell(row, "角色", userRoleNode(user.role));
      appendCell(row, "注册时间", formatDate(user.createdAt));

      if (user.role === "admin") {
        appendCell(row, "操作", "不参与队伍和分组管理");
      } else {
        const actions = document.createElement("div");
        actions.className = "user-edit-actions";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "table-action";
        button.dataset.userSaveId = user.id;
        const icon = document.createElement("i");
        icon.setAttribute("data-lucide", "save");
        icon.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        button.append(icon, label);
        const editStatus = document.createElement("small");
        editStatus.dataset.userEditStatus = "";
        actions.append(button, editStatus);
        appendCell(row, "操作", actions);
      }
      usersTableBody.append(row);
      syncUserEditRow(user.id, row);
    });

    if (!visible.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.className = "records-state";
      cell.textContent = "没有符合当前筛选条件的用户。";
      row.append(cell);
      usersTableBody.append(row);
    }
    if (globalThis.lucide) globalThis.lucide.createIcons();
  }

  function userUpdateErrorMessage(error) {
    const code = String(error?.code || "");
    if (code === "USER_NOT_FOUND") return "该账号已不存在，请刷新用户列表。";
    if (code === "INVALID_TEAM_NAME") return "队伍名需为 1 至 64 个可见字符，且不能以空格开头或结尾。";
    if (code === "TEAM_NAME_TAKEN") return "这个队伍名称已被使用，请填写不同的名称。";
    if (code === "INVALID_GROUP") return "请选择小学组、初中组或高中组。";
    return error instanceof Error ? error.message : "用户资料保存失败，请稍后重试。";
  }

  function syncUpdatedUserAcrossAdminViews(updatedUser, { previousTeamName = null } = {}) {
    const teamRenamed = typeof previousTeamName === "string" && previousTeamName !== updatedUser.teamName;
    let recordsChanged = false;
    state.records = state.records.map(record => {
      const isOwner = record.ownerUserId === updatedUser.id;
      const isTeamMember = teamRenamed && record.teamName === previousTeamName;
      if (!isOwner && !isTeamMember) return record;
      recordsChanged = true;
      return {
        ...record,
        raw: {
          ...record.raw,
          user: isOwner
            ? { ...updatedUser }
            : { ...record.raw.user, teamName: updatedUser.teamName }
        },
        username: isOwner ? updatedUser.username : record.username,
        ownerName: isOwner ? updatedUser.displayName : record.ownerName,
        teamName: updatedUser.teamName || "未填写队伍",
        group: isOwner ? updatedUser.group : record.group,
        teamGroupingKey: updatedUser.teamName
          ? `team:${normalizeSearchText(updatedUser.teamName)}`
          : `legacy:${updatedUser.id}`
      };
    });
    if (recordsChanged) {
      updateMetrics();
      renderTable();
    }

    let rankingChanged = false;
    state.rankingEntries = state.rankingEntries.map(entry => {
      const isOwner = entry.participant.id === updatedUser.id;
      const isTeamMember = teamRenamed && entry.participant.teamName === previousTeamName;
      if (!isOwner && !isTeamMember) return entry;
      rankingChanged = true;
      return {
        ...entry,
        participant: {
          ...entry.participant,
          username: isOwner ? updatedUser.username : entry.participant.username,
          displayName: isOwner ? updatedUser.displayName : entry.participant.displayName,
          teamName: updatedUser.teamName
        }
      };
    });
    if (rankingChanged) {
      updateRankingMetrics();
      renderRankingTable();
    }
  }

  async function saveUser(userId) {
    const userIndex = state.users.findIndex(user => user.id === userId);
    if (userIndex < 0 || state.userSaving.has(userId)) return;
    const currentUser = state.users[userIndex];
    if (currentUser.role === "admin") return;
    const draft = userDraftFor(currentUser);
    if (!validVisibleText(draft.teamName, 64)) {
      showUsersNotice("队伍名需为 1 至 64 个可见字符，且不能以空格开头或结尾。", "error");
      return;
    }
    if (!Object.hasOwn(GROUP_LABELS, draft.group)) {
      showUsersNotice("请选择小学组、初中组或高中组。", "error");
      return;
    }
    if (!userDraftIsDirty(currentUser, draft)) return;

    state.userSaving.add(userId);
    refreshUsersButton.disabled = true;
    showUsersNotice("");
    renderUsersTable();
    try {
      const teamName = draft.teamName;
      const group = draft.group;
      const payload = await requestJson(`${USERS_ENDPOINT}/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        body: { teamName, group }
      });
      const receipt = validateAdminUserUpdateResponse(payload, currentUser, teamName, group);
      const previousTeamName = currentUser.teamName;
      const teamRenamed = previousTeamName !== receipt.user.teamName;
      state.users = state.users.map(user => {
        if (user.id === userId) return receipt.user;
        return teamRenamed && user.teamName === previousTeamName
          ? { ...user, teamName: receipt.user.teamName }
          : user;
      });
      for (const user of state.users) {
        if (teamRenamed && user.teamName === receipt.user.teamName) {
          const draftForMember = state.userDrafts.get(user.id);
          if (draftForMember && draftForMember.teamName === previousTeamName) {
            state.userDrafts.set(user.id, { ...draftForMember, teamName: receipt.user.teamName });
          }
        }
      }
      state.userDrafts.set(userId, { teamName: receipt.user.teamName || "", group: receipt.user.group });
      updateUserMetrics();
      syncUpdatedUserAcrossAdminViews(receipt.user, { previousTeamName });
      renderTeamChallengeBest();
      showUsersNotice(
        receipt.changed
          ? `账号“${receipt.user.username}”的资料已保存；如修改队伍名，已同步同队成员和历史记录。`
          : `账号“${receipt.user.username}”的资料已是最新。`
      );
    } catch (error) {
      showUsersNotice(`保存失败：${userUpdateErrorMessage(error)} 原有用户资料未被页面替换。`, "error");
    } finally {
      state.userSaving.delete(userId);
      refreshUsersButton.disabled = state.userLoading || state.userSaving.size > 0;
      renderUsersTable();
    }
  }

  async function loadUsers() {
    if (state.userLoading || state.userSaving.size) return;
    state.userLoading = true;
    state.usersLoadError = null;
    refreshUsersButton.disabled = true;
    exportUsersButton.disabled = true;
    setUsersLoadState("loading");
    renderTeamChallengeBest();
    try {
      const payload = await requestJson(USERS_ENDPOINT);
      const users = validateAdminUsersResponse(payload);
      state.users = users;
      state.userDrafts.clear();
      state.usersLoaded = true;
      showUsersNotice("");
      updateUserMetrics();
      renderUsersTable();
      renderTeamChallengeBest();
    } catch (error) {
      const message = error instanceof Error ? error.message : "请稍后重试。";
      state.usersLoadError = message;
      if (state.usersLoaded) {
        renderUsersTable();
        showUsersNotice(`刷新失败：${message} 已保留上一次成功读取的用户列表。`, "error");
      } else {
        usersErrorMessage.textContent = message;
        setUsersLoadState("error");
      }
      renderTeamChallengeBest();
    } finally {
      state.userLoading = false;
      refreshUsersButton.disabled = state.userSaving.size > 0;
      exportUsersButton.disabled = !state.usersLoaded;
    }
  }

  function mapPointDefinitions(layout = state.mapDraft || DEFAULT_MAP_LAYOUT) {
    const indexed = (field, label, shortLabel, kind) => (Array.isArray(layout?.[field]) ? layout[field] : [])
      .map((_point, index) => ({ key: `${field}-${index}`, field, index, label: `${label} ${index + 1}`, shortLabel: `${shortLabel}${index + 1}`, kind }));
    return [
      ...indexed("checkpoints", "途径点", "途", "checkpoint"),
      ...indexed("targets", "目标物", "目", "target"),
      { key: "storage", field: "storage", label: "目标点（存放点）", shortLabel: "点", kind: "storage" },
      ...indexed("distractors", "混淆物", "混", "distractor"),
      ...indexed("obstacles", "障碍物", "障", "obstacle")
    ];
  }

  function mapPointDefinition(key) {
    return mapPointDefinitions().find(point => point.key === key) || null;
  }

  function mapPointValue(layout, definition) {
    return Number.isInteger(definition.index)
      ? layout[definition.field][definition.index]
      : layout[definition.field];
  }

  function setMapPointValue(definition, point) {
    if (!state.mapDraft || !definition) return;
    if (Number.isInteger(definition.index)) state.mapDraft[definition.field][definition.index] = point;
    else state.mapDraft[definition.field] = point;
  }

  function roundMapCoordinate(value) {
    return Math.round(value * 10000) / 10000;
  }

  function mapWorldToCm(value) {
    return Math.round(Number(value) * MAP_CM_PER_WORLD_UNIT * 10) / 10;
  }

  function mapCmToWorld(value) {
    return roundMapCoordinate(Number(value) / MAP_CM_PER_WORLD_UNIT);
  }

  function clampMapCoordinate(value, axis) {
    return Math.min(Math.max(value, MAP_LIMITS[axis][0]), MAP_LIMITS[axis][1]);
  }

  function formatMapCoordinate(value) {
    return String(mapWorldToCm(value));
  }

  function worldPointToImagePercent(point) {
    const sourceX = MAP_IMAGE.cropX + MAP_IMAGE.cropWidth / 2
      + point[0] * MAP_IMAGE.cropWidth / MAP_IMAGE.worldWidth;
    const sourceY = MAP_IMAGE.cropY + MAP_IMAGE.cropHeight / 2
      + point[1] * MAP_IMAGE.cropHeight / MAP_IMAGE.worldDepth;
    return [sourceX / MAP_IMAGE.naturalWidth * 100, sourceY / MAP_IMAGE.naturalHeight * 100];
  }

  function pointerToWorldPoint(event) {
    const bounds = mapStage.getBoundingClientRect();
    if (!(bounds.width > 0) || !(bounds.height > 0)) return null;
    const sourceX = (event.clientX - bounds.left) / bounds.width * MAP_IMAGE.naturalWidth;
    const sourceY = (event.clientY - bounds.top) / bounds.height * MAP_IMAGE.naturalHeight;
    const x = (sourceX - MAP_IMAGE.cropX - MAP_IMAGE.cropWidth / 2)
      * MAP_IMAGE.worldWidth / MAP_IMAGE.cropWidth;
    const z = (sourceY - MAP_IMAGE.cropY - MAP_IMAGE.cropHeight / 2)
      * MAP_IMAGE.worldDepth / MAP_IMAGE.cropHeight;
    return [
      roundMapCoordinate(clampMapCoordinate(x, "x")),
      roundMapCoordinate(clampMapCoordinate(z, "z"))
    ];
  }

  function mapDraftIsDirty() {
    return state.mapLoaded && !mapLayoutsEqual(state.mapDraft, state.mapEnvelope?.layout);
  }

  function showMapNotice(message, kind = "normal") {
    mapNotice.textContent = message;
    mapNotice.dataset.kind = kind;
    mapNotice.hidden = !message;
  }

  function setMapLoadState(name) {
    mapLoadingState.hidden = name !== "loading";
    mapErrorState.hidden = name !== "error";
    mapWorkspace.hidden = name !== "workspace";
    mapActions.hidden = name !== "workspace";
  }

  function setMapEditorExpanded(expanded) {
    state.mapEditorExpanded = Boolean(expanded);
    mapEditorBody.hidden = !state.mapEditorExpanded;
    toggleMapEditorButton.setAttribute("aria-expanded", String(state.mapEditorExpanded));
    const label = toggleMapEditorButton.querySelector("span");
    if (label) label.textContent = state.mapEditorExpanded ? "收起编辑" : "展开编辑";
  }

  function updateMapMetadata() {
    const envelope = state.mapEnvelope;
    mapVersion.textContent = envelope?.mapVersion || "—";
    mapRevision.textContent = envelope ? String(envelope.revision) : "—";
    mapUpdatedAt.textContent = envelope?.updatedAt ? formatDate(envelope.updatedAt) : "尚未自定义";
  }

  function updateMapActions() {
    const dirty = mapDraftIsDirty();
    const busy = state.mapLoading || state.mapSaving;
    const invalid = state.mapInvalidInputs.size > 0;
    refreshMapButton.disabled = busy;
    restoreMapButton.disabled = busy || !state.mapLoaded;
    saveMapButton.disabled = busy || !state.mapLoaded || !dirty || invalid;
    const saveLabel = saveMapButton.querySelector("span");
    if (saveLabel) saveLabel.textContent = state.mapSaving ? "保存中…" : "保存并发布";
    if (!state.mapLoaded) mapDraftStatus.textContent = "尚未加载地图";
    else if (invalid) mapDraftStatus.textContent = "请修正标红的坐标";
    else mapDraftStatus.textContent = dirty ? "有尚未发布的修改" : "当前配置未修改";
    for (const marker of state.mapMarkerElements.values()) marker.disabled = busy || !state.mapLoaded;
    for (const controls of state.mapInputElements.values()) {
      controls.x.disabled = busy || !state.mapLoaded;
      controls.z.disabled = busy || !state.mapLoaded;
    }
  }

  function selectMapPoint(key, { focusMarker = false } = {}) {
    if (!mapPointDefinition(key)) return;
    state.mapSelectedKey = key;
    for (const [candidate, marker] of state.mapMarkerElements) {
      marker.dataset.selected = String(candidate === key);
    }
    for (const [candidate, controls] of state.mapInputElements) {
      controls.row.dataset.selected = String(candidate === key);
    }
    if (focusMarker) state.mapMarkerElements.get(key)?.focus();
  }

  function renderMapEditor({ syncInputs = true } = {}) {
    if (!state.mapDraft) {
      updateMapActions();
      return;
    }
    for (const definition of mapPointDefinitions()) {
      const point = mapPointValue(state.mapDraft, definition);
      const marker = state.mapMarkerElements.get(definition.key);
      const controls = state.mapInputElements.get(definition.key);
      const [left, top] = worldPointToImagePercent(point);
      if (marker) {
        marker.style.left = `${left}%`;
        marker.style.top = `${top}%`;
        marker.title = `${definition.label}：X ${formatMapCoordinate(point[0])} cm，Z ${formatMapCoordinate(point[1])} cm`;
        marker.setAttribute("aria-label", `${definition.label}，X ${formatMapCoordinate(point[0])} 厘米，Z ${formatMapCoordinate(point[1])} 厘米。可拖动或使用方向键微调`);
      }
      if (syncInputs && controls) {
        controls.x.value = formatMapCoordinate(point[0]);
        controls.z.value = formatMapCoordinate(point[1]);
        controls.x.removeAttribute("aria-invalid");
        controls.z.removeAttribute("aria-invalid");
      }
    }
    selectMapPoint(state.mapSelectedKey);
    updateMapActions();
  }

  function updateDraftPoint(key, point, { syncInputs = true } = {}) {
    if (!state.mapLoaded || state.mapLoading || state.mapSaving) return;
    const definition = mapPointDefinition(key);
    if (!definition) return;
    setMapPointValue(definition, [
      roundMapCoordinate(clampMapCoordinate(point[0], "x")),
      roundMapCoordinate(clampMapCoordinate(point[1], "z"))
    ]);
    selectMapPoint(key);
    renderMapEditor({ syncInputs });
  }

  function createMapCoordinateInput(definition, axis) {
    const label = document.createElement("label");
    label.className = "map-coordinate-field";
    const hiddenLabel = document.createElement("span");
    hiddenLabel.className = "sr-only";
    hiddenLabel.textContent = `${definition.label} ${axis.toUpperCase()} 坐标（厘米）`;
    const input = document.createElement("input");
    input.type = "number";
    input.inputMode = "decimal";
    input.step = "1";
    input.min = String(MAP_CM_LIMITS[axis][0]);
    input.max = String(MAP_CM_LIMITS[axis][1]);
    input.dataset.mapPointKey = definition.key;
    input.dataset.mapAxis = axis;
    input.setAttribute("aria-label", hiddenLabel.textContent);
    label.append(hiddenLabel, input);
    return { label, input };
  }

  function createMapEditor() {
    const definitions = mapPointDefinitions();
    const signature = definitions.map(item => item.key).join("|");
    if (signature === state.mapEditorSignature) return;
    state.mapEditorSignature = signature;
    state.mapMarkerElements.clear();
    state.mapInputElements.clear();
    mapMarkers.replaceChildren();
    mapPointList.replaceChildren();
    if (!definitions.some(item => item.key === state.mapSelectedKey)) {
      state.mapSelectedKey = definitions[0]?.key || "";
    }
    for (const definition of definitions) {
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "map-editor-marker";
      marker.dataset.mapPointKey = definition.key;
      marker.dataset.mapKind = definition.kind;
      marker.textContent = definition.shortLabel;
      marker.disabled = true;
      marker.addEventListener("focus", () => selectMapPoint(definition.key));
      marker.addEventListener("click", () => selectMapPoint(definition.key));
      marker.addEventListener("keydown", event => {
        const movement = {
          ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
        }[event.key];
        if (!movement || !state.mapDraft) return;
        event.preventDefault();
        const step = mapCmToWorld(event.shiftKey ? 10 : 1);
        const current = mapPointValue(state.mapDraft, definition);
        updateDraftPoint(definition.key, [current[0] + movement[0] * step, current[1] + movement[1] * step]);
      });
      marker.addEventListener("pointerdown", event => {
        if (!state.mapLoaded || state.mapLoading || state.mapSaving) return;
        state.mapDraggingKey = definition.key;
        selectMapPoint(definition.key);
        marker.setPointerCapture?.(event.pointerId);
        const point = pointerToWorldPoint(event);
        if (point) updateDraftPoint(definition.key, point);
        event.preventDefault();
      });
      marker.addEventListener("pointermove", event => {
        if (state.mapDraggingKey !== definition.key) return;
        const point = pointerToWorldPoint(event);
        if (point) updateDraftPoint(definition.key, point);
      });
      const finishDrag = event => {
        if (state.mapDraggingKey !== definition.key) return;
        state.mapDraggingKey = null;
        marker.releasePointerCapture?.(event.pointerId);
      };
      marker.addEventListener("pointerup", finishDrag);
      marker.addEventListener("pointercancel", finishDrag);
      mapMarkers.append(marker);
      state.mapMarkerElements.set(definition.key, marker);

      const row = document.createElement("div");
      row.className = "map-point-row";
      row.dataset.mapPointKey = definition.key;
      const pointButton = document.createElement("button");
      pointButton.type = "button";
      pointButton.className = "map-point-name";
      pointButton.dataset.mapKind = definition.kind;
      const swatch = document.createElement("span");
      swatch.className = "map-point-swatch";
      swatch.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.textContent = definition.label;
      pointButton.append(swatch, name);
      pointButton.addEventListener("click", () => selectMapPoint(definition.key, { focusMarker: true }));
      const x = createMapCoordinateInput(definition, "x");
      const z = createMapCoordinateInput(definition, "z");
      row.append(pointButton, x.label, z.label);
      mapPointList.append(row);
      state.mapInputElements.set(definition.key, { row, x: x.input, z: z.input });

      for (const input of [x.input, z.input]) {
        const token = `${definition.key}:${input.dataset.mapAxis}`;
        input.addEventListener("focus", () => selectMapPoint(definition.key));
        input.addEventListener("input", () => {
          const axis = input.dataset.mapAxis;
          const value = input.value.trim() === "" ? Number.NaN : Number(input.value);
          if (!Number.isFinite(value) || value < MAP_CM_LIMITS[axis][0] || value > MAP_CM_LIMITS[axis][1]) {
            state.mapInvalidInputs.add(token);
            input.setAttribute("aria-invalid", "true");
            updateMapActions();
            return;
          }
          state.mapInvalidInputs.delete(token);
          input.removeAttribute("aria-invalid");
          const current = mapPointValue(state.mapDraft, definition);
          const worldValue = mapCmToWorld(value);
          updateDraftPoint(definition.key,
            axis === "x" ? [worldValue, current[1]] : [current[0], worldValue],
            { syncInputs: false });
        });
        input.addEventListener("change", () => {
          if (!state.mapInvalidInputs.has(token)) {
            renderMapEditor();
            return;
          }
          state.mapInvalidInputs.delete(token);
          renderMapEditor();
          showMapNotice(`${definition.label}的 ${input.dataset.mapAxis.toUpperCase()} 坐标已恢复为有效值。`, "error");
        });
      }
    }
    selectMapPoint(state.mapSelectedKey);
    updateMapActions();
  }

  function mapConfigErrorMessage(error) {
    const code = String(error?.code || "");
    const messages = {
      MAP_CONFIG_REVISION_CONFLICT: "地图已被其他管理员更新，请重新加载后再保存；当前未发布草稿仍保留。",
      MAP_CONFIG_INVALID_UPDATE: "地图保存请求格式不正确，请重新加载后重试。",
      MAP_CONFIG_INVALID_LAYOUT: "地图配置格式不正确。",
      MAP_CONFIG_INVALID_CHECKPOINTS: "途径点、目标物、混淆物和障碍物的数量必须与当前挑战匹配。",
      MAP_CONFIG_INVALID_POSITION: "坐标必须是有效数字。",
      MAP_CONFIG_OUT_OF_BOUNDS: "点位超出地图边界。",
      MAP_CONFIG_NOT_ROAD_REACHABLE: "点位不在可到达的道路范围内。",
      MAP_CONFIG_DISCONNECTED: "点位与停车区道路不连通。",
      MAP_CONFIG_OBJECTS_OVERLAP: "场景对象距离太近。",
      MAP_CONFIG_CHECKPOINTS_OVERLAP: "途径点距离太近。",
      MAP_CONFIG_OBSTACLE_BLOCKS_ROAD: "障碍物封死了道路，车辆无法绕行。"
    };
    if (messages[code]) return messages[code];
    if (code.startsWith("MAP_CONFIG_")) return "地图位置未通过校验，请检查各标记后重试。";
    return error instanceof Error ? error.message : "地图配置请求失败，请稍后重试。";
  }

  async function loadMapConfig({ confirmDiscard = true } = {}) {
    if (state.mapLoading || state.mapSaving) return;
    if (confirmDiscard && mapDraftIsDirty()
      && typeof window.confirm === "function"
      && !window.confirm("重新加载会放弃尚未发布的地图修改，是否继续？")) return;
    const operationId = ++state.mapOperationId;
    state.mapLoading = true;
    refreshMapButton.disabled = true;
    showMapNotice(state.mapLoaded ? "正在重新加载已发布地图…" : "正在读取当前已发布地图…");
    if (!state.mapLoaded) setMapLoadState("loading");
    updateMapActions();
    try {
      const payload = await requestJson(mapConfigEndpoint());
      const envelope = validateMapConfigResponse(payload);
      if (operationId !== state.mapOperationId) return;
      state.mapEnvelope = envelope;
      state.mapDraft = cloneMapLayout(envelope.layout);
      state.mapLoaded = true;
      state.mapInvalidInputs.clear();
      createMapEditor();
      updateMapMetadata();
      renderMapEditor();
      setMapLoadState("workspace");
      showMapNotice(`${selectedMapChallenge().label} · ${mapVariantLabel()}已加载。拖动标记或修改坐标后，再保存发布。`, "normal");
    } catch (error) {
      if (operationId !== state.mapOperationId) return;
      const message = mapConfigErrorMessage(error);
      if (state.mapLoaded) {
        renderMapEditor();
        setMapLoadState("workspace");
        showMapNotice(`重新加载失败：${message} 页面保留了原有地图和草稿。`, "error");
      } else {
        mapErrorMessage.textContent = message;
        setMapLoadState("error");
        showMapNotice(`地图读取失败：${message}`, "error");
      }
    } finally {
      if (operationId === state.mapOperationId) {
        state.mapLoading = false;
        updateMapActions();
      }
    }
  }

  function restoreDefaultMap() {
    if (!state.mapLoaded || state.mapLoading || state.mapSaving) return;
    state.mapDraft = cloneMapLayout(state.mapEnvelope.layout);
    state.mapInvalidInputs.clear();
    renderMapEditor();
    showMapNotice("已放弃当前未发布修改，恢复为这套地图的已发布位置。", "normal");
  }

  async function saveMapConfig() {
    if (!state.mapLoaded || state.mapLoading || state.mapSaving || !mapDraftIsDirty()
      || state.mapInvalidInputs.size) return;
    let layout;
    try {
      layout = normalizeMapLayout(state.mapDraft);
    } catch (error) {
      showMapNotice(mapConfigErrorMessage(error), "error");
      return;
    }
    const baseEnvelope = state.mapEnvelope;
    const operationId = ++state.mapOperationId;
    state.mapSaving = true;
    showMapNotice("正在校验并发布地图…", "normal");
    updateMapActions();
    try {
      const payload = await requestJson(mapConfigEndpoint(), {
        method: "PUT",
        body: {
          schemaVersion: MAP_UPDATE_SCHEMA_VERSION,
          baseRevision: baseEnvelope.revision,
          layout
        }
      });
      const envelope = validateMapConfigResponse(payload);
      if (operationId !== state.mapOperationId) return;
      if (envelope.revision !== baseEnvelope.revision + 1
        || !mapLayoutsEqual(envelope.layout, layout)) {
        throw compatibleDataError("地图保存回执与本次操作不一致，页面未采纳该结果。");
      }
      state.mapEnvelope = envelope;
      state.mapDraft = cloneMapLayout(envelope.layout);
      state.mapInvalidInputs.clear();
      updateMapMetadata();
      renderMapEditor();
      showMapNotice(`${selectedMapChallenge().label} · ${mapVariantLabel()}已保存并发布。被分配到这套地图的队伍刷新后会使用这个版本。`, "normal");
      void loadMapPools();
    } catch (error) {
      if (operationId !== state.mapOperationId) return;
      showMapNotice(`保存失败：${mapConfigErrorMessage(error)}`, "error");
    } finally {
      if (operationId === state.mapOperationId) {
        state.mapSaving = false;
        updateMapActions();
      }
    }
  }

  function updateMetrics() {
    const teams = new Set(state.records.map(record => record.teamGroupingKey));
    const scores = state.records.map(record => record.score).filter(Number.isFinite);
    const average = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
    document.querySelector("#adminMetricTotal").textContent = String(state.records.length);
    document.querySelector("#adminMetricUsers").textContent = String(teams.size);
    document.querySelector("#adminMetricVerified").textContent = String(state.records.filter(record => record.status === "verified").length);
    document.querySelector("#adminMetricAverage").textContent = average === null ? "—" : average.toFixed(1);
    document.querySelector("#adminMetricAi").textContent = String(
      state.records.filter(record => record.autonomyMode === "ai").length
    );
  }

  function appendCell(row, label, content) {
    const cell = document.createElement("td");
    cell.dataset.label = label;
    if (content instanceof Node) cell.append(content);
    else cell.textContent = String(content);
    row.append(cell);
  }

  function stacked(primary, secondary) {
    const wrapper = document.createElement("div");
    wrapper.className = "record-id";
    const strong = document.createElement("strong");
    strong.textContent = primary;
    const small = document.createElement("code");
    small.textContent = secondary;
    wrapper.append(strong, small);
    return wrapper;
  }

  function compareScores(left, right, direction) {
    const leftHasScore = Number.isFinite(left.score);
    const rightHasScore = Number.isFinite(right.score);
    if (leftHasScore !== rightHasScore) return leftHasScore ? -1 : 1;
    if (leftHasScore && left.score !== right.score) {
      return direction === "score-asc" ? left.score - right.score : right.score - left.score;
    }
    return left.sourceIndex - right.sourceIndex;
  }

  function compareRecords(left, right, sortMode) {
    if (sortMode === "submitted-desc") {
      const submittedDifference = Date.parse(right.submittedAt) - Date.parse(left.submittedAt);
      if (submittedDifference !== 0) return submittedDifference;
      return left.sourceIndex - right.sourceIndex;
    }
    return compareScores(left, right, sortMode);
  }

  function recordsForCurrentView() {
    const usernameQuery = normalizeSearchText(state.usernameQuery);
    const teamQuery = normalizeSearchText(state.teamQuery);
    const filtered = state.records.filter(record => {
      const statusMatches = state.status === "all" || record.status === state.status;
      const usernameMatches = !usernameQuery || normalizeSearchText(record.username).includes(usernameQuery);
      const teamMatches = !teamQuery || normalizeSearchText(record.teamName).includes(teamQuery);
      const taskMatches = state.taskId === "all" || record.taskId === state.taskId;
      const groupMatches = state.group === "all" || record.group === state.group;
      const autonomyMatches = state.autonomyMode === "all"
        || (state.autonomyMode === "ai-verified" && record.aiAutonomyVerified)
        || record.autonomyMode === state.autonomyMode;
      return statusMatches && usernameMatches && teamMatches && taskMatches && groupMatches && autonomyMatches;
    });
    const selected = state.teamRecordMode === "best-per-team"
      ? [...filtered.reduce((bestByTeam, record) => {
          const groupingKey = `${record.teamGroupingKey}\u0000${record.taskId}`;
          const current = bestByTeam.get(groupingKey);
          if (!current || compareScores(record, current, "score-desc") < 0) {
            bestByTeam.set(groupingKey, record);
          }
          return bestByTeam;
        }, new Map()).values()]
      : [...filtered];
    return selected.sort((left, right) => compareRecords(left, right, state.scoreSort));
  }

  function clampRecordPage(recordCount) {
    const totalPages = Math.max(1, Math.ceil(recordCount / RECORDS_PER_PAGE));
    const requestedPage = Number.isSafeInteger(state.recordPage) ? state.recordPage : 1;
    state.recordPage = Math.min(Math.max(requestedPage, 1), totalPages);
    return totalPages;
  }

  function updateRecordPagination(recordCount, totalPages) {
    const start = recordCount ? ((state.recordPage - 1) * RECORDS_PER_PAGE) + 1 : 0;
    const end = recordCount ? Math.min(state.recordPage * RECORDS_PER_PAGE, recordCount) : 0;
    if (recordsRange) recordsRange.textContent = `第 ${start}–${end} 条，共 ${recordCount} 条`;
    if (recordsPageStatus) recordsPageStatus.textContent = `第 ${state.recordPage} 页，共 ${totalPages} 页`;
    if (recordsPrevPage) recordsPrevPage.disabled = state.recordPage <= 1;
    if (recordsNextPage) recordsNextPage.disabled = state.recordPage >= totalPages;
  }

  function renderTable() {
    const visible = recordsForCurrentView();
    const totalPages = clampRecordPage(visible.length);
    const pageStart = (state.recordPage - 1) * RECORDS_PER_PAGE;
    const pageRecords = visible.slice(pageStart, pageStart + RECORDS_PER_PAGE);
    updateRecordPagination(visible.length, totalPages);

    tableBody.replaceChildren();
    if (!state.records.length) {
      setLoadState("empty");
      return;
    }
    setLoadState("table");
    pageRecords.forEach(record => {
      const row = document.createElement("tr");
      appendCell(row, "用户名", stacked(record.username, record.ownerName));
      appendCell(row, "队伍名", record.teamName);
      appendCell(row, "分组", GROUP_LABELS[record.group]);
      const autonomy = document.createElement("span");
      autonomy.className = "status-badge";
      autonomy.dataset.status = record.autonomyMode === "ai" ? "ai" : "standard";
      autonomy.textContent = record.aiAutonomyVerified
        ? "AI 自主（闭环已验证）"
        : record.autonomyMode === "ai" ? "AI 自主" : "常规";
      appendCell(row, "运行方式", autonomy);
      appendCell(row, "能力标记", capabilityUsageNode(record.capabilityUsage));
      appendCell(row, "任务 / 记录", stacked(record.taskName, record.submissionId || record.id || "未编号记录"));

      const score = document.createElement("span");
      score.className = "score-value";
      score.textContent = scoreText(record.score);
      appendCell(row, "得分 / 100", score);

      appendCell(row, "校验状态", verificationStatusNode(record));
      appendCell(row, "提交时间", formatDate(record.submittedAt));

      const button = document.createElement("button");
      button.type = "button";
      button.className = "table-action";
      button.dataset.recordId = record.id || record.submissionId;
      const icon = document.createElement("i");
      icon.setAttribute("data-lucide", "panel-right-open");
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = "详情";
      button.append(icon, label);
      appendCell(row, "操作", button);
      tableBody.append(row);
    });

    if (!visible.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 10;
      cell.className = "records-state";
      cell.textContent = "没有符合当前筛选条件的记录。";
      row.append(cell);
      tableBody.append(row);
    }
    if (globalThis.lucide) globalThis.lucide.createIcons();
  }

  function teamChallengeBestRows() {
    return teamScoreRules.buildTeamChallengeScores({
      users: state.users,
      records: state.records,
      taskIds: MAP_CHALLENGES.map(challenge => challenge.taskId),
      maximumScore: SCORE_MAXIMUM
    });
  }

  function renderTeamChallengeBest() {
    if (!teamChallengeBestBody || !teamChallengeBestTableWrap || !teamChallengeBestPagination) return;
    const failedSources = [];
    if (!state.usersLoaded && state.usersLoadError) failedSources.push("用户列表");
    if (!state.loaded && state.recordsLoadError) failedSources.push("正式提交记录");
    if (failedSources.length) {
      if (teamChallengeBestLoading) teamChallengeBestLoading.hidden = true;
      if (teamChallengeBestError) teamChallengeBestError.hidden = false;
      if (teamChallengeBestErrorMessage) {
        teamChallengeBestErrorMessage.textContent = `${failedSources.join("和")}读取失败，暂时无法汇总队伍成绩。请点击相应刷新按钮重试。`;
      }
      teamChallengeBestTableWrap.hidden = true;
      teamChallengeBestPagination.hidden = true;
      if (exportTeamChallengeBestButton) exportTeamChallengeBestButton.disabled = true;
      return;
    }
    if (!state.loaded || !state.usersLoaded) {
      if (teamChallengeBestLoading) teamChallengeBestLoading.hidden = false;
      if (teamChallengeBestError) teamChallengeBestError.hidden = true;
      teamChallengeBestTableWrap.hidden = true;
      teamChallengeBestPagination.hidden = true;
      if (exportTeamChallengeBestButton) exportTeamChallengeBestButton.disabled = true;
      return;
    }

    const rows = teamChallengeBestRows();
    const page = teamScoreRules.paginateTeamScores(rows, state.teamChallengeBestPage, 15);
    state.teamChallengeBestPage = page.page;
    teamChallengeBestBody.replaceChildren();
    if (teamChallengeBestLoading) teamChallengeBestLoading.hidden = true;
    if (teamChallengeBestError) teamChallengeBestError.hidden = true;
    teamChallengeBestTableWrap.hidden = false;
    teamChallengeBestPagination.hidden = false;
    if (exportTeamChallengeBestButton) exportTeamChallengeBestButton.disabled = false;
    if (teamChallengeBestRange) teamChallengeBestRange.textContent = `第 ${page.start}–${page.end} 队，共 ${page.total} 队`;
    if (teamChallengeBestPageStatus) teamChallengeBestPageStatus.textContent = `第 ${page.page} 页，共 ${page.totalPages} 页`;
    if (teamChallengeBestPrevPage) teamChallengeBestPrevPage.disabled = page.page <= 1;
    if (teamChallengeBestNextPage) teamChallengeBestNextPage.disabled = page.page >= page.totalPages;

    if (!page.items.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.className = "records-state";
      cell.textContent = "当前没有参赛队伍。";
      row.append(cell);
      teamChallengeBestBody.append(row);
      return;
    }

    for (const team of page.items) {
      const row = document.createElement("tr");
      appendCell(row, "队伍", team.teamName);
      appendCell(row, "小组", teamGroupLabel(team.group));
      MAP_CHALLENGES.forEach((challenge, index) => {
        const value = team.scores[challenge.taskId];
        const score = document.createElement("strong");
        score.className = "team-challenge-best-score";
        score.textContent = value === null ? "—" : `${scoreText(value)} / 100`;
        appendCell(row, `任务${index + 1}最高分`, score);
      });
      const total = document.createElement("strong");
      total.className = "team-challenge-best-total";
      total.textContent = `${scoreText(team.totalScore)} / 300`;
      appendCell(row, "三项总分", total);
      teamChallengeBestBody.append(row);
    }
  }

  function detailItem(label, value) {
    const item = document.createElement("div");
    item.className = "detail-item";
    const name = document.createElement("span");
    name.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value;
    item.append(name, content);
    return item;
  }

  async function openDetail(recordId, { updateUrl = true } = {}) {
    if (!recordId) return;
    const loading = document.createElement("p");
    loading.className = "page-notice";
    loading.textContent = "正在读取提交详情…";
    detailContent.replaceChildren(loading);
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("id", recordId);
      history.pushState({ recordId }, "", url);
    }
    try {
      const payload = await requestJson(`${RECORDS_ENDPOINT}/${encodeURIComponent(recordId)}`);
      const validated = validateRecordDetailResponse(payload, recordId);
      const record = validated.record;
      const verificationSummary = validateVerificationSummary(record.raw.verification);
      const grid = document.createElement("div");
      grid.className = "detail-grid";
      grid.append(
        detailItem("用户名", record.username),
        detailItem("显示名称", record.ownerName),
        detailItem("注册队伍名", record.teamName),
        detailItem("参赛分组", GROUP_LABELS[record.group]),
        detailItem("运行方式", record.aiAutonomyVerified
          ? "AI 自主（视觉、导航和道路控制闭环已验证）"
          : record.autonomyMode === "ai" ? "AI 自主（证据未形成完整闭环）" : "常规"),
        detailItem("能力标记", capabilityUsageLabel(record.capabilityUsage)),
        detailItem("用户编号", record.ownerUserId || "—"),
        detailItem("提交编号", record.submissionId || record.id || "—"),
        detailItem("场次编号", record.sessionId || "—"),
        detailItem("任务", record.taskName),
        detailItem("重算得分", scoreText(record.score)),
        detailItem("校验状态", statusLabel(record.status, verificationSummary.deterministicStatus)),
        detailItem("确定性校验范围", deterministicScopeLabel(verificationSummary.deterministicStatus)),
        detailItem("视觉校验范围", visionScopeLabel(verificationSummary.visionStatus)),
        detailItem("校验说明", reasonCodesLabel(verificationSummary.reasonCodes)),
        detailItem("提交时间", formatDate(record.submittedAt))
      );
      const reportTitle = document.createElement("h3");
      reportTitle.className = "detail-report-title";
      reportTitle.textContent = "重算与校验报告";
      const report = document.createElement("pre");
      report.className = "detail-json";
      report.textContent = JSON.stringify(validated.verification, null, 2);
      const sourceTitle = document.createElement("h3");
      sourceTitle.className = "detail-report-title";
      sourceTitle.textContent = "本次提交的 Python 代码";
      const sourceCode = document.createElement("pre");
      sourceCode.className = "detail-json detail-source-code";
      sourceCode.textContent = validated.sourceCode || "# 本次提交没有 Python 代码";
      detailContent.replaceChildren(grid, sourceTitle, sourceCode, reportTitle, report);
    } catch (error) {
      const message = document.createElement("p");
      message.className = "page-notice";
      message.dataset.kind = "error";
      message.textContent = error instanceof Error ? error.message : "详情读取失败。";
      detailContent.replaceChildren(message);
    }
  }

  function closeDetail({ updateUrl = true } = {}) {
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.delete("id");
      history.replaceState(null, "", url);
    }
  }

  async function loadRecords() {
    if (state.loading) return;
    state.loading = true;
    state.recordsLoadError = null;
    setLoadState("loading");
    renderTeamChallengeBest();
    document.querySelector("#refreshAdminRecordsButton").disabled = true;
    exportRecordsButton.disabled = true;
    try {
      const records = [];
      for (let page = 1; ; page += 1) {
        const payload = await requestJson(`${RECORDS_ENDPOINT}?page=${page}&pageSize=${RECORD_PAGE_SIZE}`);
        const current = validateRecordsResponse(payload);
        if (payload.pagination && payload.pagination.page !== page) throw compatibleDataError("正式提交记录分页顺序不兼容。");
        records.push(...current.map((record, index) => ({ ...record, sourceIndex: records.length + index })));
        if (!payload.pagination || !payload.pagination.hasNext) break;
      }
      state.records = records;
      state.loaded = true;
      showNotice("");
      updateMetrics();
      renderTable();
      renderTeamChallengeBest();
      const recordId = new URLSearchParams(window.location.search).get("id");
      if (recordId) await openDetail(recordId, { updateUrl: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : "请稍后重试。";
      state.recordsLoadError = message;
      if (state.loaded) {
        renderTable();
        showNotice(`刷新失败：${message} 已保留上一次成功读取的正式提交记录。`, "error");
      } else {
        errorMessageElement.textContent = message;
        setLoadState("error");
      }
      renderTeamChallengeBest();
    } finally {
      state.loading = false;
      document.querySelector("#refreshAdminRecordsButton").disabled = false;
      exportRecordsButton.disabled = !state.loaded;
    }
  }

  usernameFilter.addEventListener("input", event => {
    state.usernameQuery = String(event.target.value || "").slice(0, 64);
    state.recordPage = 1;
    renderTable();
  });
  teamFilter.addEventListener("input", event => {
    state.teamQuery = String(event.target.value || "").slice(0, 128);
    state.recordPage = 1;
    renderTable();
  });
  taskFilter.addEventListener("change", event => {
    const taskId = String(event.target.value || "");
    state.taskId = taskId === "all" || MAP_CHALLENGES.some(item => item.taskId === taskId)
      ? taskId
      : "all";
    state.recordPage = 1;
    renderTable();
  });
  groupFilter.addEventListener("change", event => {
    state.group = Object.hasOwn(GROUP_LABELS, event.target.value) ? event.target.value : "all";
    state.recordPage = 1;
    renderTable();
  });
  statusFilter.addEventListener("change", event => {
    state.status = ["all", "verified", "partial", "invalid"].includes(event.target.value)
      ? event.target.value
      : "all";
    state.recordPage = 1;
    renderTable();
  });
  autonomyModeFilter.addEventListener("change", event => {
    state.autonomyMode = ["all", "standard", "ai", "ai-verified"].includes(event.target.value)
      ? event.target.value
      : "all";
    state.recordPage = 1;
    renderTable();
  });
  scoreSort.addEventListener("change", event => {
    state.scoreSort = ["score-desc", "score-asc", "submitted-desc"].includes(event.target.value)
      ? event.target.value
      : "score-desc";
    state.recordPage = 1;
    renderTable();
  });
  teamRecordMode.addEventListener("change", event => {
    state.teamRecordMode = ["all", "best-per-team"].includes(event.target.value)
      ? event.target.value
      : "all";
    state.recordPage = 1;
    renderTable();
  });
  recordsPrevPage?.addEventListener("click", () => {
    if (state.recordPage <= 1) return;
    state.recordPage -= 1;
    renderTable();
  });
  recordsNextPage?.addEventListener("click", () => {
    const totalPages = clampRecordPage(recordsForCurrentView().length);
    if (state.recordPage >= totalPages) return;
    state.recordPage += 1;
    renderTable();
  });
  teamChallengeBestPrevPage?.addEventListener("click", () => {
    if (state.teamChallengeBestPage <= 1) return;
    state.teamChallengeBestPage -= 1;
    renderTeamChallengeBest();
  });
  teamChallengeBestNextPage?.addEventListener("click", () => {
    const page = teamScoreRules.paginateTeamScores(teamChallengeBestRows(), state.teamChallengeBestPage, 15);
    if (page.page >= page.totalPages) return;
    state.teamChallengeBestPage += 1;
    renderTeamChallengeBest();
  });
  userUsernameFilter.addEventListener("input", event => {
    state.userUsernameQuery = String(event.target.value || "").slice(0, 64);
    state.userPage = 1;
    renderUsersTable();
  });
  for (const tab of adminSectionTabs) {
    tab.addEventListener("click", () => selectAdminSection(tab.dataset.adminSection));
    tab.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = adminSectionTabs.indexOf(tab);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? adminSectionTabs.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + adminSectionTabs.length)
            % adminSectionTabs.length;
      const nextTab = adminSectionTabs[nextIndex];
      selectAdminSection(nextTab.dataset.adminSection);
      nextTab.focus();
    });
  }
  userTeamFilter.addEventListener("input", event => {
    state.userTeamQuery = String(event.target.value || "").slice(0, 128);
    state.userPage = 1;
    renderUsersTable();
  });
  userGroupFilter.addEventListener("change", event => {
    state.userGroup = Object.hasOwn(GROUP_LABELS, event.target.value) ? event.target.value : "all";
    state.userPage = 1;
    renderUsersTable();
  });
  userRoleFilter.addEventListener("change", event => {
    state.userRole = ["all", "user", "admin"].includes(event.target.value) ? event.target.value : "all";
    state.userPage = 1;
    renderUsersTable();
  });
  usersPrevPage?.addEventListener("click", () => {
    if (state.userPage <= 1) return;
    state.userPage -= 1;
    renderUsersTable();
  });
  usersNextPage?.addEventListener("click", () => {
    const totalPages = clampUserPage(usersForCurrentView().length);
    if (state.userPage >= totalPages) return;
    state.userPage += 1;
    renderUsersTable();
  });
  usersTableBody.addEventListener("input", event => {
    const control = event.target;
    if (control?.dataset?.userField !== "teamName") return;
    const user = state.users.find(item => item.id === control.dataset.userId);
    if (!user || state.userSaving.has(user.id)) return;
    userDraftFor(user).teamName = String(control.value || "").slice(0, 64);
    syncUserEditRow(user.id, control.closest("tr"));
  });
  usersTableBody.addEventListener("change", event => {
    const control = event.target;
    if (control?.dataset?.userField !== "group") return;
    const user = state.users.find(item => item.id === control.dataset.userId);
    if (!user || state.userSaving.has(user.id)) return;
    userDraftFor(user).group = Object.hasOwn(GROUP_LABELS, control.value) ? control.value : user.group;
    control.value = userDraftFor(user).group;
    syncUserEditRow(user.id, control.closest("tr"));
  });
  usersTableBody.addEventListener("click", event => {
    const button = event.target.closest("button[data-user-save-id]");
    if (button) saveUser(button.dataset.userSaveId);
  });
  document.querySelector("#refreshAdminRecordsButton").addEventListener("click", loadRecords);
  exportRecordsButton.addEventListener("click", exportRecords);
  exportTeamChallengeBestButton?.addEventListener("click", exportTeamChallengeBest);
  refreshUsersButton.addEventListener("click", loadUsers);
  exportUsersButton.addEventListener("click", exportUsers);
  mapChallengeSelect?.addEventListener("change", event => {
    const taskId = String(event.target.value || "");
    if (!MAP_CHALLENGES.some(item => item.taskId === taskId) || taskId === state.mapTaskId) {
      event.target.value = state.mapTaskId;
      return;
    }
    if (mapDraftIsDirty() && typeof window.confirm === "function"
      && !window.confirm("切换挑战会放弃当前未发布的地图修改，是否继续？")) {
      event.target.value = state.mapTaskId;
      return;
    }
    state.mapOperationId += 1;
    state.mapTaskId = taskId;
    state.mapVariantId = "map-01";
    populateMapVariantSelect();
    state.mapEnvelope = null;
    state.mapDraft = null;
    state.mapLoaded = false;
    state.mapInvalidInputs.clear();
    updateMapMetadata();
    renderMapEditor();
    setMapLoadState("loading");
    showMapNotice(`正在读取${selectedMapChallenge().label} · ${mapVariantLabel()}…`, "normal");
    void loadMapConfig({ confirmDiscard: false });
  });
  mapVariantSelect?.addEventListener("change", event => {
    const nextVariantId = String(event.target.value || "");
    const challenge = selectedMapChallenge();
    const validIds = new Set(Array.from({ length: challenge.variantCount }, (_item, index) => (
      `map-${String(index + 1).padStart(2, "0")}`
    )));
    if (!validIds.has(nextVariantId) || nextVariantId === state.mapVariantId) {
      event.target.value = state.mapVariantId;
      return;
    }
    if (mapDraftIsDirty() && typeof window.confirm === "function"
      && !window.confirm("切换地图会放弃当前未发布的修改，是否继续？")) {
      event.target.value = state.mapVariantId;
      return;
    }
    state.mapOperationId += 1;
    state.mapVariantId = nextVariantId;
    state.mapEnvelope = null;
    state.mapDraft = null;
    state.mapLoaded = false;
    state.mapInvalidInputs.clear();
    updateMapMetadata();
    renderMapEditor();
    setMapLoadState("loading");
    showMapNotice(`正在读取${selectedMapChallenge().label} · ${mapVariantLabel()}…`, "normal");
    void loadMapConfig({ confirmDiscard: false });
  });
  refreshMapButton.addEventListener("click", () => {
    void loadMapPools();
    void loadMapConfig();
  });
  toggleMapEditorButton.addEventListener("click", () => {
    setMapEditorExpanded(!state.mapEditorExpanded);
  });
  restoreMapButton.addEventListener("click", restoreDefaultMap);
  saveMapButton.addEventListener("click", saveMapConfig);
  refreshRankingButton.addEventListener("click", loadAdminRanking);
  rankingSearch.addEventListener("input", event => {
    state.rankingQuery = event.target.value;
    renderRankingTable();
  });
  rankingCompletionFilter.addEventListener("change", event => {
    state.completionFilter = event.target.value;
    renderRankingTable();
  });
  rankingValidityFilter.addEventListener("change", event => {
    state.validityFilter = event.target.value;
    renderRankingTable();
  });
  rankingSafetyFilter.addEventListener("change", event => {
    state.safetyFilter = event.target.value;
    renderRankingTable();
  });
  tableBody.addEventListener("click", event => {
    const button = event.target.closest("button[data-record-id]");
    if (button) openDetail(button.dataset.recordId);
  });
  document.querySelector("#closeAdminRecordDetailButton").addEventListener("click", () => closeDetail());
  dialog.addEventListener("click", event => {
    if (event.target === dialog) closeDetail();
  });
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    closeDetail();
  });
  window.addEventListener("popstate", () => {
    const recordId = new URLSearchParams(window.location.search).get("id");
    if (recordId) openDetail(recordId, { updateUrl: false });
    else closeDetail({ updateUrl: false });
  });
  window.addEventListener("beforeunload", event => {
    if (!mapDraftIsDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  populateMapVariantSelect();
  createMapEditor();
  setMapEditorExpanded(false);
  selectAdminSection("records");
  Promise.resolve(globalThis.chenlongAuthReady).then(user => {
    if (user?.role !== "admin") {
      window.location.replace("/records.html?forbidden=1");
      return;
    }
    loadUsers();
    loadRecords();
    loadMapPools();
    loadMapConfig({ confirmDiscard: false });
  });
  if (globalThis.lucide) globalThis.lucide.createIcons();
})();
