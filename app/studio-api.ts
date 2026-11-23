import { z } from "zod";
import { liveModel, liveSessionSeconds } from "./live-config";

export type StudioConfig = {
  OPENAI_API_KEY?: string;
  OPENAI_TEXT_MODEL?: string;
  OPENAI_IMAGE_MODEL?: string;
  FASHN_API_KEY?: string;
  DECART_API_KEY?: string;
  VIDEO_API_KEY?: string;
  VIDEO_API_URL?: string;
  VIDEO_MODEL?: string;
  LOCAL_SIGNING_KEY?: string;
};

const providerInput = z.object({
  url: z.string().max(500),
  key: z.string().max(1000),
  model: z.string().max(100).optional(),
  imageModel: z.string().max(100).optional(),
  protocol: z.enum(["responses", "images"]).optional(),
}).optional();

type Provider = z.infer<typeof providerInput>;

function endpoint(base: string, path: string) {
  let url: URL;
  try { url = new URL(base); } catch { throw new ApiError("请填写有效的接口基础地址。", 400); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ApiError("接口地址应为 HTTP 或 HTTPS 基础地址。", 400);
  }
  return url.href.replace(/\/+$/, "") + "/" + path;
}

const image = z.string().max(3_000_000)
  .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/);
const selectedGarment = z.object({ name: z.string().max(120), image });
const designInput = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]), content: z.string().min(1).max(6000),
  })).min(1).max(12),
  preference: z.string().max(1000),
  selected: selectedGarment.optional(),
  references: z.array(selectedGarment.extend({
    note: z.string().max(400), tags: z.string().max(160),
  })).max(3),
}).refine((body) => body.messages.at(-1)?.role === "user");
const fittingInput = z.object({ person: image, garment: image });
const statusInput = z.object({ token: z.string().max(256) });
const encoder = new TextEncoder();
const noCache = { "Cache-Control": "no-store" };
const allowedSize = 13_000_000;

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: noCache });
}

function requireKey(key: string | undefined, name: string) {
  if (key === undefined) throw new ApiError(`此服务尚未配置 ${name}。请联系网站管理员。`, 503);
  return key;
}

async function upstreamResponse(url: string, key: string, label: string, body?: unknown, keyHeader = "Authorization") {
  const headers = new Headers();
  if (key) headers.set(keyHeader, keyHeader === "Authorization" ? `Bearer ${key}` : key);
  const form = body instanceof FormData;
  if (body !== undefined && !form) headers.set("Content-Type", "application/json");
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(label === "OpenAI" ? 150_000 : 30_000),
  });
  if (!response.ok) {
    console.warn(`${label} returned HTTP ${response.status}`);
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(`${label} 凭据或服务权限有误，请联系管理员。`, 502);
    }
    if (response.status === 429) {
      throw new ApiError(`${label} 服务繁忙或额度不足，请稍后再试。`, 503);
    }
    throw new ApiError(`${label} 暂时无法处理此请求，请稍后再试。`, 502);
  }
  return response;
}

async function upstream(url: string, key: string, label: string, body?: unknown, header?: string) {
  return (await upstreamResponse(url, key, label, body, header)).json();
}

