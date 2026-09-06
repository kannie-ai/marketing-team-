/**
 * 統合API用のDBアクセス（Threads Studio 側）。
 * 既存の getDb() を使い、追加テーブルだけを触る。
 */
import { and, eq, lt } from "drizzle-orm";

import { getDb } from "../db";
import {
  integrationAccountLinks,
  integrationNonces,
  integrationOperations,
} from "./schema";

/** clientId と accountId の組み合わせが登録されているか。 */
export async function findAccountLink(
  externalClientId: string,
  accountId: number
) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(integrationAccountLinks)
    .where(
      and(
        eq(integrationAccountLinks.externalClientId, externalClientId),
        eq(integrationAccountLinks.accountId, accountId)
      )
    )
    .limit(1);
  return rows[0];
}

/** そのクライアントに紐づく accounts.id の一覧。 */
export async function listAccountLinks(externalClientId: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(integrationAccountLinks)
    .where(eq(integrationAccountLinks.externalClientId, externalClientId));
}

/**
 * nonce を使い捨てる。既に使われていれば false。
 * 一意制約に任せるので、同時実行でも二重に通らない。
 */
export async function consumeNonce(
  keyId: string,
  nonce: string,
  expiresAt: Date
): Promise<boolean> {
  const db = await getDb();
  // DBが無い構成では検証を止める（通してしまうより安全側に倒す）
  if (!db) return false;
  try {
    await db.insert(integrationNonces).values({ keyId, nonce, expiresAt });
    return true;
  } catch {
    return false;
  }
}

/** 期限切れの nonce を掃除する。失敗しても処理は続ける。 */
export async function pruneNonces(now: Date = new Date()): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db
      .delete(integrationNonces)
      .where(lt(integrationNonces.expiresAt, now));
  } catch {
    // 掃除に失敗しても本処理は続行する
  }
}

export async function findOperation(idempotencyKey: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(integrationOperations)
    .where(eq(integrationOperations.idempotencyKey, idempotencyKey))
    .limit(1);
  return rows[0];
}

/**
 * 冪等キーを予約する。
 * 既にあれば claimed=false と既存行を返し、呼び出し側は処理をやり直さない。
 */
export async function claimOperation(input: {
  idempotencyKey: string;
  externalClientId: string;
  accountId: number | null;
  operation: string;
  requestDigest: string;
}): Promise<{
  claimed: boolean;
  existing?: Awaited<ReturnType<typeof findOperation>>;
}> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  try {
    await db.insert(integrationOperations).values({
      idempotencyKey: input.idempotencyKey,
      externalClientId: input.externalClientId,
      accountId: input.accountId,
      operation: input.operation,
      requestDigest: input.requestDigest,
      status: "pending",
    });
    return { claimed: true };
  } catch {
    return {
      claimed: false,
      existing: await findOperation(input.idempotencyKey),
    };
  }
}

export async function completeOperation(
  idempotencyKey: string,
  status: "succeeded" | "failed",
  result: unknown
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(integrationOperations)
    .set({ status, result: JSON.stringify(result ?? {}) })
    .where(eq(integrationOperations.idempotencyKey, idempotencyKey));
}
