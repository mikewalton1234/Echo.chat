// ───────────────────────────────────────────────────────────────────────────────
// DOM helpers
// ───────────────────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function setThemeFromPrefs() {
  const root = $("appRoot");
  const dark = !!UIState.prefs.darkMode;

  const raw = String(UIState.prefs.accentTheme || "default");
  const accent = (["default", "blue", "purple"].includes(raw) ? raw : "default");
  const accentClasses = ["accent-default", "accent-blue", "accent-purple"];

  document.body.classList.toggle("theme-dark", dark);
  document.body.classList.toggle("theme-light", !dark);
  document.body.classList.remove(...accentClasses);
  document.body.classList.add(`accent-${accent}`);

  if (root) {
    root.classList.toggle("theme-dark", dark);
    root.classList.toggle("theme-light", !dark);
    root.classList.remove(...accentClasses);
    root.classList.add(`accent-${accent}`);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[m]));
}

// ───────────────────────────────────────────────────────────────────────────────
// Emoticons / Emoji picker (rooms + DMs + groups)
//
// Design goals:
// - Zero server changes (emoji are just Unicode text)
// - Works everywhere we have a message <input>
// - One shared popover instance (lighter + fewer event listeners)
// ───────────────────────────────────────────────────────────────────────────────

const EMOJI_RECENT_KEY = "recentEmojisV1";

