// features/streaming/transport/realtime-webrtc.js
// Implements the TransportController contract: emits events via onEvent({type: ...})

import { getWebRTCAnswerSDP } from "./session-bootstrap.js";

export function createRealtimeWebRTCTransport({ onEvent } = {}) {
  let pc = null;
  let dc = null;
  let micStream = null;
  let audioEl = null;

  function emit(type, extra) {
    try { onEvent?.({ type, ...(extra || {}) }); } catch {}
  }

  async function connect() {
    if (pc) return;

    pc = new RTCPeerConnection();

    // Remote audio playback
    audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.playsInline = true;

    pc.ontrack = (e) => {
      try { audioEl.srcObject = e.streams[0]; } catch {}
    };

    pc.onconnectionstatechange = () => {
      const s = pc?.connectionState || "disconnected";
      if (s === "connected") emit("connected");
      if (s === "failed" || s === "disconnected" || s === "closed") emit("disconnected");
    };

    // Live mic track (always-on for now)
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of micStream.getTracks()) pc.addTrack(t, micStream);

    // Data channel for events + text
    dc = pc.createDataChannel("oai-events");
    dc.addEventListener("open", () => emit("connected"));
    dc.addEventListener("close", () => emit("disconnected"));
    dc.addEventListener("message", (e) => {
      let evt = null;
      try { evt = JSON.parse(e.data); } catch { return; }
      const text = extractAssistantText(evt);
      if (text) emit("assistant_text", { text });
    });

    // SDP exchange via your backend
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const answerSDP = await getWebRTCAnswerSDP(offer.sdp);
    await pc.setRemoteDescription({ type: "answer", sdp: answerSDP });

    emit("connected"); // best-effort so UI doesn't hang
  }

  async function disconnect() {
    try { dc?.close(); } catch {}
    try { pc?.close(); } catch {}

    if (micStream) {
      for (const t of micStream.getTracks()) {
        try { t.stop(); } catch {}
      }
    }

    pc = null;
    dc = null;
    micStream = null;

    try {
      if (audioEl) {
        audioEl.pause();
        audioEl.srcObject = null;
        audioEl.remove();
      }
    } catch {}
    audioEl = null;

    emit("disconnected");
  }

  function sendEvent(evt) {
    if (!dc || dc.readyState !== "open") return false;
    dc.send(JSON.stringify(evt));
    return true;
  }

  async function sendUserText(text) {
    if (!text) return;

    const ok1 = sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });

    const ok2 = sendEvent({ type: "response.create" });

    if (!ok1 || !ok2) throw new Error("Transport not connected");
  }

  // Your current PTT records blobs; WebRTC realtime uses live mic tracks instead.
  async function sendUserAudio({ blob } = {}) {
    const kb = blob ? Math.round(blob.size / 1024) : 0;
    throw new Error(
      `WebRTC transport uses live mic audio (tracks). sendUserAudio(blob) not supported (~${kb} KB).`
    );
  }

  return { connect, disconnect, sendUserText, sendUserAudio };
}

function extractAssistantText(evt) {
  if (!evt || typeof evt !== "object") return "";

  if (typeof evt.delta === "string" && evt.delta) return evt.delta;
  if (typeof evt.text === "string" && evt.text) return evt.text;

  const content = evt?.item?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c.text === "string" && c.text) return c.text;
      if (c && typeof c.transcript === "string" && c.transcript) return c.transcript;
    }
  }
  return "";
}
