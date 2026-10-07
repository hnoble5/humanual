// Humanual coach UI. Plain JS, no build step.
// Everything the user writes is stored in this browser (localStorage) and sent
// to /api/chat with each message. The server keeps nothing.

const COACHES = {
  junie: {
    name: "Junie",
    initial: "J",
    line: "Calm and seasoned. Has read every etiquette book and kept only what works.",
    best: "Best at: decoding confusing messages, calming spirals, family and friends.",
  },
  otis: {
    name: "Otis",
    initial: "O",
    line: "Dry and no-nonsense. Explains people like a bug report: what happened, why, the fix.",
    best: "Best at: workplace conflict, getting off calls, spotting manipulation, tightening emails.",
  },
};

const ICONS = {
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  work: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 15c2 .7 3.2 2.3 3.5 5"/>',
  reply: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
  practice: '<path d="M4 6h10v7H8l-4 3z"/><path d="M14 10h6v7l-3-2h-5v-2"/>',
  chat: '<circle cx="12" cy="12" r="9"/><path d="M8 10h.01M12 10h.01M16 10h.01"/>',
};

const MODES = {
  everyday: {
    label: "Everyday comfort",
    desc: "Calls, errands, appointments, strangers. Scripts, prep cards, debriefs.",
    icon: "phone",
    placeholder: "e.g. I need to call the dentist to reschedule and I've been putting it off…",
  },
  workplace: {
    label: "Workplace conflict",
    desc: "A tense coworker, blame, credit-taking, a hard meeting.",
    icon: "work",
    placeholder: "What happened? Who was involved, and what did they say or do?",
  },
  networking: {
    label: "Networking prep",
    desc: "An event, intro, or meeting with a client or prospect.",
    icon: "people",
    placeholder: "Who are you meeting, and what do you want out of it?",
  },
  reply: {
    label: "Draft a reply",
    desc: "Paste a text, email, or Slack message you need to answer.",
    icon: "reply",
    placeholder: "Paste the message here (and your draft, if you have one)…",
  },
  practice: {
    label: "Get me ready",
    desc: "A script, likely responses, and tips. Rehearse it too, if you want.",
    icon: "practice",
    placeholder: "Who should the coach play, and what's the situation?",
  },
  open: {
    label: "Just talk it through",
    desc: "Not sure what you need yet? Start here.",
    icon: "chat",
    placeholder: "What's going on?",
  },
};

// The public demo (/demo) runs this same app on recorded sample data (see the
// demo section below). It never calls /api and saves nothing, not even in this
// browser, so a reload starts it fresh.
const DEMO = /^\/demo(\/|$)/.test(location.pathname);

// ---------- storage ----------

// Each signed-in person gets their own keys, so two people sharing a browser
// never see each other's data. Without accounts (uid null) the original keys
// are used, which is also where data saved before accounts existed lives.
let uid = null;
const LEGACY = { settings: "humanual.settings.v1", convos: "humanual.convos.v1", scripts: "humanual.scripts.v1" };
const keyFor = (name) => (uid ? `humanual.u.${uid}.${name}.v1` : LEGACY[name] ?? `humanual.${name}.v1`);

function load(key, fallback) {
  if (DEMO) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  if (DEMO) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the app keeps working for this session.
  }
}

let settings = null;
let convos = [];
let scripts = [];
let current = null; // the open conversation (may be an unsaved draft)
let busy = null;    // AbortController while a reply is streaming
let accessCodeRequired = false;

const saveSettings = () => save(keyFor("settings"), settings);
const saveConvos = () => save(keyFor("convos"), convos);
const saveScripts = () => save(keyFor("scripts"), scripts);

function loadUserData() {
  settings = load(keyFor("settings"), null);
  convos = load(keyFor("convos"), []);
  scripts = load(keyFor("scripts"), []);
}

// ---------- account & sync ----------
//
// The browser keeps a full copy of the user's data so the app opens instantly
// and works offline. Every change is also queued in an "outbox" and sent to
// /api/sync, which returns what other devices changed since our last sync.
// Per item, the newest edit wins.

let authMode = "none";   // "clerk" | "dev" | "none" (no accounts: browser only)
let clerk = null;        // Clerk instance when authMode is "clerk"
let outbox = {};         // "kind:id" -> { updated_at, deleted }
let syncCursor = 0;
let syncing = null;      // the in-flight sync, if any
let syncAgain = false;
let syncTimer = 0;
const syncEnabled = () => Boolean(uid) && authMode !== "none";

function setSyncStatus(text) {
  const node = $("#sync-status");
  if (node) node.textContent = text;
}

async function authHeaders() {
  const h = { "content-type": "application/json", "x-access-code": settings?.accessCode || "" };
  if (authMode === "clerk" && clerk?.session) h.authorization = `Bearer ${await clerk.session.getToken()}`;
  if (authMode === "dev") h["x-dev-user"] = load("humanual.devUser", "");
  return h;
}

function itemTime(kind, item) {
  return kind === "script" ? item.updated ?? item.created ?? 0 : item.updated ?? 0;
}

// The profile syncs without the access code, which is a per-device beta gate.
function profileData() {
  const { accessCode, ...rest } = settings ?? {};
  return rest;
}

function markDirty(kind, id, { deleted = false, at = Date.now() } = {}) {
  if (!syncEnabled()) return;
  outbox[`${kind}:${id}`] = { updated_at: at, deleted };
  save(keyFor("outbox"), outbox);
  setSyncStatus("Saving…");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 1500);
}

function pendingChanges() {
  const changes = [];
  for (const [key, entry] of Object.entries(outbox)) {
    const [kind, id] = key.split(":");
    if (entry.deleted) {
      changes.push({ kind, id, data: null, deleted: true, updated_at: entry.updated_at });
      continue;
    }
    const data = kind === "profile" ? (settings ? profileData() : null)
      : kind === "convo" ? convos.find((c) => c.id === id)
      : scripts.find((x) => x.id === id);
    if (data) changes.push({ kind, id, data, deleted: false, updated_at: entry.updated_at });
    else delete outbox[key]; // nothing left to send
  }
  return changes.slice(0, 200);
}

async function syncNow() {
  if (!syncEnabled()) return;
  if (syncing) { syncAgain = true; return syncing; }
  syncing = (async () => {
    setSyncStatus("Syncing…");
    try {
      let more = true;
      while (more) {
        const changes = pendingChanges();
        const res = await fetch("/api/sync", {
          method: "POST",
          headers: await authHeaders(),
          body: JSON.stringify({ since: syncCursor, changes }),
        });
        if (res.status === 401) {
          const data = await res.json().catch(() => ({}));
          setSyncStatus(data.code === "access" ? "Not synced: enter the access code" : "Not synced: sign in again");
          return;
        }
        if (!res.ok) throw new Error(`sync ${res.status}`);
        const data = await res.json();
        // Clear what we sent, unless it was edited again while in flight.
        for (const c of changes) {
          const key = `${c.kind}:${c.id}`;
          if (outbox[key]?.updated_at === c.updated_at) delete outbox[key];
        }
        save(keyFor("outbox"), outbox);
        applyRemote(data.items);
        syncCursor = data.cursor;
        save(keyFor("cursor"), syncCursor);
        more = data.more || Object.keys(outbox).length > 0 && changes.length === 200;
      }
      setSyncStatus(Object.keys(outbox).length ? "Saving…" : "Synced");
    } catch {
      setSyncStatus(navigator.onLine ? "Not synced yet. Saved on this device." : "Offline. Saved on this device.");
    } finally {
      syncing = null;
      if (syncAgain) { syncAgain = false; syncNow(); }
    }
  })();
  return syncing;
}