// Minimal curated set (common chat emoticons). Add more anytime.
// Each entry: { e: "😀", n: "grinning face", cat: "smileys", k: "keywords" }
const EMOJI_DB = [
  // Smileys
  { e: "😀", n: "grinning face", cat: "smileys", k: "grin smile happy" },
  { e: "😃", n: "grinning face with big eyes", cat: "smileys", k: "grin smile happy" },
  { e: "😄", n: "grinning face with smiling eyes", cat: "smileys", k: "grin laugh" },
  { e: "😁", n: "beaming face with smiling eyes", cat: "smileys", k: "grin teeth" },
  { e: "😆", n: "grinning squinting face", cat: "smileys", k: "laugh haha" },
  { e: "😅", n: "grinning face with sweat", cat: "smileys", k: "laugh nervous" },
  { e: "🤣", n: "rolling on the floor laughing", cat: "smileys", k: "rofl lol" },
  { e: "😂", n: "face with tears of joy", cat: "smileys", k: "lol laugh" },
  { e: "🙂", n: "slightly smiling face", cat: "smileys", k: "smile" },
  { e: "🙃", n: "upside-down face", cat: "smileys", k: "silly" },
  { e: "😉", n: "winking face", cat: "smileys", k: "wink" },
  { e: "😊", n: "smiling face with smiling eyes", cat: "smileys", k: "blush happy" },
  { e: "😇", n: "smiling face with halo", cat: "smileys", k: "angel" },
  { e: "😍", n: "smiling face with heart-eyes", cat: "smileys", k: "love" },
  { e: "🥰", n: "smiling face with hearts", cat: "smileys", k: "love" },
  { e: "😘", n: "face blowing a kiss", cat: "smileys", k: "kiss" },
  { e: "😗", n: "kissing face", cat: "smileys", k: "kiss" },
  { e: "😋", n: "face savoring food", cat: "smileys", k: "yum" },
  { e: "😜", n: "winking face with tongue", cat: "smileys", k: "silly" },
  { e: "😝", n: "squinting face with tongue", cat: "smileys", k: "silly" },
  { e: "😎", n: "smiling face with sunglasses", cat: "smileys", k: "cool" },
  { e: "🤓", n: "nerd face", cat: "smileys", k: "geek" },
  { e: "🫠", n: "melting face", cat: "smileys", k: "melt" },
  { e: "😏", n: "smirking face", cat: "smileys", k: "smirk" },
  { e: "😒", n: "unamused face", cat: "smileys", k: "meh" },
  { e: "🙄", n: "face with rolling eyes", cat: "smileys", k: "eyeroll" },
  { e: "😔", n: "pensive face", cat: "smileys", k: "sad" },
  { e: "😢", n: "crying face", cat: "smileys", k: "sad cry" },
  { e: "😭", n: "loudly crying face", cat: "smileys", k: "sad cry" },
  { e: "😤", n: "face with steam from nose", cat: "smileys", k: "angry" },
  { e: "😡", n: "pouting face", cat: "smileys", k: "angry mad" },
  { e: "🤬", n: "face with symbols on mouth", cat: "smileys", k: "angry swearing" },
  { e: "😱", n: "face screaming in fear", cat: "smileys", k: "scared" },
  { e: "😴", n: "sleeping face", cat: "smileys", k: "sleep" },
  { e: "🤯", n: "exploding head", cat: "smileys", k: "mind blown" },
  { e: "🤔", n: "thinking face", cat: "smileys", k: "think" },
  { e: "🫡", n: "saluting face", cat: "smileys", k: "salute" },

  // People / gestures
  { e: "👍", n: "thumbs up", cat: "people", k: "like yes" },
  { e: "👎", n: "thumbs down", cat: "people", k: "dislike no" },
  { e: "👋", n: "waving hand", cat: "people", k: "hello hi bye" },
  { e: "👏", n: "clapping hands", cat: "people", k: "clap" },
  { e: "🙏", n: "folded hands", cat: "people", k: "pray thanks" },
  { e: "🤝", n: "handshake", cat: "people", k: "deal" },
  { e: "💪", n: "flexed biceps", cat: "people", k: "strong" },
  { e: "🫶", n: "heart hands", cat: "people", k: "love" },
  { e: "✌️", n: "victory hand", cat: "people", k: "peace" },
  { e: "🤘", n: "sign of the horns", cat: "people", k: "rock" },
  { e: "🤙", n: "call me hand", cat: "people", k: "phone" },

  // Animals
  { e: "🐶", n: "dog", cat: "animals", k: "pet" },
  { e: "🐱", n: "cat", cat: "animals", k: "pet" },
  { e: "🐭", n: "mouse", cat: "animals", k: "animal" },
  { e: "🐹", n: "hamster", cat: "animals", k: "animal" },
  { e: "🐰", n: "rabbit", cat: "animals", k: "bunny" },
  { e: "🦊", n: "fox", cat: "animals", k: "animal" },
  { e: "🐻", n: "bear", cat: "animals", k: "animal" },
  { e: "🐼", n: "panda", cat: "animals", k: "animal" },
  { e: "🐸", n: "frog", cat: "animals", k: "animal" },
  { e: "🦄", n: "unicorn", cat: "animals", k: "magic" },
  { e: "🐔", n: "chicken", cat: "animals", k: "animal" },
  { e: "🐧", n: "penguin", cat: "animals", k: "animal" },
  { e: "🐢", n: "turtle", cat: "animals", k: "animal" },

  // Food
  { e: "🍕", n: "pizza", cat: "food", k: "food" },
  { e: "🍔", n: "hamburger", cat: "food", k: "food" },
  { e: "🌮", n: "taco", cat: "food", k: "food" },
  { e: "🍟", n: "fries", cat: "food", k: "food" },
  { e: "🍣", n: "sushi", cat: "food", k: "food" },
  { e: "🍪", n: "cookie", cat: "food", k: "food" },
  { e: "🍩", n: "doughnut", cat: "food", k: "food" },
  { e: "☕", n: "hot beverage", cat: "food", k: "coffee" },
  { e: "🍺", n: "beer", cat: "food", k: "drink" },

  // Activities
  { e: "🎮", n: "video game", cat: "activity", k: "gaming" },
  { e: "🎧", n: "headphone", cat: "activity", k: "music" },
  { e: "🎸", n: "guitar", cat: "activity", k: "music" },
  { e: "🏆", n: "trophy", cat: "activity", k: "win" },
  { e: "⚽", n: "soccer", cat: "activity", k: "sports" },
  { e: "🏀", n: "basketball", cat: "activity", k: "sports" },

  // Travel / places
  { e: "🚗", n: "car", cat: "travel", k: "drive" },
  { e: "✈️", n: "airplane", cat: "travel", k: "flight" },
  { e: "🗺️", n: "map", cat: "travel", k: "travel" },
  { e: "🏠", n: "house", cat: "travel", k: "home" },
  { e: "🌎", n: "globe", cat: "travel", k: "world" },

  // Objects
  { e: "📎", n: "paperclip", cat: "objects", k: "file" },
  { e: "📷", n: "camera", cat: "objects", k: "photo" },
  { e: "📱", n: "mobile phone", cat: "objects", k: "phone" },
  { e: "💻", n: "laptop", cat: "objects", k: "computer" },
  { e: "🖥️", n: "desktop computer", cat: "objects", k: "computer" },
  { e: "⌨️", n: "keyboard", cat: "objects", k: "computer" },
  { e: "🖱️", n: "mouse", cat: "objects", k: "computer" },
  { e: "🔒", n: "lock", cat: "objects", k: "security" },
  { e: "🔑", n: "key", cat: "objects", k: "security" },
  { e: "🧲", n: "magnet", cat: "objects", k: "torrent magnet" },

  // Symbols
  { e: "❤️", n: "red heart", cat: "symbols", k: "love" },
  { e: "💔", n: "broken heart", cat: "symbols", k: "sad" },
  { e: "✨", n: "sparkles", cat: "symbols", k: "sparkle" },
  { e: "🔥", n: "fire", cat: "symbols", k: "lit" },
  { e: "✅", n: "check", cat: "symbols", k: "ok" },
  { e: "❌", n: "cross mark", cat: "symbols", k: "no" },
  { e: "⚠️", n: "warning", cat: "symbols", k: "warn" },
  { e: "💯", n: "hundred points", cat: "symbols", k: "100" },
  { e: "⭐", n: "star", cat: "symbols", k: "favorite" }
];

