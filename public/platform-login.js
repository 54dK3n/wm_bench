"use strict";
(() => {
  const $ = selector => document.querySelector(selector);
  const status = $("#status");
  const requestedReturnTo = new URLSearchParams(location.search).get("returnTo") || "";
  function destination(user) {
    const fallback = user?.role === "admin" ? "/admin.html" : "/portal.html";
    if (!requestedReturnTo.startsWith("/") || requestedReturnTo.startsWith("//")) return fallback;
    const adminOnlyPath = requestedReturnTo.startsWith("/python/admin")
      || requestedReturnTo.startsWith("/blockly/admin")
      || requestedReturnTo.startsWith("/workshop/competition/admin")
      || requestedReturnTo.startsWith("/admin.html");
    if (adminOnlyPath) return user?.role === "admin" ? requestedReturnTo : fallback;
    const safeParticipantPath = requestedReturnTo.startsWith("/python/")
      || requestedReturnTo.startsWith("/blockly/")
      || requestedReturnTo === "/workshop"
      || requestedReturnTo === "/workshop/"
      || requestedReturnTo.startsWith("/workshop/?")
      || requestedReturnTo === "/workshop/competition"
      || requestedReturnTo.startsWith("/workshop/competition?");
    if (safeParticipantPath) return requestedReturnTo;
    return fallback;
  }
  const show = (message, kind = "error") => { status.textContent = message; status.dataset.kind = kind; status.hidden = !message; };
  async function request(path, body) {
    const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || "请求失败，请稍后重试。");
    return payload;
  }
  function select(register) {
    $("#loginForm").hidden = register;
    $("#registerForm").hidden = !register;
    $("#loginTab").setAttribute("aria-selected", String(!register));
    $("#registerTab").setAttribute("aria-selected", String(register));
    show("");
  }
  $("#loginTab").onclick = () => select(false);
  $("#registerTab").onclick = () => select(true);
  $("#teamAction").onchange = event => {
    const joining = event.target.value === "join";
    $("#teamNameField").hidden = joining; $("#teamName").required = !joining;
    $("#inviteField").hidden = !joining; $("#inviteCode").required = joining;
  };
  $("#loginForm").onsubmit = async event => {
    event.preventDefault(); show("正在登录…", "normal");
    try {
      const payload = await request("/api/v1/auth/login", { username: $("#loginUsername").value.trim(), password: $("#loginPassword").value });
      location.replace(destination(payload.user));
    } catch (error) { show(error.message); }
  };
  $("#registerForm").onsubmit = async event => {
    event.preventDefault();
    if ($("#registerPassword").value !== $("#confirmPassword").value) { show("两次输入的密码不一致。"); return; }
    const joining = $("#teamAction").value === "join";
    const body = { username: $("#registerUsername").value.trim(), password: $("#registerPassword").value, group: $("#registerGroup").value, teamAction: joining ? "join" : "create" };
    if (joining) body.inviteCode = $("#inviteCode").value.trim().toUpperCase(); else body.teamName = $("#teamName").value.trim();
    show("正在注册…", "normal");
    try {
      const payload = await request("/api/v1/auth/register", body);
      if (payload.teamInviteCode) {
        $("#createdInvite").textContent = payload.teamInviteCode;
        $("#inviteDialog").showModal();
        $("#continueButton").onclick = () => location.replace(destination(payload.user));
      } else location.replace(destination(payload.user));
    } catch (error) { show(error.message); }
  };
  fetch("/api/platform/me", { credentials: "same-origin", cache: "no-store" }).then(response => response.ok ? response.json() : null).then(payload => {
    // A bare /login.html is the intentional manual entry for the local
    // login/registration forms.  Guard redirects always carry returnTo, so
    // they retain the existing behaviour for an already-valid session.
    if (payload?.user && requestedReturnTo) location.replace(destination(payload.user));
  }).catch(() => {});
})();
