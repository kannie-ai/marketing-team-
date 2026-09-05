/**
 * 統合APIの実装（Threads Studio 側）。
 *
 * 方針
 *   - 画面用の内部構造をそのまま返さない。契約で決めた形だけを返す。
 *   - 取得できていない数値は 0 で埋めず null のまま返す。
 *   - 秘密（アクセストークン・APIキー）は応答に一切含めない。
 *   - 変更操作は冪等キーで一度だけ実行する。
 */
import { and, desc, eq, gte, inArray } from "drizzle-orm";

import {
  accounts as accountsTable,
  categories as categoriesTable,
  followerSnapshots,
  postAnalytics,
  postLogs,
  posts as postsTable,
  trendPosts as trendPostsTable,
  trendSettings as trendSettingsTable,
} from "../../drizzle/schema";
import type { Account, Post } from "../../drizzle/schema";
import { primaryAccountId, scopeOf } from "../accountScope";
import { getDb, getAccountById, listAccounts } from "../db";
import type { AuthorizedRequest } from "./auth";
import { digestOf, requirePermission } from "./auth";
import type { IntegrationErrorCode } from "./contract";
import { integrationPostStates } from "./schema";
import { claimOperation, completeOperation, listAccountLinks } from "./store";

export type HandlerResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: IntegrationErrorCode; message: string } };

const THREADS_MAX_CHARACTERS = 500;

function fail(code: IntegrationErrorCode, message: string): HandlerResult {
  return { ok: false, error: { code, message } };
}

function countCharacters(body: string): number {
  return Array.from(body).length;
}

/** 契約上の投稿ステータスへ変換する。 */
function toPostStatus(
  post: Post,
  approvalState: string | null
):
  | "draft"
  | "pending_approval"
  | "approved"
  | "scheduled"
  | "published"
  | "failed" {
  if (post.status === "error") return "failed";
  if (post.status === "posted") return "published";
  if (approvalState === "pending_approval") return "pending_approval";
  if (post.approvalStatus === "draft") return "draft";
  return post.scheduledDate ? "scheduled" : "approved";
}

async function scopeForAccount(accountId: number) {
  const all = await listAccounts();
  const account = all.find(a => a.id === accountId);
  if (!account) return null;
  return { account, scope: scopeOf(account, primaryAccountId(all)) };
}

async function approvalStatesFor(postIds: number[]) {
  const map = new Map<number, string>();
  if (postIds.length === 0) return map;
  const db = await getDb();
  if (!db) return map;
  const rows = await db
    .select()
    .from(integrationPostStates)
    .where(inArray(integrationPostStates.postId, postIds));
  for (const row of rows) map.set(row.postId, row.approvalState);
  return map;
}

/** アカウントの接続状態。トークンそのものは絶対に返さない。 */
function describeAccount(account: Account) {
  const expiresAt = account.tokenExpiresAt ?? null;
  const expired = expiresAt !== null && expiresAt.getTime() <= Date.now();
  const connectionStatus = !account.threadsAccessToken
    ? "disconnected"
    : expired
      ? "expired"
      : account.lastReplyFetchError === "auth"
        ? "error"
        : "connected";
  return {
    accountId: account.id,
    displayName: account.name,
    threadsUsername: account.threadsUsername ?? null,
    threadsUserId: account.threadsUserId ?? null,
    active: account.active,
    connectionStatus,
    tokenExpiresAt: expiresAt ? expiresAt.toISOString() : null,
    requiredScopes: [
      "threads_basic",
      "threads_content_publish",
      "threads_manage_insights",
      "threads_manage_replies",
      "threads_keyword_search",
    ],
    lastPostedAt: null as string | null,
    lastAnalyticsAt: null as string | null,
    lastError: account.lastReplyFetchError ?? null,
  };
}

// ---------------------------------------------------------------------
// accounts.list
// ---------------------------------------------------------------------

