/**
 * 大漁マーケットOS ⇄ Threads Studio のサーバー間認証（Threads Studio 側）。
 *
 * 大漁マーケット側 `src/lib/threads-studio/signature.ts` と同一。
 * 署名の作成関数も残してあるのは、テストで正しいリクエストを組み立てるため。
 *
 * 方針
 *   - ブラウザへは秘密を一切渡さない。署名はNext.jsのサーバー側でだけ作る。
 *   - 長期有効なトークンをリクエストに載せない。署名自体に時刻を含め、
 *     ±5分の範囲でしか成立しないようにする（短時間トークンと同じ効果）。
 *   - nonce を必須にし、受信側で使い捨てにすることでリプレイを防ぐ。
 *   - 署名対象に本文ハッシュを含めるため、clientId / accountId / actor を
 *     書き換えると署名が壊れる（accountIdの改ざん防止）。
 *
 * このファイルは Node の crypto だけに依存し、環境変数を読まない。
 * 秘密は引数で受け取る。そうすることで単体テストから直接検証できる。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

import {
  HEADER,
  SIGNATURE_MAX_SKEW_SECONDS,
  SIGNATURE_SCHEME,
} from "./contract";

export interface SignatureMaterial {
  keyId: string;
  timestamp: number;
  nonce: string;
  method: string;
  path: string;
  body: string;
}

/** 本文の SHA-256（16進小文字）。空本文も必ずハッシュを取る。 */
export function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * 署名対象の正規化文字列。
 * 改行区切りで固定長・固定順。ヘッダー順序やクエリ文字列に依存しない。
 */
export function canonicalString(material: SignatureMaterial): string {
  return [
    SIGNATURE_SCHEME,
    material.keyId,
    String(material.timestamp),
    material.nonce,
    material.method.toUpperCase(),
    material.path,
    hashBody(material.body),
  ].join("\n");
}

/** 署名値（`v1=<hex>`）を作る。 */
export function signRequest(
  material: SignatureMaterial,
  secret: string
): string {
  if (!secret) throw new Error("integration secret is not configured");
  const digest = createHmac("sha256", secret)
    .update(canonicalString(material), "utf8")
    .digest("hex");
  return `v1=${digest}`;
}

/** リクエストに載せるヘッダー一式。 */
export function signatureHeaders(
  material: SignatureMaterial,
  secret: string
): Record<string, string> {
  return {
    [HEADER.keyId]: material.keyId,
    [HEADER.timestamp]: String(material.timestamp),
    [HEADER.nonce]: material.nonce,
    [HEADER.signature]: signRequest(material, secret),
  };
}

/** 使い捨ての nonce。 */
export function createNonce(): string {
  return randomBytes(16).toString("hex");
}

/** 長さ差でも情報を漏らさない比較。 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type VerificationFailure =
  | "missing_headers"
  | "bad_timestamp"
  | "expired"
  | "unknown_key"
  | "bad_signature"
  | "replayed";

export type VerificationResult =
  | { ok: true; keyId: string; nonce: string; timestamp: number }
  | { ok: false; reason: VerificationFailure };

export interface VerifyOptions {
  /** keyId → secret。鍵のローテーション中は複数を同時に受け付ける。 */
  secrets: Record<string, string>;
  /** 検証時刻（ミリ秒）。テストのために差し替えられるようにしてある。 */
  nowMs?: number;
  maxSkewSeconds?: number;
  /**
   * nonce を消費する。既に使われていれば false を返すこと。
   * 省略した場合はリプレイ検査を行わない（呼び出し側の責任で必ず渡す）。
   */
  consumeNonce?: (keyId: string, nonce: string) => boolean;
}

/**
 * 受信側の検証。Threads Studio の実装（integration/threads-studio/）と
 * 同じロジックを共有できるよう、ここに置いて単体テストの対象にする。
 */
export function verifyRequest(
  input: {
    headers: Record<string, string | string[] | undefined>;
    method: string;
    path: string;
    body: string;
  },
  options: VerifyOptions
): VerificationResult {
  const header = (name: string): string => {
    const raw = input.headers[name] ?? input.headers[name.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" ? value.trim() : "";
  };

  const keyId = header(HEADER.keyId);
  const rawTimestamp = header(HEADER.timestamp);
  const nonce = header(HEADER.nonce);
  const signature = header(HEADER.signature);
  if (!keyId || !rawTimestamp || !nonce || !signature)
    return { ok: false, reason: "missing_headers" };

  if (!/^\d{1,15}$/.test(rawTimestamp))
    return { ok: false, reason: "bad_timestamp" };
  const timestamp = Number(rawTimestamp);

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const skew = Math.abs(nowSeconds - timestamp);
  const maxSkew = options.maxSkewSeconds ?? SIGNATURE_MAX_SKEW_SECONDS;
  if (skew > maxSkew) return { ok: false, reason: "expired" };

  const secret = options.secrets[keyId];
  // 未知の鍵でも署名検証まで進めず、ここで落とす。
  // 応答の内容から「鍵IDが存在するか」を推測させないよう、
  // 呼び出し側は unknown_key と bad_signature を同じ 401 に丸めること。
  if (!secret) return { ok: false, reason: "unknown_key" };

  const expected = signRequest(
    {
      keyId,
      timestamp,
      nonce,
      method: input.method,
      path: input.path,
      body: input.body,
    },
    secret
  );
  if (!safeEqual(signature, expected))
    return { ok: false, reason: "bad_signature" };

  // 署名が正しいものだけを nonce 台帳に載せる（総当たりで台帳を汚させない）。
  if (options.consumeNonce && !options.consumeNonce(keyId, nonce))
    return { ok: false, reason: "replayed" };

  return { ok: true, keyId, nonce, timestamp };
}

/**
 * 期限付きの nonce 台帳。プロセス内メモリで足りる規模を想定している。
 * 複数インスタンス構成にする場合は、同じインターフェースで
 * Redis / DB 実装に差し替える。
 */
export function createNonceStore(ttlSeconds = SIGNATURE_MAX_SKEW_SECONDS * 2) {
  const seen = new Map<string, number>();
  return {
    consume(keyId: string, nonce: string, nowMs = Date.now()): boolean {
      // Array.from にしているのは、ES5 ターゲットの環境でも動くようにするため。
      for (const [key, expiresAt] of Array.from(seen.entries()))
        if (expiresAt <= nowMs) seen.delete(key);
      const composite = `${keyId}:${nonce}`;
      if (seen.has(composite)) return false;
      seen.set(composite, nowMs + ttlSeconds * 1000);
      return true;
    },
    get size() {
      return seen.size;
    },
  };
}
