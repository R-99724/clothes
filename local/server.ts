import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BillingError, type Service } from "./billing";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { handleStudio } from "../app/studio-api";
import { AccountError, openAccounts } from "./accounts";

const address = process.env.YIYANG_HOST || "127.0.0.1";
const port = Number(process.env.YIYANG_PORT || 3080);
const certificate = process.env.YIYANG_TLS_CERT;
const privateKey = process.env.YIYANG_TLS_KEY;
const loopback = address === "127.0.0.1" || address === "::1" || address === "localhost";

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("YIYANG_PORT 必须是有效端口。");
if (Boolean(certificate) !== Boolean(privateKey)) throw new Error("请同时填写 YIYANG_TLS_CERT 和 YIYANG_TLS_KEY。");
if (!loopback && !certificate) throw new Error("局域网账号登录需要 TLS 证书。");

const accounts = openAccounts(resolve(process.env.YIYANG_DATA_DIR || ".yiyang-data"));
const cookie = certificate ? "__Host-yiyang_session" : "yiyang_session";
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", address,
  ...Object.values(networkInterfaces()).flat().map((entry) => entry?.address),
  ...(process.env.YIYANG_ALLOWED_HOSTS || "").split(",").map((host) => host.trim()).filter(Boolean),
]);
const assets = resolve("dist/local-client");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon",
};
const apiLimit = 13_000_000;
// The independent server starts with no provider credentials. Each browser supplies its own.
const config = { LOCAL_SIGNING_KEY: accounts.signingKey };

