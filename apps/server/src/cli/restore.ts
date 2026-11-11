import "../env.js";
import path from "node:path";
import { listBackups } from "../backup/backup.js";
import {
  resolveBackup,
  restoreBackup,
  RecoveryError,
  RestoreError,
  verifyBackup,
  type RestoreCode,
} from "../backup/restore.js";
import { loadConfig } from "../config.js";
import { loadMasterKey, SecretError } from "../crypto/secrets.js";
import { isInside } from "../fs-safety.js";

/**
 * `pnpm -s restore list | check <backup> | apply <backup> [--target <dir>] [--key <file>] [--yes]` (#37,
 * docs/ops.md §21). Run with the server stopped. `<backup>` is an id from `list` or a path to a backup folder.
 * Prints fixed lines only (ids, codes, counts) — never file contents.
 */
const HELP = `사용법 (서버를 멈춘 뒤 실행):
  pnpm -s restore list                         백업 목록
  pnpm -s restore check <백업> [--key <파일>]   검사만 (아무것도 쓰지 않음)
  pnpm -s restore apply <백업> [--target <폴더>] [--key <파일>] [--yes]
    --target  복원할 데이터 폴더 (기본: DATA_DIR — 그때는 --yes 필요, 기존 폴더는 옆으로 옮겨 둠)
    --key     마스터 키 파일 (기본: MASTER_KEY_PATH) — 오프라인 사본에서 되살린 키
  자세한 절차: docs/ops.md 21절`;

const MESSAGES: Record<RestoreCode, string> = {
  backup_not_found: "백업 폴더를 찾을 수 없어요.",
  manifest_invalid: "백업 목록 파일(manifest.json)이 없거나 손상됐어요.",
  backup_corrupt: "백업 파일이 손상됐어요(해시·무결성 검사 실패).",
  wrong_key: "마스터 키가 이 백업을 만든 키와 달라요. 오프라인 사본의 키를 --key로 주세요(ops.md 3절).",
  secret_unreadable: "키는 맞지만 저장된 인증 정보 일부를 풀 수 없어요(백업 손상 또는 키가 바뀐 데이터).",
  schema_newer: "이 백업은 더 새 버전의 서버가 만들었어요. 코드를 먼저 그 버전 이상으로 업데이트하세요.",
  schema_mismatch: "이 백업의 DB 스키마가 이 코드와 맞지 않아요(다른 브랜치의 마이그레이션).",
  server_running: "서버가 아직 이 데이터 폴더를 쓰고 있어요. 먼저 서버를 멈추세요.",
  target_unsafe: "복원 대상 폴더가 안전하지 않아요(백업 폴더·키와 겹치거나 심볼릭 링크).",
  old_unsettled:
    "기존 데이터 폴더의 DB를 정리(체크포인트)하지 못했어요. 다른 프로세스가 열고 있지 않은지 확인하세요.",
  not_durable:
    "새 데이터 폴더를 디스크에 확실히 쓰지 못했어요(fsync 실패 — 디스크 공간·오류 확인). 아무것도 바꾸지 않았어요.",
};

function fail(code: RestoreCode | "usage" | "key_unreadable", extra?: string): never {
  if (code === "usage") console.error(HELP);
  else if (code === "key_unreadable")
    console.error(
      `restore failed: key_unreadable — 마스터 키 파일을 읽을 수 없어요${extra ? ` (${extra})` : ""}.`,
    );
  else console.error(`restore failed: ${code} — ${MESSAGES[code]}`);
  process.exit(code === "usage" ? 2 : 1);
}

const config = loadConfig();
const cwd = process.env.INIT_CWD ?? process.cwd();
const [command, ...rest] = process.argv.slice(2).filter((a) => a !== "--");
const flags = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a === "--yes") flags.set("yes", true);
  else if (a === "--target" || a === "--key") {
    const v = rest[++i];
    if (!v) fail("usage");
    flags.set(a.slice(2), v);
  } else if (a.startsWith("--")) fail("usage");
  else positional.push(a);
}

/** The key file actually used — resolved once, for loading and for the target checks. */
const keyFile = path.resolve(cwd, (flags.get("key") as string | undefined) ?? config.masterKeyPath);

function key(): Buffer {
  const file = keyFile;
  try {
    return loadMasterKey(file);
  } catch (e) {
    fail(
      "key_unreadable",
      e instanceof SecretError ? "권한 600·32바이트·심볼릭 링크 아님을 확인" : undefined,
    );
  }
}

try {
  if (command === "list") {
    if (!config.backupDir) fail("usage");
    const items = listBackups(config.backupDir);
    if (!items.length) console.log("백업이 없어요.");
    for (const b of items)
      console.log(
        `${b.id}  ${new Date(b.createdAt).toISOString()}  ${b.valid ? `스키마 ${b.migrations} · 파일 ${b.fileCount} · ${b.bytes} B` : "손상"}`,
      );
  } else if (command === "check" && positional.length === 1) {
    const v = verifyBackup(resolveBackup(positional[0]!, config.backupDir, cwd), key());
    console.log(
      `ok: ${v.manifest.id} — 키·해시·무결성·스키마(${v.manifest.schema.migrations}, 적용할 마이그레이션 ${v.pending})·인증 정보 확인`,
    );
  } else if (command === "apply" && positional.length === 1) {
    const target = path.resolve(cwd, (flags.get("target") as string | undefined) ?? config.dataDir);
    if (isInside(target, config.dataDir) && isInside(config.dataDir, target) && !flags.get("yes")) {
      console.error("DATA_DIR에 복원하려면 --yes를 붙이세요(기존 폴더는 옆으로 옮겨 둬요).");
      process.exit(2);
    }
    const r = restoreBackup({
      backup: resolveBackup(positional[0]!, config.backupDir, cwd),
      target,
      key: key(),
      backupDir: config.backupDir,
      // Neither the key used nor the configured one may be inside the folder that is replaced.
      keyPaths: [keyFile, config.masterKeyPath],
    });
    console.log(`restored: ${r.manifest.id} (마이그레이션 ${r.pending}개 적용)`);
    if (r.previous) console.log(`이전 데이터 폴더는 옆에 남겨 뒀어요: ${path.basename(r.previous)}`);
    console.log(
      "다음: 서버를 다시 시작하세요(pnpm start 또는 sudo launchctl bootstrap system /Library/LaunchDaemons/com.agentlee.server.plist), 이어서 pnpm skills:install.",
    );
  } else fail("usage");
} catch (e) {
  if (e instanceof RestoreError) fail(e.code);
  if (typeof (e as NodeJS.ErrnoException).code === "string" && !(e instanceof RecoveryError)) {
    // A file-system error during the swap: undone in place, or left to the journal for the next start.
    console.error(
      `restore failed: ${(e as NodeJS.ErrnoException).code} — 교체 중 디스크 오류. 기존 데이터로 되돌렸거나, 다음 시작이 일지로 되돌려요(ops.md 21.4절).`,
    );
    process.exit(1);
  }
  if (e instanceof RecoveryError) {
    // An interrupted restore the next writer could not resolve: nothing was changed (docs/ops.md §21.4).
    console.error(`restore failed: ${e.message} — 일지와 두 폴더를 확인하세요(ops.md 21.4절).`);
    process.exit(1);
  }
  throw e;
}