// Merges items from other devices into the local copy.
function applyRemote(items) {
  if (!items?.length) return;
  let changedConvos = false, changedScripts = false, changedProfile = false;
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    // A local edit not yet sent that's newer than this one wins.
    if (outbox[key] && outbox[key].updated_at > item.updated_at) continue;

    if (item.kind === "profile") {
      if (item.deleted || !item.data) continue;
      if (!settings || (settings.updated ?? 0) < item.updated_at) {
        settings = { ...item.data, accessCode: settings?.accessCode || "" };
        changedProfile = true;
      }
    } else if (item.kind === "convo") {
      // Never swap out a conversation while a reply is streaming into it.
      if (busy && current?.id === item.id) continue;
      const i = convos.findIndex((c) => c.id === item.id);
      const local = convos[i];
      if (local && itemTime("convo", local) > item.updated_at) continue;
      if (item.deleted) {
        if (i >= 0) { convos.splice(i, 1); changedConvos = true; }
      } else {
        if (i >= 0) convos[i] = item.data; else convos.push(item.data);
        if (current?.id === item.id) current = item.data;
        changedConvos = true;
      }
    } else if (item.kind === "script") {
      const i = scripts.findIndex((x) => x.id === item.id);
      const local = scripts[i];
      if (local && itemTime("script", local) > item.updated_at) continue;
      if (item.deleted) {
        if (i >= 0) { scripts.splice(i, 1); changedScripts = true; }
      } else {
        if (i >= 0) scripts[i] = item.data; else scripts.push(item.data);
        changedScripts = true;
      }
    }
  }

  if (changedProfile) saveSettings();
  if (changedConvos) {
    convos.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    saveConvos();
  }
  if (changedScripts) {
    scripts.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    saveScripts();
  }
  if ($("#app").hidden) return;
  if (changedConvos || changedProfile) {
    // The open conversation was deleted on another device: move on.
    if (current && current.messages.length && !convos.some((c) => c.id === current.id)) {
      if (convos[0]) openConvo(convos[0].id); else newConvo();
    } else if (!busy) {
      render();
    } else {
      renderConvoList();
    }
  }
  if (changedScripts && view === "scripts") {
    renderSavedList();
    const shown = scripts.find((x) => x.id === shownScriptId);
    if (shownScriptId && shownScriptId !== "example") showScript(shown ?? scripts[0] ?? EXAMPLE_SCRIPT);
  }
}

// Data saved in this browser before accounts existed moves into the account.
function adoptLegacyData() {
  const legacySettings = load(LEGACY.settings, null);
  const legacyConvos = load(LEGACY.convos, []);
  const legacyScripts = load(LEGACY.scripts, []);
  if (!legacySettings && !legacyConvos.length && !legacyScripts.length) return;

  if (legacySettings && !settings) settings = { ...legacySettings, updated: legacySettings.updated ?? 1 };
  for (const c of legacyConvos) if (!convos.some((x) => x.id === c.id)) convos.push(c);
  for (const x of legacyScripts) if (!scripts.some((y) => y.id === x.id)) scripts.push(x);
  convos.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  scripts.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  saveSettings(); saveConvos(); saveScripts();

  if (settings) markDirty("profile", "me", { at: settings.updated ?? Date.now() });
  for (const c of legacyConvos) markDirty("convo", c.id, { at: itemTime("convo", c) || Date.now() });
  for (const x of legacyScripts) markDirty("script", x.id, { at: itemTime("script", x) || Date.now() });
  try {
    for (const k of Object.values(LEGACY)) localStorage.removeItem(k);
  } catch {}
}

async function enterAs(userId, { prefillName = "" } = {}) {
  uid = userId;
  if (uid) save("humanual.lastUser", uid);
  loadUserData();
  outbox = load(keyFor("outbox"), {});
  syncCursor = load(keyFor("cursor"), 0);
  $("#signin").hidden = true;

  if (syncEnabled()) {
    adoptLegacyData();
    // A new device has nothing local yet: wait briefly for the account's data
    // so we don't show the welcome screen to someone who already set up.
    await Promise.race([syncNow(), new Promise((r) => setTimeout(r, 8000))]);
    window.addEventListener("online", () => syncNow());
    document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow(); });
    setInterval(() => { if (!document.hidden) syncNow(); }, 60_000);
  }
  renderAccount();

  if (settings?.name) {
    startApp();
    if (location.hash === "#scripts") showView("scripts");
  } else {
    showOnboarding(prefillName);
  }
}

function renderAccount() {
  const box = $("#account");
  box.hidden = !syncEnabled();
  if (!syncEnabled()) return;
  const who = authMode === "clerk"
    ? clerk?.user?.primaryEmailAddress?.emailAddress ?? "Signed in"
    : `Test user: ${load("humanual.devUser", "")}`;
  $("#account-email").textContent = who;
  $("#manage-account").hidden = authMode !== "clerk";
}

async function signOut() {
  if (Object.keys(outbox).length) {
    await syncNow();
    if (Object.keys(outbox).length &&
        !confirm("Some changes haven't synced yet and will be lost from this device if you sign out now. Sign out anyway?")) return;
  }
  // Clear this person's copy from the device (shared computers).
  try {
    for (const name of ["settings", "convos", "scripts", "outbox", "cursor"]) localStorage.removeItem(keyFor(name));
    localStorage.removeItem("humanual.lastUser");
    if (authMode === "dev") localStorage.removeItem("humanual.devUser");
  } catch {}
  if (authMode === "clerk") await clerk.signOut();
  location.reload();
}

function loadClerk(publishableKey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6/dist/clerk.browser.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.dataset.clerkPublishableKey = publishableKey;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Couldn't load sign-in"));
    document.head.append(script);
  }).then(async () => {
    let c = window.Clerk;
    if (typeof c === "function") c = new c(publishableKey);
    await c.load();
    return c;
  });
}

function showSignIn() {
  $("#onboarding").hidden = true;
  $("#app").hidden = true;
  $("#signin").hidden = false;
  if (authMode === "clerk") {
    $("#dev-signin").hidden = true;
    clerk.mountSignIn($("#clerk-mount"));
  } else {
    $("#clerk-mount").hidden = true;
    $("#dev-signin").hidden = false;
    $("#dev-user").focus();
  }
}


