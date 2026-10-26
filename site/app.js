const $ = (id) => document.getElementById(id);
const els = {
  stats: $("stats"), search: $("search"),
  datesToggle: $("datesToggle"), datesPanel: $("datesPanel"), presets: $("presets"),
  calGrid: $("calGrid"),
  filtersToggle: $("filtersToggle"), filters: $("filters"),
  tags: $("tags"), genres: $("genres"), ratings: $("ratings"), options: $("options"),
  films: $("films"), empty: $("empty"), reset: $("reset"),
};

const RATING_ORDER = ["G", "PG", "PG13", "NC16", "M18", "R21", "TBA"];
const TAG_LABELS = { "LastChance": "Last chance", "Live Q&A": "Q&A", "With Intro": "Intro" };

const state = { dates: new Set(), q: "", genre: "", rating: "", tags: new Set(), hideSoldOut: false };
let films = [];
let scrapedAt = null;
let available = []; // upcoming dates that have at least one session, sorted

// Showtimes are Singapore local time; compare against "now" in the same zone.
function singaporeNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const asDate = (isoDate) => new Date(`${isoDate}T00:00:00Z`);
const fmt = (isoDate, options) => asDate(isoDate).toLocaleDateString("en-GB", { timeZone: "UTC", ...options });
const longDate = (isoDate) => fmt(isoDate, { weekday: "long", day: "numeric", month: "long" });

