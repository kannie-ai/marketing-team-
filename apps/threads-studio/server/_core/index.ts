import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { mediaHandler } from "../mediaHandler";
import { threadsConnectHandler } from "../threadsConnectHandler";
import { appRouter } from "../routers";
import { registerIntegrationRoutes } from "../integration";
import { startInternalScheduler } from "../cron";
import { createContext } from "./context";
import { serveStatic } from "./static";
import { eveningPostHandler, morningPostHandler, tickHandler } from "../scheduledHandlers";
import { conversionWebhookHandler } from "../conversionWebhook";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // 大漁マーケットOS からのサーバー間API。
  // 署名は「受け取った生の本文」のハッシュに掛かっているため、
  // express.json() より前に登録して raw のまま受け取る必要がある。
  registerIntegrationRoutes(app);
  // 署名は元バイト列を対象にするため、全体のJSONパーサーより前に限定サイズで受ける。
  app.post("/api/conversions/webhook/:accountId", express.raw({ type: "application/json", limit: "128kb" }), conversionWebhookHandler);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerOAuthRoutes(app);
  // 画像の公開配信。Threadsのサーバーが取得しに来るため認証は掛けられない
  // （tokenはランダム16バイトなので、URLを知らない限り到達できない）。
  app.get("/api/media/:token", mediaHandler);
  // Threads連携（クライアントが自分で許可して戻ってくる先。未ログインで到達する）
  app.get("/api/threads/callback", threadsConnectHandler);
  // Scheduled cron handlers — must be before Vite/static fallthrough
  app.post("/api/scheduled/tick", tickHandler);
  app.post("/api/scheduled/morning-post", morningPostHandler);
  app.post("/api/scheduled/evening-post", eveningPostHandler);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files.
  // viteは動的importにしてある（本番バンドルからは除外されるので、
  // 本番環境にdevDependenciesが無くても起動できる）。
  if (process.env.NODE_ENV === "development") {
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  // 内蔵スケジューラ（15分ごとのtick）。DISABLE_SCHEDULER=1 で無効化できる。
  if (process.env.DISABLE_SCHEDULER !== "1") {
    startInternalScheduler();
  }
}

startServer().catch(console.error);
