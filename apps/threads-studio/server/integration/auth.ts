/**
 * 統合APIの認証・認可（Threads Studio 側）。
 *
 *   1. 署名を検証する（鍵ID・時刻・nonce・メソッド・パス・本文ハッシュ）
 *   2. nonce を使い捨てる（リプレイ防止）
 *   3. 本文の clientId と accountId が対応表に載っているかを確認する
 *   4. role から権限を再計算し、申告との積集合だけを与える
 *
 * 秘密はログへ出さない。失敗理由も外へは細かく返さない
 * （unknown_key と bad_signature はどちらも 401 に丸める）。
 */
import { createHash } from "node:crypto";

import {
  INTEGRATION_API_VERSION,
  SIGNATURE_MAX_SKEW_SECONDS,
  effectivePermissions,
  type IntegrationEnvelope,
  type IntegrationErrorCode,
  type IntegrationPermission,
} from "./contract";
import { verifyRequest } from "./signature";
import { consumeNonce, findAccountLink, pruneNonces } from "./store";

export interface AuthorizedRequest {
  envelope: IntegrationEnvelope;
  permissions: IntegrationPermission[];
  /** 対応表で確認済みのアカウントID。null は「アカウント指定なし」 */
  accountId: number | null;
}

export type AuthFailure = { code: IntegrationErrorCode; message: string };

/**
 * 受け付ける鍵。ローテーション中は2つ設定できる。
 *   TAIRYO_INTEGRATION_KEY_ID / TAIRYO_INTEGRATION_SECRET
 *   TAIRYO_INTEGRATION_KEY_ID_PREVIOUS / TAIRYO_INTEGRATION_SECRET_PREVIOUS
 */
export function loadSecrets(): Record<string, string> {
  const secrets: Record<string, string> = {};
  const current = process.env.TAIRYO_INTEGRATION_SECRET ?? "";
  const currentId = process.env.TAIRYO_INTEGRATION_KEY_ID ?? "tairyo-default";
  if (current) secrets[currentId] = current;

  const previous = process.env.TAIRYO_INTEGRATION_SECRET_PREVIOUS ?? "";
  const previousId = process.env.TAIRYO_INTEGRATION_KEY_ID_PREVIOUS ?? "";
  if (previous && previousId) secrets[previousId] = previous;

  return secrets;
}

/** 許可する組織。未設定ならどの組織でも通す（単一テナント運用向け）。 */
function allowedOrganizations(): string[] {
  return (process.env.TAIRYO_ALLOWED_ORGANIZATIONS ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

export function digestOf(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload) ?? "", "utf8")
    .digest("hex");
}

function parseEnvelope(raw: string): IntegrationEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  const actor = value.actor as Record<string, unknown> | undefined;
  if (
    typeof value.apiVersion !== "string" ||
    typeof value.organizationId !== "string" ||
    typeof value.clientId !== "string" ||
    !actor ||
    typeof actor.role !== "string" ||
    typeof value.params !== "object" ||
    value.params === null
  )
    return null;
  const accountId = value.accountId;
  if (accountId !== null && !Number.isInteger(accountId)) return null;

  return {
    apiVersion: value.apiVersion,
    organizationId: value.organizationId,
    clientId: value.clientId,
    accountId: accountId as number | null,
    actor: {
      userId: typeof actor.userId === "string" ? actor.userId : null,
      role: actor.role,
      permissions: actor.permissions,
    },
    idempotencyKey:
      typeof value.idempotencyKey === "string"
        ? value.idempotencyKey
        : undefined,
    params: value.params as Record<string, unknown>,
  };
}

/**
 * リクエストを検証する。成功したら、以降のハンドラは
 * result.accountId と result.permissions しか見てはいけない。
 */
export async function authorize(input: {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  path: string;
  rawBody: string;
  /** アカウント指定が必須のエンドポイントか */
  requiresAccount: boolean;
}): Promise<
  { ok: true; data: AuthorizedRequest } | { ok: false; error: AuthFailure }
> {
  const secrets = loadSecrets();
  if (Object.keys(secrets).length === 0)
    return {
      ok: false,
      error: { code: "unauthorized", message: "統合APIが設定されていません。" },
    };

  const verified = verifyRequest(
    {
      headers: input.headers,
      method: input.method,
      path: input.path,
      body: input.rawBody,
    },
    {
      secrets,
      consumeNonce: () => true, // 署名検証を通ってから、下でDBの台帳を使う
    }
  );

  if (!verified.ok)
    return {
      ok: false,
      // 失敗理由は外に出さない。すべて 401 相当へ丸める。
      error: { code: "unauthorized", message: "署名を検証できませんでした。" },
    };

  // 署名が正しいものだけを台帳に載せる（総当たりで台帳を汚させない）。
  const expiresAt = new Date(
    Date.now() + SIGNATURE_MAX_SKEW_SECONDS * 2 * 1000
  );
  const fresh = await consumeNonce(verified.keyId, verified.nonce, expiresAt);
  if (!fresh)
    return {
      ok: false,
      error: {
        code: "unauthorized",
        message: "このリクエストは既に処理されています。",
      },
    };
  void pruneNonces();

  const envelope = parseEnvelope(input.rawBody);
  if (!envelope)
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: "リクエストの形式が不正です。",
      },
    };

  if (envelope.apiVersion !== INTEGRATION_API_VERSION)
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: `APIバージョンが一致しません（期待値 ${INTEGRATION_API_VERSION}）。`,
      },
    };

  const organizations = allowedOrganizations();
  if (
    organizations.length > 0 &&
    !organizations.includes(envelope.organizationId)
  )
    return {
      ok: false,
      error: {
        code: "forbidden",
        message: "この組織からの要求は許可されていません。",
      },
    };

  // accountId は必ず対応表で確認する。署名が正しくても、
  // 対応表に無い組み合わせは通さない（クライアント間の漏れを防ぐ最後の砦）。
  let accountId: number | null = null;
  if (envelope.accountId !== null) {
    const link = await findAccountLink(envelope.clientId, envelope.accountId);
    if (!link)
      return {
        ok: false,
        error: {
          code: "not_linked",
          message: "このクライアントに紐づいていないアカウントです。",
        },
      };
    accountId = link.accountId;
  } else if (input.requiresAccount) {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: "アカウントの指定が必要です。",
      },
    };
  }

  return {
    ok: true,
    data: {
      envelope,
      accountId,
      permissions: effectivePermissions(
        envelope.actor.role,
        envelope.actor.permissions
      ),
    },
  };
}

export function requirePermission(
  request: AuthorizedRequest,
  permission: IntegrationPermission
): AuthFailure | null {
  if (request.permissions.includes(permission)) return null;
  return { code: "forbidden", message: "この操作を行う権限がありません。" };
}