// ---------- dom helpers ----------

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const avatar = (coach, size = "") => {
  const a = el("span", { class: `avatar ${size}`.trim(), "data-coach": coach, "aria-hidden": "true" });
  a.textContent = COACHES[coach].initial;
  return a;
};

// ---------- markdown (small and safe: escapes everything first) ----------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
}
function renderMarkdown(src) {
  const lines = src.replace(/\r/g, "").split("\n");
  const out = [];
  let list = null; // { tag, items }
  let para = [];
  let quote = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushAll(); continue; }
    if ((m = line.match(/^\s*(#{1,4})\s+(.*)$/))) { flushAll(); out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushAll(); out.push("<hr>"); continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flushPara(); flushQuote();
      if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; }
      list.items.push(m[1]); continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara(); flushQuote();
      if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; }
      list.items.push(m[1]); continue;
    }
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += " " + line.trim(); continue; }
    flushList(); flushQuote();
    para.push(line);
  }
  flushAll();
  return out.join("");
}

// ---------- onboarding ----------

function fillCoachPicker(container, name, selected) {
  container.replaceChildren();
  for (const [id, c] of Object.entries(COACHES)) {
    const card = $("#coach-card").content.firstElementChild.cloneNode(true);
    const input = card.querySelector("input");
    input.name = name;
    input.value = id;
    input.checked = id === selected;
    card.querySelector(".avatar").replaceWith(avatar(id));
    card.querySelector(".coach-name").textContent = c.name;
    card.querySelector(".coach-line").textContent = c.line;
    card.querySelector(".coach-best").textContent = c.best;
    container.append(card);
  }
}

function showOnboarding(prefillName = "") {
  $("#app").hidden = true;
  $("#signin").hidden = true;
  $("#onboarding").hidden = false;
  $("#ob-storage").textContent = syncEnabled()
    ? "Your conversations and profile are saved to your account, so they're on your phone and your laptop."
    : "Your conversations and profile are saved only in this browser.";
  fillCoachPicker($("#ob-coach"), "coach", "junie");
  if (prefillName && !$("#ob-name").value) $("#ob-name").value = prefillName;
  $("#ob-name").focus();
}

$("#onboard-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  settings = {
    name: form.get("name").trim(),
    coach: form.get("coach") || "junie",
    style: form.get("style") || "direct",
    about: "",
    work: "",
    people: "",
    accessCode: "",
    updated: Date.now(),
  };
  saveSettings();
  markDirty("profile", "me", { at: settings.updated });
  startApp();
  if (accessCodeRequired) openSettings({ focusAccess: true });
});

// ---------- app shell ----------

function startApp() {
  $("#onboarding").hidden = true;
  $("#app").hidden = false;
  renderConvoList();
  const latest = convos[0];
  if (latest && !DEMO) openConvo(latest.id);
  else newConvo();
}

function newConvo() {
  stopStreaming();
  current = {
    id: crypto.randomUUID(),
    title: "",
    coach: settings.coach,
    style: settings.style,
    mode: null,
    messages: [],
    crisis: false,
    updated: Date.now(),
  };
  render();
  closeSidebar();
  $("#input").focus();
}

function openConvo(id) {
  if (view !== "chat") showView("chat");
  stopStreaming();
  const c = convos.find((x) => x.id === id);
  if (!c) return newConvo();
  current = c;
  render();
  closeSidebar();
}

function persistCurrent() {
  current.updated = Date.now();
  if (!current.title) {
    const first = current.messages.find((m) => m.role === "user")?.content ?? "";
    current.title = first.replace(/\s+/g, " ").trim().slice(0, 60) || "New conversation";
  }
  convos = [current, ...convos.filter((c) => c.id !== current.id)];
  saveConvos();
  markDirty("convo", current.id, { at: current.updated });
  renderConvoList();
}

function deleteConvo(id) {
  const c = convos.find((x) => x.id === id);
  if (!c || !confirm(`Delete "${c.title}"? This can't be undone.`)) return;
  convos = convos.filter((x) => x.id !== id);
  saveConvos();
  markDirty("convo", id, { deleted: true });
  if (current?.id === id) {
    if (convos[0]) openConvo(convos[0].id);
    else newConvo();
  } else {
    renderConvoList();
  }
}