export async function handleAccountsList(
  request: AuthorizedRequest
): Promise<HandlerResult> {
  const denied = requirePermission(request, "threads:read");
  if (denied) return { ok: false, error: denied };

  const links = await listAccountLinks(request.envelope.clientId);
  const linkedIds = new Set(links.map(link => link.accountId));
  const all = await listAccounts();

  // 連携済みのアカウントだけを返す。ただし管理者が新規に紐づけるときは、
  // まだ紐づいていないものも見えないと選べないので、その場合だけ全件返す。
  const includeUnlinked =
    request.envelope.params.includeUnlinked === true &&
    request.permissions.includes("threads:admin");

  const visible = includeUnlinked
    ? all
    : all.filter(account => linkedIds.has(account.id));

  const db = await getDb();
  const described = [] as ReturnType<typeof describeAccount>[];
  for (const account of visible) {
    const row = describeAccount(account);
    if (db) {
      const [lastLog] = await db
        .select({ postedAt: postLogs.postedAt })
        .from(postLogs)
        .where(
          and(eq(postLogs.accountId, account.id), eq(postLogs.status, "posted"))
        )
        .orderBy(desc(postLogs.postedAt))
        .limit(1);
      row.lastPostedAt = lastLog ? lastLog.postedAt.toISOString() : null;

      const [lastAnalytics] = await db
        .select({ fetchedAt: postAnalytics.fetchedAt })
        .from(postAnalytics)
        .innerJoin(postLogs, eq(postAnalytics.postLogId, postLogs.id))
        .where(eq(postLogs.accountId, account.id))
        .orderBy(desc(postAnalytics.fetchedAt))
        .limit(1);
      row.lastAnalyticsAt = lastAnalytics
        ? lastAnalytics.fetchedAt.toISOString()
        : null;
    }
    described.push(row);
  }

  return { ok: true, data: { accounts: described } };
}

// ---------------------------------------------------------------------
// posts.list
// ---------------------------------------------------------------------

export async function handlePostsList(
  request: AuthorizedRequest
): Promise<HandlerResult> {
  const denied = requirePermission(request, "threads:read");
  if (denied) return { ok: false, error: denied };
  if (request.accountId === null)
    return fail("invalid_request", "アカウントの指定が必要です。");

  const resolved = await scopeForAccount(request.accountId);
  if (!resolved) return fail("not_found", "アカウントが見つかりません。");

  const db = await getDb();
  if (!db) return fail("internal_error", "データベースへ接続できません。");

  const limitParam = Number(request.envelope.params.limit ?? 100);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.trunc(limitParam), 1), 200)
    : 100;

  const rows = await db
    .select()
    .from(postsTable)
    .where(eq(postsTable.accountId, resolved.account.id))
    .orderBy(desc(postsTable.updatedAt))
    .limit(limit);

  const states = await approvalStatesFor(rows.map(row => row.id));
  const categories = await db.select().from(categoriesTable);
  const categoryName = new Map(categories.map(c => [c.id, c.name]));

  const wanted = Array.isArray(request.envelope.params.statuses)
    ? (request.envelope.params.statuses as string[])
    : null;

  const items = rows
    .map(row => {
      const status = toPostStatus(row, states.get(row.id) ?? null);
      return {
        postId: row.id,
        accountId: resolved.account.id,
        status,
        body: row.content,
        characterCount: countCharacters(row.content),
        imageUrl: row.imageUrl ?? null,
        categoryName: row.categoryId
          ? (categoryName.get(row.categoryId) ?? null)
          : null,
        scheduledDate: row.scheduledDate ?? null,
        // 具体的な投稿時刻は投稿枠の設定で決まるため、ここでは返さない。
        scheduledAt: null as string | null,
        slotIndex: row.slotIndex,
        publishedAt: null as string | null,
        permalink: null as string | null,
        errorMessage: null as string | null,
        attemptCount: null as number | null,
        usedTrend: row.trendAnalysisId !== null,
        updatedAt: row.updatedAt.toISOString(),
      };
    })
    .filter(item => (wanted ? wanted.includes(item.status) : true));

  // 投稿済み・失敗の補足情報は post_logs から埋める。
  const logs = await db
    .select()
    .from(postLogs)
    .where(eq(postLogs.accountId, resolved.account.id))
    .orderBy(desc(postLogs.postedAt))
    .limit(500);
  const latestLog = new Map<number, (typeof logs)[number]>();
  for (const log of logs)
    if (log.postId !== null && !latestLog.has(log.postId))
      latestLog.set(log.postId, log);

  for (const item of items) {
    const log = latestLog.get(item.postId);
    if (!log) continue;
    item.publishedAt =
      log.status === "posted" ? log.postedAt.toISOString() : null;
    item.permalink = log.threadsPostId
      ? `https://www.threads.net/t/${log.threadsPostId}`
      : null;
    item.errorMessage = log.errorMessage ?? null;
    item.attemptCount = logs.filter(l => l.postId === item.postId).length;
  }

  return {
    ok: true,
    data: { items, nextCursor: null, totalCount: items.length },
  };
}