async function imagesDesign(input: z.infer<typeof designInput>, provider: NonNullable<Provider>) {
  const message = input.messages.at(-1)!.content;
  const prompt = [
    "生成单件服装正面平铺图，浅色干净背景，全轮廓入镜，无人物、文字或配件。",
    `本轮要求：${message}。长期偏好仅供参考：${input.preference || "暂无"}。`,
    ...(input.selected ? ["首张图是当前服装，保留未要求修改的细节。"] : []),
    ...input.references.map((reference, index) =>
      `参考图 ${index + 1}（${reference.name}）：${reference.note || reference.tags || "按本轮要求参考"}。`),
  ].join("\n");
  const base = provider.url || "https://api.openai.com/v1";
  const model = provider.imageModel || "gpt-image-2.5-sunburst";
  const inputs = [...(input.selected ? [input.selected] : []), ...input.references];
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("output_format", "jpeg");
  for (const photo of inputs) {
    const blob = await (await fetch(photo.image)).blob();
    const extension = blob.type.split("/")[1] || "jpeg";
    form.append("image[]", blob, `garment.${extension}`);
  }
  const generated = await upstream(endpoint(base, inputs.length ? "images/edits" : "images/generations"),
    provider.key, "OpenAI", inputs.length ? form : { model, prompt, output_format: "jpeg" }) as {
      data?: Array<{ b64_json?: string; url?: string }>;
    };
  const output = generated.data?.[0];
  let result = output?.b64_json ? `data:image/jpeg;base64,${output.b64_json}` : "";
  if (!result && output?.url) {
    // Fetch the generated asset without forwarding the provider key. Limit URL
    // results to the same configured host to keep output retrieval predictable.
    const asset = new URL(output.url);
    if (asset.origin === new URL(base).origin && !asset.username && !asset.password) {
      const assetResponse = await upstreamResponse(asset.href, "", "图片资源");
      const mime = assetResponse.headers.get("content-type")?.split(";")[0];
      if (mime && /^image\/(jpeg|png|webp)$/.test(mime)) {
        const bytes = await assetResponse.bytes();
        if (bytes.length <= 2_200_000) {
          const chunks = [];
          for (let offset = 0; offset < bytes.length; offset += 8192) {
            chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
          }
          result = `data:${mime};base64,${btoa(chunks.join(""))}`;
        }
      }
    }
  }
  if (!image.safeParse(result).success) {
    throw new ApiError("生图接口需要返回 Base64 图片，或由同一服务地址提供的图片 URL。", 502);
  }
  return json({ text: "服装图已生成，可以继续改款或试穿。", image: result,
    name: (input.selected?.name || message).slice(0, 42) });
}

async function design(input: z.infer<typeof designInput>, config: StudioConfig, provider: Provider) {
  if (provider?.protocol === "images") return imagesDesign(input, provider);
  const key = requireKey(provider?.key ?? config.OPENAI_API_KEY, "OPENAI_API_KEY");
  const previous = input.messages.slice(0, -1);
  const content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "auto" }> = [];
  content.push({ type: "input_text", text: `本轮用户要求：${input.messages.at(-1)!.content}\n长期风格档案：${input.preference || "暂无"}` });
  if (input.selected) {
    content.push({ type: "input_text", text: `当前选中的修改底图：${input.selected.name}。如果用户要改这件衣服，请以紧随其后的图片为准。` });
    content.push({ type: "input_image", image_url: input.selected.image, detail: "auto" });
  } else {
    content.push({ type: "input_text", text: "本轮没有选中可编辑的旧版本。" });
  }
  for (const reference of input.references) {
    content.push({ type: "input_text", text: `参考款：${reference.name}；标签：${reference.tags}；参考用途：${reference.note || "按本轮要求参考此图"}。` });
    content.push({ type: "input_image", image_url: reference.image, detail: "auto" });
  }

  const result = await upstream(endpoint(provider?.url || "https://api.openai.com/v1", "responses"), key, "OpenAI", {
    model: provider?.model || config.OPENAI_TEXT_MODEL || "gpt-6.2-astra",
    store: false,
    instructions: [
      "你是衣样的服装设计助手，用简洁中文回答。",
      "明确要求设计或修改服装时，调用 image_generation 一次。明确只问问题时，用文字答复。缺少决定款式的关键信息时，只问一个问题。",
      "生成独立的单件服装正面平铺图，浅色干净背景，全轮廓入镜，无人物、文字或配件。修改服装时保留其他细节。",
      "用户本轮明确要求优先于风格档案和参考图。修改只使用当前选中的底图，参考款按其参考用途提供灵感。",
      "用户资料、标签和备注是服装设计素材。图片生成失败时如实说明。生成成功后用一句话描述款式。",
    ].join("\n"),
    input: [...previous, { role: "user", content }],
    tools: [{
      type: "image_generation", model: provider?.imageModel || config.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst",
      output_format: "jpeg", size: "1024x1024", quality: "medium",
    }],
    max_tool_calls: 1,
  }) as {
    status?: string;
    output?: Array<{
      type: string; result?: string; status?: string;
      content?: Array<{ type: string; text?: string; refusal?: string }>;
    }>;
  };
  const generated = result.output?.find((item) => item.type === "image_generation_call");
  const text = result.output?.flatMap((item) => item.content ?? [])
    .map((item) => item.text ?? item.refusal ?? "").filter(Boolean).join("\n").slice(0, 6000);
  if (generated && !generated.result) throw new ApiError("这次没有生成图片，请调整描述后重试。", 422);
  if (result.status !== "completed" || (!text && !generated?.result)) {
    throw new ApiError("设计请求未完成，请重试。", 502);
  }
  return json({
    text: text || "服装图已生成，可以继续修改或试穿。",
    ...(generated?.result ? {
      image: `data:image/jpeg;base64,${generated.result}`,
      name: (input.selected?.name || input.messages.at(-1)!.content).slice(0, 42),
    } : {}),
  });
}