function respond(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function jsonError(res: ServerResponse, status: number, error: string) {
  return respond(res, status, { error });
}

async function readBody(req: IncomingMessage, limit: number) {
  if (Number(req.headers["content-length"]) > limit) throw new AccountError("上传内容过大。", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  // Keep the socket alive long enough to deliver the size error.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new AccountError("上传内容过大。", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function setSession(res: ServerResponse, token = "") {
  res.setHeader("Set-Cookie", `${cookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? accounts.lifetime : 0}${certificate ? "; Secure" : ""}`);
}

async function serve(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  if (!req.headers.host || !req.url?.startsWith("/") || req.url.startsWith("//")) {
    return jsonError(res, 400, "无效的请求地址。");
  }
  const url = new URL(`${certificate ? "https" : "http"}://${req.headers.host}${req.url}`);
  if (!localHosts.has(url.hostname)) return jsonError(res, 400, "站点主机名未获允许。");
  if (url.pathname.startsWith("/api/")) {
    const token = req.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(cookie + "="))?.slice(cookie.length + 1);
    const user = accounts.authenticate(token);
    const action = url.pathname.split("/").slice(3).join("/");
    if (req.method === "POST" && (req.headers.origin !== url.origin || req.headers["sec-fetch-site"] === "cross-site")) {
      return jsonError(res, 403, "请在衣样工作台内发起请求。");
    }
    if (req.method === "POST" && !/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")) {
      return jsonError(res, 415, "请求格式有误。");
    }
    if (url.pathname.startsWith("/api/auth/")) {
      if (req.method === "GET" && action === "state") return respond(res, 200, { ...accounts.state(), user });
      if (req.method === "POST" && (action === "setup" || action === "login" || action === "register")) {
        const session = await accounts.enter(action, JSON.parse(await readBody(req, 16_384)), req.socket.remoteAddress ?? "unknown");
        if (token) accounts.revoke(token);
        setSession(res, session.token);
        return respond(res, 200, { ...accounts.state(), user: session.user });
      }
      if (req.method === "POST" && action === "logout") {
        if (token) accounts.revoke(token);
        setSession(res);
        return respond(res, 200, { ...accounts.state(), user: null });
      }
      if (!user) return jsonError(res, 401, "请先登录。");
      if (req.method === "POST" && action === "registration") {
        const { open } = JSON.parse(await readBody(req, 2048));
        accounts.setRegistration(user, open);
        return respond(res, 200, accounts.state());
      }
      return jsonError(res, 404, "找不到接口。");
    }
    if (!url.pathname.startsWith("/api/studio/")) return jsonError(res, 404, "找不到接口。");
    if (!user || (req.headers["x-yiyang-account"] && req.headers["x-yiyang-account"] !== user.id)) {
      return jsonError(res, 401, "会话已变更，请重新登录。");
    }
    const billing = accounts.billing;
    if ((action === "settings" || action.startsWith("admin/")) && user.role !== "admin") return jsonError(res,403,"需要管理员权限。");
    if (action === "wardrobe" && req.method === "GET") {
      return respond(res, 200, { items: accounts.wardrobe.list() });
    }
    if (action.startsWith("wardrobe/photo/") && req.method === "GET") {
      const id = z.string().uuid().parse(action.slice("wardrobe/photo/".length));
      const photo = accounts.wardrobe.photo(id);
      if (!photo) return jsonError(res, 404, "参考图已下架。");
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" });
      return res.end(photo);
    }
    if (action === "admin/wardrobe/publish" && req.method === "POST") {
      const id = accounts.wardrobe.publish(JSON.parse(await readBody(req, 2_010_000)));
      return id ? respond(res, 201, { id }) : jsonError(res, 409, "公共衣橱已满，请先下架旧参考图。");
    }
    if (action === "admin/wardrobe/remove" && req.method === "POST") {
      const { id } = z.object({ id: z.string().uuid() }).parse(JSON.parse(await readBody(req, 2048)));
      return accounts.wardrobe.remove(id) ? respond(res, 200, { ok: true }) : jsonError(res, 404, "参考图已下架。");
    }
    if (action === "admin/users" && req.method === "GET") return respond(res,200,{ users:billing.users() });
    if (action === "admin/balance" && req.method === "POST") {
      billing.adjust(user.id,JSON.parse(await readBody(req,2048))); return respond(res,200,{ok:true});
    }
    if (action === "admin/refund" && req.method === "POST") {
      billing.refundPending(user.id,z.string().uuid().parse(JSON.parse(await readBody(req,2048)).id));
      return respond(res,200,{ok:true});
    }
    if (action === "admin/prices" && req.method === "POST") {
      billing.setPrices(JSON.parse(await readBody(req,2048))); return respond(res,200,{ok:true});
    }
    if (action === "usage" && req.method === "GET") {
      const offset = z.coerce.number().int().min(0).max(100000000).parse(url.searchParams.get("offset") || 0);
      return respond(res,200,{balance:billing.balance(user.id), prices:billing.prices(), logs:billing.logs(user.role==="admin"?null:user.id,offset)});
    }
    if (action === "live/observed" && req.method === "POST") {
      const data=z.object({id:z.string().uuid(),seconds:z.number().int().min(0).max(120)}).parse(JSON.parse(await readBody(req,2048)));
      billing.observed(user.id,data.id,data.seconds); return respond(res,200,{ok:true});
    }
    if (action === "settings") {
      if (req.method === "POST") accounts.saveProviders(user, JSON.parse(await readBody(req, 24_576)), Boolean(certificate));
      else if (req.method !== "GET") return jsonError(res, 405, "请求方法不受支持。");
      const providers = Object.fromEntries(Object.entries(accounts.getProviders(user)).map(([kind, { key, ...fields }]) =>
        [kind, { ...fields, hasKey: Boolean(key) }]));
      return respond(res, 200, { providers });
    }
    const providers = accounts.sharedProviders();
    if (req.method === "GET" && action === "status") {
      return respond(res, 200, { local: true, design: Boolean(providers.design), live: Boolean(providers.live),
        tryOn: Boolean(providers.photo), video: Boolean(providers.video), liveProvider: providers.live ? {url:providers.live.url,model:providers.live.model} : null, prices:billing.prices() });
    }
    if (!["design","try-on","try-on/status","live/token","video","video/status","video/content"].includes(action)) return jsonError(res,404,"找不到接口。");
    const body = req.method === "POST" ? await readBody(req, apiLimit) : undefined;
    const headers = new Headers({ "oai-authenticated-user-id": user.id });
    for (const name of ["content-type", "origin", "sec-fetch-site"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const provider = action.startsWith("try-on") ? providers.photo : action.startsWith("live/")
      ? providers.live : action.startsWith("video") ? providers.video : providers.design;
    const cancelToken = action === "live/token" ? new AbortController() : undefined;
    if (cancelToken) {
      res.once("close", () => cancelToken.abort());
      if (res.destroyed) return;
    }
    if (!provider) return jsonError(res,503,"管理员尚未配置此服务。");
    if (req.method !== "POST") return jsonError(res,405,"请求方法不受支持。");
    const input = JSON.parse(body || "{}") ?? {};
    const billable: Partial<Record<string,Service>> = {design:"design","try-on":"photo",video:"video","live/token":"live"};
    const kind = Object.hasOwn(billable,action) ? billable[action] : undefined;
    const units = kind==="live" ? z.number().int().min(1).max(120).parse(input.seconds) : 1;
    const id = z.string().uuid().parse(req.headers["idempotency-key"] || randomUUID());
    let jobId: string | undefined;
    if (action==="video/status" || action==="video/content") jobId=billing.job(user.id,"video",z.string().parse(input.id));
    if (action==="try-on/status") jobId=billing.job(user.id,"photo",z.string().parse(input.token));
    if (kind) billing.reserve(user.id,kind,units,id,input.rate);
    let result: Response;
    try {
      result = await handleStudio(new Request(url, { method: req.method, headers, body, signal: cancelToken?.signal }), config, {
      local: true, authorized: true, liveSeconds:units, provider: provider ? { ...provider, key: provider.key ?? "" } : undefined,
    });
    if (kind) {
      const data=(result.ok ? await result.clone().json() : {}) as {image?:string;id?:string;token?:string;apiKey?:string};
      billing.settle(id,!result.ok || (kind==="design" && !data.image),data.id ?? data.token ?? null);
      if (result.ok && kind==="live") result=Response.json({...data,usageId:id},{headers:{"Cache-Control":"no-store"}});
    } else if (jobId && action.endsWith("/status")) {
      const data=await result.clone().json() as {status?:string;image?:string};
      if (result.ok && (data.status==="completed" || data.image)) billing.settle(jobId,false);
      else if ((action==="try-on/status" && result.status===422) || ["failed","cancelled","canceled","expired"].includes(data.status ?? "")) billing.settle(jobId,true);
    }
    } catch(error) {
      if (kind) billing.settle(id,true);
      throw error;
    }
    if (res.destroyed) return;
    res.writeHead(result.status, Object.fromEntries(result.headers));
    if (!result.body) return res.end();
    const stream = Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0]);
    res.on("close", () => stream.destroy());
    stream.on("error", () => res.destroy());
    return stream.pipe(res);
  }

  if (req.method !== "GET" && req.method !== "HEAD") return jsonError(res, 405, "请求方法不受支持。");
  const path = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = resolve(assets, "." + path);
  if (!file.startsWith(assets + sep)) return jsonError(res, 404, "找不到页面。");
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return jsonError(res, 404, "找不到页面。");
  res.writeHead(200, {
    "Content-Type": types[extname(file)] || "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(file);
  res.on("close", () => stream.destroy());
  stream.on("error", () => res.destroy());
  return stream.pipe(res);
}

await stat(resolve(assets, "index.html"));
const handler = (req: IncomingMessage, res: ServerResponse) => {
  void serve(req, res).catch((error) => {
    if (res.headersSent) res.destroy();
    else if (error instanceof z.ZodError) jsonError(res,400,"请求参数无效。");
    else if (error instanceof AccountError || error instanceof BillingError) jsonError(res, error.status, error.message);
    else if (error instanceof SyntaxError) jsonError(res, 400, "请求内容格式有误。");
    else {
      console.warn("本地服务请求失败", error instanceof Error ? error.name : "unknown");
      jsonError(res, 500, "本地服务暂时无法处理请求。");
    }
  });
};
const server = certificate && privateKey
  ? createTlsServer({ cert: await readFile(certificate), key: await readFile(privateKey) }, handler)
  : createServer(handler);

server.listen(port, address, () => {
  const scheme = certificate ? "https" : "http";
  const hosts = address === "0.0.0.0"
    ? [...new Set(Object.values(networkInterfaces()).flat()
      .filter((entry) => entry?.family === "IPv4").map((entry) => entry!.address))]
    : [address.includes(":") ? `[${address}]` : address];
  for (const host of hosts) console.log(`衣样 · ${scheme}://${host}:${port}/`);
  const bootstrap = accounts.bootstrap();
  if (bootstrap) console.log(process.env.YIYANG_SETUP_TOKEN
    ? "首次启动请在页面输入 YIYANG_SETUP_TOKEN 并设置管理员账号。"
    : `首次管理员初始化口令 · ${bootstrap}`);
});