const EMOJI_CATS = [
  { id: "recent", icon: "🕘", label: "Recent" },
  { id: "smileys", icon: "😀", label: "Smileys" },
  { id: "people", icon: "👍", label: "People" },
  { id: "animals", icon: "🐶", label: "Animals" },
  { id: "food", icon: "🍕", label: "Food" },
  { id: "activity", icon: "🎮", label: "Activity" },
  { id: "travel", icon: "✈️", label: "Travel" },
  { id: "objects", icon: "💻", label: "Objects" },
  { id: "symbols", icon: "❤️", label: "Symbols" }
];

function loadRecentEmojis() {
  const arr = Settings.get(EMOJI_RECENT_KEY, []);
  return Array.isArray(arr) ? arr.filter(x => typeof x === "string" && x.length <= 8) : [];
}

function bumpRecentEmoji(emoji) {
  try {
    const cur = loadRecentEmojis();
    const next = [emoji, ...cur.filter(e => e !== emoji)].slice(0, 24);
    Settings.set(EMOJI_RECENT_KEY, next);
  } catch { /* ignore */ }
}

function insertAtCursor(inputEl, text) {
  if (!inputEl) return;
  const v = String(inputEl.value || "");
  const start = (typeof inputEl.selectionStart === "number") ? inputEl.selectionStart : v.length;
  const end = (typeof inputEl.selectionEnd === "number") ? inputEl.selectionEnd : v.length;
  const next = v.slice(0, start) + text + v.slice(end);
  inputEl.value = next;
  const pos = start + text.length;
  try { inputEl.setSelectionRange(pos, pos); } catch { /* ignore */ }
  inputEl.focus();
  try { inputEl.dispatchEvent(new Event("input", { bubbles: true })); } catch { /* ignore */ }
}

const EmojiUI = {
  pop: null,
  search: null,
  tabs: null,
  grid: null,
  empty: null,
  activeInput: null,
  activeAnchor: null,
  activeCat: "recent",
  visible: false
};

