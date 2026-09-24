"use strict";

(() => {
  const $ = selector => document.querySelector(selector);
  const groups = { primary: "小学组", junior: "初中组", high: "高中组" };
  const taskIds = ["R2-GYI-MVP-01", "R2-GYI-MVP-02", "R2-GYI-MVP-03"];
  const PAGE_SIZE = 15;
  let scorePage = 1;
  let scoreTotalPages = 1;
  let scoreGroup = "";
  let userPage = 1;
  let users = [];
  let bestTeam = null;
  let readinessLoaded = false;

  const readinessLabels = {
    gateway: "统一入口",
    python: "Python 赛场",
    blockly: "Blockly 赛场",
    workshop: "识物工坊"
  };
  const workshopDivisionLabels = { primary: "小学组", junior: "初中组", senior: "高中组" };

  function fail(message) {
    $("#notice").hidden = false;
    $("#notice").textContent = message;
    $("#notice").dataset.kind = "error";
  }

  async function jsonRequest(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
    const payload = await response.json().catch(() => null);
    if (response.status === 401) {
      location.replace(`/login.html?returnTo=${encodeURIComponent("/admin.html")}`);
      throw new Error("请先登录。");
    }
    if (response.status === 403) {
      location.replace("/portal.html");
      throw new Error("需要管理员权限。");
    }
    if (!response.ok) throw new Error(payload?.error?.message || "后台数据读取失败。");
    return payload;
  }

  function readinessStatus(value) {
    return value === "ok" ? { kind: "ok", label: "正常" } : { kind: "error", label: "异常" };
  }

  function configurationStatus(value, enabledLabel, disabledLabel) {
    if (value === true) return { kind: "ok", label: enabledLabel };
    if (value === false) return { kind: "warning", label: disabledLabel };
    return { kind: "unknown", label: "无法确认" };
  }

  function statusItem(title, status, detail = "") {
    const item = document.createElement("article");
    item.className = "readiness-item";
    item.dataset.kind = status.kind;
    const heading = document.createElement("div");
    heading.append(textElement("strong", "", title), textElement("span", "readiness-badge", status.label));
    item.append(heading);
    if (detail) item.append(textElement("p", "", detail));
    return item;
  }

  function renderReadiness(payload) {
    const checks = payload?.checks || {};
    const configuration = payload?.configuration || {};
    const degraded = payload?.status !== "ok";
    $("#readinessSummary").textContent = degraded
      ? "发现服务或部署配置异常，请在比赛开始前处理。"
      : "四个服务均可访问；请同时确认下方公网部署配置。";
    $("#readinessSummary").dataset.kind = degraded ? "warning" : "ok";

    $("#readinessServices").replaceChildren(...Object.entries(readinessLabels).map(([key, label]) => {
      const status = readinessStatus(checks[key]?.status);
      const detail = status.kind === "ok" ? "服务响应正常" : "当前无法正常访问";
      return statusItem(label, status, detail);
    }));

    $("#readinessConfiguration").replaceChildren(
      statusItem(
        "公网访问地址",
        configurationStatus(configuration.publicOriginConfigured, "已配置", "未配置"),
        "用于跨子系统跳转和官网单点登录回跳。"
      ),
      statusItem(
        "反向代理信任",
        configurationStatus(configuration.trustedProxyConfigured, "已配置", "未配置"),
        "经 Nginx 或云代理部署时，应只信任实际代理地址。"
      ),
      statusItem(
        "官网单点登录",
        configurationStatus(configuration.officialSsoConfigured, "已启用", "未启用"),
        "未配置密钥时，官网无法安全跳转登录。"
      )
    );
  }

  function renderEvaluationSetReadiness(evaluationSets) {
    const configured = new Set((Array.isArray(evaluationSets) ? evaluationSets : [])
      .map(item => item?.division)
      .filter(division => Object.hasOwn(workshopDivisionLabels, division)));
    const missing = Object.keys(workshopDivisionLabels).filter(division => !configured.has(division));
    const complete = missing.length === 0;
    const status = complete
      ? { kind: "ok", label: "3/3 已配置" }
      : { kind: "warning", label: `${configured.size}/3 待补齐` };
    const detail = complete
      ? "小学组、初中组、高中组均已有保密评测集。"
      : `缺少：${missing.map(division => workshopDivisionLabels[division]).join("、")}。请进入识物工坊后台上传真实评测集。`;
    $("#evaluationSetReadiness").replaceChildren(statusItem("识物工坊评测集", status, detail));
  }

  async function loadReadiness() {
    const response = await fetch("/api/readiness", { credentials: "same-origin", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!payload || payload.schemaVersion !== "chenlong.competition-platform-readiness/v1") {
      throw new Error("平台状态接口返回异常，请检查统一入口服务。");
    }
    renderReadiness(payload);
    readinessLoaded = true;
  }

  function textElement(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value;
    return element;
  }

  function updateMetrics() {
    $("#metricUsers").textContent = String(users.length);
    $("#metricParticipants").textContent = String(users.filter(user => user.role !== "admin").length);
    if (bestTeam) {
      $("#metricBest").textContent = Number(bestTeam.totalScore).toFixed(0);
      $("#metricBestTeam").textContent = bestTeam.teamName;
    } else {
      $("#metricBest").textContent = "—";
      $("#metricBestTeam").textContent = "等待成绩";
    }
    $("#metrics").hidden = false;
  }

  function renderUsers() {
    const query = $("#userSearch").value.trim().toLocaleLowerCase("zh-CN");
    const group = $("#groupFilter").value;
    const role = $("#roleFilter").value;
    const filtered = users.filter(user => {
      const searchable = `${user.username} ${user.displayName || ""} ${user.teamName || ""}`.toLocaleLowerCase("zh-CN");
      return (!query || searchable.includes(query)) && (!group || user.group === group) && (!role || user.role === role);
    });
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    userPage = Math.min(Math.max(userPage, 1), totalPages);
    const visible = filtered.slice((userPage - 1) * PAGE_SIZE, userPage * PAGE_SIZE);

    $("#userRows").replaceChildren(...visible.map(user => {
      const row = document.createElement("tr");
      const identity = document.createElement("td");
      identity.className = "identity-cell";
      identity.append(textElement("strong", "", user.username), textElement("small", "", user.displayName || user.username));
      row.append(identity);

      if (user.role === "admin") {
        row.append(textElement("td", "", "—"), textElement("td", "", "—"));
      } else {
        const teamCell = document.createElement("td");
        const teamInput = document.createElement("input");
        teamInput.value = user.teamName || "";
        teamInput.maxLength = 64;
        teamInput.dataset.field = "team";
        teamInput.setAttribute("aria-label", `${user.username} 的队伍名称`);
        teamCell.append(teamInput);
        row.append(teamCell);

        const groupCell = document.createElement("td");
        const groupSelect = document.createElement("select");
        groupSelect.dataset.field = "group";
        groupSelect.setAttribute("aria-label", `${user.username} 的小组`);
        Object.entries(groups).forEach(([value, label]) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          groupSelect.append(option);
        });
        groupSelect.value = user.group;
        groupCell.append(groupSelect);
        row.append(groupCell);
      }

      const roleCell = document.createElement("td");
      const badge = textElement("span", "role-badge", user.role === "admin" ? "管理员" : "普通用户");
      badge.dataset.role = user.role;
      roleCell.append(badge);
      row.append(roleCell);

      const action = document.createElement("td");
      action.className = "save-cell";
      if (user.role === "admin") {
        action.textContent = "—";
      } else {
        const button = textElement("button", "", "保存修改");
        button.type = "button";
        const status = textElement("span", "save-status", "");
        button.addEventListener("click", async () => {
          button.disabled = true;
          status.dataset.kind = "";
          status.textContent = "保存中…";
          try {
            const requestedTeamName = row.querySelector('[data-field="team"]').value.trim();
            const requestedGroup = row.querySelector('[data-field="group"]').value;
            const updated = await jsonRequest(`/api/platform/admin/users/${encodeURIComponent(user.id)}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ teamName: requestedTeamName, group: requestedGroup })
            });
            const fresh = updated.user || updated;
            const teamName = fresh.teamName || requestedTeamName;
            const newGroup = fresh.group || requestedGroup;
            users.forEach(member => {
              if (member.teamId && member.teamId === user.teamId) {
                member.teamName = teamName;
                member.group = newGroup;
              }
            });
            user.teamName = teamName;
            user.group = newGroup;
            renderUsers();
            await loadScores({ preservePage: true });
          } catch (error) {
            status.dataset.kind = "error";
            status.textContent = error.message;
          } finally {
            button.disabled = false;
          }
        });
        action.append(button, status);
      }
      row.append(action);
      return row;
    }));

    const start = filtered.length ? (userPage - 1) * PAGE_SIZE + 1 : 0;
    const end = Math.min(userPage * PAGE_SIZE, filtered.length);
    $("#userPageInfo").textContent = `第 ${start}–${end} 个，共 ${filtered.length} 个用户 · 第 ${userPage}/${totalPages} 页`;
    $("#userPrev").disabled = userPage <= 1;
    $("#userNext").disabled = userPage >= totalPages;
  }

  async function loadUsers() {
    const payload = await jsonRequest("/api/platform/admin/users");
    users = payload.users || [];
    renderUsers();
    updateMetrics();
  }

  function scoreBadge(value) {
    const missing = value == null;
    return textElement("span", `score-value${missing ? " missing" : ""}`, missing ? "—" : Number(value).toFixed(2));
  }

  function teamRow(team, index) {
    const row = document.createElement("tr");
    const rank = (scorePage - 1) * PAGE_SIZE + index + 1;
    const rankCell = textElement("td", "rank-cell", String(rank));
    if (rank <= 3) rankCell.dataset.medal = String(rank);
    row.append(rankCell);

    const identity = document.createElement("td");
    identity.className = "team-cell";
    identity.append(textElement("strong", "", team.teamName), textElement("small", "", groups[team.group] || team.group || "未设置小组"));
    row.append(identity);

    [team.taskScores.task1, team.taskScores.task2, team.taskScores.task3, team.workshopScore].forEach(value => {
      const cell = document.createElement("td");
      cell.append(scoreBadge(value));
      row.append(cell);
    });

    const totalCell = document.createElement("td");
    totalCell.append(textElement("strong", "total-score", Number(team.totalScore).toFixed(0)));
    row.append(totalCell);

    const mapsCell = document.createElement("td");
    const mapList = document.createElement("div");
    mapList.className = "map-list";
    (team.maps || []).forEach(map => {
      const taskNumber = taskIds.indexOf(map.taskId) + 1;
      mapList.append(textElement("span", "map-tag", `任务${taskNumber || "?"} · 第${map.variantNumber}套`));
    });
    if (!mapList.children.length) mapList.append(textElement("span", "score-value missing", "未分配"));
    mapsCell.append(mapList);
    row.append(mapsCell);
    return row;
  }

  async function loadScores({ preservePage = false } = {}) {
    if (!preservePage) scorePage = Math.max(1, scorePage);
    const query = new URLSearchParams({ page: String(scorePage) });
    if (scoreGroup) query.set("group", scoreGroup);
    const payload = await jsonRequest(`/api/platform/admin/overview?${query}`);
    renderEvaluationSetReadiness(payload.evaluationSets);
    scorePage = payload.pagination.page;
    scoreTotalPages = payload.pagination.totalPages;
    $("#rows").replaceChildren(...payload.teams.map(teamRow));
    if (scorePage === 1) bestTeam = payload.teams[0] || null;
    $("#metricTeams").textContent = String(payload.pagination.unfilteredTotal ?? payload.pagination.total);
    updateMetrics();
    const start = payload.pagination.total ? (scorePage - 1) * PAGE_SIZE + 1 : 0;
    const end = Math.min(scorePage * PAGE_SIZE, payload.pagination.total);
    $("#pageInfo").textContent = `第 ${start}–${end} 队，共 ${payload.pagination.total} 队 · 第 ${scorePage}/${scoreTotalPages} 页`;
    $("#prev").disabled = scorePage <= 1;
    $("#next").disabled = scorePage >= scoreTotalPages;
  }

  function activateTab(name, { updateHash = true } = {}) {
    const selected = ["scores", "users", "systems"].includes(name) ? name : "scores";
    document.querySelectorAll("[data-admin-tab]").forEach(button => {
      const active = button.dataset.adminTab === selected;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll("[data-admin-panel]").forEach(panel => {
      panel.hidden = panel.dataset.adminPanel !== selected;
    });
    if (selected === "systems" && !readinessLoaded) {
      loadReadiness().catch(error => {
        $("#readinessSummary").textContent = error.message;
        $("#readinessSummary").dataset.kind = "warning";
      });
    }
    if (updateHash) history.replaceState(null, "", `#${selected}`);
  }

  async function refresh(button, loader) {
    button.disabled = true;
    try { await loader(); }
    catch (error) { fail(error.message); }
    finally { button.disabled = false; }
  }

  document.querySelectorAll("[data-admin-tab]").forEach(button => {
    button.addEventListener("click", () => activateTab(button.dataset.adminTab));
  });
  $("#userSearch").addEventListener("input", () => { userPage = 1; renderUsers(); });
  $("#groupFilter").addEventListener("change", () => { userPage = 1; renderUsers(); });
  $("#roleFilter").addEventListener("change", () => { userPage = 1; renderUsers(); });
  $("#scoreGroupFilter").addEventListener("change", event => {
    scoreGroup = event.currentTarget.value;
    scorePage = 1;
    loadScores().catch(error => fail(error.message));
  });
  $("#userPrev").addEventListener("click", () => { userPage -= 1; renderUsers(); });
  $("#userNext").addEventListener("click", () => { userPage += 1; renderUsers(); });
  $("#prev").addEventListener("click", () => { scorePage -= 1; loadScores().catch(error => fail(error.message)); });
  $("#next").addEventListener("click", () => { scorePage += 1; loadScores().catch(error => fail(error.message)); });
  $("#refreshUsers").addEventListener("click", event => refresh(event.currentTarget, loadUsers));
  $("#refreshScores").addEventListener("click", event => refresh(event.currentTarget, () => loadScores({ preservePage: true })));
  $("#refreshReadiness").addEventListener("click", event => refresh(event.currentTarget, loadReadiness));
  $("#logoutButton").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await jsonRequest("/api/v1/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}"
      });
      location.replace("/login.html?message=已退出登录。");
    } catch (error) {
      fail(error.message);
      button.disabled = false;
    }
  });

  activateTab(location.hash.slice(1), { updateHash: false });
  Promise.all([
    jsonRequest("/api/platform/me").then(payload => { $("#currentAdminName").textContent = payload.user.displayName || payload.user.username; }),
    loadUsers(),
    loadScores()
  ]).then(() => {
    $("#notice").hidden = true;
  }).catch(error => fail(error.message));
})();
