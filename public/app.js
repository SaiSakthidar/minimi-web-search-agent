// minimi browser client. Vanilla JS, no build step.

const $ = (id) => document.getElementById(id);
const thread = $("thread"), scroller = $("scroll"), input = $("input"), sendBtn = $("send");

const state = { meta: null, sessions: [], current: null, running: null };

const EXAMPLES = [
  "On Monday we shortlisted CRM tools. Have any of them changed pricing since?",
  "What did I ask you on 3 November? Is your answer still correct today?",
  "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
];

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const fmtDay = (day, opts = { day: "numeric", month: "short", year: "numeric" }) =>
  day ? new Date(`${day.slice(0, 10)}T12:00:00`).toLocaleDateString("en-GB", opts) : "";

// Small markdown subset: paragraphs, bullet and numbered lists, **bold**, `code`, [text](url), and [n] citations.
function inline(text, turnId, known) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // [3], [3][4] and [3, 4] all become one marker per source.
  s = s.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g, (m, list) => list.split(",").map((x) => {
    const n = x.trim();
    return known.has(Number(n)) ? `<a class="cite" href="#src-${turnId}-${n}" data-src="src-${turnId}-${n}">${n}</a>` : `<span class="cite">${n}</span>`;
  }).join(""));
  return s;
}

function renderMarkdown(text, turnId, known = new Set()) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    for (const line of block.split("\n")) {
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || num) {
        const kind = bullet ? "ul" : "ol";
        if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${inline((bullet || num)[1], turnId, known)}</li>`);
      } else if (line.trim()) {
        close();
        const h = /^#{1,6}\s+(.*)$/.exec(line);
        out.push(`<p>${h ? `<strong>${inline(h[1], turnId, known)}</strong>` : inline(line, turnId, known)}</p>`);
      }
    }
    close();
  }
  return out.join("").replace(/<\/p><p>/g, "<br>");
}

const api = async (path, opts) => {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
};

const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
const toBottom = (force) => { if (force || nearBottom()) scroller.scrollTop = scroller.scrollHeight; };

// ---------- header and sidebar ----------

async function loadMeta() {
  state.meta = await api("/api/meta");
  const real = Math.abs(Date.now() - Date.parse(state.meta.nowIso)) < 60_000;
  const today = $("today");
  today.textContent = fmtDay(state.meta.today, { weekday: "long", day: "numeric", month: "long" });
  today.classList.toggle("override", !real);
  today.title = real ? "Today's date, used for every search and memory lookup" : "The clock is set to another day (AGENT_NOW)";
  $("model").textContent = state.meta.model;
}

// ---------- theme: system -> Latte -> Mocha ----------

const THEMES = ["system", "latte", "mocha"];
const THEME_ICON = {
  system: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
  latte: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  mocha: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="currentColor"/></svg>',
};
const THEME_LABEL = { system: "Theme: follows your system", latte: "Theme: Latte (light)", mocha: "Theme: Mocha (dark)" };

function currentTheme() { return document.documentElement.dataset.theme || "system"; }
function applyTheme(t) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { t === "system" ? localStorage.removeItem("minimi-theme") : localStorage.setItem("minimi-theme", t); } catch {}
  const btn = $("theme");
  btn.innerHTML = THEME_ICON[t];
  btn.title = THEME_LABEL[t];
  btn.setAttribute("aria-label", `${THEME_LABEL[t]}. Switch theme`);
}

// ---------- relative dates ----------

const DAY_MS = 86_400_000;
const dayNumber = (day) => Math.floor(Date.parse(`${day.slice(0, 10)}T12:00:00Z`) / DAY_MS);
const daysAgo = (day) => (state.meta ? dayNumber(state.meta.today) - dayNumber(day) : 0);
const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function sessionGroup(startedAt) {
  const n = daysAgo(localDay(startedAt));
  if (n <= 0) return "Today";
  if (n === 1) return "Yesterday";
  if (n < 7) return "This week";
  return "Earlier";
}

/** How old a source is, as a word for the card and a bucket for its colour. */
function freshness(publishedDate) {
  if (!publishedDate) return { bucket: "none", label: "no date on page" };
  const n = daysAgo(publishedDate);
  const label = n <= 0 ? "today" : n === 1 ? "yesterday" : n < 60 ? `${n} days old` : n < 730 ? `${Math.round(n / 30)} months old` : `${Math.round(n / 365)} years old`;
  return { bucket: n <= 7 ? "week" : n <= 90 ? "quarter" : "old", label: `${fmtDay(publishedDate, { day: "numeric", month: "short" })}, ${label}` };
}

async function loadSessions() {
  state.sessions = await api("/api/sessions");
  const nav = $("sessions");
  nav.replaceChildren();
  let lastGroup = "";
  for (const s of state.sessions) {
    const group = sessionGroup(s.startedAt);
    if (group !== lastGroup) { nav.append(el("div", { class: "group" }, group)); lastGroup = group; }
    nav.append(el("a", {
      href: `#${s.id}`, class: s.id === state.current ? "active" : null,
      onclick: (e) => { e.preventDefault(); openSession(s.id); closeDrawer(); },
    },
      el("span", { class: "title" }, s.title || "New conversation"),
      el("span", { class: "when" }, new Date(s.startedAt).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })),
      s.seeded ? el("span", { class: "tag" }, "seeded") : null,
    ));
  }
}