function ensureEmojiPopover() {
  if (EmojiUI.pop) return EmojiUI.pop;

  const pop = document.createElement("div");
  pop.id = "ecEmojiPopover";
  pop.className = "ec-emojiPopover hidden";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Emoticons");

  const head = document.createElement("div");
  head.className = "ec-emojiHead";

  const search = document.createElement("input");
  search.type = "text";
  search.className = "ec-emojiSearch";
  search.placeholder = "Search emoticons…";
  search.autocomplete = "off";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "ec-emojiClose";
  close.title = "Close";
  close.textContent = "×";

  head.appendChild(search);
  head.appendChild(close);

  const tabs = document.createElement("div");
  tabs.className = "ec-emojiTabs";

  EMOJI_CATS.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ec-emojiTab";
    b.dataset.cat = c.id;
    b.title = c.label;
    b.textContent = c.icon;
    tabs.appendChild(b);
  });

  const grid = document.createElement("div");
  grid.className = "ec-emojiGrid";

  const empty = document.createElement("div");
  empty.className = "ec-emojiEmpty hidden";
  empty.textContent = "No matches";

  pop.appendChild(head);
  pop.appendChild(tabs);
  pop.appendChild(grid);
  pop.appendChild(empty);
  document.body.appendChild(pop);

  const setActiveTab = (cat) => {
    EmojiUI.activeCat = cat;
    tabs.querySelectorAll(".ec-emojiTab").forEach((el) => {
      el.classList.toggle("active", el.dataset.cat === cat);
    });
  };

  const getList = () => {
    const q = (search.value || "").trim().toLowerCase();
    if (q) {
      return EMOJI_DB.filter((x) => {
        const hay = `${x.n} ${x.k}`.toLowerCase();
        return hay.includes(q) || x.e.includes(q);
      });
    }
    if (EmojiUI.activeCat === "recent") {
      const rec = loadRecentEmojis();
      const map = new Map(EMOJI_DB.map(x => [x.e, x]));
      const out = [];
      rec.forEach((e) => {
        const obj = map.get(e);
        if (obj) out.push(obj);
        else out.push({ e, n: "recent", cat: "recent", k: "" });
      });
      // If nothing yet, show a few defaults.
      if (!out.length) {
        return EMOJI_DB.filter(x => x.cat === "smileys").slice(0, 24);
      }
      return out;
    }
    return EMOJI_DB.filter(x => x.cat === EmojiUI.activeCat);
  };

  const render = () => {
    const list = getList();
    grid.innerHTML = "";
    if (!list.length) {
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    list.slice(0, 240).forEach((x) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ec-emojiCell";
      b.textContent = x.e;
      b.title = x.n;
      b.onclick = () => {
        if (EmojiUI.activeInput) insertAtCursor(EmojiUI.activeInput, x.e);
        bumpRecentEmoji(x.e);
        closeEmojiPicker();
      };
      grid.appendChild(b);
    });
  };

  const position = () => {
    if (!EmojiUI.activeAnchor) return;
    const r = EmojiUI.activeAnchor.getBoundingClientRect();
    const w = 320;
    const h = 320;
    let left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    let top = r.top - h - 8;
    if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  };

  const open = () => {
    setActiveTab(EmojiUI.activeCat || "recent");
    render();
    position();
    pop.classList.remove("hidden");
    EmojiUI.visible = true;
    setTimeout(() => search.focus(), 0);
  };

  const closeFn = () => closeEmojiPicker();

  // Events
  close.onclick = closeFn;
  tabs.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (!t.dataset.cat) return;
    setActiveTab(t.dataset.cat);
    search.value = "";
    render();
    search.focus();
  });
  search.addEventListener("input", render);
  search.addEventListener("keydown", (e) => { if (e.key === "Escape") closeFn(); });

  // One global outside-click handler
  if (!document.body.dataset.ecEmojiOutsideBound) {
    document.body.dataset.ecEmojiOutsideBound = "1";
    document.addEventListener("mousedown", (e) => {
      if (!EmojiUI.visible || !EmojiUI.pop) return;
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (EmojiUI.pop.contains(t)) return;
      if (EmojiUI.activeAnchor && EmojiUI.activeAnchor.contains(t)) return;
      closeEmojiPicker();
    });
    window.addEventListener("resize", () => { if (EmojiUI.visible) closeEmojiPicker(); });
    window.addEventListener("scroll", () => { if (EmojiUI.visible) closeEmojiPicker(); }, true);
    document.addEventListener("keydown", (e) => { if (EmojiUI.visible && e.key === "Escape") closeEmojiPicker(); });
  }

  // Expose for openEmojiPicker
  EmojiUI.pop = pop;
  EmojiUI.search = search;
  EmojiUI.tabs = tabs;
  EmojiUI.grid = grid;
  EmojiUI.empty = empty;
  pop._ecOpen = open;
  pop._ecRender = render;
  pop._ecPosition = position;
  return pop;
}

function openEmojiPicker(anchorEl, inputEl) {
  const pop = ensureEmojiPopover();
  EmojiUI.activeInput = inputEl || null;
  EmojiUI.activeAnchor = anchorEl || null;
  EmojiUI.activeCat = "recent";
  if (EmojiUI.search) EmojiUI.search.value = "";
  pop._ecOpen && pop._ecOpen();
}

function closeEmojiPicker() {
  if (!EmojiUI.pop) return;
  EmojiUI.pop.classList.add("hidden");
  EmojiUI.visible = false;
  EmojiUI.activeInput = null;
  EmojiUI.activeAnchor = null;
}

function bindEmojiButton(btnEl, inputEl) {
  if (!btnEl || !inputEl) return;
  if (btnEl.dataset.ecEmojiBound === "1") return;
  btnEl.dataset.ecEmojiBound = "1";
  btnEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openEmojiPicker(btnEl, inputEl);
  });
}



// ───────────────────────────────────────────────────────────────────────────────
// GIF picker (GIPHY)
// ───────────────────────────────────────────────────────────────────────────────
const GifUI = {
  modal: null,
  card: null,
  closeBtn: null,
  search: null,
  searchBtn: null,
  status: null,
  grid: null,
  onPick: null,
  visible: false,
};

