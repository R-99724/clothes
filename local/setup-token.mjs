import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

try {
  const db = new DatabaseSync(resolve(process.env.YIYANG_DATA_DIR || ".yiyang-data", "accounts.sqlite"), { readOnly: true });
  try {
    if (db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
      console.log("管理员已初始化。请使用管理员账号登录。");
    } else {
      const token = process.env.YIYANG_SETUP_TOKEN || db.prepare("SELECT value FROM state WHERE key='bootstrap'").get()?.value;
      if (!token) throw new Error("missing bootstrap");
      console.log(`首次管理员初始化口令 · ${token}`);
    }
  } finally { db.close(); }
} catch {
  console.error("读取失败。请先启动独立服务并确认数据目录。");
  process.exitCode = 1;
}