function relTime(ts) {
  const d = new Date(ts);
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  if (days < 1 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderConvoList() {
  const list = $("#convo-list");
  list.replaceChildren();
  if (!convos.length) {
    list.append(el("p", { class: "fineprint", text: "Your conversations will show up here." }));
    return;
  }
  for (const c of convos) {
    const item = el("div", { class: "convo-item", "aria-current": String(c.id === current?.id) }, [
      el("button", { class: "open", onclick: () => openConvo(c.id) }, [
        el("span", { class: "title", text: c.title }),
        el("span", { class: "meta", text: `${COACHES[c.coach].name} · ${c.mode ? MODES[c.mode].label : "Open"} · ${relTime(c.updated)}` }),
      ]),
      el("button", { class: "icon-btn del", "aria-label": `Delete ${c.title}`, onclick: () => deleteConvo(c.id),
        html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>' }),
    ]);
    list.append(item);
  }
}

// ---------- rendering the open conversation ----------

function render() {
  const c = current;
  const coach = COACHES[c.coach];
  const started = c.messages.length > 0;

  $("#topbar-coach").replaceChildren(
    avatar(c.coach, "sm"),
    el("span", {}, [document.createTextNode(coach.name + " "), el("span", { class: "sub", text: `· ${c.style === "direct" ? "Direct" : "Gentle"}` })]),
  );
  $("#mode-tag").hidden = !c.mode || c.mode === "open";
  $("#mode-tag").textContent = c.mode ? MODES[c.mode].label : "";
  $("#crisis-banner").hidden = !c.crisis;
  $("#practice-chips").hidden = c.mode !== "practice" || !started || DEMO;
  $("#input").placeholder = MODES[c.mode ?? "open"].placeholder;
  if (DEMO) renderDemoNext();

  $("#start").hidden = started;
  if (!started) renderStart();

  const list = $("#messages");
  list.replaceChildren();
  for (const m of c.messages) list.append(messageEl(m));
  renderConvoList();
  scrollToBottom(true);
}

function renderStart() {
  const c = current;
  $("#start-avatar").replaceWith(Object.assign(avatar(c.coach, "xl"), { id: "start-avatar" }));
  $("#start-title").textContent = `Hi ${settings.name}. What are we working on?`;
  $("#start-sub").textContent = DEMO
    ? "Tap a sample below to watch a real reply. Pick a topic to narrow the list."
    : `Pick one, or just start typing. ${COACHES[c.coach].name} will figure it out.`;
  $("#demo-samples").hidden = !DEMO;
  $(".start-settings").hidden = DEMO;
  if (DEMO) renderDemoSamples();

  // The demo has a recorded rehearsal instead of the practice setup.
  const practicing = c.mode === "practice" && !DEMO;
  $("#practice-setup").hidden = !practicing;
  $("#mode-grid").hidden = practicing;
  if (practicing) renderPracticeSetup();

  const grid = $("#mode-grid");
  grid.replaceChildren();
  for (const [id, m] of Object.entries(MODES)) {
    const card = el("button", { class: "mode-card", type: "button", "aria-pressed": String(c.mode === id),
      onclick: () => {
        current.mode = id;
        render();
        $("#input").focus();
      } }, [
      el("span", { class: "icon", html: icon(m.icon) }),
      el("strong", { text: m.label }),
      el("span", { text: m.desc }),
    ]);
    if (c.mode === id) card.style.borderColor = "var(--accent)";
    grid.append(card);
  }

  const seg = (container, name, options, value, onChange) => {
    container.replaceChildren();
    for (const [v, label] of options) {
      const input = el("input", { type: "radio", name, value: v });
      input.checked = v === value;
      input.addEventListener("change", () => onChange(v));
      container.append(el("label", {}, [input, el("span", {}, [el("strong", { text: label })])]));
    }
  };
  seg($("#start-coach"), "start-coach", Object.entries(COACHES).map(([id, x]) => [id, x.name]), c.coach, (v) => { current.coach = v; render(); });
  seg($("#start-style"), "start-style", [["direct", "Direct"], ["gentle", "Gentle"]], c.style, (v) => { current.style = v; render(); });
}

// "Get me ready" setup: where it happens, then a common situation or their own,
// then either a script to keep (default) or a rehearsal with the coach.
function renderPracticeSetup() {
  const box = $("#practice-setup");
  const channel = current.practiceChannel ?? Object.keys(CHANNELS)[0];
  const coachName = COACHES[current.coach].name;

  const pick = el("div", { class: "channel-pick three", role: "radiogroup", "aria-label": "Where does it happen?" });
  for (const [id, ch] of Object.entries(CHANNELS)) {
    const input = el("input", { type: "radio", name: "practice-channel", value: id });
    input.checked = id === channel;
    input.addEventListener("change", () => {
      current.practiceChannel = id;
      current.practiceSituation = null;
      renderPracticeSetup();
    });
    pick.append(el("label", {}, [input, el("span", { html: `<svg viewBox="0 0 24 24" aria-hidden="true">${ch.icon}</svg>${escapeHtml(ch.label)}` })]));
  }

  const custom = el("textarea", { rows: "2", maxlength: "2000", id: "practice-custom",
    placeholder: "e.g. Asking my boss for a day off next Friday. He's usually fine but gets short when busy." });

  const list = el("div", { class: "situations" });
  const situationButtons = CHANNELS[channel].practice.map((situation) => {
    const btn = el("button", { type: "button", class: "situation", text: situation,
      "aria-pressed": String(current.practiceSituation === situation),
      onclick: () => {
        current.practiceSituation = situation;
        custom.value = "";
        for (const b of situationButtons) b.setAttribute("aria-pressed", String(b === btn));
        updateActions();
      } });
    return btn;
  });
  list.append(...situationButtons);

  // Typing your own replaces any picked situation.
  custom.addEventListener("input", () => {
    if (custom.value.trim()) {
      current.practiceSituation = null;
      for (const b of situationButtons) b.setAttribute("aria-pressed", "false");
    }
    updateActions();
  });

  const chosen = () => custom.value.trim() || current.practiceSituation;
  const scriptBtn = el("button", { class: "btn primary", type: "button", text: "Get my script",
    onclick: () => chosen() && getScriptFor(channel, chosen()) });
  const practiceBtn = el("button", { class: "btn", type: "button", text: `Practice it with ${coachName}`,
    onclick: () => chosen() && startPractice(channel, chosen()) });
  const hint = el("p", { class: "muted small", text: "Pick a situation or describe your own first." });
  function updateActions() {
    const ready = Boolean(chosen());
    scriptBtn.disabled = !ready;
    practiceBtn.disabled = !ready;
    hint.hidden = ready;
  }
  updateActions();

  box.replaceChildren(
    el("button", { type: "button", class: "linkback", text: "← All options", onclick: () => { current.mode = null; render(); } }),
    el("h3", { text: "Get me ready" }),
    el("p", { class: "muted", text: `Get a script with exact lines, likely responses, and tips to keep handy. Or rehearse it with ${coachName} first. Your choice.` }),
    el("p", { class: "step", text: "Where does it happen?" }),
    pick,
    el("p", { class: "step", text: "Pick a common situation" }),
    list,
    el("label", { for: "practice-custom", class: "step", text: "Or describe your own" }),
    custom,
    el("div", { class: "ready-actions" }, [scriptBtn, practiceBtn, hint]),
  );
}

// Hands the situation to the Scripts tool, which writes, shows, and saves the card.
function getScriptFor(channel, situation) {
  showView("scripts");
  const radio = $("#channel-pick").querySelector(`input[value="${channel}"]`);
  if (radio) radio.checked = true;
  renderExamples();
  $("#script-task").value = situation;
  $("#script-details").value = "";
  $("#script-form").requestSubmit();
}

function startPractice(channel, situation) {
  current.mode = "practice";
  current.practiceChannel = channel;
  send(
    `Get me ready for this. It happens ${CHANNELS[channel].phrase}.\n` +
    `Situation: ${situation}\n\n` +
    `Let's role-play it. Set the scene in one or two lines (who you're playing and what my goal is), then start in character.`
  );
}

function messageEl(m) {
  if (m.role === "user") {
    return el("li", { class: "msg user" }, [el("div", { class: "bubble", text: m.content })]);
  }
  const body = el("div", { class: "body" }, [
    el("div", { class: "who", text: COACHES[current.coach].name }),
    el("div", { class: "md", html: renderMarkdown(m.content) }),
  ]);
  body.append(el("div", { class: "msg-actions" }, [copyButton(() => m.content)]));
  return el("li", { class: "msg coach" }, [avatar(current.coach), body]);
}

function copyButton(getText) {
  const btn = el("button", { type: "button", html: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg><span>Copy</span>' });
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      btn.querySelector("span").textContent = "Copied";
    } catch {
      btn.querySelector("span").textContent = "Couldn't copy";
    }
    setTimeout(() => (btn.querySelector("span").textContent = "Copy"), 1500);
  });
  return btn;
}

function scrollToBottom(force = false) {
  const s = $("#scroller");
  const nearBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  if (force || nearBottom) s.scrollTop = s.scrollHeight;
}

// ---------- sending ----------

function setBusy(controller) {
  busy = controller;
  const btn = $("#send");
  btn.classList.toggle("stop", Boolean(controller));
  btn.setAttribute("aria-label", controller ? "Stop" : "Send");
  btn.innerHTML = controller
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>';
  for (const chip of document.querySelectorAll(".chip")) chip.disabled = Boolean(controller);
}

function stopStreaming() {
  busy?.abort();
  setBusy(null);
}

// If the last message is the user's (the reply failed or was never received),
// sending again would break turn order, so the new text is merged into it.
function send(text) {
  text = text.trim();
  if (!text || busy) return;
  const last = current.messages[current.messages.length - 1];
  if (last?.role === "user") last.content += "\n\n" + text;
  else current.messages.push({ role: "user", content: text });
  persistCurrent();
  $("#input").value = "";
  autosize();
  render();
  requestReply();
}

async function requestReply() {
  const c = current;
  const list = $("#messages");
  const mdNode = el("div", { class: "md", html: '<span class="typing" aria-label="Coach is typing"><i></i><i></i><i></i></span>' });
  const body = el("div", { class: "body" }, [el("div", { class: "who", text: COACHES[c.coach].name }), mdNode]);
  const li = el("li", { class: "msg coach" }, [avatar(c.coach), body]);
  list.append(li);
  scrollToBottom(true);

  const controller = new AbortController();
  setBusy(controller);
  if (DEMO) {
    try {
      await playDemoReply(c, mdNode, controller.signal);
    } finally {
      if (busy === controller) setBusy(null);
    }
    return;
  }
  let text = "";
  let frame = 0;
  const paint = () => {
    frame = 0;
    mdNode.innerHTML = renderMarkdown(text);
    scrollToBottom();
  };

  const fail = (message, { access = false } = {}) => {
    mdNode.replaceChildren(el("p", { class: "error" }, [
      document.createTextNode(message),
      access
        ? el("button", { class: "btn", type: "button", text: "Open settings", onclick: () => openSettings({ focusAccess: true }) })
        : el("button", { class: "btn", type: "button", text: "Try again", onclick: () => { li.remove(); requestReply(); } }),
    ]));
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      signal: controller.signal,
      headers: await authHeaders(),
      body: JSON.stringify({
        coach: c.coach,
        style: c.style,
        mode: c.mode && c.mode !== "open" ? c.mode : null,
        profile: { name: settings.name, about: settings.about, work: settings.work, people: settings.people },
        today: new Date().toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
        messages: c.messages,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      fail(data.error || `Something went wrong (${res.status}).`, { access: data.code === "access" });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let outcome = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.t === "text") {
          text += ev.v;
          if (!frame) frame = requestAnimationFrame(paint);
        } else if (ev.t === "crisis") {
          c.crisis = true;
          $("#crisis-banner").hidden = false;
        } else {
          outcome = ev;
        }
      }
    }
    if (frame) cancelAnimationFrame(frame);

    if (outcome?.t === "error") return fail(outcome.message);
    if (outcome?.t === "refusal") {
      return fail("The coach couldn't answer that one. Try rephrasing, or start a new conversation.");
    }
    if (!text.trim()) return fail("The coach didn't reply. Try again.");
    if (!outcome) text += "\n\n_(Reply was cut off.)_";
    finishReply(c, text);
  } catch (err) {
    if (frame) cancelAnimationFrame(frame);
    if (err.name === "AbortError") {
      // User pressed stop. Keep what arrived so the conversation stays valid.
      if (text.trim() && current === c) finishReply(c, text + "\n\n_(Stopped.)_");
      else li.remove();
      return;
    }
    fail("Couldn't reach Humanual. Check your connection and try again.");
  } finally {
    if (busy === controller) setBusy(null);
  }
}

function finishReply(c, text) {
  c.messages.push({ role: "assistant", content: text });
  if (current === c) {
    persistCurrent();
    render();
  } else {
    // User switched conversations mid-reply; still save it.
    c.updated = Date.now();
    convos = [c, ...convos.filter((x) => x.id !== c.id)];
    saveConvos();
    markDirty("convo", c.id, { at: c.updated });
    renderConvoList();
  }
}

// ---------- composer ----------

function autosize() {
  const t = $("#input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + "px";
}

$("#input").addEventListener("input", autosize);
$("#input").addEventListener("keydown", (e) => {
  const touch = matchMedia("(pointer: coarse)").matches;
  if (e.key === "Enter" && !e.shiftKey && !touch && !e.isComposing) {
    e.preventDefault();
    send($("#input").value);
  }
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) stopStreaming();
  else send($("#input").value);
});
for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => send(chip.dataset.send));
}

