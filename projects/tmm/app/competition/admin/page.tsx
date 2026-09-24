import type { Metadata } from "next";

import CompetitionAdmin from "./CompetitionAdmin";

export const metadata: Metadata = {
  title: "橙子识别竞赛管理台｜识物工坊",
  description: "配置“橙子 / 非橙子”测试集并查看各组排行榜与均衡评分规则。",
  robots: { index: false, follow: false },
};

export default function CompetitionAdminPage() {
  return <CompetitionAdmin />;
}
