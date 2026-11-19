/**
 * Mario Party 3 Web — 4-Player Star-Topology Deterministic Lockstep Engine
 * ========================================================================
 * - Host = Slot 1 (P1), Guests = Slots 2..4 (P2..P4)
 * - Per-peer hybrid transport:
 *     * Primary: Direct WebRTC P2P DataChannel (unordered, 0 retransmits, 0 CF DO quota)
 *     * Automatic Fallback: Cloudflare Durable Object WebSocket relay with smart 2-frame
 *       batching (100% CGNAT-proof, zero port forwarding, zero credit card)
 * - Authoritative 4-slot Host Bundle packets (16 bytes/frame for all 4 N64 controllers)
 * - Hot-join compressed savestate sync (CompressionStream gzip, 16 KiB chunks)
 * - Background-tab lockstep keepalive so alt-tabbing to Discord doesn't freeze the room
 */

(function () {
  "use strict";

  // Outer Worker/Server framing
  const FRAME_RELAY = 0x01;
  const FRAME_ROOM_STATE = 0x02;
  const FRAME_UPDATE_ROOM = 0x03;
  const FRAME_REJECTED = 0xff;

  // Inner peer packet types
  const PKT_READY = 0x10;
  const PKT_RTC_SIGNAL = 0x11;
  const PKT_STATE_START = 0x20;
  const PKT_STATE_CHUNK = 0x21;
  const PKT_STATE_ACK = 0x22;
  const PKT_LOCKSTEP_GO = 0x23;
  const PKT_GUEST_INPUT = 0x30;
  const PKT_HOST_BUNDLE = 0x31;
  const PKT_HEARTBEAT = 0x40;

  const STATE_CHUNK_SIZE = 16384; // 16 KiB chunks
  const RTC_ICE_SERVERS = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
  ];

  async function gzipCompress(u8) {
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(u8);
    writer.close();
    const res = new Response(cs.readable);
    return new Uint8Array(await res.arrayBuffer());
  }

  async function gzipDecompress(u8) {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(u8);
    writer.close();
    const res = new Response(ds.readable);
    return new Uint8Array(await res.arrayBuffer());
  }

  function createNetEngine(opts) {
    const {
      getRelayBaseUrl,
      getCoreName,
      isEmulatorReady,
      captureSaveState,
      loadSaveState,
      sampleLocalInput,
      applyPortInput,
      resetAllPorts,
      stepOneFrame,
      getCoreFrameCount,
      onStatusChange,
      onSyncProgress,
      onToast,
      onCoreMismatch,
    } = opts;

    const urlParams = new URLSearchParams(window.location.search);
    const forceNoWebRTC = urlParams.get("webrtc") === "0";

    let ws = null;
    let roomId = null;
    let roomName = "";
    let roomCore = "";
    let mySlot = 0; // 0 = offline, 1 = Host, 2..4 = Guest
    let activeSlots = [];

    let inputDelay = 3; // Default 3 frames (50ms)
    let lockstepActive = false;
    let syncInProgress = false;
    let driftWarning = false;

    // Lockstep frame counters & buffers
    let netFrame = 0;
    let lastScheduledFrame = 0;
    let lastCommittedBundleFrame = 0;
    let highestReceivedBundleFrame = 0;
    let lastSendMs = 0;
    let lastRafMs = performance.now();

    // Smart WS relay batching trackers (2-frame batching without odd/even stall bugs)
    const lastWsSentBundleFrame = { 2: -1, 3: -1, 4: -1 };
    let lastWsSentGuestFrame = -1;

    // Host state
    const peerInputs = { 1: new Map(), 2: new Map(), 3: new Map(), 4: new Map() };
    const bundles = new Map();
    const guestReportedFrame = { 2: 0, 3: 0, 4: 0 };
    const readyGuests = new Set();
    const syncedGuests = new Set();
    const ackedSyncGuests = new Set();
    let currentSyncId = 0;
    let syncTimeoutTimer = null;

    // Guest state
    const guestLocalInputs = new Map();
    let hostReportedFrame = 0;
    let incomingSync = null;

    // Per-peer WebRTC links
    const rtcLinks = new Map();

    // Telemetry / drift check
    let lastHeartbeatFrame = 0;
    let baseCoreFrameCount = 0;
    const peerHashes = new Map();
    let localInputDigest = 0x811c9dc5;

    // Background-tab keepalive pump: prevents Chromium's rAF throttling on alt-tab from freezing lockstep
    setInterval(() => {
      if (!isEmulatorReady() || !lockstepActive || syncInProgress || mySlot === 0) return;
      if (performance.now() - lastRafMs < 32) return;
      if (stepOneFrame) stepOneFrame();
    }, 16);

    function getTransportSummary() {
      if (mySlot === 0) return { mode: "solo", peers: {} };
      const peers = {};
      if (mySlot === 1) {
        for (const s of activeSlots) {
          if (s === 1) continue;
          const link = rtcLinks.get(s);
          peers[s] = link && link.rtcOpen ? "p2p" : "relay";
        }
      } else {
        const link = rtcLinks.get(1);
        peers[1] = link && link.rtcOpen ? "p2p" : "relay";
      }
      return {
        mode: mySlot === 1 ? "host" : "guest",
        roomId,
        roomName,
        mySlot,
        activeSlots: [...activeSlots],
        syncedSlots: mySlot === 1 ? [1, ...syncedGuests] : activeSlots,
        lockstepActive,
        syncInProgress,
        inputDelay,
        netFrame,
        driftWarning,
        peers,
      };
    }

    function emitStatus() {
      if (onStatusChange) onStatusChange(getTransportSummary());
    }

    function sendWsRelay(targetSlot, innerBytes) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      const out = new Uint8Array(2 + innerBytes.length);
      out[0] = FRAME_RELAY;
      out[1] = targetSlot & 0xff;
      out.set(innerBytes, 2);
      ws.send(out);
      return true;
    }

    function sendReliableJson(targetSlot, pktType, obj) {
      const jsonBytes = new TextEncoder().encode(JSON.stringify(obj || {}));
      const inner = new Uint8Array(1 + jsonBytes.length);
      inner[0] = pktType;
      inner.set(jsonBytes, 1);
      return sendWsRelay(targetSlot, inner);
    }

    function isPeerP2P(slot) {
      const link = rtcLinks.get(slot);
      return Boolean(link && link.rtcOpen && link.dc && link.dc.readyState === "open");
    }

    function sendFastToSlot(targetSlot, innerBytes) {
      const link = rtcLinks.get(targetSlot);
      if (link && link.rtcOpen && link.dc && link.dc.readyState === "open") {
        try {
          link.dc.send(innerBytes);
          return "p2p";
        } catch (_) {}
      }
      sendWsRelay(targetSlot, innerBytes);
      return "relay";
    }

    function closeRtcLink(slot) {
      const link = rtcLinks.get(slot);
      if (!link) return;
      rtcLinks.delete(slot);
      try { link.dc?.close(); } catch (_) {}
      try { link.pc?.close(); } catch (_) {}
    }

    function closeAllRtcLinks() {
      for (const s of [...rtcLinks.keys()]) closeRtcLink(s);
    }

    function ensureRtcLink(peerSlot, isInitiator) {
      if (forceNoWebRTC) return;
      if (rtcLinks.has(peerSlot)) return;

      const pc = new RTCPeerConnection({ iceServers: RTC_ICE_SERVERS });
      const entry = { pc, dc: null, rtcOpen: false };
      rtcLinks.set(peerSlot, entry);

      const bindDc = (dc) => {
        entry.dc = dc;
        dc.binaryType = "arraybuffer";
        dc.onopen = () => {
          entry.rtcOpen = true;
          emitStatus();
          onToast?.(`⚡ P${peerSlot} upgraded to Direct WebRTC P2P`);
        };
        dc.onclose = () => {
          entry.rtcOpen = false;
          emitStatus();
        };
        dc.onerror = () => {
          entry.rtcOpen = false;
          emitStatus();
        };
        dc.onmessage = (ev) => {
          if (ev.data instanceof ArrayBuffer) {
            handleInnerPacket(peerSlot, new Uint8Array(ev.data));
          }
        };
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          sendReliableJson(peerSlot, PKT_RTC_SIGNAL, {
            type: "ice",
            candidate: ev.candidate.toJSON(),
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          entry.rtcOpen = false;
          emitStatus();
        }
      };

      if (isInitiator) {
        const dc = pc.createDataChannel("mp3-lockstep", {
          ordered: false,
          maxRetransmits: 0,
        });
        bindDc(dc);
        pc.createOffer()
          .then((offer) => pc.setLocalDescription(offer))
          .then(() => {
            sendReliableJson(peerSlot, PKT_RTC_SIGNAL, {
              type: "offer",
              sdp: pc.localDescription,
            });
          })
          .catch(() => {});
      } else {
        pc.ondatachannel = (ev) => bindDc(ev.channel);
      }
    }

    async function handleRtcSignal(senderSlot, sig) {
      if (forceNoWebRTC) return;
      if (sig.type === "offer") {
        closeRtcLink(senderSlot);
        ensureRtcLink(senderSlot, false);
        const entry = rtcLinks.get(senderSlot);
        if (!entry) return;
        try {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
          const ans = await entry.pc.createAnswer();
          await entry.pc.setLocalDescription(ans);
          sendReliableJson(senderSlot, PKT_RTC_SIGNAL, {
            type: "answer",
            sdp: entry.pc.localDescription,
          });
        } catch (_) {}
      } else if (sig.type === "answer") {
        const entry = rtcLinks.get(senderSlot);
        if (!entry) return;
        try {
          await entry.pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
        } catch (_) {}
      } else if (sig.type === "ice" && sig.candidate) {
        const entry = rtcLinks.get(senderSlot);
        if (!entry) return;
        try {
          await entry.pc.addIceCandidate(new RTCIceCandidate(sig.candidate));
        } catch (_) {}
      }
    }

    function resetLockstepState(newDelay = inputDelay) {
      inputDelay = Math.max(2, Math.min(8, newDelay | 0));
      netFrame = 0;
      lastScheduledFrame = inputDelay;
      lastCommittedBundleFrame = inputDelay;
      highestReceivedBundleFrame = inputDelay;
      hostReportedFrame = 0;
      guestReportedFrame[2] = 0;
      guestReportedFrame[3] = 0;
      guestReportedFrame[4] = 0;
      lastWsSentBundleFrame[2] = -1;
      lastWsSentBundleFrame[3] = -1;
      lastWsSentBundleFrame[4] = -1;
      lastWsSentGuestFrame = -1;
      driftWarning = false;
      localInputDigest = 0x811c9dc5;
      lastHeartbeatFrame = 0;
      baseCoreFrameCount = getCoreFrameCount ? getCoreFrameCount() : 0;
      peerHashes.clear();

      for (let s = 1; s <= 4; s++) peerInputs[s].clear();
      bundles.clear();
      guestLocalInputs.clear();

      for (let f = 0; f <= inputDelay; f++) {
        for (let s = 1; s <= 4; s++) peerInputs[s].set(f, 0);
        bundles.set(f, [0, 0, 0, 0]);
        guestLocalInputs.set(f, 0);
      }

      resetAllPorts();
    }

    function buildGuestInputPacket(currFrame, upToFrame, fullRecovery) {
      const minStart = fullRecovery
        ? Math.max(0, Math.min(hostReportedFrame, upToFrame - 5))
        : Math.max(0, upToFrame - 5);
      const startFrame = Math.max(minStart, upToFrame - 23);
      const count = Math.max(1, Math.min(24, upToFrame - startFrame + 1));

      const buf = new ArrayBuffer(10 + count * 4);
      const view = new DataView(buf);
      view.setUint8(0, PKT_GUEST_INPUT);
      view.setUint32(1, currFrame >>> 0, true);
      view.setUint32(5, startFrame >>> 0, true);
      view.setUint8(9, count);

      let fallback = guestLocalInputs.get(upToFrame) ?? 0;
      for (let i = 0; i < count; i++) {
        const val = guestLocalInputs.get(startFrame + i);
        if (val !== undefined) fallback = val;
        view.setUint32(10 + i * 4, (val !== undefined ? val : fallback) >>> 0, true);
      }
      return new Uint8Array(buf);
    }

    function buildHostBundlePacket(currFrame, startFrame, count) {
      const buf = new ArrayBuffer(10 + count * 16);
      const view = new DataView(buf);
      view.setUint8(0, PKT_HOST_BUNDLE);
      view.setUint32(1, currFrame >>> 0, true);
      view.setUint32(5, startFrame >>> 0, true);
      view.setUint8(9, count);

      for (let i = 0; i < count; i++) {
        const b = bundles.get(startFrame + i) || [0, 0, 0, 0];
        const off = 10 + i * 16;
        view.setUint32(off, b[0] >>> 0, true);
        view.setUint32(off + 4, b[1] >>> 0, true);
        view.setUint32(off + 8, b[2] >>> 0, true);
        view.setUint32(off + 12, b[3] >>> 0, true);
      }
      return new Uint8Array(buf);
    }

    function sendHostBundlesToPeers(forceImmediate = false, targetOnlySlot = 0) {
      if (mySlot !== 1 || syncedGuests.size === 0) return;
      const targets = targetOnlySlot ? [targetOnlySlot] : [...syncedGuests];
      const upTo = lastCommittedBundleFrame;
      if (upTo < 0) return;

      for (const s of targets) {
        if (!syncedGuests.has(s)) continue;
        const p2p = isPeerP2P(s);
        const gFrame = guestReportedFrame[s] || 0;

        // Over CGNAT WS relay: batch 2 frames unless guest is within 1 frame of stalling or forced
        if (!p2p && !forceImmediate) {
          const unsent = upTo - (lastWsSentBundleFrame[s] ?? -1);
          const nearStall = upTo <= gFrame + 1;
          if (unsent < 2 && !nearStall) continue;
        }

        const desiredStart = forceImmediate
          ? Math.max(0, Math.min(gFrame, upTo - 5))
          : Math.max(0, upTo - 5);
        const startFrame = Math.max(desiredStart, upTo - 23);
        const count = Math.max(1, Math.min(24, upTo - startFrame + 1));
        const pkt = buildHostBundlePacket(netFrame, startFrame, count);
        const via = sendFastToSlot(s, pkt);
        if (via === "relay") lastWsSentBundleFrame[s] = upTo;
      }
      lastSendMs = performance.now();
    }

    function tryCommitHostBundles() {
      if (mySlot !== 1) return false;
      let committedAny = false;
      while (true) {
        const nextF = lastCommittedBundleFrame + 1;
        const p1 = peerInputs[1].get(nextF);
        if (p1 === undefined) break;

        let allPresent = true;
        const vec = [p1, 0, 0, 0];
        for (const s of syncedGuests) {
          const val = peerInputs[s].get(nextF);
          if (val === undefined) {
            allPresent = false;
            break;
          }
          vec[s - 1] = val;
        }
        if (!allPresent) break;

        bundles.set(nextF, vec);
        lastCommittedBundleFrame = nextF;
        committedAny = true;
      }
      return committedAny;
    }

    async function hostBroadcastSaveState() {
      if (mySlot !== 1 || !isEmulatorReady() || syncInProgress) return;
      const targets = [...readyGuests].filter((s) => activeSlots.includes(s));
      if (targets.length === 0) {
        onToast?.("No other players ready to sync yet.");
        return;
      }

      try {
        syncInProgress = true;
        lockstepActive = false;
        driftWarning = false;
        currentSyncId = (currentSyncId + 1) & 0xffff;
        if (currentSyncId === 0) currentSyncId = 1;
        ackedSyncGuests.clear();
        syncedGuests.clear();
        for (const t of targets) syncedGuests.add(t);
        emitStatus();
        onSyncProgress?.("Capturing N64 hardware state...", 10);

        const rawState = captureSaveState();
        if (!rawState) {
          syncInProgress = false;
          onSyncProgress?.(null, 0);
          emitStatus();
          onToast?.("⚠️ Couldn't capture N64 state yet — wait a moment.");
          return;
        }

        // Re-load the exact captured savestate on Host so Host & Guests start identically
        loadSaveState(rawState);
        resetLockstepState(inputDelay);

        onSyncProgress?.(`Compressing ${(rawState.byteLength / 1048576).toFixed(1)} MiB N64 state...`, 25);
        const compressed = await gzipCompress(rawState);
        const totalChunks = Math.ceil(compressed.byteLength / STATE_CHUNK_SIZE);

        const startMeta = {
          syncId: currentSyncId,
          rawSize: rawState.byteLength,
          compressedSize: compressed.byteLength,
          totalChunks,
          inputDelay,
          activeSlots: [1, ...targets],
        };
        for (const t of targets) {
          sendReliableJson(t, PKT_STATE_START, startMeta);
        }

        for (let idx = 0; idx < totalChunks; idx++) {
          if (!syncInProgress || mySlot !== 1) return;
          const slice = compressed.subarray(idx * STATE_CHUNK_SIZE, (idx + 1) * STATE_CHUNK_SIZE);
          const inner = new Uint8Array(5 + slice.byteLength);
          inner[0] = PKT_STATE_CHUNK;
          inner[1] = currentSyncId & 0xff;
          inner[2] = (currentSyncId >> 8) & 0xff;
          inner[3] = idx & 0xff;
          inner[4] = (idx >> 8) & 0xff;
          inner.set(slice, 5);
          for (const t of targets) {
            sendWsRelay(t, inner);
          }
          if ((idx & 7) === 7 || idx === totalChunks - 1) {
            const pct = 30 + Math.round(((idx + 1) / totalChunks) * 65);
            onSyncProgress?.(`Streaming state to ${targets.length} player(s)... ${pct}%`, pct);
            await new Promise((r) => setTimeout(r, 4));
          }
        }

        onSyncProgress?.("Waiting for guests to apply state...", 96);
        clearTimeout(syncTimeoutTimer);
        syncTimeoutTimer = setTimeout(() => {
          if (!syncInProgress) return;
          for (const s of [...syncedGuests]) {
            if (!ackedSyncGuests.has(s)) syncedGuests.delete(s);
          }
          finishHostSync();
        }, 18000);
      } catch (err) {
        console.error("[MP3Net] State sync failed:", err);
        syncInProgress = false;
        onSyncProgress?.(null, 0);
        emitStatus();
        onToast?.("⚠️ State sync failed — click Sync Now to retry.");
      }
    }

    function finishHostSync() {
      clearTimeout(syncTimeoutTimer);
      syncInProgress = false;
      onSyncProgress?.(null, 0);
      if (syncedGuests.size === 0) {
        lockstepActive = false;
        emitStatus();
        return;
      }
      lockstepActive = true;
      const goPayload = {
        syncId: currentSyncId,
        inputDelay,
        activeSlots: [1, ...syncedGuests],
      };
      for (const s of syncedGuests) {
        sendReliableJson(s, PKT_LOCKSTEP_GO, goPayload);
      }
      emitStatus();
      onToast?.(`✅ ${syncedGuests.size + 1}-Player Lockstep Active!`);
    }

    async function handleGuestStateComplete() {
      const inc = incomingSync;
      incomingSync = null;
      if (!inc) return;
      try {
        onSyncProgress?.("Applying Host N64 state...", 92);
        const merged = new Uint8Array(inc.compressedSize);
        let offset = 0;
        for (let i = 0; i < inc.totalChunks; i++) {
          merged.set(inc.chunks[i], offset);
          offset += inc.chunks[i].byteLength;
        }
        const raw = await gzipDecompress(merged);
        loadSaveState(raw);
        resetLockstepState(inc.inputDelay);
        sendReliableJson(1, PKT_STATE_ACK, { syncId: inc.syncId });
        onSyncProgress?.("Waiting for Host go-signal...", 98);
      } catch (err) {
        console.error("[MP3Net] Failed to load host savestate:", err);
        syncInProgress = false;
        onSyncProgress?.(null, 0);
        emitStatus();
        onToast?.("⚠️ Failed to apply Host state.");
      }
    }

    function handleInnerPacket(senderSlot, inner) {
      if (!inner || inner.length === 0) return;
      const pktType = inner[0];

      if (pktType === PKT_RTC_SIGNAL) {
        try {
          const sig = JSON.parse(new TextDecoder().decode(inner.subarray(1)));
          handleRtcSignal(senderSlot, sig);
        } catch (_) {}
        return;
      }

      if (pktType === PKT_READY && mySlot === 1) {
        readyGuests.add(senderSlot);
        ensureRtcLink(senderSlot, true);
        if (isEmulatorReady() && !syncInProgress) {
          setTimeout(() => hostBroadcastSaveState(), 250);
        }
        return;
      }

      if (pktType === PKT_STATE_START && mySlot > 1 && senderSlot === 1) {
        try {
          const meta = JSON.parse(new TextDecoder().decode(inner.subarray(1)));
          syncInProgress = true;
          lockstepActive = false;
          incomingSync = {
            syncId: meta.syncId,
            rawSize: meta.rawSize,
            compressedSize: meta.compressedSize,
            totalChunks: meta.totalChunks,
            inputDelay: meta.inputDelay || 3,
            received: 0,
            chunks: new Array(meta.totalChunks),
          };
          emitStatus();
          onSyncProgress?.(
            `Receiving Host state (${(meta.compressedSize / 1048576).toFixed(2)} MiB)... 0%`,
            5
          );
        } catch (_) {}
        return;
      }

      if (pktType === PKT_STATE_CHUNK && mySlot > 1 && senderSlot === 1 && incomingSync) {
        if (inner.length < 5) return;
        const sid = inner[1] | (inner[2] << 8);
        const idx = inner[3] | (inner[4] << 8);
        if (sid !== incomingSync.syncId || idx >= incomingSync.totalChunks) return;
        if (!incomingSync.chunks[idx]) {
          incomingSync.chunks[idx] = inner.slice(5);
          incomingSync.received++;
          if ((incomingSync.received & 7) === 0 || incomingSync.received === incomingSync.totalChunks) {
            const pct = Math.round((incomingSync.received / incomingSync.totalChunks) * 88);
            onSyncProgress?.(`Receiving Host state... ${pct}%`, pct);
          }
          if (incomingSync.received >= incomingSync.totalChunks) {
            handleGuestStateComplete();
          }
        }
        return;
      }

      if (pktType === PKT_STATE_ACK && mySlot === 1) {
        try {
          const ack = JSON.parse(new TextDecoder().decode(inner.subarray(1)));
          if (ack.syncId === currentSyncId && syncedGuests.has(senderSlot)) {
            ackedSyncGuests.add(senderSlot);
            let allAcked = true;
            for (const s of syncedGuests) {
              if (!ackedSyncGuests.has(s)) {
                allAcked = false;
                break;
              }
            }
            if (allAcked) finishHostSync();
          }
        } catch (_) {}
        return;
      }

      if (pktType === PKT_LOCKSTEP_GO && mySlot > 1 && senderSlot === 1) {
        try {
          const go = JSON.parse(new TextDecoder().decode(inner.subarray(1)));
          inputDelay = go.inputDelay || inputDelay;
          syncInProgress = false;
          lockstepActive = true;
          driftWarning = false;
          onSyncProgress?.(null, 0);
          emitStatus();
          onToast?.(`🎮 Joined as Player ${mySlot} — Lockstep Active!`);
        } catch (_) {}
        return;
      }

      if (pktType === PKT_GUEST_INPUT && mySlot === 1 && syncedGuests.has(senderSlot)) {
        if (inner.length < 10) return;
        const view = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
        const gCurr = view.getUint32(1, true);
        const startF = view.getUint32(5, true);
        const count = view.getUint8(9);
        if (gCurr > (guestReportedFrame[senderSlot] || 0)) {
          guestReportedFrame[senderSlot] = gCurr;
        }
        const map = peerInputs[senderSlot];
        for (let i = 0; i < count; i++) {
          const off = 10 + i * 4;
          if (off + 4 > inner.byteLength) break;
          const f = startF + i;
          if (!map.has(f)) {
            map.set(f, view.getUint32(off, true));
          }
        }
        if (tryCommitHostBundles()) {
          sendHostBundlesToPeers(false);
        }
        return;
      }

      if (pktType === PKT_HOST_BUNDLE && mySlot > 1 && senderSlot === 1) {
        if (inner.length < 10) return;
        const view = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
        const hCurr = view.getUint32(1, true);
        const startF = view.getUint32(5, true);
        const count = view.getUint8(9);
        if (hCurr > hostReportedFrame) hostReportedFrame = hCurr;

        for (let i = 0; i < count; i++) {
          const off = 10 + i * 16;
          if (off + 16 > inner.byteLength) break;
          const f = startF + i;
          if (!bundles.has(f)) {
            bundles.set(f, [
              view.getUint32(off, true),
              view.getUint32(off + 4, true),
              view.getUint32(off + 8, true),
              view.getUint32(off + 12, true),
            ]);
          }
          if (f > highestReceivedBundleFrame) highestReceivedBundleFrame = f;
        }
        return;
      }

      if (pktType === PKT_HEARTBEAT) {
        try {
          const hb = JSON.parse(new TextDecoder().decode(inner.subarray(1)));
          if (mySlot > 1 && senderSlot === 1) {
            peerHashes.set(hb.frame, hb.digest);
          } else if (mySlot === 1 && hb.mismatch) {
            driftWarning = true;
            emitStatus();
          }
        } catch (_) {}
      }
    }

    function handleRoomState(state) {
      const prevSlot = mySlot;
      const prevSlots = new Set(activeSlots);
      roomId = state.room;
      roomName = state.name;
      roomCore = state.core || "";
      mySlot = state.mySlot;
      activeSlots = state.slots || [];

      if (mySlot > 1 && roomCore && getCoreName && roomCore !== getCoreName()) {
        onCoreMismatch?.(roomCore);
      }

      for (const s of [...rtcLinks.keys()]) {
        if (!activeSlots.includes(s)) closeRtcLink(s);
      }

      if (mySlot === 1) {
        for (const s of [...readyGuests]) {
          if (!activeSlots.includes(s)) readyGuests.delete(s);
        }
        for (const s of [...syncedGuests]) {
          if (!activeSlots.includes(s)) {
            syncedGuests.delete(s);
            ackedSyncGuests.delete(s);
            onToast?.(`👋 Player ${s} left the party.`);
          }
        }
        if (syncedGuests.size === 0 && !syncInProgress) {
          lockstepActive = false;
        }
        if (prevSlot > 1) {
          closeAllRtcLinks();
          syncInProgress = false;
          lockstepActive = false;
          onSyncProgress?.(null, 0);
          onToast?.("👑 You are now the Room Host (Player 1)!");
        }
      } else if (mySlot > 1 && prevSlot !== mySlot) {
        if (isEmulatorReady()) {
          sendReliableJson(1, PKT_READY, { core: getCoreName?.() || "" });
        }
      }

      for (const s of activeSlots) {
        if (s !== mySlot && !prevSlots.has(s) && mySlot === 1) {
          onToast?.(`🎉 Player ${s} joined room ${roomId}!`);
        }
      }

      emitStatus();
    }

    function connectToRoom(targetRoomId, options = {}) {
      disconnect();
      const code = String(targetRoomId || "PARTY1")
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, "")
        .slice(0, 16) || "PARTY1";

      const base = getRelayBaseUrl();
      const wsProto = base.startsWith("https://") ? "wss://" : "ws://";
      const wsHost = base.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const qs = new URLSearchParams({
        room: code,
        core: getCoreName?.() || "mupen64plus_next",
      });
      if (options.name) qs.set("name", options.name);
      if (options.create) qs.set("create", "1");

      const wsUrl = `${wsProto}${wsHost}/ws?${qs.toString()}`;
      ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        onToast?.(`🌐 Connected to room ${code}`);
      };

      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(ev.data);
        if (bytes.length === 0) return;

        const frameType = bytes[0];
        if (frameType === FRAME_ROOM_STATE) {
          try {
            const st = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
            handleRoomState(st);
          } catch (_) {}
        } else if (frameType === FRAME_RELAY && bytes.length >= 3) {
          const senderSlot = bytes[1];
          handleInnerPacket(senderSlot, bytes.subarray(2));
        } else if (frameType === FRAME_REJECTED) {
          const reason = new TextDecoder().decode(bytes.subarray(1));
          onToast?.(`❌ ${reason || "Could not join room"}`);
          disconnect();
        }
      };

      ws.onclose = () => {
        if (mySlot !== 0) {
          onToast?.("🔌 Disconnected from online room.");
        }
        cleanupLocalSession();
      };

      ws.onerror = () => {
        onToast?.("⚠️ Relay connection error.");
      };
    }

    function cleanupLocalSession() {
      clearTimeout(syncTimeoutTimer);
      closeAllRtcLinks();
      ws = null;
      roomId = null;
      roomName = "";
      mySlot = 0;
      activeSlots = [];
      readyGuests.clear();
      syncedGuests.clear();
      ackedSyncGuests.clear();
      syncInProgress = false;
      lockstepActive = false;
      driftWarning = false;
      incomingSync = null;
      onSyncProgress?.(null, 0);
      emitStatus();
    }

    function disconnect() {
      if (ws) {
        const old = ws;
        ws = null;
        try { old.close(); } catch (_) {}
      }
      cleanupLocalSession();
    }

    function notifyEmulatorBooted() {
      if (mySlot > 1 && ws && ws.readyState === WebSocket.OPEN) {
        sendReliableJson(1, PKT_READY, { core: getCoreName?.() || "" });
      } else if (mySlot === 1 && readyGuests.size > 0 && !syncInProgress) {
        setTimeout(() => hostBroadcastSaveState(), 250);
      }
    }

    function setInputDelay(frames) {
      inputDelay = Math.max(2, Math.min(8, Number(frames) || 3));
      emitStatus();
    }

    function mixDigest(frame, vec) {
      let h = localInputDigest ^ frame;
      for (let i = 0; i < 4; i++) {
        h ^= vec[i];
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      localInputDigest = h >>> 0;
    }

    function applyBundleAndAdvance(f, vec) {
      for (let p = 0; p < 4; p++) {
        applyPortInput(p, vec[p]);
      }
      mixDigest(f, vec);

      if (f > 0 && f - lastHeartbeatFrame >= 180) {
        lastHeartbeatFrame = f;
        const relCoreF = ((getCoreFrameCount ? getCoreFrameCount() : 0) - baseCoreFrameCount) >>> 0;
        const digest = (localInputDigest ^ relCoreF) >>> 0;
        if (mySlot === 1) {
          for (const s of syncedGuests) {
            sendReliableJson(s, PKT_HEARTBEAT, { frame: f, digest });
          }
        } else if (mySlot > 1 && peerHashes.has(f)) {
          const hostDigest = peerHashes.get(f);
          peerHashes.delete(f);
          if (hostDigest !== digest) {
            driftWarning = true;
            sendReliableJson(1, PKT_HEARTBEAT, { frame: f, mismatch: true });
            emitStatus();
          }
        }
      }

      if (f > 240) {
        bundles.delete(f - 240);
        for (let s = 1; s <= 4; s++) peerInputs[s].delete(f - 240);
        guestLocalInputs.delete(f - 240);
      }

      netFrame = f + 1;
    }

    function onPreMainLoop() {
      lastRafMs = performance.now();
      if (!isEmulatorReady()) return true;

      // Offline / Solo / Host waiting for guests
      if (mySlot === 0 || (mySlot === 1 && !syncInProgress && syncedGuests.size === 0)) {
        applyPortInput(0, sampleLocalInput(0, true));
        applyPortInput(1, sampleLocalInput(1, false));
        applyPortInput(2, sampleLocalInput(2, false));
        applyPortInput(3, sampleLocalInput(3, false));
        return true;
      }

      if (syncInProgress || !lockstepActive) {
        return false;
      }

      const f = netFrame;
      const targetFrame = f + inputDelay;

      if (mySlot === 1) {
        if (lastScheduledFrame < targetFrame) {
          const localPacked = sampleLocalInput(0, true);
          for (let sf = lastScheduledFrame + 1; sf <= targetFrame; sf++) {
            peerInputs[1].set(sf, localPacked);
          }
          lastScheduledFrame = targetFrame;
          if (tryCommitHostBundles()) {
            sendHostBundlesToPeers(false);
          }
        }

        const bundle = bundles.get(f);
        if (!bundle) {
          if (performance.now() - lastSendMs > 20) {
            sendHostBundlesToPeers(true);
          }
          return false;
        }

        applyBundleAndAdvance(f, bundle);

        // Host catch-up step if bundles are already queued ahead of us
        if (
          lastCommittedBundleFrame - netFrame >= inputDelay + 2 &&
          bundles.has(netFrame) &&
          stepOneFrame
        ) {
          const nf = netFrame;
          const nextTarget = nf + inputDelay;
          if (lastScheduledFrame < nextTarget) {
            const localPacked = sampleLocalInput(0, true);
            for (let sf = lastScheduledFrame + 1; sf <= nextTarget; sf++) {
              peerInputs[1].set(sf, localPacked);
            }
            lastScheduledFrame = nextTarget;
            if (tryCommitHostBundles()) sendHostBundlesToPeers(false);
          }
          applyBundleAndAdvance(nf, bundles.get(nf));
          stepOneFrame();
        }
        return true;
      } else {
        if (lastScheduledFrame < targetFrame) {
          const localPacked = sampleLocalInput(0, true);
          for (let sf = lastScheduledFrame + 1; sf <= targetFrame; sf++) {
            guestLocalInputs.set(sf, localPacked);
          }
          lastScheduledFrame = targetFrame;

          const p2p = isPeerP2P(1);
          const unsent = targetFrame - lastWsSentGuestFrame;
          const nearStall = targetFrame <= hostReportedFrame + inputDelay;
          if (p2p || unsent >= 2 || nearStall) {
            const pkt = buildGuestInputPacket(f, targetFrame, false);
            const via = sendFastToSlot(1, pkt);
            if (via === "relay") lastWsSentGuestFrame = targetFrame;
            lastSendMs = performance.now();
          }
        }

        const bundle = bundles.get(f);
        if (!bundle) {
          if (performance.now() - lastSendMs > 20) {
            const pkt = buildGuestInputPacket(f, lastScheduledFrame, true);
            const via = sendFastToSlot(1, pkt);
            if (via === "relay") lastWsSentGuestFrame = lastScheduledFrame;
            lastSendMs = performance.now();
          }
          return false;
        }

        applyBundleAndAdvance(f, bundle);

        if (
          highestReceivedBundleFrame - netFrame >= inputDelay + 2 &&
          bundles.has(netFrame) &&
          stepOneFrame
        ) {
          const nf = netFrame;
          const nextTarget = nf + inputDelay;
          if (lastScheduledFrame < nextTarget) {
            const localPacked = sampleLocalInput(0, true);
            for (let sf = lastScheduledFrame + 1; sf <= nextTarget; sf++) {
              guestLocalInputs.set(sf, localPacked);
            }
            lastScheduledFrame = nextTarget;
          }
          applyBundleAndAdvance(nf, bundles.get(nf));
          stepOneFrame();
        }

        return true;
      }
    }

    return {
      connectToRoom,
      disconnect,
      hostBroadcastSaveState,
      notifyEmulatorBooted,
      setInputDelay,
      onPreMainLoop,
      getStatus: getTransportSummary,
    };
  }

  window.MP3Net = { createNetEngine };
})();