// ---------- sidebar ----------

function openSidebar() {
  $("#sidebar").classList.add("open");
  $("#scrim").hidden = false;
}
function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#scrim").hidden = true;
}
$("#open-sidebar").addEventListener("click", openSidebar);
$("#close-sidebar").addEventListener("click", closeSidebar);
$("#scrim").addEventListener("click", closeSidebar);
$("#new-chat").addEventListener("click", () => { showView("chat"); newConvo(); });

// ---------- settings ----------

function openSettings({ focusAccess = false } = {}) {
  const form = $("#settings-form");
  for (const k of ["name", "about", "work", "people", "accessCode"]) form.elements[k].value = settings[k] ?? "";
  fillCoachPicker($("#set-coach"), "coach", settings.coach);
  form.elements.style.value = settings.style;
  const access = $("#access-field");
  access.hidden = !accessCodeRequired && !settings.accessCode;
  access.classList.toggle("flash", focusAccess);
  $("#settings").returnValue = "";
  closeSidebar();
  $("#settings").showModal();
  if (focusAccess) form.elements.accessCode.focus();
}

$("#open-settings").addEventListener("click", () => openSettings());
$("#settings").addEventListener("close", () => {
  if ($("#settings").returnValue !== "save") return;
  const form = $("#settings-form");
  const changedCoach = form.elements.coach.value !== settings.coach || form.elements.style.value !== settings.style;
  settings = {
    ...settings,
    name: form.elements.name.value.trim() || settings.name,
    about: form.elements.about.value.trim(),
    work: form.elements.work.value.trim(),
    people: form.elements.people.value.trim(),
    accessCode: form.elements.accessCode.value.trim(),
    coach: form.elements.coach.value || settings.coach,
    style: form.elements.style.value || settings.style,
    updated: Date.now(),
  };
  saveSettings();
  markDirty("profile", "me", { at: settings.updated });
  // Defaults apply to new conversations; an unstarted one can pick them up now.
  if (changedCoach && current && !current.messages.length) {
    current.coach = settings.coach;
    current.style = settings.style;
  }
  render();
});
$("#wipe").addEventListener("click", async () => {
  const where = syncEnabled() ? "from your account and every device" : "from this browser";
  if (!confirm(`Delete your profile, conversations, and saved scripts ${where}? This can't be undone.`)) return;
  if (syncEnabled()) {
    try {
      const res = await fetch("/api/sync", { method: "DELETE", headers: await authHeaders() });
      if (!res.ok) throw new Error();
    } catch {
      alert("Couldn't reach Humanual, so nothing was deleted. Try again when you're online.");
      return;
    }
  }
  try {
    for (const name of ["settings", "convos", "scripts", "outbox", "cursor"]) localStorage.removeItem(keyFor(name));
  } catch {}
  location.reload();
});

// ---------- views (coach chat / scripts) ----------

let view = "chat";

