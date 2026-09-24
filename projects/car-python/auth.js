"use strict";

(() => {
  const ENDPOINTS = Object.freeze({
    me: "/api/v1/auth/me",
    login: "/api/v1/auth/login",
    register: "/api/v1/auth/register"
  });
  const ERROR_MESSAGES = Object.freeze({
    INVALID_USERNAME: "用户名需为 3–32 位字母、数字、点、下划线或短横线，且以字母或数字开头。",
    INVALID_DISPLAY_NAME: "显示名称需为 1–64 个可见字符。",
    INVALID_TEAM_NAME: "队伍名称需为 1–64 个可见字符。",
    TEAM_NAME_TAKEN: "这个队伍名称已被使用，请创建一个不同的名称，或向队友索取邀请码加入。",
    INVALID_TEAM_ACTION: "请选择创建新队伍或加入已有队伍。",
    INVALID_TEAM_INVITE_CODE: "请输入正确的 8 位队伍邀请码。",
    TEAM_INVITE_NOT_FOUND: "未找到这个邀请码对应的队伍，请向队友确认后重试。",
    TEAM_JOIN_NAME_NOT_ALLOWED: "加入已有队伍时不需要填写队伍名称。",
    INVALID_GROUP: "请选择小学组、初中组或高中组。",
    INVALID_PASSWORD: "密码需为 10–128 个字符。",
    INVALID_CREDENTIALS: "用户名或密码不正确。",
    USERNAME_TAKEN: "这个用户名已被使用，请换一个。",
    USER_LIMIT_REACHED: "报名账号已达到系统容量上限，请联系管理员。",
    LOGIN_RATE_LIMITED: "登录尝试过多，请稍后再试。",
    REGISTRATION_RATE_LIMITED: "当前报名人数较多，请稍后再试。",
    REGISTRATION_CLOSED: "报名已关闭，如需帮助请联系管理员。",
    AUTH_QUEUE_FULL: "当前登录或报名请求过多，请稍后再试。",
    AUTH_QUEUE_TIMEOUT: "登录或报名等待超时，请重新提交。",
    CROSS_ORIGIN_REQUEST: "登录请求来源不受信任，请刷新页面后重试。"
  });

  const loginTab = document.querySelector("#loginTab");
  const registerTab = document.querySelector("#registerTab");
  const loginPanel = document.querySelector("#loginPanel");
  const registerPanel = document.querySelector("#registerPanel");
  const loginForm = document.querySelector("#loginForm");
  const registerForm = document.querySelector("#registerForm");
  const status = document.querySelector("#authStatus");
  const title = document.querySelector("#authCardTitle");
  const description = document.querySelector("#authCardDescription");
  const teamActionInput = document.querySelector("#registerTeamAction");
  const teamActionHint = document.querySelector("#registerTeamActionHint");
  const teamNameField = document.querySelector("#registerTeamNameField");
  const teamNameInput = document.querySelector("#registerTeamName");
  const inviteCodeField = document.querySelector("#registerInviteCodeField");
  const inviteCodeInput = document.querySelector("#registerInviteCode");
  const teamInviteDialog = document.querySelector("#teamInviteDialog");
  const teamInviteCodeValue = document.querySelector("#teamInviteCodeValue");
  const teamInviteCopyStatus = document.querySelector("#teamInviteCopyStatus");
  const copyTeamInviteCodeButton = document.querySelector("#copyTeamInviteCodeButton");

  function syncTeamRegistrationMode() {
    const joining = teamActionInput.value === "join";
    teamNameField.hidden = joining;
    teamNameInput.disabled = joining;
    teamNameInput.required = !joining;
    inviteCodeField.hidden = !joining;
    inviteCodeInput.disabled = !joining;
    inviteCodeInput.required = joining;
    teamActionHint.textContent = joining
      ? "输入队友提供的 8 位邀请码后加入同一队伍。"
      : "队伍名称全局唯一；创建成功后会生成邀请码，发给队友即可加入。";
  }

  function showTeamInviteDialog(inviteCode, user) {
    if (!teamInviteDialog || typeof inviteCode !== "string") {
      redirectAfterAuthentication(user);
      return;
    }
    teamInviteCodeValue.textContent = inviteCode;
    teamInviteCopyStatus.textContent = "";
    const continueToWorkspace = () => redirectAfterAuthentication(user);
    teamInviteDialog.addEventListener("close", continueToWorkspace, { once: true });
    teamInviteDialog.showModal();
  }

  function safeReturnTo() {
    const value = new URLSearchParams(window.location.search).get("returnTo") || "/";
    if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
    try {
      const url = new URL(value, window.location.origin);
      if (url.origin !== window.location.origin || url.pathname === "/login.html") return "/";
      return `${url.pathname}${url.search}${url.hash}`;
    } catch (_error) {
      return "/";
    }
  }

  function errorMessage(payload, fallback) {
    const code = payload?.error?.code ?? payload?.code;
    if (typeof code === "string" && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
    const message = payload?.error?.message ?? payload?.message;
    return typeof message === "string" && message.trim() ? message.trim().slice(0, 240) : fallback;
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
      ...options
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.toLowerCase().includes("application/json")
      ? await response.json().catch(() => null)
      : null;
    return { response, payload };
  }

  function showStatus(message, kind = "error") {
    status.textContent = message;
    status.dataset.kind = kind;
    status.hidden = !message;
  }

  function setBusy(form, busy, label) {
    [...form.elements].forEach(element => { element.disabled = busy; });
    const button = form.querySelector("button[type='submit'] span");
    if (button) {
      if (!button.dataset.label) button.dataset.label = button.textContent;
      button.textContent = busy ? label : button.dataset.label;
    }
    form.setAttribute("aria-busy", String(busy));
  }

  function selectTab(name, { focus = false } = {}) {
    const isLogin = name === "login";
    loginTab.setAttribute("aria-selected", String(isLogin));
    loginTab.tabIndex = isLogin ? 0 : -1;
    registerTab.setAttribute("aria-selected", String(!isLogin));
    registerTab.tabIndex = isLogin ? -1 : 0;
    loginPanel.hidden = !isLogin;
    registerPanel.hidden = isLogin;
    title.textContent = isLogin ? "欢迎回来" : "创建参赛账户";
    description.textContent = isLogin
      ? "使用你的参赛账户继续进入仿真工作台。"
      : "注册后即可保存个人比赛记录并查看重算结果。";
    showStatus("");
    if (focus) (isLogin ? loginTab : registerTab).focus();
  }

  function redirectAfterAuthentication(user) {
    const returnTo = safeReturnTo();
    const destination = user?.role === "admin" && returnTo === "/"
      ? "/admin.html"
      : returnTo;
    window.location.replace(destination);
  }

  async function submitLogin(username, password, { form = loginForm } = {}) {
    setBusy(form, true, "正在登录…");
    showStatus("");
    try {
      const { response, payload } = await requestJson(ENDPOINTS.login, {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      if (!response.ok) {
        const fallback = response.status === 401 ? "用户名或密码不正确。" : "登录失败，请稍后重试。";
        throw new Error(errorMessage(payload, fallback));
      }
      showStatus(payload?.user?.role === "admin"
        ? "登录成功，正在进入管理后台…"
        : "登录成功，正在进入仿真工作台…", "success");
      redirectAfterAuthentication(payload?.user);
      return true;
    } finally {
      setBusy(form, false, "");
    }
  }

  loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!loginForm.reportValidity()) return;
    const username = document.querySelector("#loginUsername").value.trim();
    const passwordInput = document.querySelector("#loginPassword");
    try {
      await submitLogin(username, passwordInput.value);
    } catch (error) {
      passwordInput.value = "";
      passwordInput.focus();
      showStatus(error instanceof Error ? error.message : "登录失败，请稍后重试。");
    }
  });

  registerForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!registerForm.reportValidity()) return;
    const teamAction = teamActionInput.value;
    const teamName = teamNameInput.value.trim();
    const inviteCode = inviteCodeInput.value.trim();
    const groupInput = document.querySelector("#registerGroup");
    const group = groupInput.value;
    const username = document.querySelector("#registerUsername").value.trim();
    const passwordInput = document.querySelector("#registerPassword");
    const confirmInput = document.querySelector("#registerPasswordConfirm");
    if (teamAction === "create" && !teamName) {
      teamNameInput.setCustomValidity("请填写队伍名称");
      teamNameInput.reportValidity();
      teamNameInput.setCustomValidity("");
      return;
    }
    if (teamAction === "join" && !inviteCode) {
      inviteCodeInput.setCustomValidity("请填写队伍邀请码");
      inviteCodeInput.reportValidity();
      inviteCodeInput.setCustomValidity("");
      return;
    }
    if (!["primary", "junior", "high"].includes(group)) {
      groupInput.setCustomValidity("请选择参赛分组");
      groupInput.reportValidity();
      groupInput.setCustomValidity("");
      return;
    }
    if (passwordInput.value !== confirmInput.value) {
      confirmInput.setCustomValidity("两次输入的密码不一致");
      confirmInput.reportValidity();
      confirmInput.setCustomValidity("");
      return;
    }

    setBusy(registerForm, true, "正在创建…");
    showStatus("");
    try {
      const body = { username, password: passwordInput.value, group, teamAction };
      if (teamAction === "create") body.teamName = teamName;
      else body.inviteCode = inviteCode;
      const { response, payload } = await requestJson(ENDPOINTS.register, {
        method: "POST",
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const fallback = response.status === 409 ? "这个用户名已被使用，请换一个。" : "注册失败，请检查填写内容。";
        throw new Error(errorMessage(payload, fallback));
      }

      if (payload?.user) {
        if (typeof payload.teamInviteCode === "string") {
          showTeamInviteDialog(payload.teamInviteCode, payload.user);
          return;
        }
        showStatus(payload.user.role === "admin"
          ? "账户已创建，正在进入管理后台…"
          : "账户已创建，正在进入仿真工作台…", "success");
        redirectAfterAuthentication(payload.user);
        return;
      }

      await submitLogin(username, passwordInput.value, { form: registerForm });
    } catch (error) {
      passwordInput.value = "";
      confirmInput.value = "";
      showStatus(error instanceof Error ? error.message : "注册失败，请稍后重试。");
    } finally {
      setBusy(registerForm, false, "");
    }
  });

  loginTab.addEventListener("click", () => selectTab("login"));
  registerTab.addEventListener("click", () => selectTab("register"));
  teamActionInput.addEventListener("change", syncTeamRegistrationMode);
  copyTeamInviteCodeButton.addEventListener("click", async () => {
    const inviteCode = teamInviteCodeValue.textContent || "";
    try {
      await navigator.clipboard?.writeText(inviteCode);
      teamInviteCopyStatus.textContent = "邀请码已复制。";
    } catch (_error) {
      teamInviteCopyStatus.textContent = "无法自动复制，请手动记录邀请码。";
    }
  });
  [loginTab, registerTab].forEach(tab => {
    tab.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      selectTab(tab === loginTab ? "register" : "login", { focus: true });
    });
  });

  const reason = new URLSearchParams(window.location.search).get("reason");
  if (reason === "authentication-required") showStatus("请先登录，再进入仿真工作台。", "normal");
  if (reason === "service-unavailable") showStatus("暂时无法连接账户服务，请确认本地后端已启动。", "error");

  syncTeamRegistrationMode();

  requestJson(ENDPOINTS.me).then(({ response, payload }) => {
    if (response.ok && payload?.user) redirectAfterAuthentication(payload.user);
  }).catch(() => {});

  if (globalThis.lucide) globalThis.lucide.createIcons();
})();