const openDrawer = () => { $("sidebar").classList.add("open"); $("scrim").classList.add("open"); };
const closeDrawer = () => { $("sidebar").classList.remove("open"); $("scrim").classList.remove("open"); };

// ---------- thread rendering ----------

function renderEmpty() {
  thread.replaceChildren(el("div", { class: "empty" },
    el("h1", {}, "What should we look up?"),
    el("p", {}, "Every answer cites its sources and shows how old they are. Ask about something we discussed before and it gets checked again."),
    el("div", { class: "examples" }, EXAMPLES.map((q) => el("button", { type: "button", onclick: () => { input.value = q; send(); } }, q))),
  ));
}

/** One assistant turn: recall chip, status, sources row, diff table, prose, footer. */
class TurnView {
  constructor(id) {
    this.id = id;
    this.text = "";
    this.sources = [];
    this.root = el("div", { class: "turn" });
    this.recallEl = el("div");
    this.statusEl = el("div", { class: "status", hidden: true });
    this.sourcesEl = el("div", { class: "sources", hidden: true });
    this.diffEl = el("div", { class: "diff", hidden: true });
    this.proseEl = el("div", { class: "prose" });
    this.footEl = el("div");
    this.root.append(this.recallEl, this.statusEl, this.sourcesEl, this.diffEl, this.proseEl, this.footEl);
    this.root.addEventListener("click", (e) => {
      const a = e.target.closest("a.cite");
      if (!a) return;
      e.preventDefault();
      const card = document.getElementById(a.dataset.src);
      if (card) { card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" }); card.classList.add("flash"); setTimeout(() => card.classList.remove("flash"), 1200); }
    });
    this.pending = false;
  }

  recall(summary, block) {
    if (!summary) return;
    this.recallEl.replaceChildren(el("details", { class: "recall" }, el("summary", {}, summary), block ? el("pre", {}, block) : null));
  }

  status(text) { this.statusEl.hidden = !text; this.statusEl.textContent = text || ""; }

  append(delta) {
    this.text += delta;
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.paint(true); });
  }

  paint(streaming = false) {
    this.proseEl.innerHTML = renderMarkdown(this.text, this.id, new Set(this.sources.map((s) => s.id)));
    this.proseEl.classList.toggle("caret", streaming);
    toBottom();
  }

  setSources(sources) {
    this.sources = sources;
    this.sourcesEl.hidden = sources.length === 0;
    this.sourcesEl.replaceChildren(...sources.map((s) => {
      const f = freshness(s.publishedDate);
      return el("a", {
        class: "source", id: `src-${this.id}-${s.id}`, href: /^https?:\/\//.test(s.url) ? s.url : "#",
        target: "_blank", rel: "noopener", title: s.url, "data-fresh": f.bucket,
      },
        el("div", { class: "dom" }, el("span", { class: "n" }, s.id), el("span", {}, host(s.url))),
        el("div", { class: "t" }, s.title),
        el("div", { class: "age" }, f.label),
      );
    }));
    this.paint();
  }

  setDiff(items) {
    if (!items?.length) return;
    const val = (v, d) => [v ?? "—", d ? el("span", { class: "sub" }, fmtDay(d)) : null];
    this.diffEl.hidden = false;
    this.diffEl.replaceChildren(el("table", {},
      el("thead", {}, el("tr", {}, ["What", "Before", "Now", "Result"].map((h) => el("th", {}, h)))),
      el("tbody", {}, items.map((it) => el("tr", {},
        el("td", {}, it.item),
        el("td", {}, val(it.before, it.beforeDate)),
        el("td", {}, val(it.after, it.afterDate)),
        el("td", {}, el("span", { class: `verdict ${it.verdict}` }, { changed: "Changed", same: "Same", unverified: "Not confirmed" }[it.verdict] ?? it.verdict),
          it.source ? el("a", { class: "cite", href: `#src-${this.id}-${it.source}`, "data-src": `src-${this.id}-${it.source}` }, it.source) : null),
      ))),
    ));
  }

  notice(text, error = false) { this.footEl.append(el("div", { class: `notice${error ? " error" : ""}` }, text)); }
  done(ms) { this.status(""); this.paint(); if (ms) this.footEl.append(el("div", { class: "foot" }, `${(ms / 1000).toFixed(1)}s`)); }
}