function showView(name) {
  view = name;
  $("#chat-view").hidden = name !== "chat";
  $("#scripts-view").hidden = name !== "scripts";
  for (const b of document.querySelectorAll(".view-btn")) {
    if (b.dataset.view === name) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  try { history.replaceState(null, "", name === "chat" ? location.pathname : "#" + name); } catch {}
  if (name === "scripts") renderScriptsView();
  closeSidebar();
}

for (const b of document.querySelectorAll(".view-btn")) b.addEventListener("click", () => showView(b.dataset.view));
for (const b of document.querySelectorAll("[data-open-sidebar]")) b.addEventListener("click", openSidebar);

// Starts a fresh coach conversation from another tool, either sending the text
// right away or leaving it in the composer for the user to finish.
function startConvoWith(mode, text, { sendNow }) {
  showView("chat");
  newConvo();
  current.mode = mode;
  render();
  if (sendNow) {
    send(text);
  } else {
    $("#input").value = text;
    autosize();
    $("#input").focus();
    $("#input").setSelectionRange(text.length, text.length);
  }
}

// ---------- scripts ----------

let shownScriptId = null;

const CHANNELS = {
  inperson: {
    label: "In person",
    phrase: "in person",
    icon: ICONS.people,
    examples: ["Return shoes without a receipt", "Ask a pharmacist about a side effect", "Order at a busy coffee counter", "Get out of a long chat with a neighbor"],
    practice: [
      "Return something without a receipt",
      "Ask a store employee where something is",
      "Small talk with a chatty cashier",
      "Ask the pharmacist a question with a line behind me",
      "Check in at a doctor's office",
      "A neighbor wants to chat and I need to leave",
      "A coworker blames me in a meeting",
      "Small talk with a stranger at a networking event",
      "A hard conversation with a friend or family member",
    ],
  },
  phone: {
    label: "Phone call",
    phrase: "on a phone call",
    icon: ICONS.phone,
    examples: ["Reschedule a doctor's appointment", "Dispute a charge on my internet bill", "Cancel a subscription that only cancels by phone", "Answer a call from an unknown number"],
    practice: [
      "Book a dentist appointment",
      "Get a wrong charge removed from a bill",
      "Cancel a membership when they push upsells",
      "Reschedule an appointment",
      "Answer a call from an unknown number",
      "End a call that's running long",
      "Raise a coworker problem with my manager",
      "Follow up with a prospect who went quiet",
    ],
  },
  written: {
    label: "Text or email",
    phrase: "by text or email (write your replies as messages, the way they'd actually write)",
    icon: ICONS.reply,
    examples: ["Decline an invitation without over-explaining", "Follow up on an email nobody answered", "Ask my landlord to fix something", "Reply to a passive-aggressive Slack message"],
    practice: [
      "Reply to a passive-aggressive Slack message",
      "A coworker took credit for my work",
      "Decline an invitation without over-explaining",
      "A prospect says \"we already have that covered\"",
      "Say no to extra work that's out of scope",
      "Ask my landlord to fix something",
      "A friend asks for a favor I don't want to do",
    ],
  },
};

const EXAMPLE_SCRIPT = {
  id: "example",
  channel: "phone",
  task: "Book a dentist cleaning",
  coach: "junie",
  example: true,
  script: {
    title: "Book a dentist cleaning by phone",
    energy: "medium",
    stakes: "low",
    norm: "Receptionists expect you to say who you are and what you want in the first sentence. Short answers are normal and not rude.",
    opener: "Hi, my name is [name]. I'd like to book a cleaning, please.",
    ask: "Do you have anything on a weekday morning in the next two weeks?",
    responses: [
      { if: "Are you a current patient?", say: "Yes, I was last in around [month]. My date of birth is [date]." },
      { if: "The earliest is three weeks out.", say: "That's fine, I'll take it. Can you put me on a list if something opens sooner?" },
      { if: "What insurance do you have?", say: "I have [insurance]. I can bring the card with me." },
    ],
    stall: "Sorry, let me check my calendar. One second.",
    exit: "I need to check a couple of things. I'll call back later today. Thank you.",
    closer: "Great, so that's [day] at [time]. Thanks for your help. Bye.",
    message: "",
    alternative: "Many offices have online booking or will answer a text or email. Check their website first if you'd rather not call.",
    comfort: ["Call mid-morning or mid-afternoon, when the front desk is least busy.", "Have your calendar and insurance card in front of you before you dial."],
  },
};

function renderScriptsView() {
  const coach = COACHES[settings.coach];
  $("#scripts-coach").replaceChildren(
    avatar(settings.coach, "sm"),
    el("span", {}, [document.createTextNode("Scripts "), el("span", { class: "sub", text: `· by ${coach.name}, ${settings.style === "direct" ? "Direct" : "Gentle"}` })]),
  );

  const pick = $("#channel-pick");
  if (!pick.children.length) {
    for (const [id, ch] of Object.entries(CHANNELS)) {
      const input = el("input", { type: "radio", name: "channel", value: id });
      input.checked = id === Object.keys(CHANNELS)[0];
      input.addEventListener("change", renderExamples);
      pick.append(el("label", {}, [input, el("span", { html: `<svg viewBox="0 0 24 24" aria-hidden="true">${ch.icon}</svg>${escapeHtml(ch.label)}` })]));
    }
    renderExamples();
  }

  renderSavedList();
  if (!$("#script-out").children.length) {
    showScript(scripts[0] ?? EXAMPLE_SCRIPT);
  }
}

function currentChannel() {
  return $("#channel-pick").querySelector("input:checked")?.value ?? Object.keys(CHANNELS)[0];
}

function renderExamples() {
  const box = $("#script-examples");
  box.replaceChildren();
  for (const ex of CHANNELS[currentChannel()].examples) {
    box.append(el("button", { type: "button", class: "chip", text: ex, onclick: () => { $("#script-task").value = ex; $("#script-task").focus(); } }));
  }
}

function scriptAsText(entry) {
  const d = entry.script;
  const lines = [d.title, ""];
  if (d.norm) lines.push("What's expected: " + d.norm, "");
  if (d.message) {
    lines.push(d.message, "");
    for (const r of d.responses) lines.push(`If they reply "${r.if}": ${r.say}`);
  } else {
    lines.push("Open: " + d.opener, "Ask: " + d.ask);
    for (const r of d.responses) lines.push(`If they say "${r.if}": ${r.say}`);
    lines.push("Stall: " + d.stall, "Exit: " + d.exit, "Close: " + d.closer);
  }
  return lines.join("\n");
}

function showScript(entry) {
  shownScriptId = entry.id;
  const d = entry.script;
  const written = entry.channel === "written";
  const coachName = COACHES[entry.coach]?.name ?? "Your coach";

  const sayLine = (t) => el("p", { class: "say", text: t });
  const row = (k, ...content) => el("div", { class: "row" }, [el("div", { class: "k", text: k }), el("div", {}, content)]);
  const pairs = (label) => d.responses.map((r) => el("div", { class: "pair" }, [el("span", { class: "if", text: `${label} "${r.if}"` }), sayLine(r.say)]));
  const levelPill = (prefix, lv) => el("span", { class: `pill ${lv}`, text: `${prefix}: ${lv}` });

  const card = el("article", { class: "card", "aria-label": d.title }, [
    el("div", { class: "card-head" }, [
      el("div", {}, [
        el("h3", { text: d.title }),
        el("div", { class: "by", text: entry.example ? "Example · write your own above"
          : `${CHANNELS[entry.channel].label} · by ${coachName}${DEMO ? " (recorded)" : ""}` }),
      ]),
      el("div", { class: "meters" }, [levelPill("Energy", d.energy), levelPill("Stakes", d.stakes)]),
    ]),
  ]);

  if (d.norm) card.append(el("div", { class: "norm" }, [el("strong", { text: "What's expected: " }), document.createTextNode(d.norm)]));

  if (written && d.message) {
    card.append(row("Ready to send", el("pre", { class: "ready", text: d.message })));
    card.append(row("If they reply", ...pairs("If they say")));
    if (d.stall) card.append(row("Not ready?", el("p", { text: d.stall, style: "margin:0" })));
  } else {
    card.append(row("Open with", sayLine(d.opener)));
    card.append(row("Then ask", sayLine(d.ask)));
    card.append(row("They might say", ...pairs("If they say")));
    card.append(row("Off-script", el("span", { class: "if muted small", text: "To buy time:" }), sayLine(d.stall),
      el("span", { class: "if muted small", text: "To get out:" }), sayLine(d.exit)));
    card.append(row("Close with", sayLine(d.closer)));
  }
  if (d.comfort?.length) card.append(row("Good to know", el("ul", { class: "plain" }, d.comfort.map((t) => el("li", { text: t })))));
  if (d.alternative) card.append(row(written ? "Another way" : "Skip the call?", el("p", { text: d.alternative, style: "margin:0" })));

  const actions = el("div", { class: "card-actions" });
  if (written && d.message) actions.append(el("button", { class: "btn", type: "button", text: "Copy message", onclick: (e) => copyText(e.currentTarget, d.message) }));
  actions.append(el("button", { class: "btn", type: "button", text: "Copy script", onclick: (e) => copyText(e.currentTarget, scriptAsText(entry)) }));
  // These start a new coach conversation, which the demo has no recording for.
  if (!written && !DEMO) {
    actions.append(el("button", { class: "btn", type: "button", text: "Practice this", onclick: () => practiceScript(entry) }));
  }
  if (!DEMO) {
    actions.append(el("button", { class: "btn", type: "button", text: `Talk it over with ${COACHES[settings.coach].name}`, onclick: () => discussScript(entry) }));
  }
  if (!entry.example) actions.append(el("button", { class: "btn ghost danger", type: "button", text: "Delete", onclick: () => deleteScript(entry.id) }));
  card.append(actions);

  $("#script-out").replaceChildren(card);
  renderSavedList();
}

async function copyText(btn, text) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Couldn't copy";
  }
  setTimeout(() => (btn.textContent = label), 1500);
}

