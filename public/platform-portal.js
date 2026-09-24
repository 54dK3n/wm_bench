"use strict";
(() => {
  const $ = selector => document.querySelector(selector);
  const groups = { primary: "小学组", junior: "初中组", high: "高中组" };
  const inviteCodePattern = /^[A-HJ-NP-Z2-9]{8}$/;
  const inviteButton = $("#inviteButton");
  const inviteDialog = $("#inviteDialog");
  const inviteCode = $("#inviteCode");
  const inviteTeam = $("#inviteTeam");
  const inviteStatus = $("#inviteStatus");
  const copyInviteButton = $("#copyInviteButton");

  async function read(path, options) {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
    const payload = await response.json().catch(() => null);
    if (response.status === 401) {
      location.replace(`/login.html?returnTo=${encodeURIComponent(location.pathname)}`);
      return null;
    }
    if (!response.ok) throw new Error(payload?.error?.message || "读取失败");
    return payload;
  }

  function closeInviteDialog() {
    if (inviteDialog?.open) inviteDialog.close();
  }

  function resetInviteDialog() {
    inviteTeam.textContent = "";
    inviteCode.textContent = "正在读取…";
    delete inviteCode.dataset.inviteCode;
    inviteStatus.textContent = "";
    copyInviteButton.disabled = true;
  }

  async function openInviteDialog() {
    resetInviteDialog();
    if (!inviteDialog.open) inviteDialog.showModal();
    inviteButton.disabled = true;
    try {
      const result = await read("/api/platform/team-invite");
      if (!result || !inviteCodePattern.test(result.inviteCode)) throw new Error("邀请码数据格式不正确。");
      inviteTeam.textContent = `队伍：${result.teamName}`;
      inviteCode.textContent = result.inviteCode;
      inviteCode.dataset.inviteCode = result.inviteCode;
      copyInviteButton.disabled = false;
    } catch (error) {
      inviteCode.textContent = "暂时无法读取";
      inviteStatus.textContent = error.message;
    } finally {
      inviteButton.disabled = false;
    }
  }

  async function copyInviteCode() {
    const code = inviteCode.dataset.inviteCode;
    if (!inviteCodePattern.test(code || "")) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(code);
      inviteStatus.textContent = "邀请码已复制。";
    } catch (_error) {
      inviteStatus.textContent = "无法自动复制，请手动复制上方邀请码。";
    }
  }

  Promise.all([read("/api/platform/me"), read("/api/platform/scores/me")]).then(([me, scores]) => {
    if (!me) return;
    $("#accountName").textContent = me.user.teamName || me.user.username;
    $("#accountMeta").textContent = me.user.role === "admin" ? "管理员" : `${groups[me.user.group] || "参赛组"} · ${me.user.username}`;
    $("#adminLink").hidden = me.user.role !== "admin";
    // 参赛账号不提供退出入口；只有管理员可退出到本地登录页。
    $("#logoutButton").hidden = me.user.role !== "admin";
    inviteButton.hidden = me.user.role !== "user";
    if (scores) {
      ["task1", "task2", "task3"].forEach((task, index) => {
        $("#score" + (index + 1)).textContent = scores.taskScores[task] == null ? "—" : `${scores.taskScores[task]} / 100`;
      });
      $("#score4").textContent = scores.workshop.available && scores.workshop.latestSubmission ? "已提交" : "—";
      $("#scores").hidden = false;
    }
    $("#notice").hidden = true;
  }).catch(error => {
    $("#notice").textContent = error.message;
    $("#notice").dataset.kind = "error";
  });

  inviteButton.addEventListener("click", () => { void openInviteDialog(); });
  copyInviteButton.addEventListener("click", () => { void copyInviteCode(); });
  $("#closeInviteButton").addEventListener("click", closeInviteDialog);
  $("#closeInviteFooterButton").addEventListener("click", closeInviteDialog);
  inviteDialog.addEventListener("click", event => {
    if (event.target === inviteDialog) closeInviteDialog();
  });
  inviteDialog.addEventListener("close", () => inviteButton.focus());

  $("#logoutButton").addEventListener("click", async () => {
    await read("/api/v1/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
    location.replace("/login.html");
  });
})();
