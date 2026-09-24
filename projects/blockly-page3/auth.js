"use strict";

(() => {
  const loginTab = document.querySelector("#loginTab");
  const registerTab = document.querySelector("#registerTab");
  const loginPanel = document.querySelector("#loginPanel");
  const registerPanel = document.querySelector("#registerPanel");
  const loginForm = document.querySelector("#loginForm");
  const registerForm = document.querySelector("#registerForm");
  const status = document.querySelector("#authStatus");
  const heading = document.querySelector("#authHeading");
  const title = document.querySelector("#authTitle");
  const description = document.querySelector("#authDescription");
  const teamAction = document.querySelector("#registerTeamAction");
  const teamActionHint = document.querySelector("#registerTeamActionHint");
  const teamNameField = document.querySelector("#registerTeamNameField");
  const teamName = document.querySelector("#registerTeamName");
  const inviteField = document.querySelector("#registerInviteCodeField");
  const inviteCode = document.querySelector("#registerInviteCode");
  const registerGroup = document.querySelector("#registerGroup");
  const inviteDialog = document.querySelector("#teamInviteDialog");
  const inviteValue = document.querySelector("#teamInviteCodeValue");
  const inviteCopyStatus = document.querySelector("#teamInviteCopyStatus");
  const copyInviteButton = document.querySelector("#copyTeamInviteCodeButton");

  const errorMessages = Object.freeze({
    INVALID_USERNAME: "用户名需为 3–32 位英文、数字、点、下划线或短横线，且以字母或数字开头。",
    INVALID_TEAM_NAME: "队伍名称需为 1–64 个可见字符。",
    TEAM_NAME_TAKEN: "这个队伍名称已被使用，请换一个名称，或向队友索取邀请码加入。",
    INVALID_TEAM_INVITE_CODE: "请输入正确的 8 位队伍邀请码。",
    TEAM_INVITE_NOT_FOUND: "未找到这个邀请码对应的队伍，请向队友确认后重试。",
    INVALID_PASSWORD: "密码需为 10–128 个字符。",
    INVALID_PARTICIPANT_GROUP: "请选择小学组、初中组或高中组。",
    USERNAME_TAKEN: "这个用户名已经被使用，请换一个。",
    INVALID_CREDENTIALS: "用户名或密码不正确。",
    CROSS_ORIGIN_REQUEST: "登录请求来源不受信任，请刷新页面后重试。"
  });

  function setStatus(message = "", kind = "error") {
    status.textContent = message;
    status.dataset.kind = kind;
    status.hidden = !message;
  }

  function messageFor(payload, fallback) {
    const code = payload?.error?.code;
    return errorMessages[code] || payload?.error?.message || fallback;
  }

  function setBusy(form, busy, label) {
    [...form.elements].forEach(element => { element.disabled = busy; });
    const text = form.querySelector("button[type='submit'] span");
    if (!text) return;
    if (!text.dataset.label) text.dataset.label = text.textContent;
    text.textContent = busy ? label : text.dataset.label;
    if (!busy && form === registerForm) syncTeamAction();
  }

  function selectTab(tab) {
    const isLogin = tab === "login";
    loginTab.setAttribute("aria-selected", String(isLogin));
    registerTab.setAttribute("aria-selected", String(!isLogin));
    loginPanel.hidden = !isLogin;
    registerPanel.hidden = isLogin;
    heading.hidden = !isLogin;
    setStatus();
  }

  function syncTeamAction() {
    const joining = teamAction.value === "join";
    teamNameField.hidden = joining;
    teamName.disabled = joining;
    teamName.required = !joining;
    inviteField.hidden = !joining;
    inviteCode.disabled = !joining;
    inviteCode.required = joining;
    teamActionHint.textContent = joining
      ? "输入队友提供的 8 位邀请码后，加入同一个队伍。"
      : "队伍名称全局唯一；创建成功后会生成邀请码，发给队友即可加入。";
  }

  async function request(path, body) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(messageFor(payload, "操作失败，请稍后重试。"));
    if (payload?.schemaVersion !== "chenlong.blockly-auth/v1" || !payload.authenticated || !payload.user) {
      throw new Error("账户回执不完整，请重试。 ");
    }
    return payload;
  }

  function enterWorkspace(user = null) {
    window.location.replace(user?.role === "admin" ? "./admin.html" : "./");
  }

  function showInvite(code) {
    if (typeof code !== "string" || !inviteDialog?.showModal) {
      enterWorkspace();
      return;
    }
    inviteValue.textContent = code;
    inviteCopyStatus.textContent = "请保存好邀请码，之后也可以在闯关页的“队伍邀请码”中查看。";
    inviteDialog.addEventListener("close", enterWorkspace, { once: true });
    inviteDialog.showModal();
  }

  loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!loginForm.reportValidity()) return;
    const password = document.querySelector("#loginPassword");
    setBusy(loginForm, true, "正在登录…");
    setStatus();
    try {
      const result = await request("/api/auth/login", { username: document.querySelector("#loginUsername").value.trim(), password: password.value });
      enterWorkspace(result.user);
    } catch (error) {
      password.value = "";
      password.focus();
      setStatus(error.message);
    } finally {
      setBusy(loginForm, false, "");
    }
  });

  registerForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!registerForm.reportValidity()) return;
    const password = document.querySelector("#registerPassword");
    const confirmation = document.querySelector("#registerPasswordConfirm");
    if (password.value !== confirmation.value) {
      confirmation.setCustomValidity("两次输入的密码不一致");
      confirmation.reportValidity();
      confirmation.setCustomValidity("");
      return;
    }
    setBusy(registerForm, true, "正在创建…");
    setStatus();
    try {
      const body = {
        username: document.querySelector("#registerUsername").value.trim(), password: password.value,
        teamAction: teamAction.value,
        group: registerGroup.value
      };
      if (teamAction.value === "create") body.teamName = teamName.value.trim();
      else body.inviteCode = inviteCode.value.trim();
      const result = await request("/api/auth/register", body);
      if (result.user.role === "admin") enterWorkspace(result.user);
      else showInvite(result.teamInviteCode);
    } catch (error) {
      password.value = "";
      confirmation.value = "";
      setStatus(error.message);
    } finally {
      setBusy(registerForm, false, "");
    }
  });

  loginTab.addEventListener("click", () => selectTab("login"));
  registerTab.addEventListener("click", () => selectTab("register"));
  teamAction.addEventListener("change", syncTeamAction);
  copyInviteButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inviteValue.textContent || "");
      inviteCopyStatus.textContent = "邀请码已复制。";
    } catch (_error) {
      inviteCopyStatus.textContent = "无法自动复制，请手动记录邀请码。";
    }
  });
  syncTeamAction();
  fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" })
    .then(response => response.ok ? response.json() : null)
    .then(payload => { if (payload?.authenticated) enterWorkspace(payload.user); })
    .catch(() => {});
  if (window.lucide) window.lucide.createIcons();
})();