function practiceScript(entry) {
  const d = entry.script;
  startConvoWith("practice",
    `Let's role-play this so I can practice before doing it for real.\n\n` +
    `Situation (${CHANNELS[entry.channel].label.toLowerCase()}): ${entry.task}${entry.details ? `\nDetails: ${entry.details}` : ""}\n\n` +
    `You play the other person, realistic difficulty. My plan is to open with "${d.opener}" and then ask "${d.ask}". Start the scene.`,
    { sendNow: true });
}

function discussScript(entry) {
  startConvoWith("everyday",
    `I have this script for something I need to do (${CHANNELS[entry.channel].label.toLowerCase()}: ${entry.task}):\n\n${scriptAsText(entry)}\n\nMy question: `,
    { sendNow: false });
}

function deleteScript(id) {
  const s = scripts.find((x) => x.id === id);
  if (!s || !confirm(`Delete "${s.script.title}"?`)) return;
  scripts = scripts.filter((x) => x.id !== id);
  saveScripts();
  markDirty("script", id, { deleted: true });
  showScript(scripts[0] ?? EXAMPLE_SCRIPT);
}

function renderSavedList() {
  const list = $("#saved-list");
  list.replaceChildren();
  $("#saved-wrap").hidden = !scripts.length;
  for (const s of scripts) {
    list.append(el("div", { class: "saved-item", "aria-current": String(s.id === shownScriptId) }, [
      el("button", { class: "open", type: "button", onclick: () => { showScript(s); $("#script-out").scrollIntoView({ behavior: "smooth", block: "start" }); } }, [
        el("span", { class: "title", text: s.script.title }),
        el("span", { class: "meta", text: `${CHANNELS[s.channel].label} · ${relTime(s.created)}` }),
      ]),
    ]));
  }
}

