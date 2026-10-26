// Starts the ShortStop web UI. Binds to 127.0.0.1 unless HOST is set: the API
// has no authentication and is meant for a local demo.
import { loadConfig, loadDotEnv } from "./config.ts";
import { createServer } from "./server.ts";

loadDotEnv();
const config = loadConfig();
const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "127.0.0.1";
createServer({ config }).listen(port, host, () => {
  console.log(`ShortStop UI on http://${host === "0.0.0.0" ? "localhost" : host}:${port}  [${config.mode.toUpperCase()} MODE]`);
});
