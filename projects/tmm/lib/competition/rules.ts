export const ORANGE_COMPETITION_LABELS = ["橙子", "非橙子"] as const;

function normalizeLabel(value: unknown, source: string): string {
  if (typeof value !== "string") throw new TypeError(`${source}必须是文字。`);
  const label = value.normalize("NFKC").trim();
  if (!label || label.length > 80) throw new RangeError(`${source}长度必须为 1–80 个字符。`);
  return label;
}

export function hasOrangeCompetitionLabels(labels: readonly unknown[]): boolean {
  if (labels.length !== ORANGE_COMPETITION_LABELS.length) return false;
  const normalized = labels.map((label) => typeof label === "string" ? label.normalize("NFKC").trim() : "");
  return new Set(normalized).size === ORANGE_COMPETITION_LABELS.length
    && ORANGE_COMPETITION_LABELS.every((required) => normalized.includes(required));
}

export function requireOrangeCompetitionLabels(
  value: unknown,
  source = "比赛类别",
): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${source}必须是数组。`);
  const labels = value.map((label, index) => normalizeLabel(label, `${source}[${index}]`));
  if (!hasOrangeCompetitionLabels(labels)) {
    throw new RangeError(`${source}必须且只能包含“橙子”和“非橙子”两个类别。`);
  }
  return labels;
}
