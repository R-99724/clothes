import { liveModel } from "./live-config";

export type Provider = { url: string; key: string; model?: string; imageModel?: string; protocol?: "responses" | "images"; hasKey?: boolean; clearKey?: boolean };
export type ProviderKind = "design" | "live" | "photo" | "video";
export type Providers = Partial<Record<ProviderKind, Provider>>;

export const defaultProviders: Record<ProviderKind, Provider> = {
  design: { url: "https://api.openai.com/v1", key: "", model: "gpt-6.2-astra", imageModel: "gpt-image-2.5-sunburst", protocol: "responses" },
  live: { url: "https://api.decart.ai/v1", key: "", model: liveModel },
  photo: { url: "https://api.fashn.ai/v1", key: "" },
  video: { url: "", key: "", model: "" },
};

let studioAccount: string | undefined;
export function setStudioAccount(id?: string) { studioAccount = id; }

export async function studioFetch(url: string, options?: RequestInit) {
  const headers = new Headers(options?.headers);
  if (studioAccount) headers.set("X-Yiyang-Account", studioAccount);
  const response = await fetch(url, { ...options, headers, cache: "no-store" });
  if (response.status === 401 && url.startsWith("/api/studio/")) window.dispatchEvent(new Event("yiyang-session-expired"));
  return response;
}

export function providerRequest(path: string, body: unknown, signal?: AbortSignal) {
  return studioFetch(`/api/studio/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(body), signal,
  });
}

export async function fetchProviders(): Promise<Providers> {
  const response = await studioFetch("/api/studio/settings");
  const result = await response.json() as { error?: string; providers?: Providers };
  if (!response.ok || !result.providers) throw new Error(result.error || "无法读取接口设置。");
  return result.providers;
}
