// ───────────────────────────────────────────────────────────────────────────────
// Window manager (floating windows like classic Yahoo Messenger)
// ───────────────────────────────────────────────────────────────────────────────
function bringToFront(winEl) {
  UIState.highestZ += 1;
  winEl.style.zIndex = UIState.highestZ;
}

function createWindow({ id, title, kind }) {
  // If exists, just focus
  if (UIState.windows.has(id)) {
    const existing = UIState.windows.get(id);
    existing.classList.remove("hidden");
    bringToFront(existing);
    return existing;
  }

  const layer = $("windowsLayer");
  if (!layer) return null;

  const win = document.createElement("div");
  win.className = "ym-window";
  win.dataset.winId = id;
  win.dataset.kind = kind;

  // Default placement
  const baseX = Math.max(20, window.innerWidth - 420 - 360 - 40);
  const x = baseX + Math.floor(Math.random() * 50);
  const y = 80 + Math.floor(Math.random() * 60);
  win.style.left = `${x}px`;
  win.style.top = `${y}px`;
  win.style.zIndex = String(++UIState.highestZ);

  const titlebar = document.createElement("div");
  titlebar.className = "ym-titlebar";

  const titleEl = document.createElement("div");
  titleEl.className = "ym-title";
  titleEl.textContent = title;

  const btns = document.createElement("div");
  btns.className = "ym-winBtns";

  const btnMin = document.createElement("button");
  btnMin.className = "winBtn";
  btnMin.title = "Minimize";
  btnMin.textContent = "–";

  const btnClose = document.createElement("button");
  btnClose.className = "winBtn danger";
  btnClose.title = "Close";
  btnClose.textContent = "×";

  btns.appendChild(btnMin);
  btns.appendChild(btnClose);

  titlebar.appendChild(titleEl);
  titlebar.appendChild(btns);

  const body = document.createElement("div");
  body.className = "ym-body";

  const log = document.createElement("div");
  log.className = "ym-log";
  log.innerHTML = `<div class="ym-line"><span class="tag">System:</span>Window opened.</div>`;

  const compose = document.createElement("div");
  compose.className = "ym-compose";

  const input = document.createElement("input");
  input.className = "ym-input";
  input.type = "text";
  input.placeholder = "Type a message…";

  // Emoticons (emoji) button
  const emojiBtn = document.createElement("button");
  emojiBtn.type = "button";
  emojiBtn.className = "ym-toolBtn ym-emojiBtn";
  emojiBtn.title = "Emoticons";
  emojiBtn.textContent = "😊";

  const send = document.createElement("button");
  send.className = "ym-send";
  send.textContent = "Send";

  compose.appendChild(input);
  compose.appendChild(emojiBtn);
  compose.appendChild(send);

  body.appendChild(log);

  // DM toolbar sits between output (log) and input (compose)
  let toolbar = null;
  let fileBtn = null;
  let fileInput = null;
  let toolHint = null;
  let gifBtn = null;
  let gifHint = null;
  let voiceBtn = null;
  let voiceHint = null;
  let voiceBar = null;
  let voiceStatus = null;
  let voiceBtnCall = null;
  let voiceBtnHang = null;
  let voiceBtnMute = null;
  let voiceBtnAccept = null;
  let voiceBtnDecline = null;
  if (kind === "dm") {
    toolbar = document.createElement("div");
    toolbar.className = "ym-toolbar";

    fileBtn = document.createElement("button");
    fileBtn.type = "button";
    fileBtn.className = "ym-toolBtn";
    fileBtn.title = "Send a file";
    fileBtn.textContent = "📎";

    toolHint = document.createElement("span");
    toolHint.className = "ym-toolHint";
    toolHint.textContent = "File";

    fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.className = "ym-fileInput";
    fileInput.style.display = "none";

    toolbar.appendChild(fileBtn);
    toolbar.appendChild(toolHint);

// GIF button (GIPHY)
gifBtn = document.createElement("button");
gifBtn.type = "button";
gifBtn.className = "ym-toolBtn";
gifBtn.title = "Search GIFs";
gifBtn.textContent = "GIF";

gifHint = document.createElement("span");
gifHint.className = "ym-toolHint";
gifHint.textContent = "GIF";

toolbar.appendChild(gifBtn);
toolbar.appendChild(gifHint);
    // Voice button (Yahoo-style)
    voiceBtn = document.createElement("button");
    voiceBtn.type = "button";
    voiceBtn.className = "ym-toolBtn";
    voiceBtn.title = "Voice chat";
    voiceBtn.textContent = "🎤";

    voiceHint = document.createElement("span");
    voiceHint.className = "ym-toolHint";
    voiceHint.textContent = "Voice";

    toolbar.appendChild(voiceBtn);
    toolbar.appendChild(voiceHint);

    toolbar.appendChild(fileInput);
    body.appendChild(toolbar);

    // Voice bar: call status + quick actions
    voiceBar = document.createElement("div");
    voiceBar.className = "ym-voiceBar hidden";

    const left = document.createElement("div");
    left.className = "ym-voiceLeft";
    left.innerHTML = `<span class="ym-voiceBadge">VOICE</span>`;

    voiceStatus = document.createElement("span");
    voiceStatus.className = "ym-voiceStatus";
    voiceStatus.textContent = "Not connected";
    left.appendChild(voiceStatus);

    const btns = document.createElement("div");
    btns.className = "ym-voiceBtns";

    voiceBtnCall = document.createElement("button");
    voiceBtnCall.className = "miniBtn";
    voiceBtnCall.textContent = "Call";

    voiceBtnHang = document.createElement("button");
    voiceBtnHang.className = "miniBtn danger";
    voiceBtnHang.textContent = "Hang up";

    voiceBtnMute = document.createElement("button");
    voiceBtnMute.className = "miniBtn";
    voiceBtnMute.textContent = "Mute";

    voiceBtnAccept = document.createElement("button");
    voiceBtnAccept.className = "miniBtn";
    voiceBtnAccept.textContent = "Accept";

    voiceBtnDecline = document.createElement("button");
    voiceBtnDecline.className = "miniBtn danger";
    voiceBtnDecline.textContent = "Decline";

    // Default: show outbound controls only
    voiceBtnAccept.style.display = "none";
    voiceBtnDecline.style.display = "none";

    btns.appendChild(voiceBtnCall);
    btns.appendChild(voiceBtnHang);
    btns.appendChild(voiceBtnMute);
    btns.appendChild(voiceBtnAccept);
    btns.appendChild(voiceBtnDecline);

    voiceBar.appendChild(left);
    voiceBar.appendChild(btns);
    body.appendChild(voiceBar);
  }
  if (kind === "group") {
    toolbar = document.createElement("div");
    toolbar.className = "ym-toolbar";

    fileBtn = document.createElement("button");
    fileBtn.type = "button";
    fileBtn.className = "ym-toolBtn";
    fileBtn.title = "Send a file to the group (E2EE)";
    fileBtn.textContent = "📎";

    toolHint = document.createElement("span");
    toolHint.className = "ym-toolHint";
    toolHint.textContent = "File";

    fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.className = "ym-fileInput";
    fileInput.style.display = "none";

    toolbar.appendChild(fileBtn);
    toolbar.appendChild(toolHint);

// GIF button (GIPHY)
gifBtn = document.createElement("button");
gifBtn.type = "button";
gifBtn.className = "ym-toolBtn";
gifBtn.title = "Search GIFs";
gifBtn.textContent = "GIF";

gifHint = document.createElement("span");
gifHint.className = "ym-toolHint";
gifHint.textContent = "GIF";

toolbar.appendChild(gifBtn);
toolbar.appendChild(gifHint);
    toolbar.appendChild(fileInput);
    body.appendChild(toolbar);
  }

  body.appendChild(compose);

  const resize = document.createElement("div");
  resize.className = "ym-resize";

  win.appendChild(titlebar);
  win.appendChild(body);
  win.appendChild(resize);

  layer.appendChild(win);
  UIState.windows.set(id, win);

  // Focus behavior
  win.addEventListener("mousedown", () => bringToFront(win));
  titlebar.addEventListener("mousedown", () => bringToFront(win));

  // Drag behavior
  (function attachDrag() {
    let dragging = false;
    let startX = 0, startY = 0, origX = 0, origY = 0;

    titlebar.addEventListener("mousedown", (e) => {
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      origX = parseInt(win.style.left || "0", 10);
      origY = parseInt(win.style.top || "0", 10);
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      win.style.left = `${origX + dx}px`;
      win.style.top = `${origY + dy}px`;
    });

    window.addEventListener("mouseup", () => { dragging = false; });
  })();

  // Resize behavior
  (function attachResize() {
    let resizing = false;
    let startX = 0, startY = 0, startW = 0, startH = 0;

    resize.addEventListener("mousedown", (e) => {
      resizing = true;
      startX = e.clientX; startY = e.clientY;
      startW = win.offsetWidth; startH = win.offsetHeight;
      e.preventDefault();
      bringToFront(win);
    });

    window.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      win.style.width = `${Math.max(340, startW + dx)}px`;
      win.style.height = `${Math.max(280, startH + dy)}px`;
    });

    window.addEventListener("mouseup", () => { resizing = false; });
  })();

  // Minimize/Close
  btnMin.onclick = () => minimizeWindow(id, title);
  btnClose.onclick = () => closeWindow(id);

  // Expose handles for message plumbing
  win._ym = { titleEl, log, input, send, emojiBtn, toolbar, fileBtn, fileInput, toolHint, gifBtn, gifHint, voiceBtn, voiceHint, voiceBar, voiceStatus, voiceBtnCall, voiceBtnHang, voiceBtnMute, voiceBtnAccept, voiceBtnDecline };

  // Bind emoticons picker
  bindEmojiButton(emojiBtn, input);

  // Enter-to-send
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send.click();
  });

  return win;
}

