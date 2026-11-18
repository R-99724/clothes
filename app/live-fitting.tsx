"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { RealTimeClient } from "@decartai/sdk";
import { Camera, CircleHelp, LoaderCircle, Sparkles, Video, VideoOff } from "lucide-react";
import { liveModel, liveSessionSeconds } from "./live-config";

type Phase = "off" | "opening" | "preview" | "connecting" | "live" | "reconnecting";
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

export default function LiveFitting({ garment, configured, children }: {
  garment: GarmentPhoto | null; configured?: boolean; children: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>("off");
  const [error, setError] = useState("");
  const [shownGarment, setShownGarment] = useState<GarmentPhoto | null>(null);
  const [switching, setSwitching] = useState(false);
  const raw = useRef<HTMLVideoElement>(null);
  const rendered = useRef<HTMLVideoElement>(null);
  const camera = useRef<MediaStream | null>(null);
  const remote = useRef<RealTimeClient | null>(null);
  const epoch = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);

  const release = useCallback(() => {
    // Invalidate delayed browser permissions, SDK callbacks and garment switches.
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
    const finish = (message: string) => {
      if (!current()) return;
      stop();
      setError(message);
    };
    setError("");
    setPhase("connecting");
    timeout.current = setTimeout(() => finish("连接实时服务超时，请重新打开摄像头后再试。"), 45_000);
    try {
      const [{ createDecartClient, models }, image] = await Promise.all([
        import("@decartai/sdk"), referenceImage(garment),
      ]);
      if (!current()) return;

      const client = createDecartClient({
        telemetry: false,
        apiKeyProvider: async () => {
          const response = await fetch("/api/studio/live/token", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: "{}", signal: controller.signal, cache: "no-store",
          });
          const payload = await response.json() as { apiKey?: string; error?: string };
          if (!response.ok || !payload.apiKey) throw new Error(payload.error || "无法取得实时试穿凭据。");
          return payload.apiKey;
        },
      });

      const connection = await client.realtime.connect(stream, {
        model: models.realtime(liveModel),
        initialState: { image },
        mirror: true,
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
      connection.on("sessionEnded", () => finish("本次实时试穿已结束，可以重新开始。"));
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => finish("本次实时试穿已结束，可以重新开始。"), liveSessionSeconds * 1000);
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
  const busy = phase === "connecting" || phase === "reconnecting";
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
            <video ref={rendered} autoPlay muted playsInline className={phase === "live" ? "visible" : ""}
              aria-label="AI 试穿视频" onPlaying={() => {
                if (!rendered.current?.srcObject || !camera.current) return;
                setPhase("live");
              }} />
            {phase !== "live" && <div className="video-message">
              {busy ? <LoaderCircle className="spin" size={30} /> : <Sparkles size={32} strokeWidth={1.25} />}
              <strong>{phase === "reconnecting" ? "正在重新连接" : busy ? "等待第一帧试穿画面" : "试穿视频将显示在这里"}</strong>
            </div>}
          </div>
        </div>
        <div className="live-controls">
          <p>{phase === "live" ? `试穿中 · ${shownGarment?.name ?? garment?.name ?? ""}` : "站远一点，让摄像头看清你想换装的位置。"}</p>
          {phase === "off" ? <button className="primary" onClick={openCamera}><Video size={17} /> 打开摄像头</button> : <>
            <button className="secondary" onClick={stop}><VideoOff size={17} /> {phase === "opening" ? "取消" : "关闭摄像头"}</button>
            {phase === "preview" && <button className="primary" onClick={start} disabled={!garment || configured === false}><Sparkles size={17} /> 开始实时试穿</button>}
            {phase === "live" && different && <button className="primary" onClick={switchGarment} disabled={switching}><Sparkles size={17} /> {switching ? "正在换装" : "换上这件"}</button>}
          </>}
        </div>
        {configured === false && <p className="live-notice"><CircleHelp size={16} /> 摄像头预览可用。实时 AI 效果待配置 Decart 密钥后开启。</p>}
        {error && <p role="alert" className="inline-error">{error}</p>}
        <p className="live-privacy">开启摄像头仅在本地预览。开始实时试穿后，视频和服装图会发送给 Decart 处理。麦克风保持关闭。</p>
      </section>
      <aside className="panel live-garment">{children}</aside>
    </div>
  </>;
}
