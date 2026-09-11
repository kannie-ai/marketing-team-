/**
 * OpenAI呼び出しの失敗応答の扱い。実際のAPIは呼ばず fetch を差し替える。
 * status だけでなく error.code（model_not_found 等）を例外に載せ、
 * エラー文に含まれうるキーの断片は伏せる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_core/env", () => ({ ENV: { openaiApiKey: "sk-test-NEVER-LEAK", openaiModel: "gpt-test" } }));

import { invokeLLM } from "./_core/llm";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("invokeLLM の失敗応答", () => {
  it("OpenAI の error.code と説明を例外に載せ、status も持つ", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(404, { error: { message: "The model `gpt-test` does not exist", type: "invalid_request_error", code: "model_not_found" } }));
    const error = await invokeLLM({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e as Error & { status?: number; code?: string });
    expect(error.status).toBe(404);
    expect(error.code).toBe("model_not_found");
    expect(error.message).toContain("404 model_not_found");
    expect(error.message).toContain("does not exist");
  });

  it("エラー文に含まれるキーの断片を伏せる", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, { error: { message: "Incorrect API key provided: sk-proj-****NEVER-LEAK", type: "invalid_request_error", code: "invalid_api_key" } }));
    const error = await invokeLLM({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e as Error);
    expect(error.message).not.toContain("NEVER-LEAK");
    expect(error.message).toContain("sk-***");
  });

  it("本文がJSONでなくても status で例外にする", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
    const error = await invokeLLM({ messages: [{ role: "user", content: "hi" }] }).catch((e) => e as Error & { status?: number });
    expect(error.status).toBe(502);
    expect(error.message).toContain("502");
  });

  it("成功応答は従来の形に正規化し、リクエストにモデルと response_format を含める", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { id: "r1", model: "gpt-test", choices: [{ index: 0, message: { content: "{\"ok\":true}" }, finish_reason: "stop" }] }));
    const result = await invokeLLM({ messages: [{ role: "user", content: "hi" }], responseFormat: { type: "json_object" } });
    expect(result.choices[0].message.content).toBe("{\"ok\":true}");
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.model).toBe("gpt-test");
    expect(body.response_format).toEqual({ type: "json_object" });
  });
});