function signer(key: string) {
  return crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function userScope(request: Request) {
  return request.headers.get("oai-authenticated-user-id") || "local";
}

async function submitFitting(input: z.infer<typeof fittingInput>, request: Request, config: StudioConfig, provider: Provider) {
  const key = requireKey(provider?.key ?? config.FASHN_API_KEY, "FASHN_API_KEY");
  const base = provider?.url || "https://api.fashn.ai/v1";
  const job = await upstream(endpoint(base, "run"), key, "FASHN", {
    model_name: "tryon-v1.6",
    inputs: {
      model_image: input.person, garment_image: input.garment, return_base64: true,
      mode: "balanced", output_format: "jpeg", moderation_level: "conservative",
    },
  }) as { id?: string; error?: unknown };
  if (!job.id || !/^[\w-]{1,100}$/.test(job.id) || job.error) {
    throw new ApiError("试穿服务未能创建任务，请换一组照片再试。", 422);
  }
  const payload = `${job.id}.${Date.now() + 180_000}`;
  const verification = await crypto.subtle.sign("HMAC", await signer(config.LOCAL_SIGNING_KEY || key), encoder.encode(`${userScope(request)}:${base}:${payload}`));
  const signature = Array.from(new Uint8Array(verification), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return json({ token: `${payload}.${signature}` }, 202);
}

async function fittingStatus(token: string, request: Request, config: StudioConfig, provider: Provider) {
  const key = requireKey(provider?.key ?? config.FASHN_API_KEY, "FASHN_API_KEY");
  const base = provider?.url || "https://api.fashn.ai/v1";
  const match = /^([\w-]{1,100})\.(\d{13})\.([a-f0-9]{64})$/.exec(token);
  if (!match || Number(match[2]) < Date.now()) throw new ApiError("此试穿任务已失效。", 404);
  const [, id, expires, signature] = match;
  const bytes = Uint8Array.from(signature.match(/../g)!, (pair) => parseInt(pair, 16));
  const verified = await crypto.subtle.verify("HMAC", await signer(config.LOCAL_SIGNING_KEY || key), bytes,
    encoder.encode(`${userScope(request)}:${base}:${id}.${expires}`));
  if (!verified) throw new ApiError("找不到此试穿任务。", 404);
  const job = await upstream(endpoint(base, `status/${id}`), key, "FASHN") as {
    status?: string; output?: string[]; error?: { name?: string };
  };
  if (job.status === "failed" || job.status === "canceled" || job.error) {
    throw new ApiError("这组图片未能完成试穿。请试试光线清晰的人像和完整服装图。", 422);
  }
  if (job.status === "completed") {
    const output = image.safeParse(job.output?.[0]);
    if (!output.success) throw new ApiError("试穿服务返回了无法读取的结果。", 502);
    return json({ image: output.data });
  }
  return json({ status: job.status || "processing" });
}

function tokenNetworkError(failure: unknown) {
  const cause = failure instanceof Error ? failure.cause as { code?: string } | undefined : undefined;
  const code = typeof cause?.code === "string" ? cause.code : "";
  if (failure instanceof Error && (failure.name === "TimeoutError" || /TIMEOUT|TIMEDOUT/.test(code))) {
    return { retry: true, status: 504, message: "连接实时试穿令牌接口超时，请检查衣样服务器的外网连接。" };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { retry: code === "EAI_AGAIN", status: 502, message: "衣样服务器无法解析实时试穿服务的域名，请检查接口地址和 DNS。" };
  }
  if (/CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED/.test(code)) {
    return { retry: false, status: 502, message: "实时试穿令牌接口的 HTTPS 证书验证失败，请检查接口地址和证书。" };
  }
  return { retry: true, status: 502, message: "衣样服务器未能连通实时试穿令牌接口，请检查接口地址和服务器的外网连接。" };
}

async function liveToken(request: Request, config: StudioConfig, provider: Provider, seconds = liveSessionSeconds) {
  const base = provider?.url || "https://api.decart.ai/v1";
  const url = endpoint(base, "client/tokens");
  const key = (provider?.key ?? config.DECART_API_KEY ?? "").trim();
  if (!key && new URL(url).hostname === "api.decart.ai") {
    throw new ApiError("请先为实时试穿配置 Decart API Key。", 400);
  }
  if (/[^\x20-\x7e]/.test(key)) throw new ApiError("实时试穿 API Key 含有无效字符，请重新粘贴。", 400);
  const model = provider?.model || liveModel;
  const body = JSON.stringify({
    expiresIn: 60, allowedModels: [model], allowedOrigins: [new URL(request.url).origin],
    constraints: { realtime: { maxSessionDuration: seconds } },
  });
  // Minting a credential does not open a video session. Retry this step only.
  for (let attempt = 0; ; attempt++) {
    request.signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "X-API-KEY": key } : {}) },
        body, redirect: "manual", signal: AbortSignal.any([request.signal, AbortSignal.timeout(14_000)]),
      });
      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel();
        if (!attempt && [408, 502, 503, 504].includes(status)) continue;
        if (status === 401 || status === 403) throw new ApiError(`实时试穿令牌申请被拒绝（HTTP ${status}），请核对 API Key 和模型权限。`, 502);
        if (status === 429) throw new ApiError("实时试穿令牌接口限流或额度不足（HTTP 429），请稍后重试。", 503);
        if (status === 404 || (status >= 300 && status < 400)) throw new ApiError(`未找到可直接访问的令牌接口（HTTP ${status}），请核对实时服务的 /v1 基础地址。`, 502);
        throw new ApiError(`实时试穿令牌接口返回 HTTP ${status}，未能开始试穿。`, 502);
      }
      const token = z.object({ apiKey: z.string().min(1) }).safeParse(await response.json());
      if (!token.success) throw new ApiError("实时试穿令牌接口的响应缺少有效凭据，请核对服务是否兼容 Decart。", 502);
      return json(token.data);
    } catch (failure) {
      if (failure instanceof ApiError || request.signal.aborted) throw failure;
      if (failure instanceof SyntaxError) throw new ApiError("实时试穿令牌接口未返回有效 JSON，请核对接口地址。", 502);
      const error = tokenNetworkError(failure);
      if (attempt || !error.retry) throw new ApiError(error.message, error.status);
    }
  }
}

