"use strict";

(() => {
  const LOGIN_PATH = "/login.html";
  const AUTH_ME_ENDPOINT = "/api/v1/auth/me";
  const AUTH_LOGOUT_ENDPOINT = "/api/v1/auth/logout";
  const TEAM_INVITE_ENDPOINT = "/api/v1/auth/team-invite";
  const TEAM_INVITE_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

  document.documentElement.classList.add("auth-pending");

  function currentReturnTo() {
    const value = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    return value.startsWith("/") && !value.startsWith("//") ? value : "/";
  }

  function loginUrl(reason = "") {
    const url = new URL(LOGIN_PATH, window.location.origin);
    url.searchParams.set("returnTo", currentReturnTo());
    if (reason) url.searchParams.set("reason", reason);
    return `${url.pathname}${url.search}`;
  }

  function redirectToLogin(reason = "") {
    window.location.replace(loginUrl(reason));
  }

  globalThis.chenlongRedirectToLogin = redirectToLogin;

  function normalizeUser(payload) {
    const source = payload?.user ?? payload?.data?.user ?? null;
    if (!source || typeof source !== "object") return null;
    const id = typeof source.id === "string" ? source.id : typeof source.userId === "string" ? source.userId : "";
    const username = typeof source.username === "string" ? source.username : "";
    const displayName = typeof source.displayName === "string" && source.displayName.trim()
      ? source.displayName.trim()
      : username;
    const role = source.role === "admin" ? "admin" : "user";
    const teamName = typeof source.teamName === "string" && source.teamName.trim()
      ? source.teamName.trim()
      : "";
    const group = ["primary", "junior", "high"].includes(source.group)
      ? source.group
      : "";
    if ((!id && !username)
      || (role === "user" && !group)
      || (role === "admin" && (source.teamName !== null || source.group !== null))) return null;
    return Object.freeze({ id, username, displayName: displayName || "参赛用户", teamName, group: role === "admin" ? null : group, role });
  }

  async function readJson(response) {
    const type = response.headers.get("content-type") || "";
    if (!type.toLowerCase().includes("application/json")) return null;
    return response.json().catch(() => null);
  }

  async function requireCurrentUser() {
    let response;
    try {
      response = await fetch(AUTH_ME_ENDPOINT, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
    } catch (_error) {
      redirectToLogin("service-unavailable");
      return new Promise(() => {});
    }

    const payload = await readJson(response);
    if (response.status === 401 || response.status === 403) {
      redirectToLogin("authentication-required");
      return new Promise(() => {});
    }
    if (!response.ok) {
      redirectToLogin("service-unavailable");
      return new Promise(() => {});
    }

    const user = normalizeUser(payload);
    if (!user) {
      redirectToLogin("authentication-required");
      return new Promise(() => {});
    }

    globalThis.chenlongCurrentUser = user;
    document.documentElement.classList.remove("auth-pending");
    document.documentElement.classList.add("auth-ready");
    document.dispatchEvent(new CustomEvent("chenlong:auth-ready", { detail: { user } }));
    return user;
  }

  async function logout() {
    const button = document.querySelector("#logoutButton");
    if (button) button.disabled = true;
    try {
      await fetch(AUTH_LOGOUT_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: "{}"
      });
    } finally {
      window.location.replace(LOGIN_PATH);
    }
  }

  function parseTeamInvite(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const expectedKeys = ["schemaVersion", "teamName", "inviteCode", "authoritative"];
    const keys = Object.keys(payload);
    if (keys.length !== expectedKeys.length || keys.some(key => !expectedKeys.includes(key))) return null;
    if (payload.schemaVersion !== "chenlong.team-invite/v1" || payload.authoritative !== false) return null;
    if (typeof payload.teamName !== "string" || !payload.teamName.trim() || typeof payload.inviteCode !== "string") return null;
    if (!TEAM_INVITE_CODE_PATTERN.test(payload.inviteCode)) return null;
    return Object.freeze({ teamName: payload.teamName.trim(), inviteCode: payload.inviteCode });
  }

  function setTeamInviteStatus(message) {
    const status = document.querySelector("#teamInviteStatus");
    if (status) status.textContent = message;
  }

  async function openTeamInvite() {
    const dialog = document.querySelector("#teamInviteDialog");
    const code = document.querySelector("#teamInviteCode");
    const teamName = document.querySelector("#teamInviteTeamName");
    const copyButton = document.querySelector("#copyTeamInviteButton");
    const trigger = document.querySelector("#teamInviteButton");
    if (!dialog || !code || !teamName || !copyButton) return;
    code.textContent = "正在读取…";
    teamName.textContent = "";
    delete code.dataset.inviteCode;
    copyButton.disabled = true;
    setTeamInviteStatus("");
    if (!dialog.open) dialog.showModal();
    if (trigger) trigger.disabled = true;
    try {
      const response = await fetch(TEAM_INVITE_ENDPOINT, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      const payload = await readJson(response);
      if (response.status === 401 || response.status === 403) {
        dialog.close();
        redirectToLogin("authentication-required");
        return;
      }
      const invite = response.ok ? parseTeamInvite(payload) : null;
      if (!invite) throw new Error("team invite response is invalid");
      teamName.textContent = `队伍：${invite.teamName}`;
      code.textContent = invite.inviteCode;
      code.dataset.inviteCode = invite.inviteCode;
      copyButton.disabled = false;
    } catch (_error) {
      code.textContent = "暂时无法读取";
      setTeamInviteStatus("邀请码暂时无法读取，请稍后重试。");
    } finally {
      if (trigger) trigger.disabled = false;
    }
  }

  async function copyTeamInvite() {
    const code = document.querySelector("#teamInviteCode")?.dataset.inviteCode;
    if (!code || !TEAM_INVITE_CODE_PATTERN.test(code)) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(code);
      setTeamInviteStatus("邀请码已复制。");
    } catch (_error) {
      setTeamInviteStatus("无法自动复制，请手动复制上方邀请码。");
    }
  }

  function installTeamInviteControl(user) {
    const button = document.querySelector("#teamInviteButton");
    const dialog = document.querySelector("#teamInviteDialog");
    if (!button || !dialog) return;
    button.hidden = user.role !== "user";
    if (user.role !== "user") return;
    button.addEventListener("click", () => { void openTeamInvite(); }, { once: false });
    document.querySelector("#copyTeamInviteButton")?.addEventListener("click", () => { void copyTeamInvite(); }, { once: false });
    const close = () => dialog.close();
    document.querySelector("#closeTeamInviteButton")?.addEventListener("click", close, { once: false });
    document.querySelector("#closeTeamInviteFooterButton")?.addEventListener("click", close, { once: false });
    dialog.addEventListener("click", event => {
      if (event.target === dialog) dialog.close();
    }, { once: false });
  }

  function renderAccount(user) {
    const name = document.querySelector("#currentUserName");
    const role = document.querySelector("#currentUserRole");
    const adminLink = document.querySelector("#adminNavLink");
    const logoutButton = document.querySelector("#logoutButton");
    if (name) {
      name.textContent = user.teamName || user.username || "未填写";
      name.title = user.role === "admin"
        ? "管理员账户"
        : (user.teamName ? `队伍：${user.teamName}` : "旧账户尚未填写队伍名称");
    }
    if (role) role.textContent = user.role === "admin" ? "管理员" : "参赛用户";
    if (adminLink) adminLink.hidden = user.role !== "admin";
    installTeamInviteControl(user);
    if (logoutButton) logoutButton.hidden = user.role !== "admin";
    logoutButton?.addEventListener("click", logout, { once: true });
    if (globalThis.lucide) globalThis.lucide.createIcons();
  }

  globalThis.chenlongAuthReady = requireCurrentUser();
  globalThis.chenlongAuthReady.then(user => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => renderAccount(user), { once: true });
    } else {
      renderAccount(user);
    }
  });
})();
