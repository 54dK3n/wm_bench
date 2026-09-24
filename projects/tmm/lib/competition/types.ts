import type { PlatformPrincipalUser } from "./platform-sso";

export const COMPETITION_DIVISIONS = ["primary", "junior", "senior"] as const;

export type CompetitionDivision = (typeof COMPETITION_DIVISIONS)[number];

const COMPETITION_DIVISION_ALIASES = Object.freeze({
  primary: "primary",
  primary_low: "primary",
  primary_high: "primary",
  junior: "junior",
  high: "senior",
  senior: "senior",
} satisfies Record<string, CompetitionDivision>);

export const COMPETITION_SUBMISSION_STATUSES = [
  "pending",
  "uploaded",
  "evaluating",
  "scored",
  "failed",
  "rejected",
] as const;

export type CompetitionSubmissionStatus =
  (typeof COMPETITION_SUBMISSION_STATUSES)[number];

export interface CompetitionTeam {
  id: string;
  teamName: string;
  division: CompetitionDivision;
  createdAt: number;
  updatedAt: number;
  latestSubmissionId: string | null;
}

export interface CompetitionTeamCredential extends CompetitionTeam {
  teamNameKey: string;
  passwordHash: string;
}

export interface CompetitionTeamSession {
  team: CompetitionTeam;
  expiresAt: number;
  platformUser?: PlatformPrincipalUser;
}

export interface CompetitionAdminCredential {
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface CompetitionAdminSession {
  adminId: 1;
  expiresAt: number;
  platformUser?: PlatformPrincipalUser;
}

export interface CompetitionSessionSecret {
  token: string;
  tokenHash: string;
}

export interface CompetitionApiError {
  error: {
    code: string;
    message: string;
  };
}

export function isCompetitionDivision(value: unknown): value is CompetitionDivision {
  return typeof value === "string" && (
    COMPETITION_DIVISIONS as readonly string[]
  ).includes(value);
}

/**
 * Normalize persisted values from the former four-group platform contract.
 * New writes must still use one of COMPETITION_DIVISIONS directly.
 */
export function normalizeCompetitionDivision(value: unknown): CompetitionDivision | null {
  if (typeof value !== "string") return null;
  const key = value.normalize("NFKC").trim().toLowerCase();
  return Object.hasOwn(COMPETITION_DIVISION_ALIASES, key)
    ? COMPETITION_DIVISION_ALIASES[key as keyof typeof COMPETITION_DIVISION_ALIASES]
    : null;
}

export function isCompetitionSubmissionStatus(
  value: unknown,
): value is CompetitionSubmissionStatus {
  return typeof value === "string" && (
    COMPETITION_SUBMISSION_STATUSES as readonly string[]
  ).includes(value);
}