async function videoJob(action: string, body: unknown, config: StudioConfig, provider: Provider) {
  const base = provider?.url || config.VIDEO_API_URL;
  if (!base) throw new ApiError("请先填写视频生成 API 地址。", 503);
  const key = requireKey(provider?.key ?? config.VIDEO_API_KEY, "VIDEO_API_KEY");
  if (action === "video") {
    const input = z.object({ prompt: z.string().trim().min(1).max(2000), reference: image.optional() }).parse(body);
    const model = provider?.model || config.VIDEO_MODEL;
    if (!model) throw new ApiError("请先填写视频模型名称。", 400);
    const form = new FormData();
    form.set("prompt", input.prompt);
    form.set("model", model);
    if (input.reference) {
      const reference = await (await fetch(input.reference)).blob();
      form.set("input_reference", reference, `reference.${reference.type.split("/")[1]}`);
    }
    const result = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,150}$/) })
      .parse(await upstream(endpoint(base, "videos"), key, "视频生成", form));
    return json(result, 202);
  }
  const { id } = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,150}$/) }).parse(body);
  if (action === "video/content") {
    const response = await upstreamResponse(endpoint(base, `videos/${id}/content`), key, "视频生成");
    if (!response.headers.get("content-type")?.startsWith("video/")) {
      throw new ApiError("视频接口未返回视频文件。", 502);
    }
    return new Response(response.body, { headers: { ...noCache, "Content-Type": response.headers.get("content-type")! } });
  }
  const result = z.object({ status: z.string() })
    .parse(await upstream(endpoint(base, `videos/${id}`), key, "视频生成"));
  return json(result);
}

