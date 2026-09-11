import { z } from "zod";

export const qualityStatusSchema = z.enum(["ok", "recommend", "review", "block"]);
export const qualityFindingSchema = z.object({
  code: z.string().max(60), status: qualityStatusSchema, message: z.string().max(500), reason: z.string().max(500),
  evidence: z.string().max(500), severity: z.number().int().min(1).max(4), suggestion: z.string().max(500),
  autoFixable: z.boolean(), humanReview: z.boolean(), deterministic: z.boolean(),
});
// AI出力の検証。余分なキーは拒否せず捨てる（zodの既定動作）。形式はプロンプト側で明示している
export const qualityCheckResultSchema = z.object({ findings: z.array(qualityFindingSchema).max(40), summary: z.string().max(800) });
export type QualityFinding = z.infer<typeof qualityFindingSchema>;

const SECRET = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|(?:api[_-]?key|secret|token)\s*[:=]\s*[A-Za-z0-9_-]{12,})/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

export function deterministicQualityCheck(content: string, forbidden: string[] = []): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const add = (code: string, status: "recommend" | "review" | "block", message: string, evidence: string, suggestion: string) => findings.push({ code, status, message, reason: message, evidence: evidence.slice(0, 500), severity: status === "block" ? 4 : status === "review" ? 3 : 2, suggestion, autoFixable: status !== "block", humanReview: status !== "recommend", deterministic: true });
  if (!content.trim()) add("empty", "block", "本文が空です", "0文字", "本文を入力してください");
  if (Array.from(content).length > 500) add("too_long", "block", "500文字を超えています", `${Array.from(content).length}文字`, "500文字以内に短くしてください");
  const matched = forbidden.find((word) => word && content.toLowerCase().includes(word.toLowerCase()));
  if (matched) add("forbidden", "block", "禁止表現が含まれています", matched, "禁止表現を削除してください");
  const secret = content.match(SECRET)?.[0]; if (secret) add("secret", "block", "Secretらしき文字列があります", secret.replace(/.(?=.{4})/g, "*"), "機密文字列を削除してください");
  const email = content.match(EMAIL)?.[0]; if (email) add("personal_info", "block", "個人情報の可能性があるメールアドレスがあります", email.replace(/^(.{1,2}).*(@.*)$/, "$1***$2"), "公開してよい情報か確認し、不要なら削除してください");
  for (const token of content.split(/\s+/).filter((x) => /^[a-z][a-z0-9+.-]*:\/\//i.test(x))) { try { const u = new URL(token); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw 0; } catch { add("invalid_url", "block", "URL形式が不正です", token, "URLを修正してください"); } }
  if (/\n{4,}/.test(content)) add("line_breaks", "recommend", "空行が多く読みづらい可能性があります", "4行以上の連続改行", "改行を整理してください");
  return findings;
}

export function shouldBlockPosting(findings: QualityFinding[]): boolean { return findings.some((x) => x.deterministic && x.status === "block"); }

export const safeRewriteSchema = z.object({ revised: z.string().min(1).max(500), changes: z.array(z.object({ before: z.string().max(300), after: z.string().max(300), reason: z.string().max(300) })).max(20) });