// ---------------------------------------------------------------------
// postLogs.list
// ---------------------------------------------------------------------

export async function handlePostLogsList(
  request: AuthorizedRequest
): Promise<HandlerResult> {
  const denied = requirePermission(request, "threads:read");
  if (denied) return { ok: false, error: denied };
  if (request.accountId === null)
    return fail("invalid_request", "アカウントの指定が必要です。");

  const db = await getDb();
  if (!db) return fail("internal_error", "データベースへ接続できません。");

  const limitParam = Number(request.envelope.params.limit ?? 50);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.trunc(limitParam), 1), 200)
    : 50;

  const rows = await db
    .select()
    .from(postLogs)
    .where(eq(postLogs.accountId, request.accountId))
    .orderBy(desc(postLogs.postedAt))
    .limit(limit);

  return {
    ok: true,
    data: {
      items: rows.map(row => ({
        postLogId: row.id,
        postId: row.postId,
        accountId: request.accountId,
        status: row.status,
        // 全文ではなく先頭だけ返す（横断画面へ本文が広がらないようにする）
        bodyPreview: row.content.slice(0, 120),
        threadsPostId: row.threadsPostId ?? null,
        permalink: row.threadsPostId
          ? `https://www.threads.net/t/${row.threadsPostId}`
          : null,
        errorMessage: row.errorMessage ?? null,
        recycled: row.recycled,
        postedAt: row.postedAt.toISOString(),
      })),
      nextCursor: null,
      totalCount: rows.length,
    },
  };
}

// ---------------------------------------------------------------------
// analytics.summary
// ---------------------------------------------------------------------