function minimizeWindow(id, title) {
  const win = UIState.windows.get(id);
  if (!win) return;

  win.classList.add("hidden");

  if (UIState.minimized.has(id)) return;

  const bar = $("dockTaskbar");
  if (!bar) return;

  const btn = document.createElement("button");
  btn.className = "taskBtn";
  btn.textContent = title;
  btn.onclick = () => {
    win.classList.remove("hidden");
    bringToFront(win);
    btn.remove();
    UIState.minimized.delete(id);
  };

  bar.appendChild(btn);
  UIState.minimized.set(id, btn);
}

function closeWindow(id) {
  const win = UIState.windows.get(id);
  if (!win) return;

  // If closing a DM while in a voice call, hang up.
  if (typeof id === "string" && id.startsWith("dm:")) {
    const peer = id.slice(3);
    if (peer && VOICE_STATE.dmCalls.has(peer)) {
      voiceHangupDm(peer, "Closed", true);
    }
  }

  // If it's a room window, keep state consistent
  if (win.dataset.kind === "room") {
    // no-op: leaving room is user-controlled via Leave button
  }

  win.remove();
  UIState.windows.delete(id);

  const taskBtn = UIState.minimized.get(id);
  if (taskBtn) taskBtn.remove();
  UIState.minimized.delete(id);
}

