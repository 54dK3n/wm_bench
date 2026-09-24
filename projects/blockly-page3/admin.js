"use strict";

(() => {
  const mapRules = globalThis.PrimaryGuangyangMaps;
  if (!mapRules) throw new Error("地图编辑规则没有加载");
  const teamScoreRules = globalThis.ChenlongAdminTeamScores;
  if (!teamScoreRules) throw new Error("队伍最高分汇总规则没有加载");
  const PAGE_SIZE = 12;
  const TEAM_SCORE_TASK_IDS = Object.freeze(["GYI-PRIMARY-01", "GYI-PRIMARY-02", "GYI-PRIMARY-03"]);
  const GROUP_LABELS = Object.freeze({ primary: "小学组", junior: "初中组", high: "高中组" });
  const CAPABILITY_USAGE_SCHEMA_VERSION = "chenlong.blockly-runtime-capability-usage/v1";
  const platformMode = new URLSearchParams(window.location.search).get("platform") === "1"
    || window.location.pathname.startsWith("/blockly/");
  const CAPABILITY_GROUPS = Object.freeze([
    Object.freeze({ key: "navigationSensorMethods", label: "导航传感", kind: "navigation" }),
    Object.freeze({ key: "roadControlMethods", label: "道路控制", kind: "road" }),
    Object.freeze({ key: "visionMethods", label: "摄像头感知", kind: "vision" })
  ]);
  const state = { user: null, users: [], records: [], maps: new Map(), userPage: 1, recordPage: 1, teamScorePage: 1, mapDirty: false, selectedTaskId: "GYI-PRIMARY-01" };
  const notice = document.querySelector("#adminNotice");
  const usersBody = document.querySelector("#adminUsersBody");
  const recordsBody = document.querySelector("#adminRecordsBody");
  const mapCanvas = document.querySelector("#adminMapCanvas");
  const mapFields = document.querySelector("#adminMapFields");
  const teamScoreBody = document.querySelector("#adminTeamChallengeBestBody");

  function loginLocation() {
    return platformMode
      ? `/login.html?${new URLSearchParams({ returnTo: "/blockly/admin.html?platform=1" }).toString()}`
      : "./login.html";
  }

  function say(message, tone = "") {
    notice.textContent = message;
    notice.dataset.tone = tone;
    notice.hidden = !message;
  }

  async function request(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || "暂时无法读取管理数据。 ");
    return payload;
  }

  async function requestAllRecordPages(path, schemaVersion) {
    const records = [];
    const recordIds = new Set();
    let page = 1;
    while (page <= 10_000) {
      const separator = path.includes("?") ? "&" : "?";
      const payload = await request(`${path}${separator}page=${page}&pageSize=1000`);
      if (payload?.schemaVersion !== schemaVersion || !Array.isArray(payload.records)) {
        throw new Error("记录数据格式不正确。 ");
      }
      const pagination = payload.pagination;
      if (!pagination) return { ...payload, records: [...records, ...payload.records] };
      if (pagination.page !== page || pagination.pageSize !== 1000
        || !Number.isInteger(pagination.total) || pagination.total < 0
        || typeof pagination.hasNext !== "boolean") {
        throw new Error("记录分页信息不正确。 ");
      }
      payload.records.forEach(record => {
        if (typeof record?.id !== "string" || recordIds.has(record.id)) return;
        recordIds.add(record.id);
        records.push(record);
      });
      if (!pagination.hasNext) {
        if (records.length !== pagination.total) throw new Error("记录分页数量不完整，请刷新后重试。 ");
        return { ...payload, records };
      }
      if (payload.records.length === 0) throw new Error("记录分页意外中断，请刷新后重试。 ");
      page += 1;
    }
    throw new Error("记录页数超出安全范围。 ");
  }

  function appendCell(row, value) {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.append(cell);
  }

  function formatTime(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString("zh-CN", { hour12: false }) : "—";
  }

  function runtimeCapabilityGroups(record) {
    const usage = record?.capabilityUsage;
    if (usage?.schemaVersion !== CAPABILITY_USAGE_SCHEMA_VERSION || usage.source !== "runtime_reported") return [];
    return CAPABILITY_GROUPS.map(group => ({
      ...group,
      methods: Array.isArray(usage[group.key])
        ? usage[group.key].filter(method => typeof method === "string")
        : []
    })).filter(group => group.methods.length > 0);
  }

  function renderRuntimeCapabilities(container, record, { detail = false } = {}) {
    container.replaceChildren();
    if (detail) {
      const heading = document.createElement("strong");
      heading.textContent = "运行时上报的能力使用";
      container.append(heading);
    }
    const groups = runtimeCapabilityGroups(record);
    if (!groups.length) {
      const empty = document.createElement("span");
      empty.className = "primary-capability-empty";
      empty.textContent = detail ? "本次运行未上报导航传感、道路控制或摄像头感知调用。" : "—";
      container.append(empty);
      return;
    }
    const list = document.createElement("span");
    list.className = "primary-capability-list";
    groups.forEach(group => {
      const badge = document.createElement("span");
      badge.className = "primary-capability-badge";
      badge.dataset.kind = group.kind;
      badge.textContent = group.label;
      badge.title = `运行时上报：${group.methods.join("、")}`;
      list.append(badge);
      if (detail) {
        const methods = document.createElement("small");
        methods.className = "primary-capability-methods";
        methods.textContent = `${group.label}：${group.methods.join("、")}`;
        list.append(methods);
      }
    });
    container.append(list);
  }

  function closeRecordDialog() {
    const dialog = document.querySelector("#adminRecordDialog");
    if (dialog.open) dialog.close();
  }

  async function openRecordDetail(recordId) {
    const dialog = document.querySelector("#adminRecordDialog");
    const meta = document.querySelector("#adminRecordDetailMeta");
    const code = document.querySelector("#adminRecordProgramCode");
    const workspace = document.querySelector("#adminRecordWorkspace");
    const capabilities = document.querySelector("#adminRecordCapabilities");
    meta.textContent = "正在读取记录…";
    code.textContent = "";
    workspace.textContent = "";
    capabilities.replaceChildren();
    dialog.showModal();
    try {
      const payload = await request(`/api/admin/records/${encodeURIComponent(recordId)}`);
      const record = payload?.record;
      if (payload?.schemaVersion !== "chenlong.blockly-admin-record-detail/v1" || record?.id !== recordId
        || typeof record.programCode !== "string" || typeof record.workspaceXml !== "string" || record.recordState !== "submitted") {
        throw new Error("记录详情格式不正确。 ");
      }
      const user = record.user || {};
      const mapText = Number.isInteger(record.mapRevision) ? `地图修订 ${record.mapRevision}` : "旧版地图";
      const groupText = GROUP_LABELS[user.group] || "未分组";
      meta.textContent = `${user.username || "已删除用户"} · ${user.teamName || "无队伍"} · ${groupText} · ${record.taskName} · ${mapText} · ${record.score}/100 分 · ${formatTime(record.submittedAt)}`;
      renderRuntimeCapabilities(capabilities, record, { detail: true });
      code.textContent = record.programCode || "（没有生成代码）";
      try { workspace.textContent = JSON.stringify(JSON.parse(record.workspaceXml), null, 2); }
      catch (_error) { workspace.textContent = record.workspaceXml || "（没有积木结构数据）"; }
    } catch (error) {
      meta.textContent = error.message;
    }
  }

  async function exportAdminData(kind, button) {
    const isUsers = kind === "users";
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "导出中…";
    try {
      const payload = await request(`/api/admin/export/${kind}`);
      const expectedSchema = isUsers ? "chenlong.blockly-admin-users-export/v1" : "chenlong.blockly-admin-records-export/v1";
      const entries = isUsers ? payload?.users : payload?.records;
      if (payload?.schemaVersion !== expectedSchema || !Array.isArray(entries)) throw new Error("导出数据格式不正确。 ");
      const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `blockly-${kind}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      say(isUsers ? "用户数据已导出。" : "正式记录已导出，包含积木、生成代码和地图版本。", "success");
    } catch (error) { say(error.message, "error"); }
    finally { button.disabled = false; button.textContent = original; }
  }

  function csvCell(value) {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportTeamScores(button) {
    button.disabled = true;
    try {
      const rows = teamChallengeBestRows();
      const header = ["队伍名称", "所在小组", "任务1最高分", "任务2最高分", "任务3最高分", "三项总分"];
      const data = rows.map(team => [
        team.teamName,
        team.group === "mixed" ? "分组不一致" : (GROUP_LABELS[team.group] || "—"),
        ...TEAM_SCORE_TASK_IDS.map(taskId => team.scores[taskId] ?? ""),
        team.totalScore
      ]);
      const content = `\uFEFF${[header, ...data].map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
      const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `blockly-各队三项最高分-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      say(`已导出 ${rows.length} 支队伍的三项最高分汇总。`, "success");
    } catch (error) { say(error.message || "导出失败。", "error"); }
    finally { button.disabled = false; }
  }

  function pageSlice(items, pageKey, infoSelector, previousSelector, nextSelector) {
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    state[pageKey] = Math.max(1, Math.min(pages, state[pageKey]));
    document.querySelector(infoSelector).textContent = `第 ${state[pageKey]}/${pages} 页 · 共 ${items.length} 条`;
    document.querySelector(previousSelector).disabled = state[pageKey] <= 1;
    document.querySelector(nextSelector).disabled = state[pageKey] >= pages;
    const start = (state[pageKey] - 1) * PAGE_SIZE;
    return items.slice(start, start + PAGE_SIZE);
  }

  function renderUsers() {
    const query = document.querySelector("#adminUserFilter").value.trim().toLocaleLowerCase("zh-CN");
    const group = document.querySelector("#adminUserGroupFilter").value;
    const users = state.users.filter(user => (
      (!query || `${user.username} ${user.teamName || ""}`.toLocaleLowerCase("zh-CN").includes(query))
      && (!group || user.group === group)
    ));
    const visible = pageSlice(users, "userPage", "#adminUsersPageInfo", "#adminUsersPrevious", "#adminUsersNext");
    usersBody.replaceChildren();
    if (!visible.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.textContent = "没有符合条件的用户。";
      row.append(cell);
      usersBody.append(row);
      return;
    }
    visible.forEach(user => {
      const row = document.createElement("tr");
      appendCell(row, user.username);
      appendCell(row, user.teamName || "—");
      appendCell(row, GROUP_LABELS[user.group] || "—");
      appendCell(row, user.role === "admin" ? "管理员" : "学生");
      appendCell(row, String(user.recordCount));
      appendCell(row, user.highestScore === null ? "—" : `${user.highestScore}/100`);
      usersBody.append(row);
    });
  }

  function filteredRecords() {
    const query = document.querySelector("#adminRecordFilter").value.trim().toLocaleLowerCase("zh-CN");
    const group = document.querySelector("#adminRecordGroupFilter").value;
    const taskId = document.querySelector("#adminRecordTaskFilter").value;
    const scope = document.querySelector("#adminRecordScope").value;
    const sort = document.querySelector("#adminRecordSort").value;
    let records = state.records.filter(record => {
      const user = record.user || {};
      const text = `${user.username || ""} ${user.teamName || ""}`.toLocaleLowerCase("zh-CN");
      return (!query || text.includes(query))
        && (!group || user.group === group)
        && (!taskId || record.taskId === taskId);
    });
    if (scope === "team-task-best") {
      const bestByTeamAndTask = new Map();
      records.forEach(record => {
        const teamKey = record.user?.teamName || record.user?.id || `record:${record.id}`;
        const key = `${teamKey}\u0000${record.taskId}`;
        const current = bestByTeamAndTask.get(key);
        if (!current || record.score > current.score || (record.score === current.score && Date.parse(record.submittedAt) > Date.parse(current.submittedAt))) {
          bestByTeamAndTask.set(key, record);
        }
      });
      records = [...bestByTeamAndTask.values()];
    }
    records.sort((left, right) => sort === "score"
      ? right.score - left.score || Date.parse(right.submittedAt) - Date.parse(left.submittedAt)
      : Date.parse(right.submittedAt) - Date.parse(left.submittedAt));
    return records;
  }

  function renderRecords() {
    const records = filteredRecords();
    const visible = pageSlice(records, "recordPage", "#adminRecordsPageInfo", "#adminRecordsPrevious", "#adminRecordsNext");
    recordsBody.replaceChildren();
    if (!visible.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 10;
      cell.textContent = "还没有符合条件的正式提交记录。";
      row.append(cell);
      recordsBody.append(row);
      return;
    }
    visible.forEach(record => {
      const user = record.user || {};
      const row = document.createElement("tr");
      appendCell(row, formatTime(record.submittedAt));
      appendCell(row, user.username || "已删除用户");
      appendCell(row, user.teamName || "—");
      appendCell(row, GROUP_LABELS[user.group] || "—");
      appendCell(row, record.taskName);
      appendCell(row, Number.isInteger(record.mapRevision) ? `修订 ${record.mapRevision}` : "旧版");
      appendCell(row, record.completed ? "已完成" : "未完成");
      appendCell(row, `${record.score}/100`);
      const capabilityCell = document.createElement("td");
      renderRuntimeCapabilities(capabilityCell, record);
      row.append(capabilityCell);
      const actionCell = document.createElement("td");
      const viewButton = document.createElement("button");
      viewButton.type = "button";
      viewButton.textContent = "查看程序";
      viewButton.addEventListener("click", () => void openRecordDetail(record.id));
      actionCell.append(viewButton);
      row.append(actionCell);
      recordsBody.append(row);
    });
  }

  function teamChallengeBestRows() {
    return teamScoreRules.buildTeamChallengeScores({
      users: state.users,
      records: state.records,
      taskIds: TEAM_SCORE_TASK_IDS,
      maximumScore: 100
    });
  }

  function renderTeamChallengeBest() {
    const rows = teamChallengeBestRows();
    const page = teamScoreRules.paginateTeamScores(rows, state.teamScorePage, 15);
    state.teamScorePage = page.page;
    teamScoreBody.replaceChildren();
    document.querySelector("#adminTeamChallengeBestLoading").hidden = true;
    document.querySelector("#adminTeamChallengeBestTableWrap").hidden = false;
    document.querySelector("#adminTeamChallengeBestPagination").hidden = false;
    document.querySelector("#adminTeamChallengeBestPageInfo").textContent = `第 ${page.start}–${page.end} 队，共 ${page.total} 队 · 第 ${page.page}/${page.totalPages} 页`;
    document.querySelector("#adminTeamChallengeBestPrevious").disabled = page.page <= 1;
    document.querySelector("#adminTeamChallengeBestNext").disabled = page.page >= page.totalPages;

    if (!page.items.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.textContent = "当前没有参赛队伍。";
      row.append(cell);
      teamScoreBody.append(row);
      return;
    }

    page.items.forEach(team => {
      const row = document.createElement("tr");
      appendCell(row, team.teamName);
      appendCell(row, team.group === "mixed" ? "分组不一致" : (GROUP_LABELS[team.group] || "—"));
      TEAM_SCORE_TASK_IDS.forEach(taskId => {
        const score = team.scores[taskId];
        appendCell(row, score === null ? "—" : `${score}/100`);
      });
      appendCell(row, `${team.totalScore}/300`);
      teamScoreBody.append(row);
    });
  }

  function renderSummary() {
    document.querySelector("#adminUserCount").textContent = String(state.users.filter(user => user.role !== "admin").length);
    document.querySelector("#adminRecordCount").textContent = String(state.records.length);
    const high = state.records.reduce((value, record) => Math.max(value, Number(record.score) || 0), 0);
    document.querySelector("#adminHighScore").textContent = state.records.length ? `${high}/100` : "—";
  }

  function selectedMap() {
    return state.maps.get(state.selectedTaskId) || null;
  }

  function mapPoint(layout, kind, index) {
    return kind === "storage" ? layout.storage : layout[kind][index];
  }

  function updateMapPoint(kind, index, coordinate, value) {
    const config = selectedMap();
    if (!config || !Number.isFinite(Number(value))) return;
    mapPoint(config.layout, kind, index)[coordinate] = Math.round(Number(value) * 10000) / 10000;
    state.mapDirty = true;
  }

  function markerEntries(config) {
    return [
      ...config.layout.checkpoints.map((point, index) => ({ kind: "checkpoints", type: "checkpoint", index, label: `途径点 ${index + 1}`, point })),
      ...config.layout.targets.map((point, index) => ({ kind: "targets", type: "target", index, label: `目标物 ${index + 1}`, point })),
      { kind: "storage", type: "storage", index: 0, label: "目标点", point: config.layout.storage },
      ...config.layout.distractors.map((point, index) => ({ kind: "distractors", type: "distractor", index, label: `混淆物 ${index + 1}`, point })),
      ...config.layout.obstacles.map((point, index) => ({ kind: "obstacles", type: "obstacle", index, label: `障碍物 ${index + 1}`, point }))
    ];
  }

  function markerPosition(marker, point) {
    marker.style.left = `${(point[0] - mapRules.MAP.minimumX) / (mapRules.MAP.maximumX - mapRules.MAP.minimumX) * 100}%`;
    marker.style.top = `${(point[1] - mapRules.MAP.minimumZ) / (mapRules.MAP.maximumZ - mapRules.MAP.minimumZ) * 100}%`;
  }

  function startMarkerDrag(event, entry, marker) {
    event.preventDefault();
    marker.setPointerCapture?.(event.pointerId);
    const move = moveEvent => {
      const rect = mapCanvas.getBoundingClientRect();
      const ratioX = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / rect.width));
      const ratioZ = Math.max(0, Math.min(1, (moveEvent.clientY - rect.top) / rect.height));
      updateMapPoint(entry.kind, entry.index, 0, mapRules.MAP.minimumX + ratioX * (mapRules.MAP.maximumX - mapRules.MAP.minimumX));
      updateMapPoint(entry.kind, entry.index, 1, mapRules.MAP.minimumZ + ratioZ * (mapRules.MAP.maximumZ - mapRules.MAP.minimumZ));
      markerPosition(marker, mapPoint(selectedMap().layout, entry.kind, entry.index));
    };
    const end = () => {
      marker.removeEventListener("pointermove", move);
      marker.removeEventListener("pointerup", end);
      marker.removeEventListener("pointercancel", end);
      renderMapEditor();
    };
    marker.addEventListener("pointermove", move);
    marker.addEventListener("pointerup", end);
    marker.addEventListener("pointercancel", end);
  }

  function addMapField(group, entry) {
    const label = document.createElement("label");
    const title = document.createElement("span");
    title.textContent = entry.label;
    const coordinates = document.createElement("span");
    coordinates.className = "primary-admin-coordinate-inputs";
    ["X", "Z"].forEach((axis, coordinate) => {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.1";
      input.min = coordinate === 0 ? String(mapRules.MAP.minimumX) : String(mapRules.MAP.minimumZ);
      input.max = coordinate === 0 ? String(mapRules.MAP.maximumX) : String(mapRules.MAP.maximumZ);
      input.value = String(entry.point[coordinate]);
      input.setAttribute("aria-label", `${entry.label} ${axis} 坐标`);
      input.addEventListener("change", () => {
        updateMapPoint(entry.kind, entry.index, coordinate, input.value);
        renderMapMarkers();
      });
      coordinates.append(input);
    });
    label.append(title, coordinates);
    group.append(label);
  }

  function renderMapMarkers() {
    mapCanvas.replaceChildren();
    const config = selectedMap();
    if (!config) return;
    markerEntries(config).forEach(entry => {
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = "primary-admin-map-marker";
      marker.dataset.kind = entry.type;
      marker.title = `${entry.label}（拖动修改）`;
      marker.textContent = entry.type === "checkpoint" ? String(entry.index + 1) : "";
      markerPosition(marker, entry.point);
      marker.addEventListener("pointerdown", event => startMarkerDrag(event, entry, marker));
      mapCanvas.append(marker);
    });
  }

  function renderMapEditor() {
    const config = selectedMap();
    mapFields.replaceChildren();
    renderMapMarkers();
    if (!config) return;
    document.querySelector("#adminMapRevision").textContent = `当前修订 ${config.revision} · 共 ${config.versionCount || 1} 个版本 · ${formatTime(config.updatedAt)}`;
    const entries = markerEntries(config);
    [["途径点（按编号依次通过）", entries.filter(entry => entry.type === "checkpoint")], ["任务物品", entries.filter(entry => entry.type !== "checkpoint")]]
      .forEach(([title, groupEntries]) => {
        const fieldset = document.createElement("fieldset");
        const legend = document.createElement("legend");
        legend.textContent = title;
        fieldset.append(legend);
        groupEntries.forEach(entry => addMapField(fieldset, entry));
        mapFields.append(fieldset);
      });
  }

  async function loadUsers() {
    const payload = await request("/api/admin/users");
    if (payload?.schemaVersion !== "chenlong.blockly-admin-users/v1" || !Array.isArray(payload.users)) throw new Error("用户数据格式不正确。 ");
    state.users = payload.users;
  }

  async function loadRecords() {
    const payload = await requestAllRecordPages("/api/admin/records", "chenlong.blockly-admin-records/v1");
    state.records = payload.records;
  }

  async function loadMaps() {
    const payload = await request("/api/admin/maps");
    if (payload?.schemaVersion !== "chenlong.blockly-admin-maps/v1" || !Array.isArray(payload.maps) || payload.maps.length !== 3) throw new Error("地图数据格式不正确。 ");
    state.maps = new Map(payload.maps.map(config => [config.taskId, { ...config, layout: mapRules.normalizeLayout(config.taskId, config.layout) }]));
    state.mapDirty = false;
    renderMapEditor();
  }

  async function saveMap() {
    const config = selectedMap();
    const button = document.querySelector("#saveAdminMap");
    if (!config) return;
    button.disabled = true;
    try {
      const layout = mapRules.normalizeLayout(config.taskId, config.layout);
      const payload = await request(`/api/admin/maps/${encodeURIComponent(config.taskId)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseRevision: config.revision, layout })
      });
      if (payload?.schemaVersion !== "chenlong.blockly-admin-map-save-receipt/v1" || payload.map?.taskId !== config.taskId) throw new Error("地图保存回执不完整。 ");
      state.maps.set(config.taskId, { ...payload.map, versionCount: (config.versionCount || 1) + 1, layout: mapRules.normalizeLayout(config.taskId, payload.map.layout) });
      state.mapDirty = false;
      renderMapEditor();
      say(`${payload.map.taskName} 已发布为修订 ${payload.map.revision}，学员下一次运行会自动同步。`, "success");
    } catch (error) { say(error.message, "error"); }
    finally { button.disabled = false; }
  }

  async function refresh(which = "all") {
    try {
      if (which === "all") await Promise.all(platformMode ? [loadUsers(), loadRecords()] : [loadUsers(), loadRecords(), loadMaps()]);
      if (which === "users") await loadUsers();
      if (which === "records") await loadRecords();
      if (which === "maps" && !platformMode) await loadMaps();
      renderSummary();
      renderUsers();
      renderRecords();
      renderTeamChallengeBest();
      say("");
    } catch (error) { say(error.message, "error"); }
  }

  function switchTab(name) {
    document.querySelectorAll("[data-admin-tab]").forEach(button => {
      const active = button.dataset.adminTab === name;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll("[data-admin-panel]").forEach(panel => { panel.hidden = panel.dataset.adminPanel !== name; });
  }

  async function initialize() {
    try {
      const payload = await request("/api/auth/me");
      if (payload?.user?.role !== "admin") throw new Error("需要管理员账号才能查看此页。 ");
      state.user = payload.user;
      document.querySelector("#adminIdentity").textContent = `管理员：${payload.user.username}`;
      if (platformMode) {
        const mapTab = document.querySelector('[data-admin-tab="maps"]');
        const mapPanel = document.querySelector('[data-admin-panel="maps"]');
        if (mapTab) mapTab.hidden = true;
        if (mapPanel) mapPanel.hidden = true;
        const headingCopy = document.querySelector(".primary-admin-heading span");
        if (headingCopy) headingCopy.textContent = "正式成绩、参赛队伍和积木程序集中管理；比赛地图请在统一平台编辑。";
      }
      await refresh();
    } catch (_error) { window.location.replace(loginLocation()); }
  }

  document.querySelectorAll("[data-admin-tab]").forEach(button => button.addEventListener("click", () => switchTab(button.dataset.adminTab)));
  document.querySelector("#refreshAdminUsers").addEventListener("click", () => void refresh("users"));
  document.querySelector("#refreshAdminRecords").addEventListener("click", () => void refresh("records"));
  document.querySelector("#refreshAdminMaps").addEventListener("click", () => void refresh("maps"));
  document.querySelector("#saveAdminMap").addEventListener("click", () => void saveMap());
  document.querySelector("#exportAdminUsers").addEventListener("click", event => void exportAdminData("users", event.currentTarget));
  document.querySelector("#exportAdminRecords").addEventListener("click", event => void exportAdminData("records", event.currentTarget));
  document.querySelector("#exportAdminTeamScores").addEventListener("click", event => exportTeamScores(event.currentTarget));
  document.querySelector("#closeAdminRecordDialog").addEventListener("click", closeRecordDialog);
  document.querySelector("#adminRecordDialog").addEventListener("click", event => { if (event.target === event.currentTarget) closeRecordDialog(); });
  ["#adminUserFilter", "#adminUserGroupFilter"].forEach(selector => document.querySelector(selector).addEventListener("input", () => { state.userPage = 1; renderUsers(); }));
  ["#adminRecordFilter", "#adminRecordGroupFilter", "#adminRecordTaskFilter", "#adminRecordScope", "#adminRecordSort"].forEach(selector => document.querySelector(selector).addEventListener("input", () => { state.recordPage = 1; renderRecords(); }));
  document.querySelector("#adminUsersPrevious").addEventListener("click", () => { state.userPage -= 1; renderUsers(); });
  document.querySelector("#adminUsersNext").addEventListener("click", () => { state.userPage += 1; renderUsers(); });
  document.querySelector("#adminRecordsPrevious").addEventListener("click", () => { state.recordPage -= 1; renderRecords(); });
  document.querySelector("#adminRecordsNext").addEventListener("click", () => { state.recordPage += 1; renderRecords(); });
  document.querySelector("#adminTeamChallengeBestPrevious").addEventListener("click", () => { state.teamScorePage -= 1; renderTeamChallengeBest(); });
  document.querySelector("#adminTeamChallengeBestNext").addEventListener("click", () => { state.teamScorePage += 1; renderTeamChallengeBest(); });
  document.querySelector("#adminMapTask").addEventListener("change", event => {
    if (state.mapDirty && !window.confirm("当前地图还没有保存，确定切换任务吗？")) {
      event.target.value = state.selectedTaskId;
      return;
    }
    state.selectedTaskId = event.target.value;
    state.mapDirty = false;
    renderMapEditor();
  });
  document.querySelector("#adminLogoutButton").addEventListener("click", async () => {
    try { await request("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" } }); } catch (_error) {}
    window.location.replace(loginLocation());
  });
  window.addEventListener("beforeunload", event => { if (state.mapDirty) { event.preventDefault(); event.returnValue = ""; } });
  if (window.lucide) window.lucide.createIcons();
  void initialize();
})();
