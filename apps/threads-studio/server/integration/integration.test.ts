/**
 * 統合API（大漁マーケットOS からのサーバー間呼び出し）の検証。
 * 実際のThreads / OpenAI / 本番DBへは接続しない。
 */
import { describe, expect, it } from "vitest";

import { effectivePermissions, permissionsForRole, HEADER } from "./contract";
import {
  canonicalString,
  createNonceStore,
  hashBody,
  signatureHeaders,
  verifyRequest,
} from "./signature";

const SECRET = "studio-side-test-secret";
const KEY_ID = "tairyo-test";
const NOW_MS = 1_780_000_000_000;

function material(body: string) {
  return {
    keyId: KEY_ID,
    timestamp: Math.floor(NOW_MS / 1000),
    nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    method: "POST",
    path: "/api/integration/v1/posts.list",
    body,
  };
}

function request(body: string, overrides: Record<string, string> = {}) {
  return {
    headers: { ...signatureHeaders(material(body), SECRET), ...overrides },
    method: "POST",
    path: "/api/integration/v1/posts.list",
    body,
  };
}

const envelope = JSON.stringify({
  apiVersion: "2026-09-01",
  organizationId: "tairyo-market",
  clientId: "client-a",
  accountId: 3,
  actor: {
    userId: "u1",
    role: "content_manager",
    permissions: ["threads:read"],
  },
  params: {},
});

describe("署名の検証", () => {
  const secrets = { [KEY_ID]: SECRET };

  it("正規化文字列は本文ハッシュを含む", () => {
    expect(canonicalString(material(envelope))).toContain(hashBody(envelope));
  });

  it("正しい署名を受け入れる", () => {
    expect(
      verifyRequest(request(envelope), { secrets, nowMs: NOW_MS })
    ).toMatchObject({ ok: true });
  });

  it("accountId を書き換えると検証に失敗する", () => {
    const tampered = request(envelope);
    tampered.body = envelope.replace('"accountId":3', '"accountId":999');
    expect(verifyRequest(tampered, { secrets, nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("5分を超えた署名は期限切れ", () => {
    expect(
      verifyRequest(request(envelope), { secrets, nowMs: NOW_MS + 301_000 })
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("未知の鍵IDは拒否する", () => {
    expect(
      verifyRequest(request(envelope), {
        secrets: { other: SECRET },
        nowMs: NOW_MS,
      })
    ).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("同じリクエストの再送を拒否する", () => {
    const store = createNonceStore();
    const options = {
      secrets,
      nowMs: NOW_MS,
      consumeNonce: (keyId: string, nonce: string) =>
        store.consume(keyId, nonce, NOW_MS),
    };
    expect(verifyRequest(request(envelope), options)).toMatchObject({
      ok: true,
    });
    expect(verifyRequest(request(envelope), options)).toEqual({
      ok: false,
      reason: "replayed",
    });
  });

  it("署名ヘッダーが無ければ拒否する", () => {
    const req = request(envelope);
    delete (req.headers as Record<string, string>)[HEADER.signature];
    expect(verifyRequest(req, { secrets, nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: "missing_headers",
    });
  });
});

describe("権限", () => {
  it("ロールから権限を導出する", () => {
    expect(permissionsForRole("analyst")).toEqual(["threads:read"]);
    expect(permissionsForRole("unknown")).toEqual(["threads:read"]);
  });

  it("申告された権限を鵜呑みにしない（積集合だけ与える）", () => {
    expect(
      effectivePermissions("analyst", [
        "threads:read",
        "threads:approve",
        "threads:admin",
      ])
    ).toEqual(["threads:read"]);
  });

  it("申告が無い場合はロールの権限をそのまま使う", () => {
    expect(effectivePermissions("creator", undefined)).toEqual([
      "threads:read",
      "threads:draft",
    ]);
  });

  it("申告が狭ければ、その狭い方に合わせる（最小権限）", () => {
    expect(effectivePermissions("admin", ["threads:read"])).toEqual([
      "threads:read",
    ]);
  });
});
