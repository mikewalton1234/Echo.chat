// ───────────────────────────────────────────────────────────────────────────────
// WebRTC P2P file transfers (Yahoo-style): try P2P first, then fallback to server.
// Server is used ONLY as signaling relay (offer/answer/ICE), not as a data path.
// ───────────────────────────────────────────────────────────────────────────────
function socketEmitAck(event, data, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`Socket ACK timeout for ${event}`));
    }, timeoutMs);

    socket.emit(event, data, (resp) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(resp);
    });
  });
}

function p2pNewTransferId() {
  // Short, URL-safe id.
  const rnd = Math.random().toString(36).slice(2, 10);
  return `p2p_${Date.now().toString(36)}_${rnd}`;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function p2pMakePc() {
  if (typeof RTCPeerConnection === "undefined") {
    throw new Error("WebRTC not available in this browser.");
  }
  return new RTCPeerConnection({ iceServers: P2P_ICE_SERVERS });
}

async function waitForDataChannelOpen(dc, timeoutMs) {
  if (dc.readyState === "open") return true;
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("DataChannel open timeout"));
    }, timeoutMs);

    dc.addEventListener("open", () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(true);
    }, { once: true });

    dc.addEventListener("error", () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      reject(new Error("DataChannel error"));
    }, { once: true });
  });
}

function p2pSafeClose(transfer_id, why = null) {
  const tr = P2P_TRANSFERS.get(transfer_id);
  if (!tr) return;
  try { if (tr._watchdog) clearTimeout(tr._watchdog); } catch {}
  try { if (tr._watchdogInterval) clearInterval(tr._watchdogInterval); } catch {}
  try { tr.dc && tr.dc.close(); } catch {}
  try { tr.pc && tr.pc.close(); } catch {}
  if (tr.ui && why) tr.ui.setStatus(why);
  P2P_TRANSFERS.delete(transfer_id);
}

async function tryP2PFileTransfer(toUser, meta, arrayBuffer, { ui } = {}) {
  // WebRTC requires a secure context in most browsers.
  if (!window.isSecureContext) return null;
  if (!toUser || !arrayBuffer) return null;

  const transfer_id = p2pNewTransferId();
  const pc = p2pMakePc();
  const dc = pc.createDataChannel("ec_file", { ordered: true });

  dc.binaryType = "arraybuffer";

  const tr = {
    role: "sender",
    peer: toUser,
    transfer_id,
    pc,
    dc,
    ui,
    meta,
    _answerResolve: null,
    _answerReject: null,
    _ackResolve: null,
    _ackReject: null,
  };
  P2P_TRANSFERS.set(transfer_id, tr);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("p2p_file_ice", { to: toUser, transfer_id, candidate: e.candidate });
    }
  };

  // Listen for ack on the datachannel
  const ackPromise = new Promise((resolve, reject) => {
    tr._ackResolve = resolve;
    tr._ackReject = reject;
    const t = setTimeout(() => reject(new Error("P2P transfer timeout")), P2P_FILE_TRANSFER_TIMEOUT_MS);

    dc.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data);
          if (msg && msg.type === "ack" && msg.transfer_id === transfer_id) {
            clearTimeout(t);
            resolve(true);
          }
        } catch {}
      }
    });
  });

  // Offer / Answer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  if (ui) ui.setStatus("Sending P2P offer…");
  const offerResp = await socketEmitAck("p2p_file_offer", {
    to: toUser,
    transfer_id,
    offer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
    meta,
  }).catch(() => null);

  if (!offerResp || offerResp.success === false || offerResp.delivered === false) {
    p2pSafeClose(transfer_id, "Peer offline — fallback to server");
    return null;
  }

  const answerPromise = new Promise((resolve, reject) => {
    tr._answerResolve = resolve;
    tr._answerReject = reject;
    setTimeout(() => reject(new Error("P2P answer timeout")), P2P_FILE_HANDSHAKE_TIMEOUT_MS);
  });

  const answer = await answerPromise;
  await pc.setRemoteDescription(new RTCSessionDescription(answer));

  if (ui) ui.setStatus("Connecting data channel…");
  await waitForDataChannelOpen(dc, P2P_FILE_HANDSHAKE_TIMEOUT_MS);

  // Send metadata first (JSON string), then raw chunks.
  if (ui) ui.setStatus("Sending file (P2P)…");

  dc.send(JSON.stringify({ type: "meta", transfer_id, meta }));

  const total = arrayBuffer.byteLength || 0;
  let sent = 0;

  // Backpressure thresholds
  const MAX_BUFFERED = 8 * 1024 * 1024; // 8MB
  const buf = arrayBuffer;

  for (let off = 0; off < total; off += P2P_FILE_CHUNK_BYTES) {
    const chunk = buf.slice(off, Math.min(off + P2P_FILE_CHUNK_BYTES, total));

    // Simple flow control
    while (dc.bufferedAmount > MAX_BUFFERED) {
      await delay(30);
    }

    dc.send(chunk);
    sent += chunk.byteLength || 0;
    if (ui) ui.setProgress(sent / total);
  }

  dc.send(JSON.stringify({ type: "done", transfer_id }));

  // Wait for receiver ack (assembled)
  await ackPromise;

  if (ui) {
    ui.setProgress(1);
    ui.setStatus("✅ Sent via P2P");
  }

  // Keep the connection around briefly so late ICE doesn't explode.
  setTimeout(() => p2pSafeClose(transfer_id), 1200);

  return {
    kind: "file",
    source: "p2p",
    transfer_id,
    name: meta.name,
    size: meta.size,
    mime: meta.mime,
    sha256: meta.sha256,
  };
}

