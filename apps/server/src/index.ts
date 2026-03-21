import { buildServer } from "./server.js";
import { config } from "./config.js";

const app = await buildServer();

try {
  await app.listen({
    port: config.port,
    host: config.host
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