function parseGifMarker(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s) return null;
  if (!s.toLowerCase().startsWith('gif:')) return null;
  const url = s.slice(4).trim();
  if (!url) return null;
  if (url.length > 2048) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}


function _gifFallbackUrl(url) {
  try {
    const u = new URL(url);
    const parts = (u.pathname || "").split("/").filter(Boolean);
    const mi = parts.indexOf("media");
    if (mi !== -1 && parts.length > (mi + 1)) {
      const id = parts[mi + 1];
      if (id) return `https://i.giphy.com/media/${id}/giphy.gif`;
    }
  } catch {}
  return null;
}

function _gifCacheBust(url) {
  try {
    const u = new URL(url);
    u.searchParams.set("cb", String(Date.now()));
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return url + sep + "cb=" + Date.now();
  }
}

function refreshGifInlineImage(img, reason = "manual") {
  if (!img) return false;

  const maxTries = 3;
  const tries = Number(img.dataset.gifTry || "0");
  if (tries >= maxTries) {
    img.dataset.gifFailed = "1";
    img.classList.add("ym-gifBroken");
    return false;
  }

  const base = img.dataset.gifBase || img.dataset.gifOrig || img.src || "";
  const canonical = _gifFallbackUrl(base) || base;

  img.dataset.gifBase = canonical;
  img.dataset.gifTry = String(tries + 1);
  img.dataset.gifLoaded = "0";
  img.dataset.gifFailed = "0";
  img.classList.remove("ym-gifBroken");

  const next = _gifCacheBust(canonical);

  // Force a reload (cache-busted) without spamming the network.
  try { img.src = ""; } catch {}
  setTimeout(() => { img.src = next; }, 0);

  return true;
}

function scheduleGifLoadCheck(img) {
  if (!img) return;
  if (img.dataset.gifWatch === "1") return;
  img.dataset.gifWatch = "1";

  // Some browsers keep images in a "stuck" state inside scroll containers.
  // If it doesn't load within a few seconds, retry with a cache-busted URL.
  setTimeout(() => {
    if (img.dataset.gifLoaded === "1") return;
    if (!navigator.onLine) return;
    if (!img.complete || img.naturalWidth === 0) {
      refreshGifInlineImage(img, "timeout");
    }
  }, 7000);
}

function refreshUnloadedGifsInScope(scope = document) {
  const root = scope || document;
  const imgs = root.querySelectorAll('img[data-ec-gif="1"]');
  let n = 0;

  imgs.forEach((img) => {
    const loaded = img.dataset.gifLoaded === "1";
    if (loaded) return;

    if (!img.complete || img.naturalWidth === 0 || img.dataset.gifFailed === "1") {
      if (refreshGifInlineImage(img, "scan")) n++;
    }
  });

  return n;
}

// Console / power-user hook: window.EchoChatRefreshGifs()
if (!window.EchoChatRefreshGifs) {
  window.EchoChatRefreshGifs = () => {
    const n = refreshUnloadedGifsInScope(document);
    try { toast(`↻ Retried ${n} GIF(s)`, "info"); } catch {}
    return n;
  };
}

