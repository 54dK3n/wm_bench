"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTeamChallengeScores, paginateTeamScores } = require("../admin-team-scores.js");

const TASKS = ["GYI-PRIMARY-01", "GYI-PRIMARY-02", "GYI-PRIMARY-03"];

test("team challenge summary uses only each team's highest submitted score for the three tasks", () => {
  const users = [
    { username: "admin", role: "admin", teamName: null },
    { username: "a1", role: "user", teamName: "广阳岛一队", group: "primary_low" },
    { username: "a2", role: "user", teamName: "广阳岛一队", group: "primary_high" },
    { username: "b1", role: "user", teamName: "广阳岛二队", group: "primary_high" },
    { username: "c1", role: "user", teamName: "尚未参赛队", group: "primary_low" }
  ];
  const records = [
    { user: { teamName: "广阳岛一队" }, taskId: TASKS[0], score: 100, recordState: "saved" },
    { user: { teamName: "广阳岛一队" }, taskId: TASKS[0], score: 72, recordState: "submitted" },
    { user: { teamName: "广阳岛一队" }, taskId: TASKS[0], score: 91.5, recordState: "submitted" },
    { user: { teamName: "广阳岛一队" }, taskId: TASKS[1], score: 83, recordState: "submitted" },
    { user: { teamName: "广阳岛二队" }, taskId: TASKS[2], score: 88, recordState: "submitted" },
    { user: { teamName: "广阳岛二队" }, taskId: "UNKNOWN", score: 100 },
    { user: { teamName: "广阳岛二队" }, taskId: TASKS[0], score: -1 }
  ];

  const rows = buildTeamChallengeScores({ users, records, taskIds: TASKS });
  assert.equal(rows.length, 3, "同队多个账号只能形成一行，管理员不能形成队伍行");
  const first = rows.find(row => row.teamName === "广阳岛一队");
  const second = rows.find(row => row.teamName === "广阳岛二队");
  const empty = rows.find(row => row.teamName === "尚未参赛队");
  assert.deepEqual(TASKS.map(taskId => first.scores[taskId]), [91.5, 83, null]);
  assert.equal(first.group, "primary", "历史两个小学组必须合并为同一小学组而不是分组不一致");
  assert.equal(first.totalScore, 174.5);
  assert.deepEqual(TASKS.map(taskId => second.scores[taskId]), [null, null, 88]);
  assert.equal(second.totalScore, 88);
  assert.deepEqual(TASKS.map(taskId => empty.scores[taskId]), [null, null, null]);
  assert.equal(empty.totalScore, 0);
});

test("personal task summary ignores saved drafts and keeps only submitted maxima", () => {
  const { buildSubmittedTaskScores } = require("../admin-team-scores.js");
  const result = buildSubmittedTaskScores([
    { recordState: "saved", taskId: TASKS[0], score: 100 },
    { recordState: "submitted", taskId: TASKS[0], score: 80 },
    { recordState: "submitted", taskId: TASKS[1], score: 92 },
    { recordState: "submitted", taskId: TASKS[2], score: null }
  ], TASKS);
  assert.deepEqual(result, { [TASKS[0]]: 80, [TASKS[1]]: 92, [TASKS[2]]: null });
});

test("stable team ids keep renamed teams together and null scores remain missing", () => {
  const teamId = "tea_11111111111111111111111111111111";
  const rows = buildTeamChallengeScores({
    users: [{ role: "user", teamId, teamName: "新队名", group: "junior" }],
    records: [
      { user: { teamId, teamName: "旧队名" }, taskId: TASKS[0], score: 88, recordState: "submitted" },
      { user: { teamId, teamName: "旧队名" }, taskId: TASKS[1], score: null, recordState: "submitted" }
    ],
    taskIds: TASKS
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].teamName, "新队名");
  assert.deepEqual(TASKS.map(taskId => rows[0].scores[taskId]), [88, null, null]);
});

test("team challenge summary pagination is fixed at fifteen teams and clamps invalid pages", () => {
  const rows = Array.from({ length: 31 }, (_value, index) => ({ teamName: `队伍${index + 1}` }));
  const first = paginateTeamScores(rows, 1);
  const second = paginateTeamScores(rows, 2);
  const last = paginateTeamScores(rows, 99);
  assert.equal(first.items.length, 15);
  assert.deepEqual([first.start, first.end, first.totalPages], [1, 15, 3]);
  assert.equal(second.items.length, 15);
  assert.deepEqual([second.start, second.end], [16, 30]);
  assert.equal(last.page, 3);
  assert.equal(last.items.length, 1);
  assert.deepEqual([last.start, last.end], [31, 31]);
});