export async function handleAnalyticsSummary(
  request: AuthorizedRequest
): Promise<HandlerResult> {
  const denied = requirePermission(request, "threads:read");
  if (denied) return { ok: false, error: denied };
  if (request.accountId === null)
    return fail("invalid_request", "アカウントの指定が必要です。");

  const db = await getDb();
  if (!db) return fail("internal_error", "データベースへ接続できません。");

  const rangeParam = Number(request.envelope.params.rangeDays ?? 30);
  const rangeDays = rangeParam === 7 ? 7 : 30;
  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);

  const logs = await db
    .select()
    .from(postLogs)
    .where(
      and(
        eq(postLogs.accountId, request.accountId),
        eq(postLogs.status, "posted"),
        gte(postLogs.postedAt, since)
      )
    )
    .orderBy(desc(postLogs.postedAt));

  const analytics =
    logs.length === 0
      ? []
      : await db
          .select()
          .from(postAnalytics)
          .where(
            inArray(
              postAnalytics.postLogId,
              logs.map(log => log.id)
            )
          );

  // 同じ postLogId が複数あれば最新のものを使う
  const byLog = new Map<number, (typeof analytics)[number]>();
  for (const row of analytics) {
    const current = byLog.get(row.postLogId);
    if (!current || current.fetchedAt < row.fetchedAt)
      byLog.set(row.postLogId, row);
  }

  // 一度も取得できていない場合は合計を 0 ではなく null で返す。
  const measured = Array.from(byLog.values());
  const totals =
    measured.length === 0
      ? { views: null, likes: null, replies: null, reposts: null }
      : {
          views: measured.reduce((sum, row) => sum + row.views, 0),
          likes: measured.reduce((sum, row) => sum + row.likes, 0),
          replies: measured.reduce((sum, row) => sum + row.replies, 0),
          reposts: measured.reduce((sum, row) => sum + row.reposts, 0),
        };

  const fetchedAt = measured.length
    ? new Date(
        Math.max(...measured.map(row => row.fetchedAt.getTime()))
      ).toISOString()
    : null;

  const snapshots = await db
    .select()
    .from(followerSnapshots)
    .where(eq(followerSnapshots.accountId, request.accountId))
    .orderBy(followerSnapshots.capturedDate);

  const current = snapshots.length
    ? snapshots[snapshots.length - 1].followerCount
    : null;
  const changeSince = (days: number): number | null => {
    if (current === null) return null;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const base = [...snapshots]
      .reverse()
      .find(row => row.capturedDate < cutoff);
    return base ? current - base.followerCount : null;
  };

  const trendPostIds = new Set(
    (
      await db
        .select({
          id: postsTable.id,
          trendAnalysisId: postsTable.trendAnalysisId,
        })
        .from(postsTable)
        .where(eq(postsTable.accountId, request.accountId))
    )
      .filter(row => row.trendAnalysisId !== null)
      .map(row => row.id)
  );

  const topPosts = logs
    .map(log => {
      const metric = byLog.get(log.id);
      return {
        postLogId: log.id,
        bodyPreview: log.content.slice(0, 120),
        permalink: log.threadsPostId
          ? `https://www.threads.net/t/${log.threadsPostId}`
          : null,
        postedAt: log.postedAt.toISOString(),
        usedTrend: log.postId !== null && trendPostIds.has(log.postId),
        // 作成方法（AI / 手動）は現状記録していないため、推測せず null を返す。
        aiGenerated: null as boolean | null,
        metrics: metric
          ? {
              views: metric.views,
              likes: metric.likes,
              replies: metric.replies,
              reposts: metric.reposts,
            }
          : { views: null, likes: null, replies: null, reposts: null },
      };
    })
    // 分析を取得できたものだけを並べる（未取得を0位として混ぜない）
    .filter(row => row.metrics.views !== null)
    .sort((a, b) => (b.metrics.views ?? 0) - (a.metrics.views ?? 0))
    .slice(0, 10);

  return {
    ok: true,
    data: {
      fetchedAt,
      rangeDays,
      totals,
      measuredPostCount: measured.length,
      publishedPostCount: logs.length,
      followers: {
        current,
        change7d: changeSince(7),
        change30d: changeSince(30),
        capturedAt: snapshots.length
          ? snapshots[snapshots.length - 1].fetchedAt.toISOString()
          : null,
      },
      topPosts,
    },
  };
}

// ---------------------------------------------------------------------
// trends.list
// ---------------------------------------------------------------------

