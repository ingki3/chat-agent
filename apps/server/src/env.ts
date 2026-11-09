import path from "node:path";
import dotenv from "dotenv";
import { REPO_ROOT } from "./config.js";

// Same .env regardless of where the process was started (pnpm runs scripts from apps/server).
dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });
