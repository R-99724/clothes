import { env } from "cloudflare:workers";
import { z } from "zod";

const config = env as typeof env & {
  OPENAI_API_KEY?: string;
  OPENAI_TEXT_MODEL?: string;
  OPENAI_IMAGE_MODEL?: string;
  FASHN_API_KEY?: string;
};

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
  if (!key) throw new ApiError(`此服务尚未配置 ${name}。请联系网站管理员。`, 503);
  return key;
}

async function upstream(url: string, key: string, label: string, body?: unknown) {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(label === "OpenAI" ? 150_000 : 20_000),
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
  return response.json();
}

async function design(input: z.infer<typeof designInput>) {
  const key = requireKey(config.OPENAI_API_KEY, "OPENAI_API_KEY");
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

  const result = await upstream("https://api.openai.com/v1/responses", key, "OpenAI", {
    model: config.OPENAI_TEXT_MODEL || "gpt-6.2-astra",
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
      type: "image_generation", model: config.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst",
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

async function submitFitting(input: z.infer<typeof fittingInput>, request: Request) {
  const key = requireKey(config.FASHN_API_KEY, "FASHN_API_KEY");
  const job = await upstream("https://api.fashn.ai/v1/run", key, "FASHN", {
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
  const verification = await crypto.subtle.sign("HMAC", await signer(key), encoder.encode(`${userScope(request)}:${payload}`));
  const signature = Array.from(new Uint8Array(verification), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return json({ token: `${payload}.${signature}` }, 202);
}

async function fittingStatus(token: string, request: Request) {
  const key = requireKey(config.FASHN_API_KEY, "FASHN_API_KEY");
  const match = /^([\w-]{1,100})\.(\d{13})\.([a-f0-9]{64})$/.exec(token);
  if (!match || Number(match[2]) < Date.now()) throw new ApiError("此试穿任务已失效。", 404);
  const [, id, expires, signature] = match;
  const bytes = Uint8Array.from(signature.match(/../g)!, (pair) => parseInt(pair, 16));
  const verified = await crypto.subtle.verify("HMAC", await signer(key), bytes,
    encoder.encode(`${userScope(request)}:${id}.${expires}`));
  if (!verified) throw new ApiError("找不到此试穿任务。", 404);
  const job = await upstream(`https://api.fashn.ai/v1/status/${id}`, key, "FASHN") as {
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

function actionFor(request: Request) {
  return new URL(request.url).pathname.split("/api/studio/")[1]?.replace(/\/$/, "");
}

export function GET(request: Request) {
  if (actionFor(request) !== "status") return json({ error: "找不到接口。" }, 404);
  return json({ design: Boolean(config.OPENAI_API_KEY), tryOn: Boolean(config.FASHN_API_KEY) });
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
      throw new ApiError("请在衣样工作台内发起请求。", 403);
    }
    if (!import.meta.env.DEV && !request.headers.get("oai-authenticated-user-id")) {
      throw new ApiError("请登录后再使用生成服务。", 401);
    }
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      throw new ApiError("请求格式有误。", 415);
    }
    if (Number(request.headers.get("content-length")) > allowedSize) throw new ApiError("图片过大。", 413);
    const raw = await request.text();
    if (raw.length > allowedSize) throw new ApiError("图片过大。", 413);
    const body: unknown = JSON.parse(raw);
    switch (actionFor(request)) {
      case "design": return await design(designInput.parse(body));
      case "try-on": return await submitFitting(fittingInput.parse(body), request);
      case "try-on/status": return await fittingStatus(statusInput.parse(body).token, request);
      default: return json({ error: "找不到接口。" }, 404);
    }
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "请求内容或图片格式有误。" }, 400);
    console.warn("Studio API request failed:", error instanceof Error ? error.name : "unknown");
    return json({ error: "请求超时或服务暂时不可用，请稍后重试。" }, 502);
  }
}
