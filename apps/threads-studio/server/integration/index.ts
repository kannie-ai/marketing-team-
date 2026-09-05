/**
 * 統合APIのルート登録（Threads Studio 側）。
 *
 * 重要：このルーターは express.json() より前に登録すること。
 * 署名は「受け取った生の本文」のハッシュに掛かっているため、
 * 一度パースして再度文字列化したものでは検証できない。
 *
 *   server/_core/index.ts の中で
 *     registerIntegrationRoutes(app);      ← ここ（json より前）
 *     app.use(express.json({ limit: "50mb" }));
 */
import express, { type Express, type Request, type Response } from "express";

import { authorize, type AuthorizedRequest } from "./auth";
import { ENDPOINT, HEADER, INTEGRATION_PREFIX } from "./contract";
import {
  handleAccountsList,
  handleAnalyticsSummary,
  handlePing,
  handlePostLogsList,
  handlePostsCreate,
  handlePostsList,
  handlePostsRetry,
  handlePostsSetApproval,
  handlePostsUpdate,
  handleStrategyGet,
  handleTrendsList,
  type HandlerResult,
} from "./handlers";

type Handler = (request: AuthorizedRequest) => Promise<HandlerResult>;

/** エンドポイントごとの実装と、アカウント指定の要否。 */
const ROUTES: Record<string, { handler: Handler; requiresAccount: boolean }> = {
  [ENDPOINT.ping]: { handler: handlePing, requiresAccount: false },
  [ENDPOINT.accountsList]: {
    handler: handleAccountsList,
    requiresAccount: false,
  },
  [ENDPOINT.postsList]: { handler: handlePostsList, requiresAccount: true },
  [ENDPOINT.postsCreate]: { handler: handlePostsCreate, requiresAccount: true },
  [ENDPOINT.postsUpdate]: { handler: handlePostsUpdate, requiresAccount: true },
  [ENDPOINT.postsSetApproval]: {
    handler: handlePostsSetApproval,
    requiresAccount: true,
  },
  [ENDPOINT.postsRetry]: { handler: handlePostsRetry, requiresAccount: true },
  [ENDPOINT.postLogsList]: {
    handler: handlePostLogsList,
    requiresAccount: true,
  },
  [ENDPOINT.analyticsSummary]: {
    handler: handleAnalyticsSummary,
    requiresAccount: true,
  },
  [ENDPOINT.trendsList]: { handler: handleTrendsList, requiresAccount: true },
  [ENDPOINT.strategyGet]: { handler: handleStrategyGet, requiresAccount: true },
};

const STATUS_BY_CODE: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_linked: 403,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  upstream_error: 502,
  internal_error: 500,
};

/**
 * 素朴なレート制限。鍵IDごとに1分あたりの回数を制限する。
 * 分散構成にする場合は共有ストアへ差し替えること。
 */
const RATE_LIMIT_PER_MINUTE = Number(
  process.env.TAIRYO_INTEGRATION_RATE_LIMIT ?? "240"
);
const counters = new Map<string, { count: number; resetAt: number }>();

function overRateLimit(keyId: string, now = Date.now()): boolean {
  const entry = counters.get(keyId);
  if (!entry || entry.resetAt <= now) {
    counters.set(keyId, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_PER_MINUTE;
}

export function registerIntegrationRoutes(app: Express): void {
  // 生の本文が必要なので、この経路だけ raw で受ける（最大2MB）。
  app.use(
    INTEGRATION_PREFIX,
    express.raw({ type: "*/*", limit: "2mb" }),
    async (req: Request, res: Response) => {
      const requestId =
        (req.headers[HEADER.requestId] as string | undefined) ?? "";
      const path = `${INTEGRATION_PREFIX}${req.path === "/" ? "" : req.path}`;
      const route = ROUTES[path];

      const send = (status: number, payload: Record<string, unknown>): void => {
        res.status(status).json({ requestId, ...payload });
      };

      if (req.method !== "POST")
        return send(405, {
          ok: false,
          error: {
            code: "invalid_request",
            message: "POST のみ受け付けます。",
          },
        });
      if (!route)
        return send(404, {
          ok: false,
          error: {
            code: "not_found",
            message: "存在しないエンドポイントです。",
          },
        });

      const keyId = (req.headers[HEADER.keyId] as string | undefined) ?? "";
      if (keyId && overRateLimit(keyId))
        return send(429, {
          ok: false,
          error: { code: "rate_limited", message: "要求が多すぎます。" },
        });

      const rawBody = Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : typeof req.body === "string"
          ? req.body
          : "";

      const authorized = await authorize({
        headers: req.headers as Record<string, string | string[] | undefined>,
        method: req.method,
        path,
        rawBody,
        requiresAccount: route.requiresAccount,
      });

      if (!authorized.ok)
        return send(STATUS_BY_CODE[authorized.error.code] ?? 400, {
          ok: false,
          error: authorized.error,
        });

      try {
        const result = await route.handler(authorized.data);
        if (!result.ok)
          return send(STATUS_BY_CODE[result.error.code] ?? 400, {
            ok: false,
            error: result.error,
          });
        return send(200, { ok: true, data: result.data });
      } catch (error) {
        // 例外の中身はそのまま返さない（秘密が混ざりうるため）。
        console.error(
          "[integration] handler failed",
          path,
          error instanceof Error ? error.name : "unknown"
        );
        return send(500, {
          ok: false,
          error: { code: "internal_error", message: "処理に失敗しました。" },
        });
      }
    }
  );
}
