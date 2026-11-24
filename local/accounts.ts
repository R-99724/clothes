import { openSharedWardrobe } from "./shared-wardrobe";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openBilling } from "./billing";
import { z } from "zod";

export class AccountError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const lifetime = 7 * 24 * 60 * 60;
const provider = z.object({
  url: z.string().trim().max(500), key: z.string().trim().max(4096).optional(),
  clearKey: z.boolean().optional(), model: z.string().trim().max(100).optional(),
  imageModel: z.string().trim().max(100).optional(), protocol: z.enum(["images", "responses"]).optional(),
}).strict();
const settings = z.object({
  design: provider.optional(), live: provider.optional(), photo: provider.optional(), video: provider.optional(),
}).strict();
const loginInput = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{2,31}$/),
  password: z.string().min(1).max(128),
  bootstrap: z.string().max(256).optional(),
}).strict();
type User = { id: string; username: string; role: "admin" | "member" };
type ProviderKind = keyof z.infer<typeof settings>;
type StoredProviders = Partial<Record<ProviderKind, z.infer<typeof provider>>>;

function secretFile(directory: string) {
  const path = resolve(directory, "secrets.key");
  const temp = resolve(directory, `.key-${randomUUID()}`);
  try {
    writeFileSync(temp, randomBytes(32), { mode: 0o600, flag: "wx" });
    try { linkSync(temp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { rmSync(temp, { force: true }); }
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error("账号数据密钥格式有误。");
  return key;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function openAccounts(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = secretFile(directory);
  const database = new DatabaseSync(resolve(directory, "accounts.sqlite"), {
    enableForeignKeyConstraints: true,
  });
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','member')), password TEXT NOT NULL,
      settings TEXT, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
  `);
  const readState = (name: string) => database.prepare("SELECT value FROM state WHERE key=?").get(name)?.value as string | undefined;
  const setState = (name: string, value: string) => database.prepare("INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(name, value);
  const initialized = () => Boolean(database.prepare("SELECT 1 FROM users WHERE role='admin'").get());
  if (!initialized()) database.prepare("INSERT OR IGNORE INTO state VALUES ('bootstrap', ?)").run(randomBytes(18).toString("base64url"));

  const state = () => ({ needsSetup: !initialized(), registrationOpen: initialized() && readState("registration") !== "closed" });
  const bootstrap = () => initialized() ? undefined : process.env.YIYANG_SETUP_TOKEN || readState("bootstrap");
  let hashesInProgress = 0;
  function throttle(bucket: string, max: number) {
    const now = Date.now();
    database.prepare("DELETE FROM attempts WHERE expires <= ?").run(now);
    const row = database.prepare(`
      INSERT INTO attempts VALUES (?, 1, ?)
      ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count
    `).get(bucket, now + 15 * 60_000);
    if (Number(row?.count) > max) throw new AccountError("尝试次数过多，请 15 分钟后再试。", 429);
  }
  async function passwordHash(password: string, salt: string) {
    if (hashesInProgress >= 2) throw new AccountError("认证服务繁忙，请稍后再试。", 429);
    hashesInProgress++;
    try {
      const key = await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, 64, { N: 65_536, r: 8, p: 2, maxmem: 96 * 1024 * 1024 },
          (error, bytes) => error ? reject(error) : resolve(bytes));
      });
      return key.toString("hex");
    } finally { hashesInProgress--; }
  }
  function issue(user: User) {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    database.prepare("DELETE FROM sessions WHERE expires <= ?").run(now);
    database.prepare("INSERT INTO sessions VALUES (?,?,?)").run(hash(token), user.id, now + lifetime * 1000);
    return { user, token };
  }
  function authenticate(token: string | undefined) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return (database.prepare(`
      SELECT users.id, username, role FROM sessions JOIN users ON users.id=sessions.user_id
      WHERE sessions.token=? AND expires>?
    `).get(hash(token), Date.now()) as User | undefined) ?? null;
  }
  async function enter(action: "setup" | "register" | "login", input: unknown, ip: string) {
    throttle(`ip:${ip}`, 40);
    const parsed = loginInput.safeParse(input);
    if (!parsed.success) throw new AccountError("用户名须为 3–32 位字母、数字、点、下划线或横线，密码最多 128 字符。");
    const { username, password, bootstrap: provided } = parsed.data;
    const existing = database.prepare("SELECT id, username, role, password FROM users WHERE username=?").get(username) as (User & { password: string }) | undefined;
    if (action === "login") {
      throttle(`login:${username}`, 10);
      const [salt, expected] = existing?.password.split(":") ?? ["yiyang-missing-user", "0".repeat(128)];
      const actual = await passwordHash(password, salt);
      if (!existing || !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))) {
        throw new AccountError("用户名或密码不正确。", 401);
      }
      database.prepare("DELETE FROM attempts WHERE bucket=?").run(`login:${username}`);
      return issue({ id: existing.id, username, role: existing.role });
    }
    if (password.length < 12) throw new AccountError("设置密码时至少使用 12 个字符。");
    if (action === "setup") {
      const expected = bootstrap();
      if (!expected) throw new AccountError("管理员已完成初始化。请登录。", 409);
      if (!provided || !timingSafeEqual(Buffer.from(hash(expected)), Buffer.from(hash(provided)))) {
        throw new AccountError("初始化口令不正确。", 403);
      }
    } else if (!state().registrationOpen) {
      throw new AccountError("注册尚未开放。", 403);
    }
    const salt = randomBytes(16).toString("hex");
    const passwordValue = `${salt}:${await passwordHash(password, salt)}`;
    const user = { id: randomUUID(), username, role: action === "setup" ? "admin" : "member" } as const;
    database.exec("BEGIN IMMEDIATE");
    try {
      if (action === "setup" && initialized()) throw new AccountError("管理员已完成初始化。请登录。", 409);
      if (action === "register" && !state().registrationOpen) throw new AccountError("注册尚未开放。", 403);
      if (database.prepare("SELECT 1 FROM users WHERE username=?").get(username)) throw new AccountError("该用户名已被使用。", 409);
      database.prepare("INSERT INTO users (id,username,role,password,created) VALUES (?,?,?,?,?)")
        .run(user.id, username, user.role, passwordValue, Date.now());
      if (action === "setup") database.prepare("DELETE FROM state WHERE key='bootstrap'").run();
      const session = issue(user);
      database.exec("COMMIT");
      return session;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function getProviders(user: User): StoredProviders {
    const stored = database.prepare("SELECT settings FROM users WHERE id=?").get(user.id)?.settings;
    if (typeof stored !== "string") return {};
    const [iv, tag, body] = stored.split(".");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(user.id));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString());
  }

  function saveProviders(user: User, input: unknown, secure: boolean) {
    const parsed = settings.safeParse(input);
    if (!parsed.success) throw new AccountError("接口设置格式有误。");
    const previous = getProviders(user);
    const next: StoredProviders = {};
    const approved = new Set([
      "https://api.openai.com", "https://api.fashn.ai", "https://api.decart.ai",
      ...(process.env.YIYANG_PROVIDER_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean),
    ]);
    for (const [kind, value] of Object.entries(parsed.data) as [ProviderKind, NonNullable<StoredProviders[ProviderKind]>][]) {
      let url: URL;
      try { url = new URL(value.url); } catch { throw new AccountError("请输入有效的 API 基础地址。"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new AccountError("API 地址只能使用 HTTP 或 HTTPS，且不能包含凭据、参数或片段。");
      }
      if (user.role !== "admin" && !approved.has(url.origin)) {
        throw new AccountError("该接口域名尚未获管理员允许。", 403);
      }
      const base = url.href.replace(/\/+$/, "");
      if (kind === "live" && (!base.endsWith("/v1") || (secure && url.protocol !== "https:"))) {
        throw new AccountError("实时试穿地址须以 /v1 结尾。HTTPS 站点须使用 HTTPS 实时服务。");
      }
      if (kind === "video" && !value.model) throw new AccountError("请输入视频模型名称。");
      const secret = value.clearKey ? "" : value.key || (previous[kind]?.url === base ? previous[kind]?.key : "") || "";
      next[kind] = { url: base, key: secret, model: value.model, imageModel: value.imageModel, protocol: value.protocol };
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(user.id));
    const body = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()]);
    const record = [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64")).join(".");
    database.prepare("UPDATE users SET settings=? WHERE id=?").run(record, user.id);
  }

  return {
    signingKey: createHmac("sha256",key).update("yiyang/photo-job/v1").digest("hex"),
    billing: openBilling(database),
    wardrobe: openSharedWardrobe(database),
    sharedProviders() {
      const admin = database.prepare("SELECT id FROM users WHERE role='admin' ORDER BY created LIMIT 1").get();
      return admin ? getProviders({id:String(admin.id),role:"admin",username:""}) : {};
    },
    state, bootstrap, authenticate, enter, lifetime, getProviders, saveProviders,
    revoke(token: string) { database.prepare("DELETE FROM sessions WHERE token=?").run(hash(token)); },
    setRegistration(user: User, open: unknown) {
      if (user.role !== "admin") throw new AccountError("仅管理员可管理注册。", 403);
      if (typeof open !== "boolean") throw new AccountError("注册设置格式有误。");
      setState("registration", open ? "open" : "closed");
    },
  };
}
