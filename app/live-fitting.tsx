"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { RealTimeClient } from "@decartai/sdk";
import { Camera, CircleHelp, LoaderCircle, Sparkles, Video, VideoOff } from "lucide-react";
import { liveModel, liveSessionSeconds } from "./live-config";
import { monitorLiveQuality } from "./live-quality";
import { providerRequest, studioFetch, type Provider } from "./provider-settings";

type Phase = "off" | "opening" | "preview" | "authorizing" | "connecting" | "live" | "reconnecting";
type GarmentPhoto = { image: string; name: string };

function cameraError(error: unknown) {
  if (!(error instanceof Error)) return "无法启动摄像头。";
  switch (error.name) {
    case "NotAllowedError":
    case "SecurityError": return "浏览器未授予摄像头权限。请在站点设置里允许摄像头，或在独立浏览器标签页打开衣样。";
    case "NotFoundError": return "未找到摄像头。请连接摄像头后重试。";
    case "NotReadableError": return "摄像头无法读取。请关闭占用摄像头的其他应用后重试。";
    default: return error.message;
  }
}

async function referenceImage(garment: GarmentPhoto) {
  const response = await fetch(garment.image);
  if (!response.ok) throw new Error("无法读取服装图，请重新选择。");
  return response.blob();
}

export default function LiveFitting({ garment, configured, provider, children, metered, rate }: {
  metered?: boolean; rate?:number;
  garment: GarmentPhoto | null; configured?: boolean; provider?: Provider; children: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>("off");
  const [error, setError] = useState("");
  const [shownGarment, setShownGarment] = useState<GarmentPhoto | null>(null);
  const [switching, setSwitching] = useState(false);
  const [streamStatus, setStreamStatus] = useState("");
  const [fast, setFast] = useState(false);
  const modelName = provider?.model || liveModel;
  const canUseFast = (!provider || /^https:\/\/api\.decart\.ai\/v1\/?$/.test(provider.url))
    && ["lucy-vton-3.5", "lucy-vton-3.6", "lucy-vton-latest"].includes(modelName);
  const [seconds,setSeconds]=useState(30);
  const receipt=useRef<{id:string;start?:number} | null>(null);
  const raw = useRef<HTMLVideoElement>(null);
  const rendered = useRef<HTMLVideoElement>(null);
  const camera = useRef<MediaStream | null>(null);
  const remote = useRef<RealTimeClient | null>(null);
  const epoch = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);

  const release = useCallback(() => {
    // Invalidate delayed browser permissions, SDK callbacks and garment switches.
    const usage=receipt.current;
    receipt.current=null;
    if (usage) void studioFetch("/api/studio/live/observed",{method:"POST",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({id:usage.id,seconds:usage.start?Math.min(120,Math.ceil((performance.now()-usage.start)/1000)):0})}).catch(()=>{});
    ++epoch.current;
    clearTimeout(timeout.current);
    abort.current?.abort();
    abort.current = null;
    camera.current?.getTracks().forEach((track) => track.stop());
    camera.current = null;
    const active = remote.current;
    remote.current = null;
    if (raw.current) raw.current.srcObject = null;
    if (rendered.current) rendered.current.srcObject = null;
    active?.disconnect();
  }, []);

  const stop = useCallback(() => {
    release();
    setPhase("off");
    setSwitching(false);
    setShownGarment(null);
    setStreamStatus("");
    setFast(false);
  }, [release]);

  useEffect(() => {
    window.addEventListener("pagehide", stop);
    return () => {
      window.removeEventListener("pagehide", stop);
      release();
    };
  }, [release, stop]);

  async function openCamera() {
    if (phase !== "off") return;
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("这里无法使用摄像头。请在支持摄像头的浏览器中打开 HTTPS 页面。");
      return;
    }
    const attempt = ++epoch.current;
    setPhase("opening");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 25, max: 30 } },
      });
      if (epoch.current !== attempt) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      camera.current = stream;
      const [track] = stream.getVideoTracks();
      if (track && "contentHint" in track) track.contentHint = "motion";
      stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => {
        if (camera.current !== stream) return;
        stop();
        setError("摄像头已断开，请重新开启。");
      }, { once: true }));
      if (raw.current) raw.current.srcObject = stream;
      setPhase("preview");
    } catch (failure) {
      if (epoch.current !== attempt) return;
      stop();
      setError(cameraError(failure));
    }
  }

  async function start() {
    const stream = camera.current;
    if (!stream || !garment || phase !== "preview") return;
    if (configured === false) {
      setError("实时试穿尚未配置 Decart 密钥。摄像头预览仍可使用。");
      return;
    }
    const attempt = ++epoch.current;
    const controller = new AbortController();
    abort.current = controller;
    const current = () => epoch.current === attempt;
    let tokenIssued = false;
    const finish = (message: string) => {
      if (!current()) return;
      if (!tokenIssued && stream.active) {
        // No media was published. Keep the preview and selection available for retry.
        ++epoch.current;
        clearTimeout(timeout.current);
        controller.abort();
        abort.current = null;
        setPhase("preview");
      } else {
        stop();
      }
      setError(message);
    };
    setError("");
    setPhase("authorizing");
    timeout.current = setTimeout(() => finish("实时试穿凭据申请超时，可以直接重试。"), 40_000);
    try {
      const [{ createDecartClient, models }, image] = await Promise.all([
        import("@decartai/sdk"), referenceImage(garment),
      ]);
      if (!current()) return;

      const base = provider?.url.replace(/\/+$/, "").replace(/\/v1$/, "");
      const client = createDecartClient({
        ...(base ? { baseUrl: base, realtimeBaseUrl: base.replace(/^http/, "ws") } : {}),
        telemetry: false,
        apiKeyProvider: async () => {
          let response: Response;
          if (metered && tokenIssued) throw new Error("重连需要重新确认积分。");
          try { response = await providerRequest("live/token", metered?{seconds,rate}: {}, controller.signal); }
          catch { throw new Error("浏览器未能连接衣样服务器申请实时试穿凭据，请检查到衣样的网络连接。"); }
          const payload = await response.json() as { apiKey?: string; usageId?:string; error?: string };
          if (!response.ok || !payload.apiKey) throw new Error(payload.error || "无法取得实时试穿凭据。");
          if (!current()) throw new Error("本次试穿已取消。");
          if (!tokenIssued) {
            if(payload.usageId) receipt.current={id:payload.usageId};
            tokenIssued = true;
            setPhase("connecting");
            clearTimeout(timeout.current);
            timeout.current = setTimeout(() => finish("已取得凭据，实时视频连接超时。请检查当前设备到试穿服务的网络连接。"), 45_000);
          }
          return payload.apiKey;
        },
      });

      const connection = await client.realtime.connect(stream, {
        model: models.realtime(modelName as Parameters<typeof models.realtime>[0]),
        initialState: { image },
        // Mirror both previews in CSS so WebRTC can encode the native camera track.
        mirror: false,
        ...(fast && canUseFast ? { speed: "fast" as const } : {}),
        retries: 0,
        onRemoteStream: (output) => {
          if (current() && rendered.current) rendered.current.srcObject = output;
        },
        onConnectionChange: (state) => {
          if (!current()) return;
          if (state === "reconnecting") {
            if (rendered.current) rendered.current.srcObject = null;
            setPhase("reconnecting");
          }
          if (state === "disconnected" && remote.current) finish("实时连接已断开，可以重新开始。");
        },
      });
      if (!current()) { connection.disconnect(); return; }
      remote.current = connection;
      const [track] = stream.getVideoTracks();
      if (track) monitorLiveQuality(connection, track, rendered.current, controller.signal, setStreamStatus);
      connection.on("sessionEnded", () => finish("本次实时试穿已结束，可以重新开始。"));
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => finish("本次实时试穿已结束，可以重新开始。"), (metered?seconds:liveSessionSeconds) * 1000);
      setShownGarment(garment);
    } catch (failure) {
      finish(failure instanceof Error ? failure.message : "无法连接实时试穿，请重试。");
    }
  }

  async function switchGarment() {
    const connection = remote.current;
    if (!connection || !garment || switching) return;
    const attempt = epoch.current;
    setSwitching(true);
    setError("");
    try {
      const image = await referenceImage(garment);
      if (epoch.current !== attempt) return;
      await connection.set({ image });
      if (epoch.current === attempt) setShownGarment(garment);
    } catch {
      if (epoch.current === attempt) setError("未能更换服装，请重试。");
    } finally {
      if (epoch.current === attempt) setSwitching(false);
    }
  }

  const cameraOn = phase !== "off" && phase !== "opening";
  const busy = phase === "authorizing" || phase === "connecting" || phase === "reconnecting";
  const different = garment && shownGarment?.image !== garment.image;

  return <>
    <div className="page-head live-head">
      <div><h1>实时试穿</h1><p>用摄像头照照镜子，看看衣服随动作变化的样子。</p></div>
    </div>
    <div className="live-grid">
      <section className="panel live-stage" aria-label="实时试穿视频">
        <div className="live-videos">
          <div className="live-tile">
            <span className="video-label"><Camera size={14} /> 摄像头原画</span>
            <video ref={raw} autoPlay muted playsInline className={cameraOn ? "visible mirrored" : "mirrored"} aria-label="摄像头原画" />
            {!cameraOn && <div className="video-message"><VideoOff size={32} strokeWidth={1.25} /><strong>摄像头关闭</strong></div>}
          </div>
          <div className="live-tile live-output">
            <span className={`video-label ${phase === "live" ? "live-active" : ""}`}><Sparkles size={14} /> {phase === "live" ? "实时 AI 画面" : "AI 换装"}</span>
            <video ref={rendered} autoPlay muted playsInline className={phase === "live" ? "visible mirrored" : "mirrored"}
              aria-label="AI 试穿视频" onPlaying={() => {
                if (!rendered.current?.srcObject || !camera.current) return;
                if(receipt.current && !receipt.current.start) receipt.current.start=performance.now();
                setPhase("live");
              }} />
            {phase !== "live" && <div className="video-message">
              {busy ? <LoaderCircle className="spin" size={30} /> : <Sparkles size={32} strokeWidth={1.25} />}
              <strong>{phase === "authorizing" ? "正在申请实时试穿凭据" : phase === "reconnecting" ? "正在重新连接" : busy ? "等待第一帧试穿画面" : "试穿视频将显示在这里"}</strong>
            </div>}
          </div>
        </div>
        <div className="live-controls">
          <p>{phase === "live" ? `试穿中 · ${shownGarment?.name ?? garment?.name ?? ""}` : "站远一点，让摄像头看清你想换装的位置。"}</p>
          {phase==="preview" && metered && <label>实时试穿时长 <select value={seconds} onChange={e=>setSeconds(Number(e.target.value))}>{[10,30,60,120].map(n=><option key={n} value={n}>{n} 秒</option>)}</select> · {rate==null?"尚未定价":(seconds*rate)+" 积分"}（签发凭据时按授权时长计费）</label>}
          {phase === "preview" && canUseFast && configured !== false && <label className="live-fast">
            <input type="checkbox" checked={fast} onChange={(event) => setFast(event.target.checked)} />
            云端加速（美国区，双倍积分）
          </label>}
          {phase === "off" ? <button className="primary" onClick={openCamera}><Video size={17} /> 打开摄像头</button> : <>
            <button className="secondary" onClick={stop}><VideoOff size={17} /> {phase === "opening" ? "取消" : "关闭摄像头"}</button>
            {phase === "preview" && <button className="primary" onClick={start} disabled={!garment || configured === false}><Sparkles size={17} /> {error ? "重试实时试穿" : "开始实时试穿"}</button>}
            {phase === "live" && different && <button className="primary" onClick={switchGarment} disabled={switching}><Sparkles size={17} /> {switching ? "正在换装" : "换上这件"}</button>}
          </>}
        </div>
        {phase === "live" && streamStatus && <p className="live-metrics">{streamStatus}</p>}
        {configured === false && <p className="live-notice"><CircleHelp size={16} /> 摄像头预览可用。实时 AI 效果待配置视频试穿服务后开启。</p>}
        {error && <p role="alert" className="inline-error">{error}</p>}
        <p className="live-privacy">开启摄像头仅在本地预览。开始实时试穿后，视频和服装图会发送给 Decart 处理。麦克风保持关闭。</p>
      </section>
      <aside className="panel live-garment">{children}</aside>
    </div>
  </>;
}