// Auto-recover when network comes back or user returns to the tab
if (!window.__ecGifAutoRefreshBound) {
  window.__ecGifAutoRefreshBound = true;
  window.addEventListener("online", () => setTimeout(() => refreshUnloadedGifsInScope(document), 400));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) setTimeout(() => refreshUnloadedGifsInScope(document), 400);
  });
}


function configureGifInlineImage(img, gifUrl) {
  img.className = "ym-gifInline";
  // Lazy-loading inside scroll containers is unreliable; force eager for chat UX.
  img.loading = "eager";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.alt = "GIF";

  img.dataset.ecGif = "1";
  img.dataset.gifOrig = gifUrl;

  const base = _gifFallbackUrl(gifUrl) || gifUrl;
  img.dataset.gifBase = base;
  img.dataset.gifTry = "0";
  img.dataset.gifLoaded = "0";
  img.dataset.gifFailed = "0";

  img.src = base;
  scheduleGifLoadCheck(img);

  img.onload = () => {
    img.dataset.gifLoaded = "1";
    img.dataset.gifFailed = "0";
    img.classList.remove("ym-gifBroken");
  };

  img.onerror = () => {
    refreshGifInlineImage(img, "error");
  };

  img.onclick = () => {
    const notLoaded = (img.dataset.gifLoaded !== "1") && (!img.complete || img.naturalWidth === 0);

    // If it looks stuck/broken, clicking retries; the "Open" link still opens the URL.
    if (notLoaded || img.dataset.gifFailed === "1") {
      refreshGifInlineImage(img, "click");
      return;
    }

    try { window.open(img.dataset.gifOrig || img.dataset.gifBase || img.src, "_blank"); } catch {}
  };
}



function appendLine(winEl, who, text, kind = "msg") {
  const log = winEl._ym?.log;
  if (!log) return;

  const line = document.createElement("div");
  line.className = "ym-line";

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = String(who || "");
  line.appendChild(tag);

  const gifUrl = parseGifMarker(text);
  if (gifUrl) {
    line.appendChild(document.createTextNode(" "));

    const img = document.createElement("img");
    configureGifInlineImage(img, gifUrl);

    const open = document.createElement("a");
    open.className = "ym-gifOpen";
    open.href = gifUrl;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.textContent = "Open";

    line.appendChild(img);
    line.appendChild(document.createTextNode(" "));
    line.appendChild(open);
  } else {
    const s = (typeof text === "string") ? text : String(text ?? "");
    line.appendChild(document.createTextNode(" " + s));
  }

  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}


function parseDmPayload(plaintext) {
  if (typeof plaintext !== "string") return { kind: "text", text: String(plaintext) };

  // DM special payloads are encrypted JSON objects: {"_ec":"file"|"torrent", ...}
  if (plaintext.startsWith("{")) {
    try {
      const obj = JSON.parse(plaintext);
      if (obj && obj._ec === "file" && typeof obj.file_id === "string") {
        return {
          kind: "file",
          file_id: obj.file_id,
          name: String(obj.name || "file"),
          size: Number(obj.size || 0) || 0,
          mime: String(obj.mime || "application/octet-stream"),
          sha256: obj.sha256 ? String(obj.sha256) : null,
        };
      }
      if (obj && obj._ec === "torrent") {
        return {
          kind: "torrent",
          t: {
            name: String(obj.name || obj.display_name || "Torrent"),
            infohash: String(obj.infohash || obj.infohash_hex || ""),
            magnet: String(obj.magnet || ""),
            total_size: Number(obj.total_size || 0) || 0,
            seeds: (obj.seeds === null || obj.seeds === undefined) ? null : Number(obj.seeds),
            leechers: (obj.leechers === null || obj.leechers === undefined) ? null : Number(obj.leechers),
            completed: (obj.completed === null || obj.completed === undefined) ? null : Number(obj.completed),
            trackers: Array.isArray(obj.trackers) ? obj.trackers.map(String) : [],
            comment: obj.comment ? String(obj.comment) : "",
            created_by: obj.created_by ? String(obj.created_by) : "",
            creation_date: obj.creation_date ? String(obj.creation_date) : "",
            // Optional: if the sender also sent the .torrent file via server, they can include it.
            file_id: typeof obj.file_id === "string" ? obj.file_id : null,
          }
        };
      }
    } catch {
      // fall through
    }
  }
  // If a user pastes a magnet link as plain text, render it as a torrent card.
  if (isMagnetText(plaintext)) {
    const pm = parseMagnet(plaintext);
    if (pm) {
      return {
        kind: "torrent",
        t: {
          name: pm.name || "Magnet",
          infohash: pm.infohash,
          magnet: pm.magnet,
          total_size: 0,
          seeds: null,
          leechers: null,
          completed: null,
          trackers: pm.trackers || [],
          comment: "",
          created_by: "",
          creation_date: "",
          file_id: null,
        }
      };
    }
  }
  return { kind: "text", text: plaintext };
}