function ensureGifPicker() {
  if (GifUI.modal) return GifUI.modal;

  const overlay = document.createElement('div');
  overlay.id = 'ecGifPicker';
  overlay.className = 'ym-gifPicker hidden';

  overlay.innerHTML = `
    <div class="ym-gifCard" role="dialog" aria-modal="true" aria-label="GIF picker">
      <div class="ym-gifHead">
        <div class="ym-gifTitle">GIFs</div>
        <button type="button" class="winBtn danger ym-gifClose" title="Close">×</button>
      </div>
      <div class="ym-gifSearchRow">
        <input class="ym-gifSearch" type="text" placeholder="Search GIPHY…" autocomplete="off" />
        <button type="button" class="ym-send ym-gifSearchBtn">Search</button>
      </div>
      <div class="ym-gifStatus"></div>
      <div class="ym-gifGrid" aria-label="GIF results"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  GifUI.modal = overlay;
  GifUI.card = overlay.querySelector('.ym-gifCard');
  GifUI.closeBtn = overlay.querySelector('.ym-gifClose');
  GifUI.search = overlay.querySelector('.ym-gifSearch');
  GifUI.searchBtn = overlay.querySelector('.ym-gifSearchBtn');
  GifUI.status = overlay.querySelector('.ym-gifStatus');
  GifUI.grid = overlay.querySelector('.ym-gifGrid');

  const close = () => closeGifPicker();

  GifUI.closeBtn?.addEventListener('click', (e) => { e.preventDefault(); close(); });
  overlay.addEventListener('mousedown', (e) => {
    // click outside the card closes
    const tgt = e.target;
    if (!tgt) return;
    if (tgt === overlay) close();
  });

  const doSearch = () => {
    const q = GifUI.search?.value?.trim() || '';
    gifSearch(q);
  };

  GifUI.searchBtn?.addEventListener('click', (e) => { e.preventDefault(); doSearch(); });
  GifUI.search?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
    if (e.key === 'Escape') close();
  });

  // One-time global escape binding
  if (!document.body.dataset.ecGifEscapeBound) {
    document.body.dataset.ecGifEscapeBound = '1';
    document.addEventListener('keydown', (e) => {
      if (GifUI.visible && e.key === 'Escape') closeGifPicker();
    });
  }

  return overlay;
}

function openGifPicker(onPick, { prefill = '' } = {}) {
  const modal = ensureGifPicker();
  GifUI.onPick = (typeof onPick === 'function') ? onPick : null;

  if (GifUI.search) {
    GifUI.search.value = String(prefill || '');
    try { GifUI.search.focus(); GifUI.search.select(); } catch {}
  }

  // Show
  modal.classList.remove('hidden');
  GifUI.visible = true;

  // Auto-search on open if prefilled
  const q = (GifUI.search?.value || '').trim();
  if (q) gifSearch(q);
  else {
    if (GifUI.grid) GifUI.grid.innerHTML = '';
    if (GifUI.status) GifUI.status.textContent = 'Type a search, then hit Enter.';
  }
}

function closeGifPicker() {
  if (!GifUI.modal) return;
  GifUI.modal.classList.add('hidden');
  GifUI.visible = false;
  GifUI.onPick = null;
}

async function gifSearch(query) {
  const q = (query || '').trim();
  if (!GifUI.status || !GifUI.grid) return;

  if (!q) {
    GifUI.grid.innerHTML = '';
    GifUI.status.textContent = 'Type a search, then hit Enter.';
    return;
  }

  GifUI.status.textContent = 'Searching…';
  GifUI.grid.innerHTML = '';

  try {
    const resp = await fetchWithAuth(`/api/gifs/search?q=${encodeURIComponent(q)}&limit=24`, { method: 'GET' });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.success) {
      const msg = data?.error || `HTTP ${resp.status}`;
      GifUI.status.textContent = `❌ ${msg}`;
      return;
    }

    const arr = Array.isArray(data?.data) ? data.data : [];
    if (!arr.length) {
      GifUI.status.textContent = 'No results.';
      return;
    }

    GifUI.status.textContent = `${arr.length} result(s)`;

    arr.forEach((g) => {
      const url = String(g?.url || '').trim();
      const pv = String(g?.preview || url).trim();
      if (!url) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ym-gifItem';
      btn.title = (g?.title || 'GIF').toString().slice(0, 120);

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.src = pv || url;
      img.alt = 'GIF';

      img.onerror = () => {
        const fb = _gifFallbackUrl(url) || _gifFallbackUrl(pv);
        if (fb && img.src !== fb) img.src = _gifCacheBust(fb);
      };
      btn.appendChild(img);
      btn.onclick = () => {
        try {
          if (GifUI.onPick) GifUI.onPick(url);
        } finally {
          closeGifPicker();
        }
      };

      GifUI.grid.appendChild(btn);
    });
  } catch (e) {
    console.error(e);
    GifUI.status.textContent = '❌ GIF search failed.';
  }
}

function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(";").shift();
  return null;
}

