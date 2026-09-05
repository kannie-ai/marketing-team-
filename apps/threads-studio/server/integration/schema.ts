/**
 * 統合APIのためのテーブル（Threads Studio 側）。
 *
 * 既存テーブルは一切変更しない。追加だけ。
 *   integration_account_links … 大漁マーケットの clientId ⇄ accounts.id
 *   integration_nonces        … リプレイ防止の使い捨て台帳
 *   integration_operations    … 冪等キーと監査ログ
 */
import {
  int,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * どのクライアントがどのアカウントを操作してよいかの正本。
 *
 * 大漁マーケットが送ってくる accountId は、この表に載っている組み合わせしか
 * 通さない。大漁マーケット側に不具合があっても、他クライアントのアカウントへは
 * 到達できない。
 */
export const integrationAccountLinks = mysqlTable("integration_account_links", {
  id: int("id").autoincrement().primaryKey(),
  /** 大漁マーケットの組織識別子 */
  organizationId: varchar("organizationId", { length: 64 }).notNull(),
  /** 大漁マーケットの clients.id (uuid) */
  externalClientId: varchar("externalClientId", { length: 64 }).notNull(),
  /** Threads Studio の accounts.id */
  accountId: int("accountId").notNull().unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** 署名済みリクエストの使い捨て台帳。期限切れは定期的に掃除する。 */
export const integrationNonces = mysqlTable("integration_nonces", {
  id: int("id").autoincrement().primaryKey(),
  keyId: varchar("keyId", { length: 64 }).notNull(),
  nonce: varchar("nonce", { length: 64 }).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/**
 * 冪等キーと結果。
 * 同じ鍵で再送されたら、処理をやり直さず前回の結果を返す。
 */
export const integrationOperations = mysqlTable("integration_operations", {
  id: int("id").autoincrement().primaryKey(),
  idempotencyKey: varchar("idempotencyKey", { length: 128 }).notNull().unique(),
  externalClientId: varchar("externalClientId", { length: 64 }).notNull(),
  accountId: int("accountId"),
  operation: varchar("operation", { length: 64 }).notNull(),
  /** 同じ鍵で違う内容が来たことを検出するためのSHA-256 */
  requestDigest: varchar("requestDigest", { length: 64 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  /** 応答のJSON。秘密は入れない */
  result: text("result"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type IntegrationAccountLink =
  typeof integrationAccountLinks.$inferSelect;
export type IntegrationOperation = typeof integrationOperations.$inferSelect;

/**
 * `pnpm db:upgrade`（server/scripts/upgradeDb.ts）へ追加するDDL。
 * createTable / addIndex は既存の実装がテーブルの有無を見るので、
 * 何度実行しても失敗しない。
 */
export const INTEGRATION_TABLES: { table: string; ddl: string }[] = [
  {
    table: "integration_account_links",
    ddl: `
    CREATE TABLE \`integration_account_links\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`organizationId\` varchar(64) NOT NULL,
      \`externalClientId\` varchar(64) NOT NULL,
      \`accountId\` int NOT NULL UNIQUE,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `,
  },
  {
    table: "integration_nonces",
    ddl: `
    CREATE TABLE \`integration_nonces\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`keyId\` varchar(64) NOT NULL,
      \`nonce\` varchar(64) NOT NULL,
      \`expiresAt\` timestamp NOT NULL,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY \`uniq_integration_nonce\` (\`keyId\`, \`nonce\`)
    )
  `,
  },
  {
    table: "integration_operations",
    ddl: `
    CREATE TABLE \`integration_operations\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`idempotencyKey\` varchar(128) NOT NULL UNIQUE,
      \`externalClientId\` varchar(64) NOT NULL,
      \`accountId\` int NULL,
      \`operation\` varchar(64) NOT NULL,
      \`requestDigest\` varchar(64) NOT NULL,
      \`status\` varchar(16) NOT NULL,
      \`result\` text NULL,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `,
  },
];

export const INTEGRATION_INDEXES: {
  table: string;
  index: string;
  columns: string;
}[] = [
  {
    table: "integration_account_links",
    index: "idx_integration_links_client",
    columns: "`externalClientId`",
  },
  {
    table: "integration_nonces",
    index: "idx_integration_nonces_expires",
    columns: "`expiresAt`",
  },
  {
    table: "integration_operations",
    index: "idx_integration_ops_client",
    columns: "`externalClientId`, `createdAt`",
  },
];

/**
 * 統合API経由の承認状態。
 *
 * 既存の posts.approvalStatus（draft / approved）は変更しない。
 * 「承認待ち」「差し戻し」という中間状態と、判断した人・コメントだけを
 * この表に持つ。posts へ列を足さないので、既存の動作に影響しない。
 */
export const integrationPostStates = mysqlTable("integration_post_states", {
  postId: int("postId").primaryKey(),
  /** pending_approval / approved / rejected */
  approvalState: varchar("approvalState", { length: 24 }).notNull(),
  note: text("note"),
  /** 大漁マーケットの利用者ID */
  decidedBy: varchar("decidedBy", { length: 64 }),
  decidedAt: timestamp("decidedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type IntegrationPostState = typeof integrationPostStates.$inferSelect;

INTEGRATION_TABLES.push({
  table: "integration_post_states",
  ddl: `
    CREATE TABLE \`integration_post_states\` (
      \`postId\` int PRIMARY KEY,
      \`approvalState\` varchar(24) NOT NULL,
      \`note\` text NULL,
      \`decidedBy\` varchar(64) NULL,
      \`decidedAt\` timestamp NULL,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `,
});
