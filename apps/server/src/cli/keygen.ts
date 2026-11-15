import { loadConfig } from "../config.js";
import { createMasterKey } from "../crypto/secrets.js";
import "../env.js";

// Creates the credential-encryption master key (mode 600). Run once per installation; back it up offline.
const config = loadConfig();
createMasterKey(config.masterKeyPath);
console.log(
  `master key created at ${config.masterKeyPath} (mode 600). Store an offline copy — see docs/ops.md.`,
);