async function downloadAndDecryptDmFile(fileId, fallbackName) {
  if (!HAS_WEBCRYPTO) throw new Error(`E2EE requires HTTPS (or http://localhost / http://127.0.0.1). Current origin: ${window.location.origin}`);
  const privKey = await ensurePrivateKeyUnlocked();

  const metaResp = await fetchWithAuth(`/api/dm_files/${encodeURIComponent(fileId)}/meta`, {
    method: "GET",
    credentials: "same-origin",
  });
  const meta = await metaResp.json().catch(() => null);
  if (!metaResp.ok || !meta?.success) {
    throw new Error(meta?.error || `Metadata fetch failed (HTTP ${metaResp.status})`);
  }

  const blobResp = await fetchWithAuth(`/api/dm_files/${encodeURIComponent(fileId)}/blob`, {
    method: "GET",
    credentials: "same-origin",
  });
  if (!blobResp.ok) {
    throw new Error(`Blob fetch failed (HTTP ${blobResp.status})`);
  }
  const ctBuf = await blobResp.arrayBuffer();

  const wrappedKeyBuf = bytesFromB64(meta.ek_b64).buffer;
  const rawAesKey = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, privKey, wrappedKeyBuf);
  const aesKey = await window.crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = bytesFromB64(meta.iv_b64);

  const ptBuf = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ctBuf);
  const mime = meta.mime || "application/octet-stream";
  const outBlob = new Blob([ptBuf], { type: mime });
  const filename = meta.name || fallbackName || "file";
  downloadBlob(filename, outBlob);
}


async function downloadAndDecryptGroupFile(fileId, fallbackName, groupId) {
  if (!HAS_WEBCRYPTO) throw new Error(`E2EE requires HTTPS (or http://localhost / http://127.0.0.1). Current origin: ${window.location.origin}`);
  const privKey = await ensurePrivateKeyUnlocked();

  const metaResp = await fetchWithAuth(`/api/group_files/${encodeURIComponent(fileId)}/meta`, {
    method: "GET",
    credentials: "same-origin",
  });
  const meta = await metaResp.json().catch(() => null);
  if (!metaResp.ok || !meta?.success) {
    throw new Error(meta?.error || `Metadata fetch failed (HTTP ${metaResp.status})`);
  }
  if (groupId && Number(meta.group_id) !== Number(groupId)) {
    // Soft guard: the server is authoritative, but keep UI consistent.
    console.warn("Group file meta group_id mismatch", { meta_gid: meta.group_id, expected: groupId });
  }

  const blobResp = await fetchWithAuth(`/api/group_files/${encodeURIComponent(fileId)}/blob`, {
    method: "GET",
    credentials: "same-origin",
  });
  if (!blobResp.ok) {
    throw new Error(`Blob fetch failed (HTTP ${blobResp.status})`);
  }
  const ctBuf = await blobResp.arrayBuffer();

  const wrappedKeyBuf = bytesFromB64(meta.ek_b64).buffer;
  const rawAesKey = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, privKey, wrappedKeyBuf);
  const aesKey = await window.crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = bytesFromB64(meta.iv_b64);

  const ptBuf = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ctBuf);
  const mime = meta.mime || "application/octet-stream";
  const outBlob = new Blob([ptBuf], { type: mime });
  const filename = (meta.name || fallbackName || "file").toString();
  downloadBlob(filename, outBlob);
}

