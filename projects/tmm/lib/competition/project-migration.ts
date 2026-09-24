import type { Project } from "../project/types";
import { ORANGE_COMPETITION_LABELS } from "./rules";

const LEGACY_PLACEHOLDER_LABELS = ["物品 A", "物品 B"] as const;

function nextUpdatedAt(previous: string, now: number): string {
  const previousTime = Date.parse(previous);
  return new Date(Math.max(now, Number.isFinite(previousTime) ? previousTime + 1 : now)).toISOString();
}

export function migrateLegacyOrangeCompetitionProject(
  project: Project,
  now = Date.now(),
): Project | null {
  if (project.classes.length !== LEGACY_PLACEHOLDER_LABELS.length) return null;
  const normalized = project.classes.map(({ name }) => name.normalize("NFKC").trim());
  if (!LEGACY_PLACEHOLDER_LABELS.every((label, index) => normalized[index] === label)) return null;

  return {
    ...project,
    name: project.name.normalize("NFKC").trim() === "未命名项目"
      ? "橙子识别项目"
      : project.name,
    updatedAt: nextUpdatedAt(project.updatedAt, now),
    classes: project.classes.map((projectClass, index) => ({
      ...projectClass,
      name: ORANGE_COMPETITION_LABELS[index],
    })),
  };
}