function appendDmPayload(winEl, who, payload, { peer, direction } = {}) {
  if (!payload || !winEl) return;
  if (payload.kind === "file") {
    appendFileLine(winEl, who, payload, { peer, direction });
  } else if (payload.kind === "torrent") {
    appendTorrentLine(winEl, who, payload.t, { peer, direction });
  } else {
    appendLine(winEl, who, payload.text);
  }
}

function makeFileLineElement(who, filePayload, { peer, direction } = {}) {
  const line = document.createElement("div");
  line.className = "ym-line";

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = who;
  line.appendChild(tag);
  line.appendChild(document.createTextNode(" "));

  const card = document.createElement("span");
  card.className = "ym-fileCard";

  const icon = document.createElement("span");
  icon.textContent = "📎";

  const name = document.createElement("span");
  name.className = "ym-fileName";
  name.textContent = filePayload?.name || "file";

  const meta = document.createElement("span");
  meta.className = "ym-fileMeta";
  meta.textContent = humanBytes(filePayload?.size || 0);

  // Source badge (P2P vs server)
  const badge = document.createElement("span");
  badge.className = "ym-fileBadge";
  const src = filePayload?.source || (filePayload?.transfer_id ? "p2p" : "server");
  badge.textContent = (src === "p2p") ? "P2P" : "SRV";

  // Download / status
  let actionEl = null;

  if (filePayload?.blob instanceof Blob) {
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "ym-fileDl";
    dl.textContent = "Download";
    dl.onclick = () => downloadBlob(filePayload.name || "file", filePayload.blob);
    actionEl = dl;
  } else if (typeof filePayload?.file_id === "string" && filePayload.file_id) {
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "ym-fileDl";
    dl.textContent = "Download";
    dl.onclick = async () => {
      try {
        if (filePayload && filePayload.group_id) {
          await downloadAndDecryptGroupFile(filePayload.file_id, filePayload.name, filePayload.group_id);
        } else {
          await downloadAndDecryptDmFile(filePayload.file_id, filePayload.name);
        }
      } catch (e) {
        console.error(e);
        toast("❌ File download failed", "error");
      }
    };
    actionEl = dl;
  } else {
    // Outgoing P2P: nothing to download (receiver-side only).
    const st = document.createElement("span");
    st.className = "ym-fileMeta";
    st.textContent = (direction === "out") ? "Sent" : "";
    actionEl = st;
  }

  card.appendChild(icon);
  card.appendChild(name);
  card.appendChild(meta);
  card.appendChild(badge);
  if (actionEl) card.appendChild(actionEl);
  line.appendChild(card);
  return line;
}

