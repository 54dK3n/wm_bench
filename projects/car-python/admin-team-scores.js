"use strict";

((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ChenlongAdminTeamScores = api;
})(typeof globalThis === "object" ? globalThis : null, () => {
  const DEFAULT_PAGE_SIZE = 15;

  function normalizeTeamName(value) {
    return typeof value === "string"
      ? value.trim().normalize("NFC").toLocaleLowerCase("zh-CN")
      : "";
  }

  function visibleTeamName(value) {
    return typeof value === "string" && value.trim() ? value.trim().normalize("NFC") : "";
  }

  function recordTeamName(record) {
    return visibleTeamName(record?.teamName || record?.user?.teamName);
  }

  function visibleGroup(value) {
    return typeof value === "string" && value.trim() ? value.trim() : "";
  }

  function recordGroup(record) {
    return visibleGroup(record?.group || record?.user?.group);
  }

  function buildTeamChallengeScores({ users = [], records = [], taskIds = [], maximumScore = 100 } = {}) {
    const orderedTaskIds = [...new Set(taskIds.filter(taskId => typeof taskId === "string" && taskId))];
    const allowedTaskIds = new Set(orderedTaskIds);
    const teams = new Map();

    function ensureTeam(teamName, group = "") {
      const displayName = visibleTeamName(teamName);
      const normalizedName = normalizeTeamName(displayName);
      if (!displayName || !normalizedName) return null;
      const key = `team:${normalizedName}`;
      if (!teams.has(key)) {
        teams.set(key, {
          key,
          teamName: displayName,
          group: null,
          groups: new Set(),
          scores: Object.fromEntries(orderedTaskIds.map(taskId => [taskId, null]))
        });
      }
      const team = teams.get(key);
      const normalizedGroup = visibleGroup(group);
      if (normalizedGroup) team.groups.add(normalizedGroup);
      return team;
    }

    if (Array.isArray(users)) {
      for (const user of users) {
        if (!user || user.role === "admin") continue;
        ensureTeam(user.teamName, user.group);
      }
    }

    if (Array.isArray(records)) {
      for (const record of records) {
        if (record?.recordState && record.recordState !== "submitted") continue;
        const team = ensureTeam(recordTeamName(record), recordGroup(record));
        const score = Number(record?.score);
        if (!team || !allowedTaskIds.has(record?.taskId) || !Number.isFinite(score)
          || score < 0 || score > maximumScore) continue;
        const current = team.scores[record.taskId];
        if (current === null || score > current) team.scores[record.taskId] = score;
      }
    }

    const results = [...teams.values()].map(team => {
      const groups = [...team.groups];
      const totalScore = orderedTaskIds.reduce((sum, taskId) => sum + (Number(team.scores[taskId]) || 0), 0);
      return {
        key: team.key,
        teamName: team.teamName,
        group: groups.length === 1 ? groups[0] : groups.length > 1 ? "mixed" : null,
        scores: team.scores,
        totalScore: Math.round(totalScore * 10) / 10
      };
    });
    return results.sort((left, right) => (
      left.teamName.localeCompare(right.teamName, "zh-CN", { numeric: true, sensitivity: "base" })
      || left.key.localeCompare(right.key)
    ));
  }

  function buildSubmittedTaskScores(records = [], taskIds = [], maximumScore = 100) {
    const orderedTaskIds = [...new Set(taskIds.filter(taskId => typeof taskId === "string" && taskId))];
    const result = Object.fromEntries(orderedTaskIds.map(taskId => [taskId, null]));
    for (const record of Array.isArray(records) ? records : []) {
      const score = Number(record?.score);
      if (record?.recordState !== "submitted" || !Object.hasOwn(result, record?.taskId)
        || !Number.isFinite(score) || score < 0 || score > maximumScore) continue;
      if (result[record.taskId] === null || score > result[record.taskId]) result[record.taskId] = score;
    }
    return result;
  }

  function paginateTeamScores(entries, requestedPage = 1, pageSize = DEFAULT_PAGE_SIZE) {
    const rows = Array.isArray(entries) ? entries : [];
    const safePageSize = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(rows.length / safePageSize));
    const page = Math.min(Math.max(Number.isSafeInteger(requestedPage) ? requestedPage : 1, 1), totalPages);
    const offset = (page - 1) * safePageSize;
    const items = rows.slice(offset, offset + safePageSize);
    return {
      items,
      page,
      pageSize: safePageSize,
      total: rows.length,
      totalPages,
      start: rows.length ? offset + 1 : 0,
      end: rows.length ? offset + items.length : 0
    };
  }

  return Object.freeze({ DEFAULT_PAGE_SIZE, buildTeamChallengeScores, buildSubmittedTaskScores, paginateTeamScores });
});
