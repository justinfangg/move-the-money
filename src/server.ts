import { buildApp } from "./app.js";
import { createPool } from "./db/pool.js";

const pool = createPool();
const app = buildApp({ pool, logger: true });
const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: "127.0.0.1" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => pool.end());
  });
}