function addDays(isoDate, n) {
  const d = asDate(isoDate);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayLabel(isoDate, today) {
  if (isoDate === today) return "Today";
  if (isoDate === addDays(today, 1)) return "Tomorrow";
  return fmt(isoDate, { weekday: "short", day: "numeric", month: "short" });
}

function timeAgo(iso) {
  const minutes = Math.round((Date.now() - new Date(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const CALENDAR_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>';
const CHEVRON_ICON = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6l4 4 4-4"/></svg>';

// Icons are fixed markup defined above, never data.
function icon(svg) {
  const span = document.createElement("span");
  span.className = "icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = svg;
  return span;
}

const genresOf = (film) => (film.genre ? film.genre.split("/").map((g) => g.trim()) : []);
const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.dates = new Set((p.get("date") ?? "").split(",").filter(Boolean));
  state.q = p.get("q") ?? "";
  state.genre = p.get("genre") ?? "";
  state.rating = p.get("rating") ?? "";
  state.tags = new Set((p.get("tags") ?? "").split(",").filter(Boolean));
  state.hideSoldOut = p.get("soldout") === "hide";
}

function writeUrl() {
  const p = new URLSearchParams();
  if (state.dates.size) p.set("date", [...state.dates].sort().join(","));
  if (state.q) p.set("q", state.q);
  if (state.genre) p.set("genre", state.genre);
  if (state.rating) p.set("rating", state.rating);
  if (state.tags.size) p.set("tags", [...state.tags].join(","));
  if (state.hideSoldOut) p.set("soldout", "hide");
  const query = p.toString();
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

const moreFilterCount = () =>
  (state.genre ? 1 : 0) + (state.rating ? 1 : 0) + state.tags.size + (state.hideSoldOut ? 1 : 0);

// Sessions that pass the session-level filters, with past sessions dropped.
function visibleShowings(film, now) {
  return film.showings.filter((s) =>
    (s.date > now.date || (s.date === now.date && s.time >= now.time)) &&
    (!state.dates.size || state.dates.has(s.date)) &&
    (!state.hideSoldOut || !s.soldOut) &&
    (!state.tags.size || s.tags.some((t) => state.tags.has(t))),
  );
}

function matchesFilm(film) {
  if (state.genre && !genresOf(film).includes(state.genre)) return false;
  if (state.rating && film.rating !== state.rating) return false;
  if (state.q) {
    const haystack = [film.title, film.genre, ...film.directors, ...film.cast].join(" ").toLowerCase();
    if (!state.q.toLowerCase().split(/\s+/).every((word) => haystack.includes(word))) return false;
  }
  return true;
}

// Quick picks, each limited to days that actually have sessions.
function presets(today) {
  const range = (from, days) => Array.from({ length: days }, (_, i) => addDays(from, i));
  const dow = asDate(today).getUTCDay(); // 0 = Sunday
  const weekend = dow === 0 ? [today] : range(addDays(today, (6 - dow) % 7), 2);
  return [
    ["Today", [today]],
    ["Tomorrow", [addDays(today, 1)]],
    ["This weekend", weekend],
    ["Next 7 days", range(today, 7)],
  ].map(([label, days]) => [label, days.filter((d) => available.includes(d))]);
}

const sameSet = (set, list) => set.size === list.length && list.every((d) => set.has(d));

function renderDates(now) {
  const n = state.dates.size;
  const picked = n === 0 ? null : n === 1 ? dayLabel([...state.dates][0], now.date) : `${n} days`;
  els.datesToggle.replaceChildren(...[icon(CALENDAR_ICON), "Date", picked && el("span", { class: "val" }, picked), icon(CHEVRON_ICON)].filter(Boolean));
  els.datesToggle.classList.toggle("active", n > 0);

  els.presets.replaceChildren(
    ...presets(now.date).map(([label, days]) => el("button", {
      type: "button", "aria-pressed": String(days.length > 0 && sameSet(state.dates, days)),
      disabled: days.length === 0,
      onclick: () => { state.dates = new Set(days); update(); },
    }, label)),
    n ? el("button", { type: "button", onclick: () => { state.dates.clear(); update(); } }, "Clear") : null,
  );

  // One continuous Monday-first calendar from this week to the last week with sessions,
  // so ranges like a weekend never split across pages. Days without sessions can't be picked.
  const mondayOf = (date) => addDays(date, -((asDate(date).getUTCDay() + 6) % 7));
  const start = mondayOf(now.date);
  const end = addDays(mondayOf(available.at(-1) ?? now.date), 6);
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  els.calGrid.replaceChildren(
    ...["M", "T", "W", "T", "F", "S", "S"].map((d) => el("span", { class: "dow", "aria-hidden": "true" }, d)),
    ...days.map((date, i) => {
      const open = available.includes(date);
      // Name the month on the first cell and wherever a new month starts.
      const month = i === 0 || date.endsWith("-01") ? el("span", { class: "mon", "aria-hidden": "true" }, fmt(date, { month: "short" })) : null;
      return el("button", {
        type: "button", class: date === now.date ? "today" : null, disabled: !open,
        "aria-pressed": String(state.dates.has(date)), "aria-label": longDate(date),
        onclick: () => { state.dates.has(date) ? state.dates.delete(date) : state.dates.add(date); update(); },
      }, month, String(Number(date.slice(8))));
    }),
  );
}

function option(label, pressed, onclick) {
  return el("button", { type: "button", "aria-pressed": String(pressed), onclick }, label);
}

function renderFilters() {
  const allTags = [...new Set(films.flatMap((f) => f.showings.flatMap((s) => s.tags)))].sort();
  els.tags.replaceChildren(...allTags.map((t) => option(TAG_LABELS[t] ?? t, state.tags.has(t), () => {
    state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t);
    update();
  })));

  const genres = [...new Set(films.flatMap(genresOf))].sort();
  els.genres.replaceChildren(...genres.map((g) => option(g, state.genre === g, () => {
    state.genre = state.genre === g ? "" : g;
    update();
  })));

  const ratings = [...new Set(films.map((f) => f.rating).filter(Boolean))]
    .sort((a, b) => RATING_ORDER.indexOf(a) - RATING_ORDER.indexOf(b));
  els.ratings.replaceChildren(...ratings.map((r) => option(r, state.rating === r, () => {
    state.rating = state.rating === r ? "" : r;
    update();
  })));

  els.options.replaceChildren(option("Hide sold out", state.hideSoldOut, () => {
    state.hideSoldOut = !state.hideSoldOut;
    update();
  }));

  const n = moreFilterCount();
  els.filtersToggle.replaceChildren(...["More filters", n && el("span", { class: "val" }, String(n)), icon(CHEVRON_ICON)].filter(Boolean));
  els.filtersToggle.classList.toggle("active", n > 0);
}

function renderSession(s, today) {
  const parts = [el("span", { class: "day" }, dayLabel(s.date, today)), el("span", { class: "at" }, s.label)];
  if (s.soldOut || !s.bookUrl) {
    return el("li", {}, el("span", { class: "time sold", title: "Sold out" }, parts));
  }
  return el("li", {}, el("a", {
    class: "time", href: s.bookUrl, target: "_blank", rel: "noopener",
    title: `Book ${longDate(s.date)}, ${s.label} on filmhouse.sg`,
  }, parts));
}

function renderFilm(film, showings, today) {
  const meta = [film.rating, film.runtime?.replace(/\s*mins?$/, " min"), film.genre].filter(Boolean).join(" · ");
  return el("li", { class: "film" },
    el("a", { class: "poster", href: film.url, target: "_blank", rel: "noopener", tabindex: "-1", "aria-hidden": "true" },
      el("img", { src: film.poster, alt: "", loading: "lazy", width: "44", height: "66" })),
    el("div", {},
      el("a", { class: "title", href: film.url, target: "_blank", rel: "noopener" }, film.title),
      el("div", { class: "meta" }, meta),
    ),
    el("ul", { class: "times" }, showings.map((s) => renderSession(s, today))),
  );
}

function update() {
  const now = singaporeNow();
  available = [...new Set(films.flatMap((f) => f.showings).filter((s) => s.date >= now.date).map((s) => s.date))].sort();
  for (const d of state.dates) if (!available.includes(d)) state.dates.delete(d);
  writeUrl();
  renderDates(now);
  renderFilters();

  const rows = films
    .filter(matchesFilm)
    .map((film) => ({ film, showings: visibleShowings(film, now) }))
    .filter((r) => r.showings.length)
    .sort((a, b) => {
      const ka = a.showings[0].date + a.showings[0].time;
      const kb = b.showings[0].date + b.showings[0].time;
      return ka.localeCompare(kb) || a.film.title.localeCompare(b.film.title);
    });

  els.films.replaceChildren(...rows.map((r) => renderFilm(r.film, r.showings, now.date)));
  els.empty.hidden = rows.length > 0;

  const sessions = rows.reduce((n, r) => n + r.showings.length, 0);
  // The refresh runs every 15 minutes; flag it if GitHub has stopped running it.
  const stale = Date.now() - new Date(scrapedAt) > 6 * 3600_000;
  els.stats.replaceChildren(
    `${count(rows.length, "film")} · ${count(sessions, "session")} · `,
    el("span", { class: stale ? "stale" : null, title: new Date(scrapedAt).toLocaleString("en-SG") }, `updated ${timeAgo(scrapedAt)}`),
  );
}

// Only one panel open at a time.
function setPanel(open) {
  for (const [toggle, panel] of [[els.datesToggle, els.datesPanel], [els.filtersToggle, els.filters]]) {
    panel.hidden = panel !== open;
    toggle.setAttribute("aria-expanded", String(panel === open));
  }
}

async function main() {
  const response = await fetch("films.json", { cache: "no-cache" });
  const snapshot = await response.json();
  scrapedAt = snapshot.scrapedAt;
  films = snapshot.films.map((f) => ({
    ...f, showings: [...f.showings].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
  }));

  readUrl();
  els.search.value = state.q;
  setPanel(null);

  els.search.addEventListener("input", () => { state.q = els.search.value.trim(); update(); });
  els.datesToggle.addEventListener("click", () => setPanel(els.datesPanel.hidden ? els.datesPanel : null));
  els.filtersToggle.addEventListener("click", () => setPanel(els.filters.hidden ? els.filters : null));
  // Panels only stay open while in use: a click elsewhere or Escape closes them.
  // composedPath() is captured at dispatch, so it still holds the bar after a click re-renders the panel.
  const bar = document.querySelector(".bar");
  document.addEventListener("click", (e) => { if (!e.composedPath().includes(bar)) setPanel(null); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setPanel(null); });
  els.reset.addEventListener("click", () => {
    Object.assign(state, { dates: new Set(), q: "", genre: "", rating: "", tags: new Set(), hideSoldOut: false });
    els.search.value = "";
    update();
  });

  update();
}

main().catch((error) => {
  console.error(error);
  els.empty.hidden = false;
  els.empty.textContent = "Couldn't load the listings. Try again shortly, or browse filmhouse.sg directly.";
});