async function openSession(id) {
  state.current = id;
  history.replaceState(null, "", `#${id}`);
  await loadSessions();
  const msgs = await api(`/api/sessions/${id}/messages`);
  thread.replaceChildren();
  let pendingRecall = null;
  let n = 0;
  for (const m of msgs) {
    if (m.msg.role === "system" && m.msg.text.startsWith("[Memory recall")) pendingRecall = m.msg.text; // follows its user message
    else if (m.msg.role === "user") {
      const text = m.msg.parts.filter((p) => p.type === "text").map((p) => p.text).join("");
      if (text) thread.append(el("div", { class: "user" }, text));
    } else if (m.msg.role === "assistant" && m.meta) {
      const view = new TurnView(`h${n++}`);
      thread.append(view.root);
      view.recall(m.meta.recall, pendingRecall);
      view.text = m.meta.text;
      view.setSources(m.meta.sources || []);
      view.setDiff(m.meta.diff);
      pendingRecall = null;
    }
  }
  if (!thread.children.length) renderEmpty();
  toBottom(true);
}

// ---------- sending a turn ----------

async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (event && data) onEvent(event, JSON.parse(data));
    }
  }
}

function setRunning(controller) {
  state.running = controller;
  sendBtn.textContent = controller ? "■" : "↑";
  sendBtn.classList.toggle("stop", !!controller);
  sendBtn.setAttribute("aria-label", controller ? "Stop" : "Send");
}

async function send() {
  const text = input.value.trim();
  if (!text || state.running) return;
  input.value = "";
  autosize();
  if (!state.current) state.current = (await api("/api/sessions", { method: "POST" })).id;
  if (thread.querySelector(".empty")) thread.replaceChildren();

  thread.append(el("div", { class: "user" }, text));
  const view = new TurnView(`t${Date.now()}`);
  thread.append(view.root);
  view.status("thinking…");
  toBottom(true);

  const controller = new AbortController();
  setRunning(controller);
  try {
    const res = await fetch(`/api/sessions/${state.current}/turn`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: controller.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    await readSse(res, (event, data) => {
      if (event === "recall") view.recall(data.summary, data.block);
      else if (event === "status") view.status(data.text);
      else if (event === "text") { view.status(""); view.append(data.delta); }
      else if (event === "diff") view.setDiff(data.items);
      else if (event === "sources") view.setSources(data.sources);
      else if (event === "notice") view.notice(data.text);
      else if (event === "error") view.notice(data.message, true);
      else if (event === "done") view.done(data.ms);
    });
  } catch (e) {
    view.notice(e.name === "AbortError" ? "Stopped." : `Something went wrong: ${e.message}`, e.name !== "AbortError");
  } finally {
    view.status("");
    view.paint();
    setRunning(null);
    loadSessions();
    setTimeout(loadSessions, 4000); // the title arrives from background extraction
  }
}

// ---------- wiring ----------

function autosize() { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; }

$("composer").addEventListener("submit", (e) => { e.preventDefault(); state.running ? state.running.abort() : send(); });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
input.addEventListener("input", autosize);
$("new-session").addEventListener("click", () => { state.current = null; history.replaceState(null, "", "#"); loadSessions(); renderEmpty(); closeDrawer(); input.focus(); });
$("menu").addEventListener("click", openDrawer);
$("theme").addEventListener("click", () => applyTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]));
applyTheme(currentTheme());
$("scrim").addEventListener("click", closeDrawer);

(async function init() {
  try {
    await loadMeta();
    await loadSessions();
    const fromHash = location.hash.slice(1);
    if (fromHash && state.sessions.some((s) => s.id === fromHash)) await openSession(fromHash);
    else renderEmpty();
  } catch (e) {
    thread.replaceChildren(el("div", { class: "notice error" }, `Could not reach the server: ${e.message}`));
  }
  input.focus();
})();
