import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));
vi.mock("./db", () => ({
  createContentStrategy: vi.fn(), createWeeklyReview: vi.fn(), getAccountSettings: vi.fn(), getClientProfile: vi.fn(),
  getLatestTrendAnalysis: vi.fn(), getWeeklyReviewForStrategy: vi.fn(), listAccounts: vi.fn(), listContentStrategies: vi.fn(),
  listFollowerSnapshots: vi.fn(), listPostOutcomes: vi.fn(), listPosts: vi.fn(),
}));
vi.mock("./_core/env", () => ({ ENV: { openaiApiKey: "test-key" } }));

import { invokeLLM } from "./_core/llm";
import * as db from "./db";
import { generateAccountStrategy, reviewAccountStrategy, runStrategyMaintenance } from "./strategyService";
import { classifyAiError } from "./aiSupport";

const account = { id: 7, name: "Client A", threadsUserId: "u", threadsAccessToken: "secret", tokenRefreshedAt: null, tokenExpiresAt: null, morningHour: 8, morningMinute: 0, eveningHour: 18, eveningMinute: 0, timezone: "JP", slots: null, active: true, createdAt: new Date(), updatedAt: new Date() } as const;
const strategyJson = { goal: "問い合わせ", audience: "地域顧客", coreMessage: "安心", warnings: [], items: Array.from({ length: 7 }, (_, i) => ({ day: i + 1, date: `2026-09-${String(i + 4).padStart(2, "0")}`, purpose: i === 6 ? "inquiry" : "education", theme: `テーマ${i}`, hook: `フック${i}`, cta: "相談", format: "text", recommendedTime: "09:00", trend: null, rationale: "仮説", expectedOutcome: "会話", confidence: 0.5, hypothesis: true, factCheckWarning: null })) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getAccountSettings).mockResolvedValue({ weeklyPostCount: 7, defaultCta: null, purposeRatios: null } as never);
  vi.mocked(db.getClientProfile).mockResolvedValue(undefined); vi.mocked(db.getLatestTrendAnalysis).mockResolvedValue(undefined);
  vi.mocked(db.listPosts).mockResolvedValue([]); vi.mocked(db.listPostOutcomes).mockResolvedValue([]);
  vi.mocked(db.listFollowerSnapshots).mockResolvedValue([]);
  vi.mocked(db.listAccounts).mockResolvedValue([]); vi.mocked(db.listContentStrategies).mockResolvedValue([]); vi.mocked(db.getWeeklyReviewForStrategy).mockResolvedValue(undefined);
  vi.mocked(db.createContentStrategy).mockResolvedValue(42);
});

describe("週間戦略サービス", () => {
  it("選択アカウントのデータだけをAIへ渡し、検証後に保存する", async () => {
    vi.mocked(db.listPosts).mockResolvedValue([{ id: 1, content: "Client A only", scheduledDate: "2026-09-04" }] as never);
    vi.mocked(invokeLLM).mockResolvedValue({ id: "x", model: "test", choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: JSON.stringify(strategyJson) } }] });
    const result = await generateAccountStrategy(account as never, { accountId: 7, includeLegacy: false }, 3, "2026-09-04");
    expect(result.id).toBe(42); expect(db.createContentStrategy).toHaveBeenCalledWith(7, 3, "2026-09-04", expect.anything());
    const prompt = vi.mocked(invokeLLM).mock.calls[0][0].messages[1].content;
    expect(prompt).toContain("Client A only"); expect(prompt).not.toContain(account.threadsAccessToken);
  });

  it("7日でない不正AI出力をDBへ保存しない", async () => {
    vi.mocked(invokeLLM).mockResolvedValue({ id: "x", model: "test", choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: JSON.stringify({ ...strategyJson, items: strategyJson.items.slice(0, 6) }) } }] });
    await expect(generateAccountStrategy(account as never, { accountId: 7, includeLegacy: false }, 3, "2026-09-04")).rejects.toThrow();
    expect(db.createContentStrategy).not.toHaveBeenCalled();
  });

  it("既存の週間振り返りを重複作成しない", async () => {
    const review = { summary: "済み", topPost: null, lowPost: null, continueThemes: [], stopThemes: [], nextHypotheses: [], confidence: 0.2, sampleWarning: "少数" };
    vi.mocked(db.getWeeklyReviewForStrategy).mockResolvedValue({ id: 9, result: JSON.stringify(review) } as never);
    const result = await reviewAccountStrategy(7, { accountId: 7, includeLegacy: false }, { id: 5, startDate: "2026-09-04" } as never);
    expect(result.duplicate).toBe(true); expect(invokeLLM).not.toHaveBeenCalled(); expect(db.createWeeklyReview).not.toHaveBeenCalled();
  });

  it("振り返りへ戦略項目の成果とフォロワー増減を渡す", async () => {
    const review = { summary: "振り返り", topPost: "#1", lowPost: null, continueThemes: ["教育"], stopThemes: [], nextHypotheses: ["CTAを試す"], confidence: 0.6, sampleWarning: null };
    vi.mocked(db.listPostOutcomes).mockResolvedValue([{ postedAt: new Date("2026-09-05T00:00:00Z"), strategyItemId: 88, postId: 1, content: "投稿" }] as never);
    vi.mocked(db.listFollowerSnapshots).mockResolvedValue([{ capturedDate: "2026-09-04", followerCount: 100 }, { capturedDate: "2026-09-10", followerCount: 108 }] as never);
    vi.mocked(db.createWeeklyReview).mockResolvedValue(12);
    vi.mocked(invokeLLM).mockResolvedValue({ id: "x", model: "test", choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: JSON.stringify(review) } }] });
    const result = await reviewAccountStrategy(7, { accountId: 7, includeLegacy: false }, { id: 5, startDate: "2026-09-04", items: [{ id: 88, purpose: "education", theme: "教育" }] } as never);
    expect(result.duplicate).toBe(false); expect(db.createWeeklyReview).toHaveBeenCalledWith(7, 5, review, 1);
    const prompt = vi.mocked(invokeLLM).mock.calls[0][0].messages[1].content;
    expect(prompt).toContain('"strategyItemId":88'); expect(prompt).toContain('"followerChange":8');
  });

  it("自動作成ONで当週の戦略がない場合だけ下書き戦略を作る", async () => {
    vi.mocked(db.listAccounts).mockResolvedValue([account] as never);
    vi.mocked(db.getAccountSettings).mockResolvedValue({ weeklyPostCount: 7, defaultCta: null, purposeRatios: null, autoWeeklyStrategy: true, weeklyReviewEnabled: false } as never);
    vi.mocked(invokeLLM).mockResolvedValue({ id: "x", model: "test", choices: [{ index: 0, finish_reason: null, message: { role: "assistant", content: JSON.stringify(strategyJson) } }] });
    const result = await runStrategyMaintenance(new Date("2026-09-04T01:00:00Z"));
    expect(result).toContainEqual({ accountId: 7, action: "strategy" });
    expect(db.createContentStrategy).toHaveBeenCalledWith(7, null, "2026-09-04", expect.anything());
  });
});