async function decryptLegacyRSA(privKey, cipherB64) {
  const raw = atob(cipherB64);
  const buf = new Uint8Array(raw.split("").map(c => c.charCodeAt(0))).buffer;
  const decryptedBuffer = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, privKey, buf);
  return new TextDecoder().decode(decryptedBuffer);
}

async function decryptHybridEnvelope(privKey, cipherStr) {
  const envJson = atob(cipherStr.slice(PM_ENVELOPE_PREFIX.length));
  let env;
  try { env = JSON.parse(envJson); } catch { throw new Error("Bad PM envelope JSON"); }

  if (!env || env.v !== 1 || env.alg !== "RSA-OAEP+AES-GCM") {
    throw new Error("Unknown PM envelope format");
  }

  const wrappedKeyBuf = bytesFromB64(env.ek).buffer;
  const rawAesKey = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, privKey, wrappedKeyBuf);

  const aesKey = await window.crypto.subtle.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = bytesFromB64(env.iv);
  const ctBuf = bytesFromB64(env.ct).buffer;

  const decryptedBuffer = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ctBuf);
  return new TextDecoder().decode(decryptedBuffer);
}

socket.on("private_message", async ({ sender, cipher }) => {
  const win = openPrivateChat(sender) || UIState.windows.get("dm:" + sender);
  try {
    let plaintext;

    // Plaintext wrapper (compat mode): no E2EE required.
    if (typeof cipher === "string" && cipher.startsWith(PM_PLAINTEXT_PREFIX)) {
      plaintext = unwrapPlainDm(cipher);
    } else {
      const privKey = await ensurePrivateKeyUnlocked();
      if (typeof cipher === "string" && cipher.startsWith(PM_ENVELOPE_PREFIX)) {
        plaintext = await decryptHybridEnvelope(privKey, cipher);
      } else {
        plaintext = await decryptLegacyRSA(privKey, cipher);
      }
    }

    const payload = parseDmPayload(plaintext);
    const w = UIState.windows.get("dm:" + sender);
    if (w) appendDmPayload(w, `${sender}:`, payload, { peer: sender, direction: "in" });

    if (payload.kind === "file") {
      addPmHistory(sender, "in", `📎 ${payload.name} (${humanBytes(payload.size)})`);
    } else if (payload.kind === "torrent") {
      const nm = payload?.t?.name || payload?.t?.infohash || "Torrent";
      addPmHistory(sender, "in", `🧲 ${nm}`);
    } else {
      addPmHistory(sender, "in", payload.text);
    }

    if (payload.kind === "file") {
      toast(`📎 ${sender} sent a file: ${payload.name}`, "info");
      maybeBrowserNotify("File received", `${sender}: ${payload.name}`);
    } else if (payload.kind === "torrent") {
      const nm = payload?.t?.name || payload?.t?.infohash || "Torrent";
      toast(`🧲 ${sender} shared a torrent: ${nm}`, "info");
      maybeBrowserNotify("Torrent shared", `${sender}: ${nm}`);
    } else {
      toast(`📥 New PM from ${sender}`, "info");
      maybeBrowserNotify("Private message", `${sender}: ${payload.text}`);
    }
  } catch (e) {
    console.error("Failed to process PM:", e);
    const w = UIState.windows.get("dm:" + sender);

    const msg = String(e?.message || e || "");
    const low = msg.toLowerCase();

    let sysLine = "PM received but could not decrypt.";
    let toastMsg = `⚠️ PM from ${sender} (could not decrypt)`;

    if (!HAS_WEBCRYPTO) {
      sysLine = `PM received but could not decrypt (E2EE requires HTTPS or localhost; current: ${window.location.origin}).`;
      toastMsg = `⚠️ PM from ${sender} (E2EE unavailable on this origin)`;
    } else if (low.includes("private messages are locked") || low.includes("unlock skipped") || low.includes("no encrypted private key")) {
      sysLine = "🔒 PM received but your private messages are locked on this tab. Open ⚙ Settings → Unlock DMs.";
      toastMsg = `🔒 Unlock DMs to read PM from ${sender}`;
      // Best-effort: prompt once per tab.
      if (!window.__ec_unlock_prompted) {
        window.__ec_unlock_prompted = true;
        try { showUnlockModal(); } catch {}
      }
    } else if (low.includes("operationerror") || low.includes("data error") || low.includes("could not decrypt") || low.includes("bad pm envelope")) {
      // Most common cause in practice: sender encrypted to a stale public key (keys rotate after password reset).
      sysLine = "🔑 PM received but could not decrypt (key mismatch). If you recently reset your password, ask the sender to refresh and resend.";
      toastMsg = `🔑 PM from ${sender} (key mismatch)`;
    }

    if (w) appendLine(w, "System:", sysLine);
    toast(toastMsg, "warn");
  }
});

