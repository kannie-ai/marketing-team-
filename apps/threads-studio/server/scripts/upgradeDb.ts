/**
 * Idempotent DB upgrade script.
 *
 * The historical drizzle migration chain is out of sync with the deployed
 * database (columns were added outside drizzle), so this script inspects
 * information_schema and applies only what is missing. Safe to run any
 * number of times.
 *
 *   pnpm db:upgrade   (requires DATABASE_URL)
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { buildDbConfig, describeDbTarget } from "../dbConfig";
import { INTEGRATION_INDEXES, INTEGRATION_TABLES } from "../integration/schema";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const dbName = new URL(url).pathname.replace(/^\//, "");
  console.log(`[upgrade] 接続先: ${describeDbTarget(url)}`);

  // 新規のMySQL/TiDBインスタンスはデータベースが空なので、無ければ作る。
  // （手動で CREATE DATABASE しなくてもデプロイが通るようにするため）
  if (dbName) {
    if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
      throw new Error(`Unsupported database name in DATABASE_URL: ${dbName}`);
    }
    const bootstrap = await mysql.createConnection({
      ...buildDbConfig(url),
      database: undefined,
    });
    await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await bootstrap.end();
  }

  const conn = await mysql.createConnection(buildDbConfig(url));

  async function hasTable(table: string): Promise<boolean> {
    const [rows] = await conn.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?",
      [dbName, table]
    );
    return (rows as unknown[]).length > 0;
  }

  async function hasColumn(table: string, column: string): Promise<boolean> {
    const [rows] = await conn.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?",
      [dbName, table, column]
    );
    return (rows as unknown[]).length > 0;
  }

  async function addColumn(table: string, column: string, ddl: string) {
    if (await hasColumn(table, column)) return;
    console.log(`[upgrade] ${table}.${column} を追加`);
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
  }

  async function hasIndex(table: string, index: string): Promise<boolean> {
    const [rows] = await conn.query(
      "SELECT 1 FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? AND index_name = ?",
      [dbName, table, index]
    );
    return (rows as unknown[]).length > 0;
  }

  async function addIndex(table: string, index: string, columns: string) {
    if (!(await hasTable(table))) return;
    if (await hasIndex(table, index)) return;
    console.log(`[upgrade] ${table} に索引 ${index} を追加`);
    await conn.query(`CREATE INDEX \`${index}\` ON \`${table}\` (${columns})`);
  }

  async function addUniqueIndex(table: string, index: string, columns: string) {
    if (!(await hasTable(table))) return;
    if (await hasIndex(table, index)) return;
    console.log(`[upgrade] ${table} に一意索引 ${index} を追加`);
    await conn.query(`CREATE UNIQUE INDEX \`${index}\` ON \`${table}\` (${columns})`);
  }

  // ── 基本テーブル（空のDBへの初回デプロイ用。drizzle/schema.ts と揃えること） ──
  async function createTable(table: string, ddl: string) {
    if (await hasTable(table)) return;
    console.log(`[upgrade] ${table} テーブルを作成`);
    await conn.query(ddl);
  }

  await createTable("users", `
    CREATE TABLE \`users\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`openId\` varchar(64) NOT NULL UNIQUE,
      \`name\` text NULL,
      \`email\` varchar(320) NULL,
      \`loginMethod\` varchar(64) NULL,
      \`role\` enum('user','admin') NOT NULL DEFAULT 'user',
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      \`lastSignedIn\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await createTable("settings", `
    CREATE TABLE \`settings\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`threadsAccessToken\` text NULL,
      \`threadsUserId\` varchar(64) NULL,
      \`morningCronTaskUid\` varchar(65) NULL,
      \`eveningCronTaskUid\` varchar(65) NULL,
      \`morningHour\` int NOT NULL DEFAULT 8,
      \`morningMinute\` int NOT NULL DEFAULT 0,
      \`eveningHour\` int NOT NULL DEFAULT 18,
      \`eveningMinute\` int NOT NULL DEFAULT 0,
      \`timezone\` enum('LA','JP','ET','CT','MT') NOT NULL DEFAULT 'LA',
      \`postsPerDay\` int NOT NULL DEFAULT 2,
      \`extraSlots\` text NOT NULL,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await createTable("categories", `
    CREATE TABLE \`categories\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`name\` varchar(64) NOT NULL,
      \`color\` varchar(16) NOT NULL DEFAULT '#335B82',
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await createTable("posts", `
    CREATE TABLE \`posts\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`content\` text NOT NULL,
      \`status\` enum('pending','posted','error') NOT NULL DEFAULT 'pending',
      \`slotIndex\` int NOT NULL DEFAULT 0,
      \`scheduledDate\` varchar(10) NULL,
      \`categoryId\` int NULL,
      \`sortOrder\` int NOT NULL DEFAULT 0,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await createTable("post_logs", `
    CREATE TABLE \`post_logs\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`postId\` int NULL,
      \`content\` text NOT NULL,
      \`status\` enum('posted','error') NOT NULL,
      \`threadsPostId\` varchar(128) NULL,
      \`errorMessage\` text NULL,
      \`slotIndex\` int NOT NULL DEFAULT 0,
      \`categoryId\` int NULL,
      \`postedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await createTable("post_analytics", `
    CREATE TABLE \`post_analytics\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`postLogId\` int NOT NULL,
      \`threadsPostId\` varchar(128) NOT NULL,
      \`likes\` int NOT NULL DEFAULT 0,
      \`replies\` int NOT NULL DEFAULT 0,
      \`reposts\` int NOT NULL DEFAULT 0,
      \`views\` bigint NOT NULL DEFAULT 0,
      \`fetchedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // settings.extraSlots は TEXT のため DEFAULT が付けられない。初期行を1行入れておく
  const [settingsCount] = await conn.query("SELECT COUNT(*) AS c FROM `settings`");
  if (((settingsCount as { c: number }[])[0]?.c ?? 0) === 0) {
    console.log("[upgrade] settings 初期行を作成");
    await conn.query("INSERT INTO `settings` (`extraSlots`) VALUES ('[]')");
  }

  // ── accounts table ──────────────────────────────────────────────────────────
  if (!(await hasTable("accounts"))) {
    console.log("[upgrade] accounts テーブルを作成");
    await conn.query(`
      CREATE TABLE \`accounts\` (
        \`id\` int AUTO_INCREMENT PRIMARY KEY,
        \`name\` varchar(64) NOT NULL,
        \`threadsUserId\` varchar(64) NOT NULL,
        \`threadsAccessToken\` text NOT NULL,
        \`tokenRefreshedAt\` timestamp NULL,
        \`tokenExpiresAt\` timestamp NULL,
        \`morningHour\` int NOT NULL DEFAULT 8,
        \`morningMinute\` int NOT NULL DEFAULT 0,
        \`eveningHour\` int NOT NULL DEFAULT 18,
        \`eveningMinute\` int NOT NULL DEFAULT 0,
        \`timezone\` enum('LA','JP','ET','CT','MT') NOT NULL DEFAULT 'LA',
        \`active\` boolean NOT NULL DEFAULT true,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  }

  // ── posts ───────────────────────────────────────────────────────────────────
  await addColumn("posts", "approvalStatus", "`approvalStatus` enum('draft','approved') NOT NULL DEFAULT 'approved'");
  await addColumn("posts", "accountId", "`accountId` int NULL");

  // ── media（画像アップロード） ────────────────────────────────────────────────
  await createTable("media", `
    CREATE TABLE \`media\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`token\` varchar(40) NOT NULL UNIQUE,
      \`mimeType\` varchar(40) NOT NULL,
      \`byteSize\` int NOT NULL,
      \`data\` mediumtext NOT NULL,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await addColumn("posts", "imageUrl", "`imageUrl` varchar(512) NULL");
  await addColumn("post_logs", "imageUrl", "`imageUrl` varchar(512) NULL");

  // ── posts: 再投稿コンテンツ ──────────────────────────────────────────────────
  await addColumn("posts", "evergreen", "`evergreen` boolean NOT NULL DEFAULT false");
  await addColumn("posts", "lastRecycledAt", "`lastRecycledAt` timestamp NULL");
  await addColumn("posts", "recycleCount", "`recycleCount` int NOT NULL DEFAULT 0");

  // ── post_logs ───────────────────────────────────────────────────────────────
  await addColumn("post_logs", "accountId", "`accountId` int NULL");
  await addColumn("post_logs", "recycled", "`recycled` boolean NOT NULL DEFAULT false");

  // ── settings ────────────────────────────────────────────────────────────────
  await addColumn("settings", "requireApproval", "`requireApproval` boolean NOT NULL DEFAULT false");
  await addColumn("settings", "notifyOnError", "`notifyOnError` boolean NOT NULL DEFAULT true");
  await addColumn("settings", "brandName", "`brandName` varchar(64) NULL");
  await addColumn("settings", "brandAccent", "`brandAccent` varchar(16) NULL");
  await addColumn("settings", "lastMaintenanceDate", "`lastMaintenanceDate` varchar(10) NULL");
  await addColumn("settings", "autoFillEvergreen", "`autoFillEvergreen` boolean NOT NULL DEFAULT false");
  await addColumn("settings", "recycleRewrite", "`recycleRewrite` boolean NOT NULL DEFAULT true");
  await addColumn("settings", "recycleCooldownDays", "`recycleCooldownDays` int NOT NULL DEFAULT 30");

  // ── timezone enum拡張（米国タイムゾーン ET/CT/MT を追加） ────────────────────
  async function widenTimezoneEnum(table: string) {
    const [rows] = await conn.query(
      "SELECT COLUMN_TYPE AS t FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = 'timezone'",
      [dbName, table]
    );
    const colType = (rows as { t: string }[])[0]?.t ?? "";
    if (colType && !colType.includes("'ET'")) {
      console.log(`[upgrade] ${table}.timezone enum を拡張 (ET/CT/MT)`);
      await conn.query(
        `ALTER TABLE \`${table}\` MODIFY COLUMN \`timezone\` enum('LA','JP','ET','CT','MT') NOT NULL DEFAULT 'LA'`
      );
    }
  }
  await widenTimezoneEnum("settings");
  await widenTimezoneEnum("accounts");

  // ── data migration: settings 単一トークン → accounts ────────────────────────
  const [accountRows] = await conn.query("SELECT COUNT(*) AS c FROM `accounts`");
  const accountCount = (accountRows as { c: number }[])[0]?.c ?? 0;
  if (accountCount === 0) {
    const [settingRows] = await conn.query(
      "SELECT threadsAccessToken, threadsUserId, morningHour, morningMinute, eveningHour, eveningMinute, timezone FROM `settings` LIMIT 1"
    );
    const s = (settingRows as Record<string, unknown>[])[0];
    if (s?.threadsAccessToken && s?.threadsUserId) {
      console.log("[upgrade] 既存のsettingsトークンをaccountsへ移行");
      await conn.query(
        `INSERT INTO \`accounts\`
          (name, threadsUserId, threadsAccessToken, morningHour, morningMinute, eveningHour, eveningMinute, timezone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "メインアカウント",
          s.threadsUserId,
          s.threadsAccessToken,
          s.morningHour ?? 8,
          s.morningMinute ?? 0,
          s.eveningHour ?? 18,
          s.eveningMinute ?? 0,
          s.timezone ?? "LA",
        ]
      );
    }
  }

  // ── アカウント分離（マルチアカウント対応） ──────────────────────────────────
  // すべて追加のみ。既存の行・列・値は一切変更しない。

  // カテゴリーの所属アカウント。NULL = 従来からある全アカウント共通のカテゴリー
  await addColumn("categories", "accountId", "`accountId` int NULL");

  // 投稿枠の定義（枠ごとにタイムゾーンを持つ）。
  // NULL のままなら従来の朝夕設定がそのまま使われるので、既存アカウントは無変更で動く。
  await addColumn("accounts", "slots", "`slots` text NULL");

  // アカウントごとの運用設定
  await createTable("account_settings", `
    CREATE TABLE \`account_settings\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`accountId\` int NOT NULL UNIQUE,
      \`requireApproval\` boolean NOT NULL DEFAULT false,
      \`notifyOnError\` boolean NOT NULL DEFAULT true,
      \`autoFillEvergreen\` boolean NOT NULL DEFAULT false,
      \`recycleRewrite\` boolean NOT NULL DEFAULT true,
      \`recycleCooldownDays\` int NOT NULL DEFAULT 30,
      \`postsPerDay\` int NOT NULL DEFAULT 2,
      \`brandName\` varchar(64) NULL,
      \`brandAccent\` varchar(16) NULL,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // 既存アカウントに設定行が無ければ、現在のグローバル settings の値をコピーして作る。
  // 「今の挙動をそのまま各アカウントに引き継ぐ」ためのINSERTのみで、更新はしない。
  {
    const [globalRows] = await conn.query(
      "SELECT requireApproval, notifyOnError, autoFillEvergreen, recycleRewrite, recycleCooldownDays, postsPerDay, brandName, brandAccent FROM `settings` LIMIT 1"
    );
    const g = (globalRows as Record<string, unknown>[])[0] ?? {};
    const [missing] = await conn.query(
      "SELECT a.id FROM `accounts` a LEFT JOIN `account_settings` s ON s.accountId = a.id WHERE s.id IS NULL"
    );
    for (const row of missing as { id: number }[]) {
      console.log(`[upgrade] account_settings をアカウント ${row.id} に作成（現行のグローバル設定を引き継ぎ）`);
      await conn.query(
        `INSERT INTO \`account_settings\`
          (accountId, requireApproval, notifyOnError, autoFillEvergreen, recycleRewrite, recycleCooldownDays, postsPerDay, brandName, brandAccent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          g.requireApproval ?? false,
          g.notifyOnError ?? true,
          g.autoFillEvergreen ?? false,
          g.recycleRewrite ?? true,
          g.recycleCooldownDays ?? 30,
          g.postsPerDay ?? 2,
          g.brandName ?? null,
          g.brandAccent ?? null,
        ]
      );
    }
  }

  // フォロワー数の日次スナップショット。増減は差分から求めるため履歴を持つ
  await createTable("follower_snapshots", `
    CREATE TABLE \`follower_snapshots\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`accountId\` int NOT NULL,
      \`capturedDate\` varchar(10) NOT NULL,
      \`followerCount\` int NOT NULL,
      \`fetchedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY \`uniq_follower_account_date\` (\`accountId\`, \`capturedDate\`)
    )
  `);

  // ── トレンドリサーチ ──────────────────────────────────────────────────────
  await addColumn("posts", "trendAnalysisId", "`trendAnalysisId` int NULL");
  await addColumn("posts", "trendMeta", "`trendMeta` text NULL");

  await createTable("trend_settings", `
    CREATE TABLE \`trend_settings\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`accountId\` int NOT NULL UNIQUE,
      \`keywords\` text NULL,
      \`excludeKeywords\` text NULL,
      \`refAccounts\` text NULL,
      \`language\` varchar(8) NOT NULL DEFAULT 'ja',
      \`region\` varchar(8) NOT NULL DEFAULT 'JP',
      \`industry\` varchar(64) NULL,
      \`fetchTimes\` text NULL,
      \`autoFetch\` boolean NOT NULL DEFAULT true,
      \`retentionDays\` int NOT NULL DEFAULT 30,
      \`aiDailyLimit\` int NOT NULL DEFAULT 20,
      \`lastFetchKey\` varchar(24) NULL,
      \`lastFetchAt\` timestamp NULL,
      \`lastFetchError\` varchar(32) NULL,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  // 既にテーブルがある環境向け（作成済みなら上の CREATE は走らないので個別に足す）
  await addColumn("trend_settings", "lastFetchError", "`lastFetchError` varchar(32) NULL");

  await createTable("trend_posts", `
    CREATE TABLE \`trend_posts\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`accountId\` int NOT NULL,
      \`platform\` enum('threads','instagram') NOT NULL,
      \`source\` enum('keyword','manual') NOT NULL DEFAULT 'keyword',
      \`keyword\` varchar(64) NULL,
      \`externalId\` varchar(128) NOT NULL,
      \`permalink\` varchar(512) NULL,
      \`username\` varchar(64) NULL,
      \`postedAt\` timestamp NULL,
      \`mediaType\` varchar(24) NULL,
      \`summary\` varchar(255) NOT NULL,
      \`hasReplies\` boolean NULL,
      \`likes\` int NULL,
      \`replies\` int NULL,
      \`reposts\` int NULL,
      \`views\` int NULL,
      \`saves\` int NULL,
      \`score\` int NOT NULL DEFAULT 0,
      \`scoreBreakdown\` text NULL,
      \`isRising\` boolean NOT NULL DEFAULT false,
      \`status\` enum('active','saved','excluded','deleted') NOT NULL DEFAULT 'active',
      \`aiReason\` text NULL,
      \`aiIdeas\` text NULL,
      \`firstSeenAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`fetchedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY \`uniq_trend_post\` (\`accountId\`, \`platform\`, \`externalId\`)
    )
  `);

  await createTable("trend_analyses", `
    CREATE TABLE \`trend_analyses\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`accountId\` int NOT NULL,
      \`period\` varchar(8) NOT NULL,
      \`result\` text NOT NULL,
      \`postCount\` int NOT NULL DEFAULT 0,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── 受信箱（Threadsの返信管理） ────────────────────────────────────────────
  await addColumn("accounts", "lastReplyFetchAt", "`lastReplyFetchAt` timestamp NULL");
  await addColumn("accounts", "lastReplyFetchError", "`lastReplyFetchError` varchar(32) NULL");
  // 自分自身の返信（スレッドの続き）を受信箱から除くために必要。未設定の既存アカウントは
  // 次回の返信取得時に自動で埋まる（server/replies.ts fetchRepliesForAccount 参照）
  await addColumn("accounts", "threadsUsername", "`threadsUsername` varchar(64) NULL");

  await createTable("thread_replies", `
    CREATE TABLE \`thread_replies\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`accountId\` int NOT NULL,
      \`externalId\` varchar(128) NOT NULL,
      \`rootMediaId\` varchar(128) NULL,
      \`rootPermalink\` varchar(512) NULL,
      \`username\` varchar(64) NULL,
      \`text\` varchar(600) NULL,
      \`permalink\` varchar(512) NULL,
      \`postedAt\` timestamp NULL,
      \`hideStatus\` varchar(24) NULL,
      \`status\` enum('unread','read','replied') NOT NULL DEFAULT 'unread',
      \`repliedContent\` text NULL,
      \`repliedAt\` timestamp NULL,
      \`firstSeenAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`fetchedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY \`uniq_thread_reply\` (\`accountId\`, \`externalId\`)
    )
  `);

  await createTable("reply_templates", `
    CREATE TABLE \`reply_templates\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`accountId\` int NOT NULL,
      \`keywords\` text NOT NULL,
      \`replyText\` varchar(500) NOT NULL,
      \`enabled\` boolean NOT NULL DEFAULT true,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await createTable("engagement_comments", `
    CREATE TABLE \`engagement_comments\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`accountId\` int NOT NULL,
      \`targetExternalId\` varchar(128) NOT NULL,
      \`targetType\` enum('post','reply') NOT NULL DEFAULT 'post',
      \`trendPostId\` int NULL,
      \`targetUsername\` varchar(64) NULL,
      \`targetPermalink\` varchar(512) NULL,
      \`targetSummary\` varchar(255) NULL,
      \`content\` varchar(500) NOT NULL,
      \`threadsCommentId\` varchar(128) NULL,
      \`sentAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── クライアント情報のAI読み取り ──────────────────────────────────────────
  await createTable("client_profile_drafts", `
    CREATE TABLE \`client_profile_drafts\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`accountId\` int NOT NULL,
      \`status\` enum('pending','approved','dismissed') NOT NULL DEFAULT 'pending',
      \`inputs\` text NOT NULL,
      \`profile\` mediumtext NOT NULL,
      \`keywords\` text NOT NULL,
      \`warnings\` text NOT NULL,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`reviewedAt\` timestamp NULL
    )
  `);
  await createTable("client_profiles", `
    CREATE TABLE \`client_profiles\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`accountId\` int NOT NULL UNIQUE,
      \`profile\` mediumtext NOT NULL,
      \`sourceInputs\` text NOT NULL,
      \`approvedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await createTable("client_trend_keywords", `
    CREATE TABLE \`client_trend_keywords\` (
      \`id\` int AUTO_INCREMENT PRIMARY KEY,
      \`accountId\` int NOT NULL,
      \`keyword\` varchar(64) NOT NULL,
      \`category\` varchar(32) NOT NULL,
      \`reason\` varchar(300) NOT NULL,
      \`targetCustomer\` varchar(160) NULL,
      \`region\` varchar(80) NULL,
      \`priority\` int NOT NULL DEFAULT 3,
      \`enabled\` boolean NOT NULL DEFAULT true,
      \`sources\` text NOT NULL,
      \`lastUsedAt\` timestamp NULL,
      \`outcome\` text NULL,
      \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY \`uniq_client_keyword\` (\`accountId\`, \`keyword\`)
    )
  `);

  await createTable("campaigns", `CREATE TABLE \`campaigns\` (\`id\` int AUTO_INCREMENT PRIMARY KEY, \`accountId\` int NOT NULL, \`name\` varchar(100) NOT NULL, \`code\` varchar(80) NOT NULL, \`active\` boolean NOT NULL DEFAULT true, \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY \`uniq_campaign_code\` (\`accountId\`,\`code\`))`);
  await createTable("conversion_goals", `CREATE TABLE \`conversion_goals\` (\`id\` int AUTO_INCREMENT PRIMARY KEY, \`accountId\` int NOT NULL, \`name\` varchar(80) NOT NULL, \`type\` varchar(32) NOT NULL, \`destinationUrl\` varchar(2048) NULL, \`enabled\` boolean NOT NULL DEFAULT true, \`priority\` int NOT NULL DEFAULT 3, \`valueCents\` bigint NULL, \`currency\` varchar(3) NOT NULL DEFAULT 'JPY', \`region\` varchar(80) NULL, \`campaign\` varchar(100) NULL, \`attributionDays\` int NOT NULL DEFAULT 30, \`primary\` boolean NOT NULL DEFAULT false, \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await createTable("conversion_events", `CREATE TABLE \`conversion_events\` (\`id\` int AUTO_INCREMENT PRIMARY KEY, \`accountId\` int NOT NULL, \`postId\` int NULL, \`postLogId\` int NULL, \`campaignId\` int NULL, \`conversionGoalId\` int NULL, \`eventType\` varchar(32) NOT NULL, \`eventTime\` timestamp NOT NULL, \`quantity\` int NOT NULL DEFAULT 1, \`valueCents\` bigint NULL, \`currency\` varchar(3) NOT NULL DEFAULT 'JPY', \`source\` varchar(100) NULL, \`medium\` varchar(100) NULL, \`campaign\` varchar(100) NULL, \`content\` varchar(100) NULL, \`externalEventId\` varchar(160) NULL, \`metadata\` text NULL, \`note\` varchar(500) NULL, \`registeredBy\` int NULL, \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY \`uniq_conversion_external\` (\`accountId\`,\`externalEventId\`))`);
  await createTable("conversion_event_revisions", `CREATE TABLE \`conversion_event_revisions\` (\`id\` int AUTO_INCREMENT PRIMARY KEY, \`accountId\` int NOT NULL, \`conversionEventId\` int NOT NULL, \`snapshot\` text NOT NULL, \`changedBy\` int NULL, \`reason\` varchar(300) NULL, \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await createTable("content_strategies", `CREATE TABLE \`content_strategies\` (\`id\` int AUTO_INCREMENT PRIMARY KEY, \`accountId\` int NOT NULL, \`startDate\` varchar(10) NOT NULL, \`status\` enum('draft','approved','archived') NOT NULL DEFAULT 'draft', \`goal\` varchar(300) NOT NULL, \`audience\` varchar(300) NOT NULL, \`coreMessage\` varchar(500) NOT NULL, \`warnings\` text NOT NULL, \`createdBy\` int NULL, \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await createTable("content_strategy_items", `CREATE TABLE \`content_strategy_items\` (\`id\` int AUTO_INCREMENT PRIMARY KEY, \`accountId\` int NOT NULL, \`strategyId\` int NOT NULL, \`day\` int NOT NULL, \`date\` varchar(10) NOT NULL, \`status\` enum('active','excluded','scheduled') NOT NULL DEFAULT 'active', \`purpose\` varchar(32) NOT NULL, \`theme\` varchar(160) NOT NULL, \`hook\` varchar(200) NOT NULL, \`cta\` varchar(200) NOT NULL, \`format\` varchar(24) NOT NULL, \`recommendedTime\` varchar(5) NOT NULL, \`trend\` varchar(160) NULL, \`rationale\` varchar(500) NOT NULL, \`expectedOutcome\` varchar(300) NOT NULL, \`confidence\` int NOT NULL, \`hypothesis\` boolean NOT NULL DEFAULT true, \`factCheckWarning\` varchar(300) NULL, \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await createTable("weekly_reviews", `CREATE TABLE \`weekly_reviews\` (\`id\` int AUTO_INCREMENT PRIMARY KEY, \`accountId\` int NOT NULL, \`strategyId\` int NOT NULL, \`result\` text NOT NULL, \`sampleSize\` int NOT NULL DEFAULT 0, \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await createTable("post_quality_checks", `CREATE TABLE \`post_quality_checks\` (\`id\` int AUTO_INCREMENT PRIMARY KEY, \`accountId\` int NOT NULL, \`postId\` int NULL, \`contentHash\` varchar(64) NOT NULL, \`status\` varchar(16) NOT NULL, \`summary\` varchar(800) NOT NULL, \`aiUsed\` boolean NOT NULL DEFAULT false, \`createdBy\` int NULL, \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await createTable("post_quality_findings", `CREATE TABLE \`post_quality_findings\` (\`id\` int AUTO_INCREMENT PRIMARY KEY, \`accountId\` int NOT NULL, \`qualityCheckId\` int NOT NULL, \`code\` varchar(60) NOT NULL, \`status\` varchar(16) NOT NULL, \`message\` varchar(500) NOT NULL, \`reason\` varchar(500) NOT NULL, \`evidence\` varchar(500) NOT NULL, \`severity\` int NOT NULL, \`suggestion\` varchar(500) NOT NULL, \`autoFixable\` boolean NOT NULL DEFAULT false, \`humanReview\` boolean NOT NULL DEFAULT false, \`deterministic\` boolean NOT NULL DEFAULT false, \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP)`);

  await addColumn("posts", "campaignId", "\`campaignId\` int NULL");
  await addColumn("posts", "strategyItemId", "\`strategyItemId\` int NULL");
  await addColumn("posts", "conversionGoalId", "\`conversionGoalId\` int NULL");
  await addColumn("posts", "trackingMeta", "\`trackingMeta\` text NULL");
  await addColumn("posts", "creationSource", "\`creationSource\` enum('manual','ai','strategy','import','recycle') NOT NULL DEFAULT 'manual'");
  await addColumn("posts", "qualityCheckStatus", "\`qualityCheckStatus\` enum('unchecked','ok','recommend','review','blocked') NOT NULL DEFAULT 'unchecked'");
  await addColumn("account_settings", "weeklyPostCount", "\`weeklyPostCount\` int NOT NULL DEFAULT 7");
  await addColumn("account_settings", "purposeRatios", "\`purposeRatios\` text NULL");
  await addColumn("account_settings", "defaultCta", "\`defaultCta\` varchar(300) NULL");
  await addColumn("account_settings", "forbiddenTopics", "\`forbiddenTopics\` text NULL");
  await addColumn("account_settings", "qualityStrictness", "\`qualityStrictness\` enum('standard','strict') NOT NULL DEFAULT 'standard'");
  await addColumn("account_settings", "strategyAiDailyLimit", "\`strategyAiDailyLimit\` int NOT NULL DEFAULT 10");
  await addColumn("account_settings", "autoWeeklyStrategy", "\`autoWeeklyStrategy\` boolean NOT NULL DEFAULT false");
  await addColumn("account_settings", "weeklyReviewEnabled", "\`weeklyReviewEnabled\` boolean NOT NULL DEFAULT true");
  await addColumn("account_settings", "conversionTrackingEnabled", "\`conversionTrackingEnabled\` boolean NOT NULL DEFAULT true");

  // ── 大漁マーケットOS 統合（追加のみ。既存テーブルは変更しない） ────────────
  for (const t of INTEGRATION_TABLES) await createTable(t.table, t.ddl);
  for (const i of INTEGRATION_INDEXES) await addIndex(i.table, i.index, i.columns);

  // アカウント単位の絞り込みが常に索引に乗るようにする
  await addIndex("posts", "idx_posts_account", "`accountId`");
  await addIndex("posts", "idx_posts_account_date", "`accountId`, `scheduledDate`");
  await addIndex("post_logs", "idx_post_logs_account", "`accountId`, `postedAt`");
  await addIndex("post_analytics", "idx_post_analytics_log", "`postLogId`");
  await addIndex("categories", "idx_categories_account", "`accountId`");
  await addIndex("follower_snapshots", "idx_follower_account_date", "`accountId`, `capturedDate`");
  await addIndex("trend_posts", "idx_trend_posts_account_fetched", "`accountId`, `fetchedAt`");
  await addIndex("trend_posts", "idx_trend_posts_account_status", "`accountId`, `status`");
  await addIndex("trend_analyses", "idx_trend_analyses_account", "`accountId`, `createdAt`");
  await addIndex("posts", "idx_posts_trend", "`trendAnalysisId`");
  await addIndex("thread_replies", "idx_thread_replies_account_status", "`accountId`, `status`");
  await addIndex("thread_replies", "idx_thread_replies_account_posted", "`accountId`, `postedAt`");
  await addIndex("reply_templates", "idx_reply_templates_account", "`accountId`");
  await addIndex("engagement_comments", "idx_engagement_comments_account_sent", "`accountId`, `sentAt`");
  await addIndex("engagement_comments", "idx_engagement_comments_target", "`accountId`, `targetExternalId`");
  await addIndex("client_profile_drafts", "idx_profile_draft_account", "`accountId`, `createdAt`");
  await addIndex("client_trend_keywords", "idx_client_keyword_account", "`accountId`, `enabled`, `priority`");
  await addIndex("conversion_goals", "idx_conversion_goal_account", "`accountId`, `enabled`, `priority`");
  await addIndex("conversion_events", "idx_conversion_event_account_time", "`accountId`, `eventTime`");
  await addIndex("conversion_events", "idx_conversion_event_post", "`accountId`, `postId`");
  await addIndex("conversion_event_revisions", "idx_conversion_revision_event", "`accountId`, `conversionEventId`");
  await addIndex("content_strategies", "idx_strategy_account_start", "`accountId`, `startDate`");
  await addIndex("content_strategy_items", "idx_strategy_item_account", "`accountId`, `strategyId`, `date`");
  await addUniqueIndex("weekly_reviews", "uniq_weekly_review_strategy", "`accountId`, `strategyId`");
  await addIndex("post_quality_checks", "idx_quality_account_post", "`accountId`, `postId`, `createdAt`");
  await addIndex("post_quality_findings", "idx_quality_finding_check", "`accountId`, `qualityCheckId`");

  console.log("[upgrade] 完了");
  await conn.end();
}

main().catch((e) => {
  console.error("[upgrade] 失敗:", e);
  const code = (e as { code?: string })?.code;
  // よくある失敗の原因をログに添える（Renderのデプロイログだけで切り分けられるように）
  if (code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "ENOTFOUND") {
    console.error(
      "[upgrade] DBに接続できません。DATABASE_URL のホスト/ポート、" +
        "およびDB側のIP許可リスト（TiDB Cloudなら 0.0.0.0/0 の追加）を確認してください。"
    );
  } else if (code === "ER_ACCESS_DENIED_ERROR") {
    console.error("[upgrade] 認証に失敗しました。DATABASE_URL のユーザー名/パスワードを確認してください。");
  } else if (code === "HANDSHAKE_SSL_ERROR" || String(e).includes("SSL")) {
    console.error("[upgrade] TLSハンドシェイクに失敗しました。DB_SSL=insecure で再試行できます。");
  }
  process.exit(1);
});