export async function handleTrendsList(
  request: AuthorizedRequest
): Promise<HandlerResult> {
  const denied = requirePermission(request, "threads:read");
  if (denied) return { ok: false, error: denied };
  if (request.accountId === null)
    return fail("invalid_request", "アカウントの指定が必要です。");

  const db = await getDb();
  if (!db) return fail("internal_error", "データベースへ接続できません。");

  const period = String(request.envelope.params.period ?? "7d");
  const days = period === "24h" ? 1 : period === "30d" ? 30 : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const limitParam = Number(request.envelope.params.limit ?? 30);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.trunc(limitParam), 1), 100)
    : 30;

  const [settings] = await db
    .select()
    .from(trendSettingsTable)
    .where(eq(trendSettingsTable.accountId, request.accountId))
    .limit(1);

  const rows = await db
    .select()
    .from(trendPostsTable)
    .where(
      and(
        eq(trendPostsTable.accountId, request.accountId),
        gte(trendPostsTable.fetchedAt, since),
        inArray(trendPostsTable.status, ["active", "saved"])
      )
    )
    .orderBy(
      request.envelope.params.order === "recent"
        ? desc(trendPostsTable.postedAt)
        : desc(trendPostsTable.score)
    )
    .limit(limit);

  const parseList = (raw: string | null): string[] => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string")
        : [];
    } catch {
      return [];
    }
  };

  const apiPermission =
    settings?.lastFetchError === "permission"
      ? "missing_scope"
      : settings?.lastFetchError === "rate_limited"
        ? "rate_limited"
        : settings?.lastFetchError
          ? "unknown"
          : "ok";

  return {
    ok: true,
    data: {
      state: {
        apiPermission,
        lastFetchAt: settings?.lastFetchAt
          ? settings.lastFetchAt.toISOString()
          : null,
        lastFetchError: settings?.lastFetchError ?? null,
        keywords: parseList(settings?.keywords ?? null),
      },
      items: rows.map(row => ({
        trendPostId: row.id,
        platform: row.platform,
        source: row.source,
        keyword: row.keyword ?? null,
        summary: row.summary,
        permalink: row.permalink ?? null,
        username: row.username ?? null,
        postedAt: row.postedAt ? row.postedAt.toISOString() : null,
        score: row.score,
        isRising: row.isRising,
        status: row.status === "deleted" ? "excluded" : row.status,
        metrics: {
          views: row.views,
          likes: row.likes,
          replies: row.replies,
          reposts: row.reposts,
        },
        aiReason: row.aiReason ?? null,
        aiIdeas: parseList(row.aiIdeas ?? null),
        fetchedAt: row.fetchedAt.toISOString(),
      })),
      nextCursor: null,
    },
  };
}

// ---------------------------------------------------------------------
// strategy.get
// ---------------------------------------------------------------------

/**
 * 7日間コンテンツ戦略は Threads Studio にまだ存在しない機能である。
 * 数字や文章を作って返さない。null を返し、大漁マーケット側は
 * 「まだ作成されていません」と表示する。
 */
export async function handleStrategyGet(
  request: AuthorizedRequest
): Promise<HandlerResult> {
  const denied = requirePermission(request, "threads:read");
  if (denied) return { ok: false, error: denied };
  return { ok: true, data: { strategy: null } };
}

// ---------------------------------------------------------------------
// 変更系（冪等キー必須）
// ---------------------------------------------------------------------

async function runIdempotent(
  request: AuthorizedRequest,
  operation: string,
  run: () => Promise<{ postId: number | null; status: string }>
): Promise<HandlerResult> {
  const idempotencyKey = request.envelope.idempotencyKey;
  if (!idempotencyKey) return fail("invalid_request", "冪等キーが必要です。");

  const requestDigest = digestOf(request.envelope.params);
  const claim = await claimOperation({
    idempotencyKey,
    externalClientId: request.envelope.clientId,
    accountId: request.accountId,
    operation,
    requestDigest,
  });

  if (!claim.claimed) {
    const existing = claim.existing;
    if (!existing) return fail("conflict", "処理状態を確認できませんでした。");
    if (existing.requestDigest !== requestDigest)
      return fail("conflict", "同じ操作キーで異なる内容が送信されました。");
    if (existing.status === "succeeded")
      return {
        ok: true,
        data: {
          ...(JSON.parse(existing.result ?? "{}") as Record<string, unknown>),
          idempotentReplay: true,
        },
      };
    if (existing.status === "pending")
      return fail("conflict", "同じ操作を処理中です。");
    return fail("conflict", "前回の操作が失敗しています。");
  }

  try {
    const result = await run();
    await completeOperation(idempotencyKey, "succeeded", result);
    return { ok: true, data: { ...result, idempotentReplay: false } };
  } catch (error) {
    await completeOperation(idempotencyKey, "failed", {});
    const message =
      error instanceof Error ? error.message : "処理に失敗しました。";
    return fail("internal_error", message);
  }
}

function validateBody(body: unknown): string | null {
  if (typeof body !== "string") return "本文が不正です。";
  if (!body.trim()) return "本文が空です。";
  if (countCharacters(body) > THREADS_MAX_CHARACTERS)
    return `本文が ${THREADS_MAX_CHARACTERS} 文字を超えています。`;
  return null;
}

