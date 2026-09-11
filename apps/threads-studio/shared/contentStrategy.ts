import { z } from "zod";

export const purposeRatiosSchema = z.object({
  awarenessEmpathy: z.number().int().min(0).max(100),
  educationExpertise: z.number().int().min(0).max(100),
  trustResults: z.number().int().min(0).max(100),
  community: z.number().int().min(0).max(100),
  salesInquiry: z.number().int().min(0).max(100),
}).strict().refine((value) => Object.values(value).reduce((sum, ratio) => sum + ratio, 0) === 100, {
  message: "投稿目的の比率合計は100%にしてください",
});

export const DEFAULT_PURPOSE_RATIOS = {
  awarenessEmpathy: 25,
  educationExpertise: 30,
  trustResults: 20,
  community: 15,
  salesInquiry: 10,
} as const;

export function parsePurposeRatios(value: string | null | undefined) {
  if (!value) return DEFAULT_PURPOSE_RATIOS;
  try { return purposeRatiosSchema.parse(JSON.parse(value)); }
  catch { return DEFAULT_PURPOSE_RATIOS; }
}

export const STRATEGY_PURPOSES = ["awareness", "empathy", "education", "expertise", "case_study", "trust", "faq", "comparison", "behind_scenes", "inquiry", "sales"] as const;
export const STRATEGY_FORMATS = ["text", "image", "question", "story", "list"] as const;

export const strategyItemSchema = z.object({
  day: z.number().int().min(1).max(7), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  purpose: z.enum(STRATEGY_PURPOSES),
  theme: z.string().min(1).max(160), hook: z.string().min(1).max(200), cta: z.string().max(200),
  format: z.enum(STRATEGY_FORMATS), recommendedTime: z.string().regex(/^\d{2}:\d{2}$/),
  trend: z.string().max(160).nullable(), rationale: z.string().min(1).max(500), expectedOutcome: z.string().max(300),
  confidence: z.number().min(0).max(1), hypothesis: z.boolean(), factCheckWarning: z.string().max(300).nullable(),
});
export const weeklyStrategySchema = z.object({
  goal: z.string().min(1).max(300), audience: z.string().min(1).max(300), coreMessage: z.string().min(1).max(500),
  items: z.array(strategyItemSchema).length(7), warnings: z.array(z.string().max(300)).max(20),
}).superRefine((value, ctx) => {
  if (new Set(value.items.map((x) => x.date)).size !== 7) ctx.addIssue({ code: "custom", path: ["items"], message: "7日分の日付が必要です" });
  if (new Set(value.items.map((x) => x.theme.trim().toLowerCase())).size < 5) ctx.addIssue({ code: "custom", path: ["items"], message: "テーマが偏っています" });
  if (value.items.filter((x) => x.purpose === "sales" || x.purpose === "inquiry").length > 3) ctx.addIssue({ code: "custom", path: ["items"], message: "販売投稿が多すぎます" });
});
export type WeeklyStrategy = z.infer<typeof weeklyStrategySchema>;

export const weeklyReviewSchema = z.object({
  summary: z.string().min(1).max(1000), topPost: z.string().max(500).nullable(), lowPost: z.string().max(500).nullable(),
  continueThemes: z.array(z.string().max(160)).max(10), stopThemes: z.array(z.string().max(160)).max(10),
  nextHypotheses: z.array(z.string().max(300)).max(10), confidence: z.number().min(0).max(1), sampleWarning: z.string().max(300).nullable(),
});

export function dateSequence(start: string): string[] {
  const base = new Date(`${start}T12:00:00Z`);
  if (Number.isNaN(base.getTime()) || base.toISOString().slice(0, 10) !== start) throw new Error("invalid date");
  return Array.from({ length: 7 }, (_, i) => new Date(base.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

/**
 * AIに渡す出力形式の説明。weeklyStrategySchema と同じキー・候補値をそのまま列挙する
 * （形式を伝えずに厳密検証すると、ほぼ必ず検証に落ちて「AI処理に失敗」になるため）。
 */
export function describeWeeklyStrategyJson(dates: string[]): string {
  return [
    "出力はJSONのみ。キーは次の通りで、これ以外のキーは付けない:",
    '{"goal":string,"audience":string,"coreMessage":string,"warnings":string[],"items":[item×7]}',
    `item = {"day":1〜7,"date":"YYYY-MM-DD"(指定の日付順にそのまま: ${dates.join(", ")}),` +
      `"purpose":${STRATEGY_PURPOSES.map((x) => `"${x}"`).join("|")},` +
      '"theme":string(160字以内),"hook":string(200字以内),"cta":string(200字以内。無ければ""),' +
      `"format":${STRATEGY_FORMATS.map((x) => `"${x}"`).join("|")},"recommendedTime":"HH:MM",` +
      '"trend":string|null,"rationale":string(500字以内),"expectedOutcome":string(300字以内),' +
      '"confidence":0〜1の数値,"hypothesis":boolean,"factCheckWarning":string|null}',
    "制約: itemsは必ず7件、themeは5種類以上、purposeが sales/inquiry の項目は3件以下。",
  ].join("\n");
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * AI出力の「揺れ」を検証前に正す。日付と day は指定順で決まるので index から埋め、
 * confidence が 0〜100 なら 0〜1 に直し、"9:00" は "09:00" にする。
 * 意味を変える補正はしない（purpose の候補外、items の件数不足などは検証で落とす）。
 */
export function normalizeWeeklyStrategy(raw: unknown, dates: string[]): unknown {
  const root = asRecord(raw);
  if (!root) return raw;
  const items = Array.isArray(root.items) ? root.items.map((entry, i) => {
    const item = asRecord(entry);
    if (!item) return entry;
    let confidence = item.confidence;
    if (typeof confidence === "string" && confidence.trim() !== "" && !Number.isNaN(Number(confidence))) confidence = Number(confidence);
    if (typeof confidence === "number" && confidence > 1 && confidence <= 100) confidence = confidence / 100;
    const time = typeof item.recommendedTime === "string" ? item.recommendedTime.trim().match(/^(\d{1,2}):(\d{2})$/) : null;
    return {
      ...item,
      day: i + 1,
      date: dates[i] ?? item.date,
      confidence,
      recommendedTime: time ? `${time[1].padStart(2, "0")}:${time[2]}` : item.recommendedTime,
      cta: item.cta ?? "",
      expectedOutcome: item.expectedOutcome ?? "",
      trend: item.trend ?? null,
      factCheckWarning: item.factCheckWarning ?? null,
      // フラグが無い場合は「仮説」として扱う（データ不足の注意書きが出る側に倒す）
      hypothesis: typeof item.hypothesis === "boolean" ? item.hypothesis : true,
    };
  }) : root.items;
  return { ...root, items, warnings: root.warnings ?? [] };
}

