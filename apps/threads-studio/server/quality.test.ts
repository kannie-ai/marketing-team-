import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));
import { invokeLLM } from "./_core/llm";
import { createSafeRewrite, runAiQualityCheck } from "./quality";
import { classifyAiError } from "./aiSupport";

beforeEach(() => vi.clearAllMocks());

describe("AI品質チェック", () => {
  it("AIがblockを返しても要確認へ正規化する", async () => {
    vi.mocked(invokeLLM).mockResolvedValue({ choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: JSON.stringify({ summary: "確認", findings: [{ code: "tone", status: "block", message: "断定できない", reason: "文体", evidence: "本文", severity: 4, suggestion: "確認", autoFixable: false, humanReview: true, deterministic: false }] }) } }], id: "x", model: "test" });
    const result = await runAiQualityCheck("本文", {});
    expect(result.findings[0].status).toBe("review");
    expect(result.findings[0].deterministic).toBe(false);
  });

  it("安全な修正案は数字・URLを維持する", async () => {
    vi.mocked(invokeLLM).mockResolvedValue({ choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: JSON.stringify({ revised: "料金は1,000円です。 https://example.com", changes: [{ before: "料金1000円", after: "料金は1,000円", reason: "読みやすさ" }] }) } }], id: "x", model: "test" });
    await expect(createSafeRewrite("料金は1,000円 https://example.com", [])).resolves.toMatchObject({ revised: expect.stringContaining("https://example.com") });
  });

  it("AIが数字やURLを変えた案を拒否し、元原稿は呼び出し側に残る", async () => {
    vi.mocked(invokeLLM).mockResolvedValue({ choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: JSON.stringify({ revised: "料金は2,000円 https://evil.example", changes: [] }) } }], id: "x", model: "test" });
    await expect(createSafeRewrite("料金は1,000円 https://example.com", [])).rejects.toThrow("変更しました");
  });

  it("英字・カタカナの固有名詞を変えた案を拒否する", async () => {
    vi.mocked(invokeLLM).mockResolvedValue({ choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: JSON.stringify({ revised: "OpenAIとキャンペーンを紹介します", changes: [] }) } }], id: "x", model: "test" });
    await expect(createSafeRewrite("Threads Studioとスレッズを紹介します", [])).rejects.toThrow("変更しました");
  });

  it("プロンプトで出力形式（キー・status候補）を伝え、余分なキーは捨てる", async () => {
    vi.mocked(invokeLLM).mockResolvedValue({ choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: JSON.stringify({ summary: "問題なし", findings: [], overall: "余分なキー" }) } }], id: "x", model: "test" });
    const result = await runAiQualityCheck("本文", {});
    expect(result).not.toHaveProperty("overall");
    expect(result.findings).toEqual([]);
    const system = String(vi.mocked(invokeLLM).mock.calls[0][0].messages[0].content);
    for (const key of ["summary", "findings", "code", "status", "severity", "autoFixable", "humanReview", "deterministic"]) expect(system).toContain(`"${key}"`);
    expect(system).toContain('"recommend"');
  });

  it("形式が合わないAI出力は「解釈できない」種別のエラーになる", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(invokeLLM).mockResolvedValue({ choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: JSON.stringify({ result: "ok" }) } }], id: "x", model: "test" });
    const error = await runAiQualityCheck("本文", {}).catch((e) => e as Error);
    expect(classifyAiError(error)).toBe("invalid_output");
  });

  it("不正なAI JSONを保存可能な結果として返さない", async () => {
    vi.mocked(invokeLLM).mockResolvedValue({ choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: "not-json" } }], id: "x", model: "test" });
    await expect(runAiQualityCheck("本文", {})).rejects.toThrow();
  });
});
