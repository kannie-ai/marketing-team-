/**
 * 大漁マーケットOS ⇄ Threads Studio 統合APIの契約（Threads Studio 側）。
 *
 * 大漁マーケット側 `src/lib/threads-studio/contract.ts` と同じ内容を保つこと。
 * どちらか一方のUI都合でこのファイルを変えない。変えるときは両方同時に。
 */

export const INTEGRATION_API_VERSION = "2026-09-01";
export const SIGNATURE_SCHEME = "TAIRYO-HMAC-SHA256";
export const SIGNATURE_MAX_SKEW_SECONDS = 300;

export const HEADER = {
  keyId: "x-tairyo-key-id",
  timestamp: "x-tairyo-timestamp",
  nonce: "x-tairyo-nonce",
  signature: "x-tairyo-signature",
  requestId: "x-tairyo-request-id",
} as const;

export const INTEGRATION_PREFIX = "/api/integration/v1";

export const ENDPOINT = {
  ping: `${INTEGRATION_PREFIX}/ping`,
  accountsList: `${INTEGRATION_PREFIX}/accounts.list`,
  postsList: `${INTEGRATION_PREFIX}/posts.list`,
  postsCreate: `${INTEGRATION_PREFIX}/posts.create`,
  postsUpdate: `${INTEGRATION_PREFIX}/posts.update`,
  postsSetApproval: `${INTEGRATION_PREFIX}/posts.setApproval`,
  postsRetry: `${INTEGRATION_PREFIX}/posts.retry`,
  postLogsList: `${INTEGRATION_PREFIX}/postLogs.list`,
  analyticsSummary: `${INTEGRATION_PREFIX}/analytics.summary`,
  trendsList: `${INTEGRATION_PREFIX}/trends.list`,
  strategyGet: `${INTEGRATION_PREFIX}/strategy.get`,
} as const;

export type IntegrationErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_linked"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "upstream_error"
  | "internal_error";

export type IntegrationPermission =
  | "threads:read"
  | "threads:draft"
  | "threads:schedule"
  | "threads:approve"
  | "threads:retry"
  | "threads:admin";

/**
 * ロール別の権限。大漁マーケット側と同じ表を持ち、申告された permissions を
 * そのままは信用しない。role から再計算した権限と突き合わせ、
 * 「両方に含まれるもの」だけを有効とする。
 */
const ROLE_PERMISSIONS: Record<string, IntegrationPermission[]> = {
  owner: [
    "threads:read",
    "threads:draft",
    "threads:schedule",
    "threads:approve",
    "threads:retry",
    "threads:admin",
  ],
  admin: [
    "threads:read",
    "threads:draft",
    "threads:schedule",
    "threads:approve",
    "threads:retry",
    "threads:admin",
  ],
  strategist: [
    "threads:read",
    "threads:draft",
    "threads:schedule",
    "threads:approve",
    "threads:retry",
  ],
  content_manager: [
    "threads:read",
    "threads:draft",
    "threads:schedule",
    "threads:approve",
    "threads:retry",
  ],
  creator: ["threads:read", "threads:draft"],
  analyst: ["threads:read"],
  client_viewer: ["threads:read"],
};

export function permissionsForRole(role: string): IntegrationPermission[] {
  return ROLE_PERMISSIONS[role] ?? ["threads:read"];
}

/** 申告と再計算の積集合。どちらかに無いものは与えない。 */
export function effectivePermissions(
  role: string,
  claimed: unknown
): IntegrationPermission[] {
  const derived = permissionsForRole(role);
  if (!Array.isArray(claimed)) return derived;
  return derived.filter(permission => claimed.includes(permission));
}

export type IntegrationEnvelope = {
  apiVersion: string;
  organizationId: string;
  clientId: string;
  accountId: number | null;
  actor: { userId: string | null; role: string; permissions: unknown };
  idempotencyKey?: string;
  params: Record<string, unknown>;
};
