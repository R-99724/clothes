import type { RealTimeClient, WebRTCStats } from "@decartai/sdk";

// SDK stats arrive about once a second. Keep short network spikes and initial
// bandwidth probing from changing the camera resolution.
export function monitorLiveQuality(
  connection: RealTimeClient, track: MediaStreamTrack, output: HTMLVideoElement | null, signal: AbortSignal,
  onStatus: (status: string) => void,
) {
  let previous: { timestamp: number; frames: number; packetsReceived: number; playbackDrops?: number } | undefined;
  let warmupUntil = 0;
  let limitedSince: number | undefined;
  let nextLongEdge = 960;
  let adjusting = false;
  const observe = (stats: WebRTCStats) => {
    if (signal.aborted || !stats.video) return;
    const { framesDecoded, freezeCountDelta, packetsReceived, packetsLostDelta } = stats.video;
    const playbackDrops = output?.getVideoPlaybackQuality?.().droppedVideoFrames;
    const last = previous;
    previous = { timestamp: stats.timestamp, frames: framesDecoded, packetsReceived, playbackDrops };
    if (!last || stats.timestamp <= last.timestamp || stats.timestamp - last.timestamp > 5000 || framesDecoded < last.frames) {
      warmupUntil = stats.timestamp + 5000;
      limitedSince = undefined;
      return;
    }
    const fps = Math.round(1000 * (framesDecoded - last.frames) / (stats.timestamp - last.timestamp));
    // The SDK exposes the last second's outbound encode rate, and uses zero
    // when the browser omits it. Only a positive reading is unambiguous.
    const sendFps = stats.outboundVideo?.framesPerSecond;
    const reason = stats.outboundVideo?.qualityLimitationReason;
    const loss = stats.remoteInbound?.fractionLost;
    const uploadLoss = loss != null && loss >= 0.05 && loss <= 1;
    const uploadLimited = reason === "cpu" || reason === "bandwidth" || uploadLoss;
    const { width, height } = track.getSettings();
    const details = [sendFps != null && sendFps > 0 ? `上行 ${Math.round(sendFps)} 帧/秒` : "上行帧率待测", `回传 ${fps} 帧/秒`];
    const rtt = stats.remoteInbound?.roundTripTime ?? stats.connection?.currentRoundTripTime;
    if (rtt != null) details.push(`网络往返 ${Math.round(rtt * 1000)} 毫秒`);
    const latency = stats.glassToGlass?.medianMs;
    if (latency != null) details.push(`端到端 ${Math.round(latency)} 毫秒`);
    if (width && height) details.push(`采集 ${width}×${height}`);
    if (reason === "cpu") details.push("编码受限");
    if (reason === "bandwidth") details.push("上行带宽受限");
    if (uploadLoss) details.push(`上行丢包 ${Math.round(loss * 100)}%`);
    const receivedDelta = packetsReceived - last.packetsReceived;
    if (packetsLostDelta > 0 && receivedDelta >= 0) {
      details.push(`回传丢包 ${packetsLostDelta}/${packetsLostDelta + receivedDelta}`);
    }
    if (playbackDrops != null && last.playbackDrops != null && playbackDrops > last.playbackDrops) {
      details.push(`本地播放丢 ${playbackDrops - last.playbackDrops} 帧`);
    }
    onStatus(details.join(" · "));

    if (stats.timestamp < warmupUntil || !uploadLimited || (fps >= 20 && freezeCountDelta === 0)) {
      limitedSince = undefined;
      return;
    }
    limitedSince ??= stats.timestamp;
    if (stats.timestamp - limitedSince < 2500 || adjusting || !nextLongEdge || !width || !height || !track.applyConstraints) return;
    // Allow a second reduction only if the uplink remains limited after settling.
    const longEdge = Math.max(width, height);
    const target = longEdge > nextLongEdge ? nextLongEdge : 720;
    if (longEdge <= target) return;
    const scale = target / longEdge;
    nextLongEdge = target === 960 ? 720 : 0;
    adjusting = true;
    void track.applyConstraints({
      ...track.getConstraints(),
      width: { ideal: 2 * Math.max(1, Math.round(width * scale / 2)) },
      height: { ideal: 2 * Math.max(1, Math.round(height * scale / 2)) },
    }).catch(() => { /* Fixed-format cameras keep their existing settings. */ }).finally(() => {
      adjusting = false;
      limitedSince = undefined;
      warmupUntil = (previous?.timestamp ?? stats.timestamp) + 8000;
    });
  };
  connection.on("stats", observe);
  signal.addEventListener("abort", () => connection.off("stats", observe), { once: true });
}
