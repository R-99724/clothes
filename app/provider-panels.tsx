"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Clapperboard, LoaderCircle, Sparkles, Upload } from "lucide-react";
import {
  defaultProviders, fetchProviders, providerRequest,
  type Provider, type ProviderKind, type Providers,
} from "./provider-settings";
import { imageData, readImage } from "./studio-data";

const legacyKey = "yiyang-provider-settings";

const services = [
  ["design", "对话与生图", "Responses 支持对话和生图。Images 只生成或编辑服装图。"],
  ["live", "实时视频试穿", "填写兼容 Decart 的 API 基础地址，地址应以 /v1 结尾。"],
  ["photo", "静态照片试穿", "填写兼容 FASHN 的基础地址，例如 https://api.fashn.ai/v1。"],
  ["video", "短视频生成", "填写支持 OpenAI Videos 协议的基础地址和模型。"],
] as const;

function legacyProviders(): Providers {
  try {
    const raw = sessionStorage.getItem(legacyKey);
    const data = raw ? (JSON.parse(raw) as { providers?: Providers }).providers : undefined;
    return Object.fromEntries(services.flatMap(([kind]) => typeof data?.[kind]?.url === "string"
      && typeof data[kind]?.key === "string" ? [[kind, data[kind]]] : []));
  } catch { return {}; }
}

