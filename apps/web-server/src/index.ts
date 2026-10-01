import { buildApp } from "./app.js";
import { EnvError, loadEnv } from "./env.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const app = buildApp(env);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down");
      app.close().catch((err: unknown) => {
        app.log.error(err, "error during shutdown");
        process.exitCode = 1;
      });
    });
  }

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((err: unknown) => {
  console.error(err instanceof EnvError ? err.message : err);
  process.exit(1);
});