$("#script-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const task = $("#script-task").value.trim();
  if (!task) return $("#script-task").focus();
  const channel = currentChannel();
  const details = $("#script-details").value.trim();
  const status = $("#script-status");
  const btn = $("#script-go");
  if (DEMO) return demoScript(task, status, btn);

  btn.disabled = true;
  status.className = "status";
  status.textContent = `${COACHES[settings.coach].name} is writing your script… this can take up to a minute.`;
  $("#script-crisis").hidden = true;

  try {
    let res;
    try {
      res = await fetch("/api/script", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        coach: settings.coach,
        style: settings.style,
        profile: { name: settings.name, about: settings.about, work: settings.work, people: settings.people },
        today: new Date().toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
        channel,
        task,
        details,
      }),
      });
    } catch {
      throw new Error("Couldn't reach Humanual. Check your connection and try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (data.code === "access") {
      status.className = "status err";
      status.textContent = data.error;
      openSettings({ focusAccess: true });
      return;
    }
    if (data.crisis) {
      status.textContent = "";
      $("#script-crisis").hidden = false;
      $("#script-crisis").dataset.task = task;
      return;
    }
    if (!res.ok || !data.script) throw new Error(data.error || `Something went wrong (${res.status}).`);

    const now = Date.now();
    const entry = { id: crypto.randomUUID(), channel, task, details, coach: settings.coach, created: now, updated: now, script: data.script };
    scripts.unshift(entry);
    saveScripts();
    markDirty("script", entry.id, { at: now });
    status.textContent = "";
    $("#script-task").value = "";
    $("#script-details").value = "";
    showScript(entry);
    $("#script-out").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    status.className = "status err";
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$("#script-crisis-chat").addEventListener("click", () => {
  startConvoWith(null, $("#script-crisis").dataset.task || "", { sendNow: true });
});

// Lets phones install Humanual to the home screen and open saved scripts offline.
if ("serviceWorker" in navigator && !DEMO) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// ---------- demo ----------
//
// /demo plays back real coach replies recorded by tools/record-demo.mjs
// (public/demo/samples.json). A conversation that stays on a sample's script
// gets the recorded reply; anything else gets DEMO_OFF_SCRIPT. Changes live
// only in memory.

let demoData = null;

const DEMO_OFF_SCRIPT =
  "**This is the demo**, so I can only replay sample conversations. Every reply here was recorded from the real coach, " +
  "but nothing you type is sent anywhere.\n\n" +
  "Tap **New conversation** to pick a sample. The live app answers anything you bring to it.";

const CHIP_LABELS = { hint: "Hint", pause: "Pause", stop: "Stop & get feedback" };

async function startDemo() {
  document.body.classList.add("demo");
  document.title = "Humanual demo";
  $("#demo-bar").hidden = false;
  try {
    demoData = await (await fetch("/demo/samples.json")).json();
  } catch {
    $("#onboarding").hidden = true;
    document.body.append(el("p", { class: "notice", text: "Couldn't load the demo. Check your connection and reload the page." }));
    return;
  }
  const now = Date.now();
  settings = { ...demoData.profile, coach: "junie", style: "direct", accessCode: "", updated: now };
  // One finished rehearsal in the sidebar and two saved scripts, so those screens aren't empty.
  const rehearsal = demoData.conversations.find((s) => s.mode === "practice");
  convos = rehearsal ? [demoConvo(rehearsal, rehearsal.messages, now - 3_600_000)] : [];
  scripts = demoData.scripts
    .filter((s) => s.task === "Reschedule a doctor's appointment" || s.task === "Ask my landlord to fix something")
    .map((s, i) => demoScriptEntry(s, now - 86_400_000 * (i + 1)));
  startApp();
}

function demoConvo(sample, messages, at = Date.now()) {
  return {
    id: crypto.randomUUID(), title: sample.label, coach: sample.coach, style: sample.style, mode: sample.mode,
    messages: messages.map((m) => ({ ...m })), crisis: false, updated: at, sample: sample.id,
  };
}

function demoScriptEntry(rec, at = Date.now()) {
  return { id: crypto.randomUUID(), channel: rec.channel, task: rec.task, details: "", coach: rec.coach, created: at, updated: at, script: rec.script };
}

// The conversation's sample, if every message so far matches the recording.
function demoSampleFor(c) {
  const s = demoData?.conversations.find((x) => x.id === c.sample);
  if (!s || c.messages.length > s.messages.length) return null;
  return c.messages.every((m, i) => s.messages[i].content === m.content) ? s : null;
}

function renderDemoSamples() {
  const c = current;
  const samples = demoData.conversations.filter((s) => !c.mode || (s.mode ?? "open") === c.mode);
  const list = $("#sample-list");
  list.replaceChildren();
  for (const s of samples.length ? samples : demoData.conversations) {
    list.append(el("button", { type: "button", class: "sample", "data-testid": `demo-sample-${s.id}`, onclick: () => playSample(s) }, [
      avatar(s.coach),
      el("span", { class: "sample-text" }, [
        el("strong", { text: s.label }),
        el("span", { class: "meta", text: `${COACHES[s.coach].name} · ${s.style === "direct" ? "Direct" : "Gentle"} · ${MODES[s.mode ?? "open"].label}` }),
      ]),
    ]));
  }
}

function playSample(s) {
  Object.assign(current, { coach: s.coach, style: s.style, mode: s.mode, sample: s.id, title: s.label });
  send(s.messages[0].content);
}

// Offers the sample's next message as a chip, so the visitor can keep going.
function renderDemoNext() {
  const box = $("#demo-next");
  box.replaceChildren();
  const c = current;
  const s = demoSampleFor(c);
  const next = s && c.messages.length % 2 === 0 ? s.messages[c.messages.length]?.content : null;
  box.hidden = !next;
  if (!next) return;
  box.append(el("button", { type: "button", class: "chip next", "data-testid": "demo-next-chip", title: next,
    "aria-label": `Send: ${next}`, text: `Next → ${CHIP_LABELS[next] ?? next}`, onclick: () => send(next) }));
}

function demoWait(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Stopped", "AbortError")); }, { once: true });
  });
}

// Types the recorded reply out at roughly the speed a live reply streams in.
async function playDemoReply(c, mdNode, signal) {
  const s = demoSampleFor(c);
  const full = s?.messages[c.messages.length]?.content ?? DEMO_OFF_SCRIPT;
  const pieces = full.split(/(?<=\s)/);
  let text = "";
  try {
    await demoWait(600, signal);
    for (let i = 0; i < pieces.length; i += 4) {
      text += pieces.slice(i, i + 4).join("");
      mdNode.innerHTML = renderMarkdown(text);
      scrollToBottom();
      await demoWait(30, signal);
    }
    finishReply(c, full);
  } catch {
    if (text.trim() && current === c) finishReply(c, text + "\n\n_(Stopped.)_");
    else mdNode.closest("li")?.remove();
  }
}

async function demoScript(task, status, btn) {
  const rec = demoData.scripts.find((s) => s.task.toLowerCase() === task.toLowerCase());
  status.className = "status";
  if (!rec) {
    status.textContent = "The demo has recorded scripts for the example buttons above, so pick one of those. The live app writes a script for anything.";
    return;
  }
  btn.disabled = true;
  status.textContent = `${COACHES[rec.coach].name} is writing your script…`;
  await new Promise((r) => setTimeout(r, 1200));
  const entry = demoScriptEntry(rec);
  scripts.unshift(entry);
  status.textContent = "";
  btn.disabled = false;
  $("#script-task").value = "";
  showScript(entry);
  $("#script-out").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- account buttons ----------

$("#dev-signin").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("#dev-user").value.trim();
  if (!/^[\w.@-]{1,64}$/.test(id)) return;
  save("humanual.devUser", id);
  enterAs(`dev_${id}`);
});
$("#sign-out").addEventListener("click", signOut);
$("#manage-account").addEventListener("click", () => clerk?.openUserProfile());

// ---------- boot ----------

(async function boot() {
  if (DEMO) return startDemo();
  let config = null;
  try {
    config = await (await fetch("/api/config")).json();
    save("humanual.config", config);
  } catch {
    config = load("humanual.config", null); // offline: use what we saw last time
  }
  accessCodeRequired = Boolean(config?.accessCodeRequired);
  authMode = config?.auth ?? "none";

  if (authMode === "none") return enterAs(null);

  if (authMode === "clerk") {
    try {
      clerk = await loadClerk(config.clerkPublishableKey);
    } catch {
      // Offline or sign-in service unreachable: open the last account's saved copy.
      const last = load("humanual.lastUser", null);
      if (last) return enterAs(last);
      $("#signin-error").hidden = false;
      return showSignIn();
    }
    if (clerk.user) return enterAs(clerk.user.id, { prefillName: clerk.user.firstName ?? "" });
    showSignIn();
    clerk.addListener(({ user }) => {
      if (user && !uid) enterAs(user.id, { prefillName: user.firstName ?? "" });
    });
    return;
  }

  // Dev sign-in (local testing only).
  const devUser = load("humanual.devUser", "");
  if (devUser) return enterAs(`dev_${devUser}`);
  showSignIn();
})();