function validateImageUrl(imageUrl: unknown): string | null {
  if (imageUrl === null || imageUrl === undefined || imageUrl === "")
    return null;
  if (typeof imageUrl !== "string") return "画像URLが不正です。";
  try {
    const url = new URL(imageUrl);
    if (url.protocol !== "https:")
      return "画像URLは https:// である必要があります。";
  } catch {
    return "画像URLが不正です。";
  }
  return null;
}

export async function handlePostsCreate(
  request: AuthorizedRequest
): Promise<HandlerResult> {
  const denied = requirePermission(request, "threads:draft");
  if (denied) return { ok: false, error: denied };
  if (request.accountId === null)
    return fail("invalid_request", "アカウントの指定が必要です。");

  const params = request.envelope.params;
  const bodyError = validateBody(params.body);
  if (bodyError) return fail("invalid_request", bodyError);
  const imageError = validateImageUrl(params.imageUrl);
  if (imageError) return fail("invalid_request", imageError);

  const scheduledDate =
    typeof params.scheduledDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(params.scheduledDate)
      ? params.scheduledDate
      : null;
  if (scheduledDate && !request.permissions.includes("threads:schedule"))
    return fail("forbidden", "予約を行う権限がありません。");

  const accountId = request.accountId;
  const wantsApproval = params.approvalStatus === "pending_approval";

  return runIdempotent(request, "posts.create", async () => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");

    const slotIndexRaw = Number(params.slotIndex);
    const [inserted] = await db.insert(postsTable).values({
      content: params.body as string,
      accountId,
      // 統合経由で作った原稿は、承認されるまで自動投稿させない。
      approvalStatus: "draft",
      scheduledDate,
      slotIndex: Number.isInteger(slotIndexRaw) ? slotIndexRaw : 0,
      imageUrl: typeof params.imageUrl === "string" ? params.imageUrl : null,
    });
    const postId = inserted.insertId;

    await db.insert(integrationPostStates).values({
      postId,
      approvalState: wantsApproval ? "pending_approval" : "rejected",
    });
    if (!wantsApproval)
      // 承認申請なしの新規は「下書き」。rejected ではなく下書きとして扱うため
      // 中間状態の行は消しておく。
      await db
        .delete(integrationPostStates)
        .where(eq(integrationPostStates.postId, postId));

    return { postId, status: wantsApproval ? "pending_approval" : "draft" };
  });
}

export async function handlePostsUpdate(
  request: AuthorizedRequest
): Promise<HandlerResult> {
  const denied = requirePermission(request, "threads:draft");
  if (denied) return { ok: false, error: denied };
  if (request.accountId === null)
    return fail("invalid_request", "アカウントの指定が必要です。");

  const params = request.envelope.params;
  const postId = Number(params.postId);
  if (!Number.isInteger(postId))
    return fail("invalid_request", "投稿IDが不正です。");
  const bodyError = validateBody(params.body);
  if (bodyError) return fail("invalid_request", bodyError);
  const imageError = validateImageUrl(params.imageUrl);
  if (imageError) return fail("invalid_request", imageError);

  const scheduledDate =
    typeof params.scheduledDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(params.scheduledDate)
      ? params.scheduledDate
      : null;
  if (scheduledDate && !request.permissions.includes("threads:schedule"))
    return fail("forbidden", "予約を行う権限がありません。");

  const owned = await getOwnedByAccount(postId, request.accountId);
  if (!owned) return fail("not_found", "この原稿は見つかりません。");
  if (owned.status === "posted")
    return fail("conflict", "投稿済みの原稿は編集できません。");

  return runIdempotent(request, "posts.update", async () => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const slotIndexRaw = Number(params.slotIndex);
    await db
      .update(postsTable)
      .set({
        content: params.body as string,
        scheduledDate,
        imageUrl: typeof params.imageUrl === "string" ? params.imageUrl : null,
        ...(Number.isInteger(slotIndexRaw) ? { slotIndex: slotIndexRaw } : {}),
      })
      .where(eq(postsTable.id, postId));
    return { postId, status: "updated" };
  });
}