describe("AI出力の形式（本番で起きた「AI処理に失敗」の再発防止）", () => {
  const llm = (content: unknown) => ({ id: "x", model: "test", choices: [{ index: 0, finish_reason: null, message: { role: "assistant" as const, content: JSON.stringify(content) } }] });

  it("プロンプトで出力形式（全キー・purpose候補・指定日付）を伝える", async () => {
    vi.mocked(invokeLLM).mockResolvedValue(llm(strategyJson));
    await generateAccountStrategy(account as never, { accountId: 7, includeLegacy: false }, 3, "2026-09-04");
    const system = String(vi.mocked(invokeLLM).mock.calls[0][0].messages[0].content);
    for (const key of ["factCheckWarning", "recommendedTime", "expectedOutcome", "hypothesis"]) expect(system).toContain(`"${key}"`);
    expect(system).toContain('"behind_scenes"');
    expect(system).toContain("2026-09-10");
  });

  it("AIの出力に表記揺れ（day欠落・confidence 0〜100・余分なキー）があっても保存できる", async () => {
    const loose = {
      goal: "問い合わせ", audience: "地域顧客", coreMessage: "安心", note: "余分",
      items: strategyJson.items.map(({ day: _day, ...item }, i) => ({ ...item, date: "2000-01-01", confidence: 55, recommendedTime: "9:00", extra: i })),
    };
    vi.mocked(invokeLLM).mockResolvedValue(llm(loose));
    const result = await generateAccountStrategy(account as never, { accountId: 7, includeLegacy: false }, 3, "2026-09-04");
    expect(result.id).toBe(42);
    expect(result.strategy.items.map((x) => x.date)[6]).toBe("2026-09-10");
    expect(result.strategy.items[0].confidence).toBe(0.55);
    expect(db.createContentStrategy).toHaveBeenCalledTimes(1);
  });

  it("形式が合わない出力は「解釈できない」種別のエラーになり、本文はログに出さない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(invokeLLM).mockResolvedValue(llm({ goal: "g", audience: "a", coreMessage: "c", items: [{ theme: "SECRET-BODY-TEXT" }], warnings: [] }));
    const error = await generateAccountStrategy(account as never, { accountId: 7, includeLegacy: false }, 3, "2026-09-04").catch((e) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(classifyAiError(error)).toBe("invalid_output");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("SECRET-BODY-TEXT");
    expect(warn.mock.calls.flat().join(" ")).toContain("items");
    expect(db.createContentStrategy).not.toHaveBeenCalled();
  });

  it("週間振り返りもプロンプトで形式を伝え、余分なキーは捨てる", async () => {
    const review = { summary: "振り返り", topPost: null, lowPost: null, continueThemes: [], stopThemes: [], nextHypotheses: [], confidence: 0.4, sampleWarning: null, extra: "捨てる" };
    vi.mocked(db.createWeeklyReview).mockResolvedValue(13);
    vi.mocked(invokeLLM).mockResolvedValue(llm(review));
    const result = await reviewAccountStrategy(7, { accountId: 7, includeLegacy: false }, { id: 5, startDate: "2026-09-04", items: [] } as never);
    expect(result.review).not.toHaveProperty("extra");
    expect(String(vi.mocked(invokeLLM).mock.calls[0][0].messages[0].content)).toContain('"nextHypotheses"');
  });
});