function appendFileLine(winEl, who, filePayload, { peer, direction } = {}) {
  const log = winEl._ym?.log;
  if (!log) return;
  const line = makeFileLineElement(who, filePayload, { peer, direction });
  if (!line) return;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function isTorrentName(name) {
  return typeof name === "string" && /\.torrent$/i.test(name.trim());
}

function _shortHash(h) {
  if (!h) return "";
  const s = String(h);
  return s.length > 12 ? (s.slice(0, 6) + "…" + s.slice(-6)) : s;
}

function buildTorrentCard(t) {
  const card = document.createElement("span");
  card.className = "ym-torrentCard";

  const icon = document.createElement("span");
  icon.textContent = "🧲";

  const main = document.createElement("span");
  main.className = "ym-torrentMain";

  const title = document.createElement("div");
  title.className = "ym-torrentTitle";
  title.innerHTML = `<span class="ym-torrentName">${escapeHtml(t?.name || "Torrent")}</span>`;

  const meta = document.createElement("div");
  meta.className = "ym-torrentMeta";

  const sizeText = t?.total_size ? humanBytes(Number(t.total_size) || 0) : "—";
  const seeds = (t?.seeds === null || t?.seeds === undefined || Number.isNaN(Number(t?.seeds))) ? "?" : String(Math.max(0, Number(t.seeds)));
  const leech = (t?.leechers === null || t?.leechers === undefined || Number.isNaN(Number(t?.leechers))) ? "?" : String(Math.max(0, Number(t.leechers)));
  const done = (t?.completed === null || t?.completed === undefined || Number.isNaN(Number(t?.completed))) ? "?" : String(Math.max(0, Number(t.completed)));

  meta.textContent = `Size ${sizeText} • Seeds ${seeds} • Leechers ${leech} • Completed ${done}`;

  // If we didn't receive swarm stats, do a lazy refresh once (best-effort).
  // This makes pasted magnet links and old clients still show seeds/leechers.
  const needsRefresh = (seeds === "?" || leech === "?" || done === "?") && !!t?.infohash;
  if (needsRefresh) {
    const trList = (Array.isArray(t?.trackers) && t.trackers.length) ? t.trackers : DEFAULT_PUBLIC_TRACKERS;
    fetchTorrentSwarm(String(t.infohash || ""), trList).then((sw) => {
      if (!sw) return;
      const s2 = (sw.seeds === null || sw.seeds === undefined || Number.isNaN(Number(sw.seeds))) ? "?" : String(Math.max(0, Number(sw.seeds)));
      const l2 = (sw.leechers === null || sw.leechers === undefined || Number.isNaN(Number(sw.leechers))) ? "?" : String(Math.max(0, Number(sw.leechers)));
      const d2 = (sw.completed === null || sw.completed === undefined || Number.isNaN(Number(sw.completed))) ? "?" : String(Math.max(0, Number(sw.completed)));
      const size2 = t?.total_size ? humanBytes(Number(t.total_size) || 0) : "—";
      meta.textContent = `Size ${size2} • Seeds ${s2} • Leechers ${l2} • Completed ${d2}`;
    }).catch(() => {});
  }

  const hash = document.createElement("div");
  hash.className = "ym-torrentHash";
  hash.textContent = `Infohash: ${_shortHash(t?.infohash || "")}`;

  const actions = document.createElement("div");
  actions.className = "ym-torrentActions";

  const btnCopyMagnet = document.createElement("button");
  btnCopyMagnet.className = "ym-fileDl";
  btnCopyMagnet.textContent = "Copy magnet";
  btnCopyMagnet.onclick = async () => {
    const m = t?.magnet || "";
    if (!m) return toast("⚠️ No magnet available", "warn");
    try {
      await navigator.clipboard.writeText(m);
      toast("📋 Magnet copied", "ok");
    } catch {
      toast("❌ Could not copy", "error");
    }
  };

  const btnCopyHash = document.createElement("button");
  btnCopyHash.className = "ym-fileDl";
  btnCopyHash.textContent = "Copy hash";
  btnCopyHash.onclick = async () => {
    const h = t?.infohash || "";
    if (!h) return toast("⚠️ No infohash", "warn");
    try {
      await navigator.clipboard.writeText(h);
      toast("📋 Hash copied", "ok");
    } catch {
      toast("❌ Could not copy", "error");
    }
  };

  actions.appendChild(btnCopyMagnet);
  actions.appendChild(btnCopyHash);

  // Optional server-stored torrent download (rooms)
  if (t?.download_url) {
    const btnDl = document.createElement("button");
    btnDl.className = "ym-fileDl";
    btnDl.textContent = "Download .torrent";
    btnDl.onclick = () => {
      try {
        const a = document.createElement("a");
        a.href = t.download_url;
        a.download = t?.file_name || "download.torrent";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch {
        window.open(t.download_url, "_blank");
      }
    };
    actions.appendChild(btnDl);
  }

  main.appendChild(title);
  main.appendChild(meta);
  if (t?.infohash) main.appendChild(hash);
  if ((t?.trackers || []).length) {
    const tr = document.createElement("div");
    tr.className = "ym-torrentTrackers";
    tr.textContent = `${t.trackers.length} tracker(s)`;
    main.appendChild(tr);
  }
  if (t?.comment) {
    const c = document.createElement("div");
    c.className = "ym-torrentComment";
    c.textContent = t.comment;
    main.appendChild(c);
  }

  card.appendChild(icon);
  card.appendChild(main);
  card.appendChild(actions);
  return card;
}

function appendTorrentLine(winEl, who, t, { peer, direction } = {}) {
  const log = winEl._ym?.log;
  if (!log) return;

  const line = document.createElement("div");
  line.className = "ym-line";

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = who;
  line.appendChild(tag);
  line.appendChild(document.createTextNode(" "));

  line.appendChild(buildTorrentCard(t));
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function appendP2pTransferUI(winEl, who, meta, { mode = "outgoing" } = {}) {
  const log = winEl?._ym?.log;
  if (!log) return { setProgress() {}, setStatus() {}, remove() {}, disableActions() {}, onAccept() {}, onDecline() {} };

  const line = document.createElement("div");
  line.className = "ym-line";

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = who;
  line.appendChild(tag);
  line.appendChild(document.createTextNode(" "));

  const card = document.createElement("span");
  card.className = "ym-xferCard";

  const row = document.createElement("span");
  row.className = "ym-xferRow";

  const icon = document.createElement("span");
  icon.textContent = "📎";

  const name = document.createElement("span");
  name.className = "ym-fileName";
  name.textContent = String(meta?.name || "file");

  const size = document.createElement("span");
  size.className = "ym-fileMeta";
  size.textContent = humanBytes(Number(meta?.size || 0) || 0);

  const badge = document.createElement("span");
  badge.className = "ym-fileBadge";
  badge.textContent = "P2P";

  row.appendChild(icon);
  row.appendChild(name);
  row.appendChild(size);
  row.appendChild(badge);

  const status = document.createElement("div");
  status.className = "ym-xferStatus";
  status.textContent = (mode === "incoming") ? "Incoming file…" : "Preparing…";

  const bar = document.createElement("div");
  bar.className = "ym-xferBar";
  const fill = document.createElement("span");
  fill.className = "ym-xferFill";
  bar.appendChild(fill);

  const actions = document.createElement("div");
  actions.className = "ym-xferActions";

  const btnAccept = document.createElement("button");
  btnAccept.type = "button";
  btnAccept.className = "ym-xferBtn";
  btnAccept.textContent = "Accept";

  const btnDecline = document.createElement("button");
  btnDecline.type = "button";
  btnDecline.className = "ym-xferBtn danger";
  btnDecline.textContent = "Decline";

  if (mode === "incoming") {
    actions.appendChild(btnAccept);
    actions.appendChild(btnDecline);
  }

  card.appendChild(row);
  card.appendChild(status);
  card.appendChild(bar);
  if (mode === "incoming") card.appendChild(actions);

  line.appendChild(card);
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;

  let _onAccept = null;
  let _onDecline = null;

  btnAccept.onclick = () => _onAccept && _onAccept();
  btnDecline.onclick = () => _onDecline && _onDecline();

  return {
    setProgress(r) {
      const ratio = Math.max(0, Math.min(1, Number(r) || 0));
      fill.style.width = `${Math.round(ratio * 100)}%`;
    },
    setStatus(s) {
      status.textContent = String(s || "");
    },
    remove() {
      try { line.remove(); } catch {}
    },
    disableActions() {
      btnAccept.disabled = true;
      btnDecline.disabled = true;
    },
    onAccept(fn) { _onAccept = fn; },
    onDecline(fn) { _onDecline = fn; },
    setBadge(text) {
      badge.textContent = String(text || "").slice(0, 6) || "";
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Message reactions (rooms)
// ───────────────────────────────────────────────────────────────────────────────
const DEFAULT_REACTION_EMOJIS = ["👍", "👎", "😂", "❤️", "😮"]; // fast common set

function _ensureMsgIndex(viewEl) {
  if (!viewEl) return;
  if (!viewEl._ym) viewEl._ym = {};
  if (!viewEl._ym.msgIndex) viewEl._ym.msgIndex = new Map();
  if (!viewEl._ym.myReactions) viewEl._ym.myReactions = new Map(); // message_id -> emoji (current user)
}

function _findMsgEl(viewEl, messageId) {
  _ensureMsgIndex(viewEl);
  return viewEl._ym.msgIndex.get(messageId) || null;
}

function _getMyReaction(viewEl, messageId) {
  _ensureMsgIndex(viewEl);
  return viewEl?._ym?.myReactions?.get(messageId) || null;
}

function _setMyReaction(viewEl, messageId, emojiOrNull) {
  _ensureMsgIndex(viewEl);
  if (!viewEl?._ym?.myReactions) return;

  if (emojiOrNull) viewEl._ym.myReactions.set(messageId, emojiOrNull);
  else viewEl._ym.myReactions.delete(messageId);

  const msgEl = _findMsgEl(viewEl, messageId);
  if (!msgEl) return;
  msgEl.querySelectorAll(".reactBtn").forEach((b) => {
    b.classList.toggle("active", (b.dataset?.emoji || b.textContent) === emojiOrNull);
  });
}

function _lockReactions(viewEl, messageId) {
  const msgEl = _findMsgEl(viewEl, messageId);
  if (!msgEl) return;
  msgEl.classList.add("rxLocked");
  msgEl.querySelectorAll(".reactBtn").forEach((b) => {
    b.disabled = true;
    b.classList.add("disabled");
  });
}


function _renderReactionPills(container, counts) {
  if (!container) return;
  container.innerHTML = "";
  if (!counts) return;

  // Stable ordering: show default emojis first, then any others the server sends.
  const keys = Object.keys(counts);
  const ordered = [
    ...DEFAULT_REACTION_EMOJIS.filter(e => keys.includes(e)),
    ...keys.filter(e => !DEFAULT_REACTION_EMOJIS.includes(e)).sort()
  ];

  ordered.forEach((emoji) => {
    const n = counts[emoji];
    if (!n) return;
    const pill = document.createElement("span");
    pill.className = "reactPill";
    pill.textContent = `${emoji} ${n}`;
    container.appendChild(pill);
  });
}

function _sendReaction(viewEl, room, messageId, emoji) {
  if (!room || !messageId || !emoji) return;

  // Enforce "final reaction" client-side: once you react, it is locked.
  const current = _getMyReaction(viewEl, messageId);
  if (current) {
    toast("🔒 Reaction is final. You can’t change or undo it.", "warn");
    return;
  }

  socket.emit("react_to_message", { room, message_id: messageId, emoji }, (res) => {
    if (!res?.success) {
      toast(`❌ ${res?.error || "Reaction failed"}`, "error");
      return;
    }

    // Track my selected emoji for UI highlighting.
    _setMyReaction(viewEl, messageId, emoji);
    _lockReactions(viewEl, messageId);

    // Fast-path update (server also broadcasts message_reactions).
    const msgEl = _findMsgEl(viewEl, messageId);
    if (msgEl) {
      const rx = msgEl.querySelector(".msgReactions");
      if (rx && res?.counts) _renderReactionPills(rx, res.counts);
    }
  });
}

function appendRoomMessage(viewEl, payload) {
  const log = viewEl?._ym?.log;
  if (!log) return;

  const username = payload?.username || "";
  const message = payload?.message ?? "";
  const room = payload?.room || UIState.currentRoom || null;

  // If server did not provide one (older server), create a local one.
  const messageId = payload?.message_id || payload?.messageId || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  _ensureMsgIndex(viewEl);

  const row = document.createElement("div");
  row.className = "msgRow";
  row.dataset.msgid = messageId;

  const head = document.createElement("div");
  head.className = "msgHeader";

  const userEl = document.createElement("span");
  userEl.className = "msgUser";
  userEl.textContent = username ? `${username}:` : "";

  head.appendChild(userEl);

  const body = document.createElement("div");
  body.className = "msgText";
  // Support special in-room payloads (e.g. torrent cards)
  let _ecObj = null;
  if (typeof message === "string" && message.startsWith("{")) {
    try { _ecObj = JSON.parse(message); } catch { _ecObj = null; }
  }

  if (_ecObj && _ecObj._ec === "torrent") {
    const t = {
      name: String(_ecObj.name || _ecObj.file_name || "Torrent"),
      infohash: String(_ecObj.infohash || _ecObj.infohash_hex || ""),
      magnet: String(_ecObj.magnet || ""),
      total_size: Number(_ecObj.total_size || 0) || 0,
      seeds: (_ecObj.seeds === null || _ecObj.seeds === undefined) ? null : Number(_ecObj.seeds),
      leechers: (_ecObj.leechers === null || _ecObj.leechers === undefined) ? null : Number(_ecObj.leechers),
      completed: (_ecObj.completed === null || _ecObj.completed === undefined) ? null : Number(_ecObj.completed),
      trackers: Array.isArray(_ecObj.trackers) ? _ecObj.trackers.map(String) : [],
      comment: _ecObj.comment ? String(_ecObj.comment) : "",
      created_by: _ecObj.created_by ? String(_ecObj.created_by) : "",
      creation_date: _ecObj.creation_date ? String(_ecObj.creation_date) : "",
      download_url: _ecObj.download_url ? String(_ecObj.download_url) : ""
    };
    body.innerHTML = "";
    body.appendChild(buildTorrentCard(t));
  } else if (typeof message === "string" && isMagnetText(message)) {
    const pm = parseMagnet(message);
    if (pm) {
      const t = {
        name: pm.name || "Magnet",
        infohash: pm.infohash,
        magnet: pm.magnet,
        total_size: 0,
        seeds: null,
        leechers: null,
        completed: null,
        trackers: pm.trackers || [],
        comment: "",
        created_by: "",
        creation_date: "",
        download_url: ""
      };
      body.innerHTML = "";
      body.appendChild(buildTorrentCard(t));
    } else {
      body.textContent = message;
    }
  } else {
    const gifUrl = parseGifMarker(message);
    if (gifUrl) {
      body.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "ym-gifWrap";

      const img = document.createElement("img");
      configureGifInlineImage(img, gifUrl);

      const open = document.createElement("a");
      open.className = "ym-gifOpen";
      open.href = gifUrl;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.textContent = "Open";

      wrap.appendChild(img);
      wrap.appendChild(open);
      body.appendChild(wrap);
    } else {
      body.textContent = message;
    }
  }

  // Message line: text + (hover) reaction picker on the SAME line
  const line = document.createElement("div");
  line.className = "msgLine";

  const actions = document.createElement("div");
  actions.className = "msgActions";
  DEFAULT_REACTION_EMOJIS.forEach((emoji) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "reactBtn";
    b.textContent = emoji;
    b.dataset.emoji = emoji;
    b.title = `React ${emoji}`;
    b.onclick = () => _sendReaction(viewEl, room, messageId, emoji);
    actions.appendChild(b);
  });

  const rx = document.createElement("div");
  rx.className = "msgReactions";

  line.appendChild(body);
  line.appendChild(actions);

  row.appendChild(head);
  row.appendChild(line);
  row.appendChild(rx);

  log.appendChild(row);
  viewEl._ym.msgIndex.set(messageId, row);
  log.scrollTop = log.scrollHeight;
}

