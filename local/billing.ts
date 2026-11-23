import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const amount = z.number().int().min(0).max(1000000);
const rates = z.object({ design: amount, photo: amount, video: amount, live: amount }).strict();
export type Service = keyof z.infer<typeof rates>;
export class BillingError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function openBilling(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS wallets(uid TEXT PRIMARY KEY REFERENCES users(id), balance INTEGER NOT NULL CHECK(balance>=0));
    CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES users(id), service TEXT NOT NULL,
      units INTEGER NOT NULL, points INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, job TEXT, actor TEXT, observed INTEGER);
    CREATE INDEX IF NOT EXISTS usage_user ON usage(uid,created);
    CREATE INDEX IF NOT EXISTS usage_job ON usage(uid,service,job);`);
  function tx<T>(fn: () => T) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function balance(uid: string) {
    return Number(db.prepare("SELECT balance FROM wallets WHERE uid=?").get(uid)?.balance ?? 0);
  }
  function prices() {
    const row = db.prepare("SELECT value FROM state WHERE key='prices'").get();
    return row ? rates.parse(JSON.parse(String(row.value))) : null;
  }
  function settle(id: string, refund: boolean, job: string | null = null) {
    tx(() => {
      const row = db.prepare("SELECT * FROM usage WHERE id=? AND status IN ('reserved','submitted')").get(id);
      if (!row) return;
      if (refund) db.prepare("UPDATE wallets SET balance=balance+? WHERE uid=?").run(row.points,row.uid);
      db.prepare("UPDATE usage SET status=?,job=coalesce(?,job) WHERE id=?").run(refund ? "refunded" : job ? "submitted" : "charged",job,id);
    });
  }
  return {
    balance, prices, settle,
    users: () => db.prepare("SELECT id,username,role,coalesce(balance,0) balance FROM users LEFT JOIN wallets ON uid=id ORDER BY username").all(),
    setPrices(input: unknown) {
      const parsed = rates.safeParse(input);
      if (!parsed.success) throw new BillingError("单价须为 0 到 1000000 的整数。");
      db.prepare("INSERT OR REPLACE INTO state(key,value) VALUES('prices',?)").run(JSON.stringify(parsed.data));
    },
    adjust(actor: string, input: unknown) {
      const {uid,target,expected} = z.object({uid:z.string().uuid(),target:amount,expected:z.number().int().nonnegative()}).parse(input);
      tx(() => {
        if (!db.prepare("SELECT id FROM users WHERE id=?").get(uid)) throw new BillingError("账号不存在。",404);
        if (balance(uid)!==expected) throw new BillingError("余额已变化，请刷新后再操作。",409);
        db.prepare("INSERT OR REPLACE INTO wallets VALUES(?,?)").run(uid,target);
        db.prepare("INSERT INTO usage(id,uid,service,units,points,status,created,actor) VALUES(?,?,'adjust',1,?,'charged',?,?)").run(randomUUID(),uid,expected-target,Date.now(),actor);
      });
    },
    reserve(uid:string, service:Service, units:number, id:string, quoted?:number) {
      tx(() => {
        const price = prices();
        if (!price) throw new BillingError("管理员尚未设置计费标准。",503);
        if (service==="live" && quoted!==price.live) throw new BillingError("实时试穿单价已更新，请刷新页面后确认费用。",409);
        const cost=price[service]*units;
        if (db.prepare("SELECT id FROM usage WHERE id=?").get(id)) throw new BillingError("请求已经受理，请勿重复提交。",409);
        if (balance(uid)<cost) throw new BillingError("积分不足，请联系管理员充值。",402);
        db.prepare("UPDATE wallets SET balance=balance-? WHERE uid=?").run(cost,uid);
        db.prepare("INSERT INTO usage(id,uid,service,units,points,status,created) VALUES(?,?,?,?,?,'reserved',?)").run(id,uid,service,units,cost,Date.now());
      });
    },
    job(uid:string,service:Service,job:string) {
      const row=db.prepare("SELECT id FROM usage WHERE uid=? AND service=? AND job=?").get(uid,service,job);
      if (!row) throw new BillingError("找不到此账号的任务。",404);
      return String(row.id);
    },
    refundPending(actor:string, id:string) {
      tx(() => {
        const row=db.prepare("SELECT * FROM usage WHERE id=? AND status IN ('reserved','submitted') AND created<?").get(id,Date.now()-600000);
        if (!row) throw new BillingError("该记录已结算或仍在处理。",409);
        db.prepare("UPDATE wallets SET balance=balance+? WHERE uid=?").run(row.points,row.uid);
        db.prepare("UPDATE usage SET status='refunded',actor=? WHERE id=?").run(actor,id);
      });
    },
    observed(uid:string,id:string,seconds:number) {
      db.prepare("UPDATE usage SET observed=min(units,?) WHERE uid=? AND id=? AND service='live' AND observed IS NULL AND status='charged'").run(seconds,uid,id);
    },
    logs(uid:string|null,offset:number) {
      return db.prepare(`SELECT usage.id,users.username,service,units,points,status,usage.created,observed,a.username actor FROM usage
        JOIN users ON users.id=usage.uid LEFT JOIN users a ON a.id=usage.actor
        WHERE (? IS NULL OR usage.uid=?) ORDER BY usage.rowid DESC LIMIT 50 OFFSET ?`).all(uid,uid,offset);
    }
  };
}