// WebRTC P2P file transfer signaling (offer/answer/ICE)
// ───────────────────────────────────────────────────────────────────────────────
socket.on("p2p_file_answer", ({ sender, transfer_id, answer }) => {
  const tr = P2P_TRANSFERS.get(transfer_id);
  if (!tr || tr.role !== "sender") return;
  if (tr._answerResolve) tr._answerResolve(answer);
});

socket.on("p2p_file_decline", ({ sender, transfer_id, reason }) => {
  const tr = P2P_TRANSFERS.get(transfer_id);
  if (!tr) return;
  if (tr._answerReject) tr._answerReject(new Error(reason || "Declined"));
  if (tr.ui) tr.ui.setStatus("❌ Declined");
  p2pSafeClose(transfer_id);
});

socket.on("p2p_file_ice", async ({ sender, transfer_id, candidate }) => {
  const tr = P2P_TRANSFERS.get(transfer_id);
  if (!tr || !tr.pc || !candidate) return;
  try {
    await tr.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    // ICE can race with setRemoteDescription; ignore noisy failures.
  }
});

socket.on("p2p_file_offer", async ({ sender, transfer_id, offer, meta }) => {
  try {
    // If we already have a transfer with this id, ignore dupes.
    if (P2P_TRANSFERS.has(transfer_id)) return;

    const win = openPrivateChat(sender) || UIState.windows.get("dm:" + sender);
    if (!win) return;

    const ui = appendP2pTransferUI(win, `${sender}:`, meta || {}, { mode: "incoming" });
    ui.setStatus("Incoming file offer");

    ui.onAccept(async () => {
      ui.disableActions();
      if (ui?.setBadge) ui.setBadge("P2P");
      ui.setStatus("Accepting…");

      const pc = p2pMakePc();
      let dc = null;

      const tr = {
        role: "receiver",
        peer: sender,
        transfer_id,
        pc,
        dc: null,
        ui,
        meta: meta || {},
        recv: { expected: 0, got: 0, parts: [], gotDone: false },
        _watchdog: null,
        _watchdogInterval: null,
      };
      P2P_TRANSFERS.set(transfer_id, tr);

      const fail = (msg) => {
        try { ui.setStatus(msg || "⚠️ Transfer failed"); } catch {}
        try { socket.emit("p2p_file_decline", { to: sender, transfer_id, reason: msg || "Failed" }); } catch {}
        p2pSafeClose(transfer_id);
      };

      // ICE + state diagnostics
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit("p2p_file_ice", { to: sender, transfer_id, candidate: e.candidate });
        }
      };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "failed") fail("⚠️ Connection failed");
      };
      pc.oniceconnectionstatechange = () => {
        const st = pc.iceConnectionState;
        if (st === "failed") fail("⚠️ ICE failed");
      };

      pc.ondatachannel = (ev) => {
        dc = ev.channel;
        tr.dc = dc;
        dc.binaryType = "arraybuffer";

        dc.onmessage = async (msgEv) => {
          const data = msgEv.data;

          if (typeof data === "string") {
            let obj = null;
            try { obj = JSON.parse(data); } catch {}
            if (!obj || obj.transfer_id !== transfer_id) return;

            if (obj.type === "meta" && obj.meta) {
              tr.meta = obj.meta;
              tr.recv.expected = Number(obj.meta.size || 0) || 0;
              ui.setStatus("Receiving…");
              return;
            }

            if (obj.type === "done") {
              tr.recv.gotDone = true;
              if (tr.recv.expected && tr.recv.got >= tr.recv.expected) {
                await finalizeIncomingP2pFile(sender, transfer_id);
              }
              return;
            }

            return;
          }

          if (data instanceof ArrayBuffer) {
            tr.recv.parts.push(data);
            tr.recv.got += data.byteLength || 0;
            if (tr.recv.expected) ui.setProgress(tr.recv.got / tr.recv.expected);

            if (tr.recv.gotDone && tr.recv.expected && tr.recv.got >= tr.recv.expected) {
              await finalizeIncomingP2pFile(sender, transfer_id);
            }
          }
        };

        dc.onopen = () => ui.setStatus("Receiving…");
        dc.onerror = () => fail("⚠️ DataChannel error");
        dc.onclose = () => {
          // If we didn't finish, treat as failure.
          if (!tr.recv.gotDone || (tr.recv.expected && tr.recv.got < tr.recv.expected)) {
            fail("⚠️ Channel closed");
          }
        };
      };

      // Watchdog: if the sender never completes handshake / never sends data.
      const deadline = Date.now() + (Number(P2P_HANDSHAKE_TIMEOUT_MS) || 7000) * 3;
      tr._watchdogInterval = setInterval(() => {
        if (!P2P_TRANSFERS.has(transfer_id)) return;
        if (tr.recv.got > 0) return; // activity started
        if (Date.now() > deadline) {
          fail("⏳ Sender not responding");
        }
      }, 600);

      try {
        // Apply offer, generate answer
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const resp = await socketEmitAck("p2p_file_answer", {
          to: sender,
          transfer_id,
          answer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        }).catch(() => null);

        if (!resp || resp.success === false) {
          fail("⚠️ Answer failed");
          return;
        }

        ui.setStatus("Answer sent — waiting for sender…");
      } catch (e) {
        const msg = `❌ Accept failed: ${String(e?.message || e || "error")}`;
        fail(msg);
      }
    });

    ui.onDecline(() => {
      ui.setStatus("Declined");
      socket.emit("p2p_file_decline", { to: sender, transfer_id, reason: "Declined" });
      setTimeout(() => ui.remove(), 700);
    });
  } catch (e) {
    console.error("p2p_file_offer handler failed:", e);
  }
});

