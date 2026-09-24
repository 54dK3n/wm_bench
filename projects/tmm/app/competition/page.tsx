import type { Metadata } from "next";

import CompetitionPortal from "./CompetitionPortal";

export const metadata: Metadata = {
  title: "橙子识别挑战赛｜识物工坊",
  description: "注册参赛队伍并提交“橙子 / 非橙子”识别模型，评测成绩仅赛事管理员可见。",
};

export default function CompetitionPage() {
  return <CompetitionPortal />;
}