export function SettingsPanel({ onSave }: { onSave: (providers: Providers) => void }) {
  const [active, setActive] = useState<Providers>({});
  const [ready, setReady] = useState(false);
  const [oldSettings, setOldSettings] = useState(false);
  const [imported, setImported] = useState(false);
  const [drafts, setDrafts] = useState(defaultProviders);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchProviders().then((saved) => {
      if (!mounted) return;
      setActive(saved);
      setDrafts({ ...defaultProviders, ...Object.fromEntries(Object.entries(saved).map(([kind, value]) => [kind, { ...value, key: "" }])) });
      setReady(true);
      setOldSettings(Object.keys(saved).length === 0 && Object.keys(legacyProviders()).length > 0);
    }).catch((error) => { if (mounted) setMessage(error.message); });
    return () => { mounted = false; };
  }, []);

  function update(kind: ProviderKind, next: Partial<Provider>) {
    setDrafts((current) => ({ ...current, [kind]: { ...current[kind], ...next } }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const settings: Providers = {};
      for (const [kind, title] of services) {
        if (!active[kind]) continue;
        const item = drafts[kind];
        const url = new URL(item.url.trim());
        if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
          throw new Error(`${title}需要 HTTP 或 HTTPS 基础地址，且不包含查询参数或账号密码。`);
        }
        if (kind === "live" && (!url.pathname.replace(/\/+$/, "").endsWith("/v1") || (location.protocol === "https:" && url.protocol !== "https:"))) {
          throw new Error("实时试穿需要以 /v1 结尾的地址。HTTPS 页面需要 HTTPS 实时服务。");
        }
        if (kind === "video" && !item.model?.trim()) throw new Error("请输入短视频模型名称。");
        settings[kind] = { url: url.href.replace(/\/+$/, ""), key: item.key?.trim() || "",
          model: item.model?.trim(), imageModel: item.imageModel?.trim(), protocol: item.protocol, clearKey: item.clearKey };
      }
      const response = await providerRequest("settings", settings);
      const result = await response.json() as { error?: string; providers?: Providers };
      if (!response.ok) throw new Error(result.error || "本地服务访问校验失败。");
      if (!result.providers) throw new Error("保存结果有误，请重新进入页面核对。");
      setActive(result.providers);
      setDrafts({ ...defaultProviders, ...Object.fromEntries(Object.entries(result.providers).map(([kind, value]) => [kind, { ...value, key: "" }])) });
      if (imported) {
        try { sessionStorage.removeItem(legacyKey); } catch { /* Browser storage may be disabled. */ }
        setOldSettings(false);
        setImported(false);
      }
      onSave(result.providers);
      setMessage("已保存，所有用户的新请求将使用此配置。");
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <div className="page-head"><div><h1>接口设置</h1><p>统一管理全站的服务地址、密钥和模型。</p></div></div>
    <form className="provider-form" onSubmit={save}>
      <p className="muted">设置对所有账号生效。已保存的密钥以状态提示显示，留空可沿用同一地址的密钥。</p>
      {oldSettings && !imported && <button className="secondary" type="button" onClick={() => {
        const old = legacyProviders();
        setActive(old);
        setDrafts({ ...defaultProviders, ...old });
        setImported(true);
        setMessage("已载入旧配置，请核对后保存到当前账号。");
      }}>导入此标签页的旧设置</button>}
      <div className="provider-grid">
        {services.map(([kind, title, description]) => <section className="panel provider-card" key={kind}>
          <div className="provider-title"><h2>{title}</h2><label className="provider-switch"><input type="checkbox" checked={Boolean(active[kind])}
            onChange={(event) => setActive((items) => ({ ...items, [kind]: event.target.checked ? drafts[kind] : undefined }))} /> 自定义</label></div>
          <p className="muted">{description}</p>
          {active[kind] && <div className="provider-fields">
            {kind === "design" && <label>协议<select value={drafts.design.protocol} onChange={(event) => update("design", { protocol: event.target.value === "images" ? "images" : "responses" })}>
              <option value="responses">OpenAI Responses · 对话与生图</option><option value="images">OpenAI Images · 直接生图与改图</option>
            </select></label>}
            <label>API 基础地址<input type="url" required value={drafts[kind].url} onChange={(event) => update(kind, { url: event.target.value })} placeholder="https://example.com/v1" /></label>
            <label>API Key<input type="password" value={drafts[kind].key || ""} onChange={(event) => update(kind, { key: event.target.value, clearKey: false })}
              autoComplete="off" placeholder={drafts[kind].hasKey ? "已保存密钥，留空保留" : "服务无需认证时可留空"} /></label>
            {drafts[kind].hasKey && <label className="provider-switch"><input type="checkbox" checked={Boolean(drafts[kind].clearKey)}
              onChange={(event) => update(kind, { clearKey: event.target.checked, key: "" })} /> 清除已保存的密钥</label>}
            {kind !== "photo" && (kind !== "design" || drafts.design.protocol !== "images") && <label>{kind === "design" ? "对话模型" : "模型名称"}
              <input value={drafts[kind].model || ""} onChange={(event) => update(kind, { model: event.target.value })} /></label>}
            {kind === "design" && <label>生图模型<input value={drafts.design.imageModel || ""} onChange={(event) => update(kind, { imageModel: event.target.value })} /></label>}
          </div>}
        </section>)}
      </div>
      <button className="primary" disabled={saving || !ready}>{saving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />} 保存接口设置</button>
      {message && <p className="muted" role="status">{message}</p>}
    </form>
  </>;
}

export function VideoPanel({ image }: { image?: string }) {
  const [prompt, setPrompt] = useState("");
  const [reference, setReference] = useState("");
  const [video, setVideo] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const upload = useRef<HTMLInputElement>(null);

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => () => { if (video) URL.revokeObjectURL(video); }, [video]);

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (busy || !prompt.trim()) return;
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    async function call(path: string, data: unknown) {
      const response = await providerRequest(path, data, signal);
      if (!response.ok) {
        const error = await response.json() as { error?: string };
        throw new Error(error.error || "视频服务暂时不可用。");
      }
      return response;
    }
    setBusy(true);
    setVideo("");
    setStatus("正在提交视频任务…");
    try {
      const job = await (await call("video", { prompt: prompt.trim(), reference: reference ? await imageData(reference) : undefined })).json() as { id: string };
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline && !signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const { status: phase } = await (await call("video/status", { id: job.id })).json() as { status: string };
        if (phase === "completed") {
          const file = await (await call("video/content", { id: job.id })).blob();
          if (!signal.aborted) {
            setVideo(URL.createObjectURL(file));
            setStatus("视频生成完成");
          }
          return;
        }
        if (["failed", "canceled", "cancelled", "expired"].includes(phase)) throw new Error("视频服务未能完成任务。");
        setStatus(phase === "queued" ? "视频正在排队…" : "正在生成视频…");
      }
      if (!signal.aborted) throw new Error("等待超时，服务端任务可能还在处理。");
    } catch (failure) {
      if (!signal.aborted) setStatus(failure instanceof Error ? failure.message : "视频生成失败。");
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  return <>
    <div className="page-head"><div><h1>视频生成</h1><p>用文字和可选的服装参考图生成一段视频。</p></div></div>
    <div className="design-grid">
      <form className="panel provider-form" onSubmit={generate}>
        <label>视频描述<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} maxLength={2000}
          placeholder="例如，让这件亚麻外套在摄影棚里缓慢转动，展示正面和侧面。" /></label>
        {reference && <img className="video-reference" src={reference} alt="视频参考图" />}
        <div className="preview-actions">
          <input type="file" hidden ref={upload} accept="image/jpeg,image/png,image/webp" onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            try { setReference(await readImage(file)); } catch (error) { setStatus((error as Error).message); }
          }} />
          <button className="secondary" type="button" onClick={() => upload.current?.click()}><Upload size={16} /> 上传参考图</button>
          {image && <button className="secondary" type="button" onClick={() => setReference(image)}>使用当前服装</button>}
          {reference && <button className="text-button" type="button" onClick={() => setReference("")}>移除参考图</button>}
        </div>
        <button className="primary" disabled={busy || !prompt.trim()}>{busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />} 生成视频</button>
        {status && <p className="muted" role="status">{status}</p>}
      </form>
      <section className="panel">
        {video ? <><video controls playsInline className="generated-video" src={video} /><a className="secondary" href={video} download="衣样-视频.mp4">下载视频</a></>
          : <div className="result-empty design-empty"><Clapperboard size={32} /><strong>视频预览</strong></div>}
      </section>
    </div>
  </>;
}