/** 他アカウントの原稿IDを渡されても触れないようにする。 */
async function getOwnedByAccount(postId: number, accountId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(postsTable)
    .where(and(eq(postsTable.id, postId), eq(postsTable.accountId, accountId)))
    .limit(1);
  return rows[0];
}

export async function handlePostsSetApproval(
  request: AuthorizedRequest
): Promise<HandlerResult> {
  const denied = requirePermission(request, "threads:approve");
  if (denied) return { ok: false, error: denied };
  if (request.accountId === null)
    return fail("invalid_request", "アカウントの指定が必要です。");

  const params = request.envelope.params;
  const postId = Number(params.postId);
  const decision = params.decision;
  if (!Number.isInteger(postId))
    return fail("invalid_request", "投稿IDが不正です。");
  if (decision !== "approve" && decision !== "reject")
    return fail("invalid_request", "判断の指定が不正です。");

  const owned = await getOwnedByAccount(postId, request.accountId);
  if (!owned) return fail("not_found", "この原稿は見つかりません。");
  if (owned.status !== "pending")
    return fail("conflict", "この原稿は既に投稿処理へ進んでいます。");

  // 画面に出ていた版と現在の版が違えば、承認を通さない（更新競合の防止）。
  const expected = params.expectedUpdatedAt;
  if (
    typeof expected === "string" &&
    expected &&
    new Date(expected).getTime() !== owned.updatedAt.getTime()
  )
    return fail(
      "conflict",
      "表示していた内容から更新されています。読み直してから承認してください。"
    );

  const userId = request.envelope.actor.userId;

  return runIdempotent(request, "posts.setApproval", async () => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    const approvalState = decision === "approve" ? "approved" : "rejected";

    await db
      .update(postsTable)
      .set({ approvalStatus: decision === "approve" ? "approved" : "draft" })
      .where(eq(postsTable.id, postId));

    await db
      .insert(integrationPostStates)
      .values({
        postId,
        approvalState,
        note: typeof params.note === "string" ? params.note : null,
        decidedBy: userId,
        decidedAt: new Date(),
      })
      .onDuplicateKeyUpdate({
        set: {
          approvalState,
          note: typeof params.note === "string" ? params.note : null,
          decidedBy: userId,
          decidedAt: new Date(),
        },
      });

    return { postId, status: approvalState };
  });
}

export async function handlePostsRetry(
  request: AuthorizedRequest
): Promise<HandlerResult> {
  const denied = requirePermission(request, "threads:retry");
  if (denied) return { ok: false, error: denied };
  if (request.accountId === null)
    return fail("invalid_request", "アカウントの指定が必要です。");

  const postId = Number(request.envelope.params.postId);
  if (!Number.isInteger(postId))
    return fail("invalid_request", "投稿IDが不正です。");

  const owned = await getOwnedByAccount(postId, request.accountId);
  if (!owned) return fail("not_found", "この原稿は見つかりません。");
  if (owned.status !== "error")
    return fail("conflict", "失敗していない原稿は再試行できません。");

  return runIdempotent(request, "posts.retry", async () => {
    const db = await getDb();
    if (!db) throw new Error("DB unavailable");
    // 実際の投稿はスケジューラーが行う。ここでは対象へ戻すだけ。
    await db
      .update(postsTable)
      .set({ status: "pending" })
      .where(eq(postsTable.id, postId));
    return { postId, status: "pending" };
  });
}

export async function handlePing(
  request: AuthorizedRequest
): Promise<HandlerResult> {
  const account =
    request.accountId === null ? null : await getAccountById(request.accountId);
  return {
    ok: true,
    data: {
      pong: true,
      clientId: request.envelope.clientId,
      accountId: account?.id ?? null,
      permissions: request.permissions,
    },
  };
}

// accountsTable は describeAccount の型付けにだけ使う（未使用警告の回避）
void accountsTable;