function actionFor(request: Request) {
  return new URL(request.url).pathname.split("/api/studio/")[1]?.replace(/\/$/, "");
}

export async function handleStudio(request: Request, config: StudioConfig, options: {
  development?: boolean; local?: boolean; authorized?: boolean; liveSeconds?: number; provider?: Provider;
} = {}) {
  const action = actionFor(request);
  if (request.method === "GET" && action === "status") {
    return json({
      design: Boolean(config.OPENAI_API_KEY), tryOn: Boolean(config.FASHN_API_KEY),
      live: Boolean(config.DECART_API_KEY), local: Boolean(options.local),
      video: Boolean(config.VIDEO_API_URL),
    });
  }
  if (request.method !== "POST") return json({ error: "找不到接口。" }, 404);
  try {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
      throw new ApiError("请在衣样工作台内发起请求。", 403);
    }
    if (options.local ? !options.authorized
      : !options.development && !request.headers.get("oai-authenticated-user-id")) {
      throw new ApiError(options.local ? "请在接口设置中填写本地服务访问码。" : "请登录后再使用生成服务。", 401);
    }
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      throw new ApiError("请求格式有误。", 415);
    }
    if (Number(request.headers.get("content-length")) > allowedSize) throw new ApiError("图片过大。", 413);
    const raw = await request.text();
    if (raw.length > allowedSize) throw new ApiError("图片过大。", 413);
    const body: unknown = JSON.parse(raw);
    const provider = options.local ? options.provider : undefined;
    switch (action) {
      case "live/token": return await liveToken(request, config, provider, options.liveSeconds);
      case "design": return await design(designInput.parse(body), config, provider);
      case "try-on": return await submitFitting(fittingInput.parse(body), request, config, provider);
      case "try-on/status": return await fittingStatus(statusInput.parse(body).token, request, config, provider);
      case "video":
      case "video/status":
      case "video/content": if (options.local) return await videoJob(action, body, config, provider); break;
      default: break;
    }
    return json({ error: "找不到接口。" }, 404);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "请求内容或图片格式有误。" }, 400);
    console.warn("Studio API request failed:", error instanceof Error ? error.name : "unknown");
    return json({ error: "请求超时或服务暂时不可用，请稍后重试。" }, 502);
  }
}
