import { describe, expect, it } from "vitest";
import { STRATEGY_PURPOSES, dateSequence, describeWeeklyStrategyJson, normalizeWeeklyStrategy, purposeRatiosSchema, weeklyStrategySchema } from "./contentStrategy";

const item = (day: number) => ({
  day, date: `2026-09-${String(day + 3).padStart(2, "0")}`, purpose: "education" as const,
  theme: `テーマ${day}`, hook: `フック${day}`, cta: "詳しくはこちら", format: "text" as const,
  recommendedTime: "09:00", trend: null, rationale: "実データまたは検証可能な仮説に基づく",
  expectedOutcome: "会話の増加", confidence: 0.5, hypothesis: true, factCheckWarning: null,
});

describe("7日間コンテンツ戦略の検証", () => {
  it("連続する7日と多様なテーマを受理する", () => {
    expect(dateSequence("2026-09-04")).toEqual(["2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10"]);
    expect(weeklyStrategySchema.safeParse({ goal: "問い合わせ", audience: "地域の顧客", coreMessage: "安心して相談できる", items: Array.from({ length: 7 }, (_, i) => item(i + 1)), warnings: [] }).success).toBe(true);
  });

  it("存在しない日付を拒否する", () => {
    expect(() => dateSequence("2026-02-31")).toThrow("invalid date");
  });

  it("テーマ偏りと販売偏重を拒否する", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ ...item(i + 1), theme: "同じテーマ", purpose: i < 4 ? "sales" as const : "education" as const }));
    const result = weeklyStrategySchema.safeParse({ goal: "販売", audience: "顧客", coreMessage: "案内", items, warnings: [] });
    expect(result.success).toBe(false);
  });

  it("目的比率は合計100だけを受理する", () => {
    expect(purposeRatiosSchema.safeParse({ awarenessEmpathy: 25, educationExpertise: 30, trustResults: 20, community: 15, salesInquiry: 10 }).success).toBe(true);
    expect(purposeRatiosSchema.safeParse({ awarenessEmpathy: 25, educationExpertise: 30, trustResults: 20, community: 15, salesInquiry: 20 }).success).toBe(false);
  });
});

describe("AI出力の正規化（検証前の表記揺れの吸収）", () => {
  const dates = dateSequence("2026-09-04");
  const aiItem = (i: number) => ({
    // AIが返しがちな揺れ: day 無し、date の誤り、confidence が 0〜100、"9:00"、任意項目の欠落、余分なキー
    date: "2026-01-01", purpose: "education", theme: `テーマ${i}`, hook: `フック${i}`, format: "text",
    recommendedTime: "9:00", rationale: "根拠", confidence: 80, notes: "余分なキー",
  });

  it("日付と day は指定順で埋め、confidence と時刻の表記を直し、余分なキーは捨てる", () => {
    const normalized = normalizeWeeklyStrategy({ goal: "問い合わせ", audience: "顧客", coreMessage: "安心", items: Array.from({ length: 7 }, (_, i) => aiItem(i)) }, dates);
    const result = weeklyStrategySchema.safeParse(normalized);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.items.map((x) => x.date)).toEqual(dates);
    expect(result.data.items.map((x) => x.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.data.items[0]).toMatchObject({ confidence: 0.8, recommendedTime: "09:00", cta: "", expectedOutcome: "", trend: null, factCheckWarning: null, hypothesis: true });
    expect(result.data.items[0]).not.toHaveProperty("notes");
    expect(result.data.warnings).toEqual([]);
  });

  it("件数不足・候補外の purpose は正規化しても受理しない（意味を変える補正はしない）", () => {
    expect(weeklyStrategySchema.safeParse(normalizeWeeklyStrategy({ goal: "g", audience: "a", coreMessage: "c", items: Array.from({ length: 6 }, (_, i) => aiItem(i)) }, dates)).success).toBe(false);
    const badPurpose = Array.from({ length: 7 }, (_, i) => ({ ...aiItem(i), purpose: "marketing" }));
    expect(weeklyStrategySchema.safeParse(normalizeWeeklyStrategy({ goal: "g", audience: "a", coreMessage: "c", items: badPurpose }, dates)).success).toBe(false);
  });

  it("オブジェクトでない出力はそのまま返す（検証側で落とす）", () => {
    expect(normalizeWeeklyStrategy("not json", dates)).toBe("not json");
    expect(weeklyStrategySchema.safeParse(normalizeWeeklyStrategy(null, dates)).success).toBe(false);
  });

  it("出力形式の説明には全キー・purpose候補・指定日付が含まれる", () => {
    const text = describeWeeklyStrategyJson(dates);
    for (const key of ["goal", "audience", "coreMessage", "warnings", "items", "day", "date", "purpose", "theme", "hook", "cta", "format", "recommendedTime", "trend", "rationale", "expectedOutcome", "confidence", "hypothesis", "factCheckWarning"]) {
      expect(text).toContain(`"${key}"`);
    }
    for (const purpose of STRATEGY_PURPOSES) expect(text).toContain(`"${purpose}"`);
    expect(text).toContain("2026-09-10");
  });
});

