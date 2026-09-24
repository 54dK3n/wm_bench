"use strict";

(() => {
  const RECORDS_ENDPOINT = "/api/v1/records";
  const RECORDS_SCHEMA_VERSION = "chenlong.records/v1";
  const RECORD_DETAIL_SCHEMA_VERSION = "chenlong.record-detail/v1";
  const RECORD_SUBMIT_RECEIPT_SCHEMA_VERSION = "chenlong.record-submit-receipt/v1";
  const VERIFICATION_REPORT_SCHEMA_VERSION = "chenlong.verification-report/v1";
  const MAX_RECORDS = 10000;
  const RECORD_PAGE_SIZE = 250;
  const MAX_RECORD_BYTES = 40 * 1024 * 1024;
  const MAX_SOURCE_CODE_CHARACTERS = 128 * 1024;
  const MAX_VERIFICATION_REPORT_CHARACTERS = 1024 * 1024;
  const SCORE_MAXIMUM = 100;
  const SUBMISSION_ID_PATTERN = /^sub_[a-f0-9]{32}$/;
  const SESSION_ID_PATTERN = /^ses_[a-f0-9]{32}$/;
  const RUN_ID_PATTERN = /^run_[a-f0-9]{32}$/;
  const USER_ID_PATTERN = /^usr_[a-f0-9]{32}$/;
  const SHA256_PATTERN = /^[a-f0-9]{64}$/;
  const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
  const TEAM_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
  const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
  const PARTICIPANT_GROUP_VALUES = Object.freeze(["primary", "junior", "high"]);
  const RECORD_SUMMARY_KEYS = Object.freeze([
    "id", "submissionId", "sessionId", "runId", "ownerUserId", "teamId", "taskId",
    "taskName", "score", "scoreMaximum", "status", "verification", "recordState", "savedAt", "submittedAt",
    "receivedAt", "challengeDigest", "recordSha256", "recordByteLength", "authoritative", "user"
  ]);
  const PUBLIC_USER_KEYS = Object.freeze([
    "id", "username", "displayName", "teamName", "group", "role", "createdAt"
  ]);
  const VERIFICATION_SUMMARY_KEYS = Object.freeze([
    "status", "reasonCodes", "visionStatus", "verificationScope"
  ]);
  const state = {
    records: [],
    query: "",
    status: "all",
    loading: false,
    submitting: new Set()
  };

  const tableBody = document.querySelector("#recordsTableBody");
  const tableWrap = document.querySelector("#recordTableWrap");
  const loadingState = document.querySelector("#recordsLoading");
  const emptyState = document.querySelector("#recordsEmpty");
  const errorState = document.querySelector("#recordsError");
  const errorMessageElement = document.querySelector("#recordsErrorMessage");
  const refreshButton = document.querySelector("#refreshRecordsButton");
  const dialog = document.querySelector("#recordDetailDialog");
  const detailContent = document.querySelector("#recordDetailContent");
  const notice = document.querySelector("#recordsNotice");
  const bestSubmissionHint = document.querySelector("#bestSubmissionHint");

  function safeText(value, fallback = "—") {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return fallback;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function hasExactKeys(value, expectedKeys) {
    if (!isPlainObject(value)) return false;
    const actualKeys = Object.keys(value).sort();
    const sortedExpectedKeys = [...expectedKeys].sort();
    return actualKeys.length === sortedExpectedKeys.length
      && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
  }

  function compatibleDataError(message = "比赛记录服务返回的数据格式不兼容。") {
    const error = new Error(message);
    error.code = "INCOMPATIBLE_RECORD_DATA";
    return error;
  }

  function validIsoTimestamp(value) {
    if (typeof value !== "string") return false;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  }

  function validVisibleText(value, maximum, { nullable = false } = {}) {
    if (nullable && value === null) return true;
    if (typeof value !== "string" || value !== value.trim() || value !== value.normalize("NFC")) return false;
    const length = [...value].length;
    return length >= 1 && length <= maximum && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
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
        throw compatibleDataError("比赛记录缺少对应的账户信息。");
      }
      return null;
    }
    if (!hasExactKeys(value, PUBLIC_USER_KEYS)
      || !USER_ID_PATTERN.test(value.id || "")
      || value.id !== expectedOwnerUserId
      || !USERNAME_PATTERN.test(value.username || "")
      || !validVisibleText(value.displayName, 64)
      || !validVisibleText(value.teamName, 64, { nullable: true })
      || !PARTICIPANT_GROUP_VALUES.includes(value.group)
      || !["user", "admin"].includes(value.role)
      || !validIsoTimestamp(value.createdAt)) {
      throw compatibleDataError("比赛记录中的账户信息格式不兼容。");
    }
    return value;
  }

  function validateVerificationSummary(value, recordState) {
    if (!hasExactKeys(value, VERIFICATION_SUMMARY_KEYS)
      || !hasExactKeys(value.verificationScope, ["deterministic", "vision"])
      || !hasExactKeys(value.verificationScope.deterministic, ["status"])
      || !validateReasonCodes(value.reasonCodes)) {
      throw compatibleDataError("比赛记录中的校验摘要格式不兼容。");
    }
    const deterministicStatus = value.verificationScope.deterministic.status;
    const visionStatus = value.visionStatus;
    if (value.verificationScope.vision !== visionStatus) {
      throw compatibleDataError("比赛记录中的视觉校验状态不一致。");
    }
    if (recordState === "saved") {
      if (value.status !== "pending" || value.reasonCodes.length !== 0
        || deterministicStatus !== "unknown" || visionStatus !== "unknown") {
        throw compatibleDataError("待提交记录包含了不合法的校验状态。");
      }
    } else if (!["verified", "partial", "invalid", "error", "unknown"].includes(value.status)
      || !["complete", "incomplete", "unknown"].includes(deterministicStatus)
      || !["not_used", "not_recomputed", "matched", "unknown"].includes(visionStatus)) {
      throw compatibleDataError("已提交记录包含了无法识别的校验状态。");
    }
    return {
      status: value.status,
      deterministicStatus,
      visionStatus,
      reasonCodes: [...value.reasonCodes]
    };
  }

  function normalizeRecord(value) {
    if (!hasExactKeys(value, RECORD_SUMMARY_KEYS)
      || !SUBMISSION_ID_PATTERN.test(value.id || "")
      || !SESSION_ID_PATTERN.test(value.sessionId || "")
      || !RUN_ID_PATTERN.test(value.runId || "")
      || (value.ownerUserId !== null && !USER_ID_PATTERN.test(value.ownerUserId || ""))
      || !TEAM_ID_PATTERN.test(value.teamId || "")
      || !TASK_ID_PATTERN.test(value.taskId || "")
      || !validVisibleText(value.taskName, 256)
      || value.scoreMaximum !== SCORE_MAXIMUM
      || !(value.score === null || (typeof value.score === "number" && Number.isFinite(value.score)
        && value.score >= 0 && value.score <= SCORE_MAXIMUM))
      || !["saved", "submitted"].includes(value.recordState)
      || !validIsoTimestamp(value.savedAt)
      || !validIsoTimestamp(value.receivedAt)
      || value.receivedAt !== value.savedAt
      || !SHA256_PATTERN.test(value.challengeDigest || "")
      || !SHA256_PATTERN.test(value.recordSha256 || "")
      || !Number.isSafeInteger(value.recordByteLength)
      || value.recordByteLength < 1
      || value.recordByteLength > MAX_RECORD_BYTES
      || value.authoritative !== false) {
      throw compatibleDataError("比赛记录条目的格式不兼容。");
    }
    if (value.recordState === "saved") {
      if (value.submissionId !== null || value.status !== "pending" || value.submittedAt !== null) {
        throw compatibleDataError("待提交记录的状态字段不一致。");
      }
    } else if (value.submissionId !== value.id
      || !validIsoTimestamp(value.submittedAt)
      || Date.parse(value.savedAt) > Date.parse(value.submittedAt)) {
      throw compatibleDataError("已提交记录的状态字段不一致。");
    }
    const verification = validateVerificationSummary(value.verification, value.recordState);
    if (value.status !== verification.status) {
      throw compatibleDataError("比赛记录与校验摘要的状态不一致。");
    }
    const user = validatePublicUser(value.user, value.ownerUserId);
    return {
      raw: value,
      id: value.id,
      submissionId: value.submissionId,
      sessionId: value.sessionId,
      teamId: value.teamId,
      teamName: user ? safeText(user.teamName ?? user.username, "未填写") : "未填写",
      taskId: value.taskId,
      taskName: value.taskName,
      score: value.score,
      scoreMaximum: value.scoreMaximum,
      recordState: value.recordState,
      status: verification.status,
      deterministicStatus: verification.deterministicStatus,
      visionStatus: verification.visionStatus,
      reasonCodes: verification.reasonCodes,
      savedAt: value.savedAt,
      submittedAt: value.submittedAt,
      authoritative: value.authoritative
    };
  }

  function validateRecordsResponse(payload) {
    const paged = hasExactKeys(payload, ["schemaVersion", "records", "authoritative", "pagination"]);
    if ((!paged && !hasExactKeys(payload, ["schemaVersion", "records", "authoritative"]))
      || payload.schemaVersion !== RECORDS_SCHEMA_VERSION
      || payload.authoritative !== false
      || !Array.isArray(payload.records)
      || payload.records.length > MAX_RECORDS) {
      throw compatibleDataError("比赛记录列表响应格式不兼容。");
    }
    if (paged && (!hasExactKeys(payload.pagination, ["page", "pageSize", "total", "totalPages", "hasNext"])
      || !Number.isSafeInteger(payload.pagination.page) || payload.pagination.page < 1
      || !Number.isSafeInteger(payload.pagination.pageSize) || payload.pagination.pageSize < 1
      || !Number.isSafeInteger(payload.pagination.total) || payload.pagination.total < 0 || payload.pagination.total > MAX_RECORDS
      || !Number.isSafeInteger(payload.pagination.totalPages) || payload.pagination.totalPages < 1
      || typeof payload.pagination.hasNext !== "boolean")) throw compatibleDataError("比赛记录分页信息不兼容。");
    const seenIds = new Set();
    const records = payload.records.map((item, index) => {
      try {
        const record = normalizeRecord(item);
        if (seenIds.has(record.id)) throw compatibleDataError("比赛记录列表包含重复编号。");
        seenIds.add(record.id);
        return record;
      } catch (error) {
        if (error?.code === "INCOMPATIBLE_RECORD_DATA") {
          throw compatibleDataError(`比赛记录列表第 ${index + 1} 条数据格式不兼容。`);
        }
        throw error;
      }
    });
    return records;
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
    if (value.status !== "error") {
      if (!validateReasonCodes(value.reasonCodes, 64)
        || !hasExactKeys(value.verificationScope, ["deterministic", "vision"])
        || !isPlainObject(value.verificationScope.deterministic)
        || !["complete", "incomplete"].includes(value.verificationScope.deterministic.status)
        || !["not_used", "not_recomputed", "matched"].includes(value.visionStatus)
        || value.verificationScope.vision !== value.visionStatus) {
        throw compatibleDataError("正式校验报告的状态范围不兼容。");
      }
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
      throw compatibleDataError("比赛记录详情响应格式不兼容。");
    }
    const record = normalizeRecord(payload.record);
    if (record.id !== requestedRecordId) {
      throw compatibleDataError("比赛记录详情与请求的记录编号不一致。");
    }
    if (record.recordState === "saved") {
      if (payload.verification !== null) throw compatibleDataError("待提交记录不应包含正式校验报告。");
    } else {
      const report = validateVerificationReport(payload.verification);
      if (report.status !== record.status) {
        throw compatibleDataError("比赛记录详情与正式校验报告的状态不一致。");
      }
    }
    return { record, verification: payload.verification, sourceCode: payload.sourceCode };
  }

  function validateRecordSubmitReceipt(payload, record) {
    if (!hasExactKeys(payload, [
      "schemaVersion", "recordId", "submissionId", "sessionId", "submittedAt", "duplicate",
      "recordState", "verification", "authoritative"
    ])
      || payload.schemaVersion !== RECORD_SUBMIT_RECEIPT_SCHEMA_VERSION
      || payload.recordId !== record.id
      || payload.submissionId !== record.id
      || !SESSION_ID_PATTERN.test(payload.sessionId || "")
      || payload.sessionId !== record.sessionId
      || !validIsoTimestamp(payload.submittedAt)
      || Date.parse(payload.submittedAt) < Date.parse(record.savedAt)
      || typeof payload.duplicate !== "boolean"
      || payload.recordState !== "submitted"
      || payload.authoritative !== false) {
      throw compatibleDataError("记录提交回执格式不兼容。");
    }
    validateVerificationReport(payload.verification);
    return payload;
  }

  function formatDate(value, { compact = false } = {}) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-CN", compact
      ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
      : {
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
        }
    ).format(date);
  }

  function scoreText(score) {
    return Number.isFinite(score) ? `${score.toFixed(1)} / ${SCORE_MAXIMUM}` : `— / ${SCORE_MAXIMUM}`;
  }

  function statusLabel(record) {
    if (record.recordState === "saved") return "提交后自动校验";
    return ({
      verified: "校验通过",
      partial: record.deterministicStatus === "incomplete" ? "校验不完整" : "旧记录校验不完整",
      invalid: "校验失败",
      error: "校验出错",
      failed: "处理失败",
      pending: "处理中",
      unknown: "状态未知"
    })[record.status] || "状态未知";
  }

  function recordStateLabel(record) {
    return record.recordState === "saved" ? "已保存，待提交" : "已提交";
  }

  function deterministicScopeLabel(record) {
    if (record.recordState === "saved") return "尚未提交，不执行正式重算";
    return ({
      complete: "控制、物理、交互、任务、规则与计分均已重算",
      incomplete: "确定性重算未覆盖全部范围",
      unknown: "旧记录未声明校验范围"
    })[record.deterministicStatus] || "旧记录未声明校验范围";
  }

  function visionScopeLabel(record) {
    if (record.recordState === "saved") return "尚未提交，不执行视觉重算";
    return ({
      not_used: "未使用视觉识别",
      not_recomputed: "视觉识别结果未重算",
      matched: "视觉识别结果已重算并匹配",
      unknown: "旧记录未声明视觉校验范围"
    })[record.visionStatus] || "旧记录未声明视觉校验范围";
  }

  function showNotice(message, kind = "normal") {
    notice.textContent = message;
    notice.dataset.kind = kind;
    notice.hidden = !message;
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      method: options.method || "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    const payload = (response.headers.get("content-type") || "").toLowerCase().includes("application/json")
      ? await response.json().catch(() => null)
      : null;
    if (response.status === 401 || response.status === 403) {
      window.location.replace(`/login.html?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
      return new Promise(() => {});
    }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
      error.code = payload?.error?.code || "REQUEST_FAILED";
      throw error;
    }
    if (payload?.authoritative !== false) throw new Error("服务返回了无法识别的记录响应");
    return payload;
  }

  function setLoadState(name) {
    loadingState.hidden = name !== "loading";
    emptyState.hidden = name !== "empty";
    errorState.hidden = name !== "error";
    tableWrap.hidden = name !== "table";
  }

  function updateMetrics() {
    const scores = state.records.map(record => record.score).filter(Number.isFinite);
    const best = scores.length ? Math.max(...scores) : null;
    const latest = [...state.records].sort((left, right) => (
      Date.parse(right.savedAt) - Date.parse(left.savedAt)
    ))[0];
    document.querySelector("#metricTotal").textContent = String(state.records.length);
    document.querySelector("#metricBest").textContent = best === null ? "—" : `${best.toFixed(1)} / ${SCORE_MAXIMUM}`;
    document.querySelector("#metricPending").textContent = String(
      state.records.filter(record => record.recordState === "saved").length
    );
    document.querySelector("#metricLatest").textContent = latest
      ? formatDate(latest.savedAt, { compact: true })
      : "—";
    document.querySelector("#metricLatestDate").textContent = latest ? latest.taskName : "暂无记录";
    updateBestSubmissionHint();
  }

  function updateBestSubmissionHint() {
    const pending = state.records.filter(record => (
      record.recordState === "saved" && Number.isFinite(record.score)
    ));
    if (!pending.length) {
      bestSubmissionHint.hidden = true;
      bestSubmissionHint.textContent = "";
      return;
    }
    const score = Math.max(...pending.map(record => record.score));
    const highest = pending.filter(record => record.score === score);
    const taskName = highest[0].taskName;
    bestSubmissionHint.textContent = highest.length === 1
      ? `建议优先提交最高分的待提交记录：${taskName}，${scoreText(score)}。`
      : `有 ${highest.length} 条待提交记录并列最高分：${scoreText(score)}，可任选一条优先提交。`;
    bestSubmissionHint.hidden = false;
  }

  function appendCell(row, label, content) {
    const cell = document.createElement("td");
    cell.dataset.label = label;
    if (content instanceof Node) cell.append(content);
    else cell.textContent = String(content);
    row.append(cell);
  }

  function badge(text, status) {
    const element = document.createElement("span");
    element.className = "status-badge";
    element.dataset.status = status;
    element.textContent = text;
    return element;
  }

  function actionButton(record, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action === "submit" ? "table-action table-submit-action" : "table-action";
    button.dataset.recordId = record.id;
    button.dataset.recordAction = action;
    const submitting = state.submitting.has(record.id);
    if (action === "submit") {
      button.disabled = submitting;
      button.setAttribute("aria-busy", String(submitting));
    }
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", action === "submit" ? "send" : "panel-right-open");
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = action === "submit"
      ? submitting ? "提交中" : "提交"
      : "详情";
    button.append(icon, label);
    return button;
  }

  function renderTable() {
    const query = state.query.trim().toLocaleLowerCase("zh-CN");
    const visible = state.records.filter(record => {
      const stateMatches = state.status === "all" || record.recordState === state.status;
      const haystack = `${record.id} ${record.submissionId} ${record.taskId} ${record.taskName} ${record.teamId} ${record.teamName}`
        .toLocaleLowerCase("zh-CN");
      return stateMatches && (!query || haystack.includes(query));
    });

    tableBody.replaceChildren();
    if (!state.records.length) {
      setLoadState("empty");
      return;
    }
    setLoadState("table");
    for (const record of visible) {
      const row = document.createElement("tr");
      const identity = document.createElement("div");
      identity.className = "record-id";
      const idLabel = document.createElement("strong");
      idLabel.textContent = record.id || "未编号记录";
      const session = document.createElement("code");
      session.textContent = record.sessionId ? `场次 ${record.sessionId}` : "本地记录";
      identity.append(idLabel, session);
      appendCell(row, "记录", identity);
      appendCell(row, "任务", record.taskName);

      const score = document.createElement("span");
      score.className = "score-value";
      score.textContent = scoreText(record.score);
      appendCell(row, "评分", score);
      appendCell(row, "记录状态", badge(
        recordStateLabel(record),
        record.recordState === "saved" ? "pending" : "completed"
      ));
      appendCell(row, "校验状态", badge(statusLabel(record), record.status));
      appendCell(row, "运行时间", formatDate(record.savedAt));

      const actions = document.createElement("div");
      actions.className = "record-row-actions";
      if (record.recordState === "saved" && SUBMISSION_ID_PATTERN.test(record.id)
        && record.submissionId === null) {
        actions.append(actionButton(record, "submit"));
      }
      actions.append(actionButton(record, "detail"));
      appendCell(row, "操作", actions);
      tableBody.append(row);
    }

    if (!visible.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.className = "records-state";
      cell.textContent = "没有符合当前筛选条件的记录。";
      row.append(cell);
      tableBody.append(row);
    }
    globalThis.lucide?.createIcons();
  }

  async function submitRecord(recordId) {
    const record = state.records.find(item => item.id === recordId);
    if (!record || record.recordState !== "saved" || state.submitting.has(recordId)) return;
    state.submitting.add(recordId);
    showNotice(`正在提交 ${recordId.slice(-8)}，系统会进行正式校验…`);
    renderTable();
    try {
      const payload = await requestJson(`${RECORDS_ENDPOINT}/${encodeURIComponent(recordId)}/submit`, {
        method: "POST",
        body: {}
      });
      validateRecordSubmitReceipt(payload, record);
      showNotice(`记录 ${recordId.slice(-8)} 已提交。`, "success");
      await loadRecords({ preserveNotice: true });
    } catch (error) {
      showNotice(`提交失败：${error instanceof Error ? error.message : "请稍后重试"}`, "error");
    } finally {
      state.submitting.delete(recordId);
      renderTable();
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
    detailContent.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "page-notice";
    loading.textContent = "正在读取记录详情…";
    detailContent.append(loading);
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
      const detail = validateRecordDetailResponse(payload, recordId);
      const record = detail.record;
      const grid = document.createElement("div");
      grid.className = "detail-grid";
      grid.append(
        detailItem("记录编号", record.id || "—"),
        detailItem("场次编号", record.sessionId || "—"),
        detailItem("队伍名称", record.teamName),
        detailItem("任务", record.taskName),
        detailItem("评分", scoreText(record.score)),
        detailItem("记录状态", recordStateLabel(record)),
        detailItem("校验状态", statusLabel(record)),
        detailItem("确定性校验", deterministicScopeLabel(record)),
        detailItem("视觉校验", visionScopeLabel(record)),
        detailItem("自动保存时间", formatDate(record.savedAt)),
        detailItem("提交时间", record.submittedAt ? formatDate(record.submittedAt) : "尚未提交")
      );
      const reportTitle = document.createElement("h3");
      reportTitle.className = "detail-report-title";
      reportTitle.textContent = record.recordState === "saved" ? "提交说明" : "重算与校验报告";
      const report = document.createElement("pre");
      report.className = "detail-json";
      report.textContent = record.recordState === "saved"
        ? "这条运行记录已自动保存，但尚未正式提交。点击列表中的“提交”后，系统才会执行正式校验。"
        : JSON.stringify(detail.verification, null, 2);
      const sourceTitle = document.createElement("h3");
      sourceTitle.className = "detail-report-title";
      sourceTitle.textContent = "本次运行的 Python 代码";
      const sourceCode = document.createElement("pre");
      sourceCode.className = "detail-json detail-source-code";
      sourceCode.textContent = detail.sourceCode || "# 本次运行没有 Python 代码";
      detailContent.replaceChildren(grid, reportTitle, report, sourceTitle, sourceCode);
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

  async function loadRecords({ preserveNotice = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    setLoadState("loading");
    refreshButton.disabled = true;
    if (!preserveNotice) showNotice("");
    try {
      const records = [];
      for (let page = 1; ; page += 1) {
        const payload = await requestJson(`${RECORDS_ENDPOINT}?page=${page}&pageSize=${RECORD_PAGE_SIZE}`);
        const current = validateRecordsResponse(payload);
        if (payload.pagination && payload.pagination.page !== page) throw compatibleDataError("比赛记录分页顺序不兼容。");
        records.push(...current);
        if (!payload.pagination || !payload.pagination.hasNext) break;
      }
      state.records = records;
      updateMetrics();
      renderTable();
      const recordId = new URLSearchParams(window.location.search).get("id");
      if (recordId) await openDetail(recordId, { updateUrl: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : "请稍后重试。";
      if (state.records.length) {
        renderTable();
        showNotice(`刷新失败：${message} 已保留上一次成功读取的记录。`, "error");
      } else {
        errorMessageElement.textContent = message;
        setLoadState("error");
      }
    } finally {
      state.loading = false;
      refreshButton.disabled = false;
    }
  }

  document.querySelector("#recordSearch").addEventListener("input", event => {
    state.query = event.target.value;
    renderTable();
  });
  document.querySelector("#recordStatusFilter").addEventListener("change", event => {
    state.status = event.target.value;
    renderTable();
  });
  refreshButton.addEventListener("click", () => loadRecords());
  tableBody.addEventListener("click", event => {
    const button = event.target.closest("button[data-record-action][data-record-id]");
    if (!button) return;
    if (button.dataset.recordAction === "submit") void submitRecord(button.dataset.recordId);
    else void openDetail(button.dataset.recordId);
  });
  document.querySelector("#closeRecordDetailButton").addEventListener("click", () => closeDetail());
  dialog.addEventListener("click", event => {
    if (event.target === dialog) closeDetail();
  });
  dialog.addEventListener("cancel", event => {
    event.preventDefault();
    closeDetail();
  });
  window.addEventListener("popstate", () => {
    const recordId = new URLSearchParams(window.location.search).get("id");
    if (recordId) void openDetail(recordId, { updateUrl: false });
    else closeDetail({ updateUrl: false });
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted) void loadRecords();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void loadRecords();
  });

  if (new URLSearchParams(window.location.search).get("forbidden") === "1") {
    showNotice("当前账户没有管理后台权限。", "error");
  }

  Promise.resolve(globalThis.chenlongAuthReady).then(() => loadRecords());
  globalThis.lucide?.createIcons();
})();