async function finalizeIncomingP2pFile(sender, transfer_id) {
  const tr = P2P_TRANSFERS.get(transfer_id);
  if (!tr || tr.role !== "receiver") return;

  const meta = tr.meta || {};
  const parts = tr.recv?.parts || [];
  const blob = new Blob(parts, { type: meta.mime || "application/octet-stream" });

  // Optional integrity check (best-effort)
  try {
    if (meta.sha256) {
      const buf = await blob.arrayBuffer();
      const got = await sha256HexFromArrayBuffer(buf);
      if (got !== meta.sha256) {
        tr.ui.setStatus("⚠️ Hash mismatch");
      }
    }
  } catch {}

  // Show final file card in the PM window
  const win = UIState.windows.get("dm:" + sender);
  if (win) {
    appendDmPayload(win, `${sender}:`, {
      kind: "file",
      source: "p2p",
      transfer_id,
      name: meta.name || "file",
      size: Number(meta.size || blob.size) || blob.size,
      mime: meta.mime || blob.type || "application/octet-stream",
      sha256: meta.sha256 || null,
      blob,
    }, { peer: sender, direction: "in" });

    addPmHistory(sender, "in", `📎 ${meta.name || "file"} (${humanBytes(Number(meta.size || blob.size) || blob.size)})`);
  }

  // ACK back to sender
  try {
    tr.dc && tr.dc.send(JSON.stringify({ type: "ack", transfer_id }));
  } catch {}

  tr.ui.setProgress(1);
  tr.ui.setStatus("✅ Received — click Download");
  setTimeout(() => tr.ui.remove(), 900);

  p2pSafeClose(transfer_id);
}

