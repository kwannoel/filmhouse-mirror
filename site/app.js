const $ = (id) => document.getElementById(id);
const els = {
  stats: $("stats"), days: $("days"), search: $("search"), filtersToggle: $("filtersToggle"), filters: $("filters"),
  tags: $("tags"), genres: $("genres"), ratings: $("ratings"), options: $("options"), sorts: $("sorts"),
  films: $("films"), empty: $("empty"), reset: $("reset"),
};

const RATING_ORDER = ["G", "PG", "PG13", "NC16", "M18", "R21", "TBA"];
const TAG_LABELS = { "LastChance": "Last chance", "Live Q&A": "Q&A", "With Intro": "Intro" };
const SORTS = { next: "Soonest", title: "A–Z" };
// With "All" days selected, a film shows this many sessions before a "+N" toggle.
const COLLAPSED_SESSIONS = 2;

const state = { date: "", q: "", genre: "", rating: "", tags: new Set(), hideSoldOut: false, sort: "next" };
const expanded = new Set();
let films = [];
let scrapedAt = null;

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

function addDays(isoDate, n) {
  const d = asDate(isoDate);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayLabel(isoDate, today) {
  if (isoDate === today) return "Today";
  if (isoDate === addDays(today, 1)) return "Tomorrow";
  return fmt(isoDate, { weekday: "short", day: "numeric" });
}

function timeAgo(iso) {
  const minutes = Math.round((Date.now() - new Date(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
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
  state.date = p.get("date") ?? "";
  state.q = p.get("q") ?? "";
  state.genre = p.get("genre") ?? "";
  state.rating = p.get("rating") ?? "";
  state.tags = new Set((p.get("tags") ?? "").split(",").filter(Boolean));
  state.hideSoldOut = p.get("soldout") === "hide";
  state.sort = p.get("sort") === "title" ? "title" : "next";
}

function writeUrl() {
  const p = new URLSearchParams();
  if (state.date) p.set("date", state.date);
  if (state.q) p.set("q", state.q);
  if (state.genre) p.set("genre", state.genre);
  if (state.rating) p.set("rating", state.rating);
  if (state.tags.size) p.set("tags", [...state.tags].join(","));
  if (state.hideSoldOut) p.set("soldout", "hide");
  if (state.sort !== "next") p.set("sort", state.sort);
  const query = p.toString();
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

const activeFilterCount = () =>
  (state.genre ? 1 : 0) + (state.rating ? 1 : 0) + state.tags.size + (state.hideSoldOut ? 1 : 0);

// Sessions that pass the session-level filters, with past sessions dropped.
function visibleShowings(film, now) {
  return film.showings.filter((s) =>
    (s.date > now.date || (s.date === now.date && s.time >= now.time)) &&
    (!state.date || s.date === state.date) &&
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

function renderDays(now) {
  const dates = [...new Set(films.flatMap((f) => f.showings).filter((s) => s.date >= now.date).map((s) => s.date))].sort();
  if (state.date && !dates.includes(state.date)) state.date = "";

  const day = (value, label, title) => el("button", {
    type: "button", "aria-pressed": String(state.date === value), title,
    onclick: () => { state.date = value; update(); },
  }, label);

  els.days.replaceChildren(
    day("", "All"),
    ...dates.map((d, i) => {
      // Name the month where it changes, so "Sun 1" isn't ambiguous.
      const newMonth = i > 0 && d.slice(0, 7) !== dates[i - 1].slice(0, 7);
      const label = newMonth ? fmt(d, { weekday: "short", day: "numeric", month: "short" }) : dayLabel(d, now.date);
      return day(d, label, fmt(d, { weekday: "long", day: "numeric", month: "long" }));
    }),
  );
  // Keep the chosen day visible in the horizontally scrolling row (without scrolling the page).
  const pressed = els.days.querySelector('[aria-pressed="true"]');
  els.days.scrollLeft = pressed.offsetLeft - els.days.offsetLeft - (els.days.clientWidth - pressed.offsetWidth) / 2;
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

  els.sorts.replaceChildren(...Object.entries(SORTS).map(([key, label]) => option(label, state.sort === key, () => {
    state.sort = key;
    update();
  })));

  const n = activeFilterCount();
  els.filtersToggle.textContent = n ? `Filters (${n})` : "Filters";
}

function renderSession(s, today) {
  const parts = [
    state.date ? null : el("span", { class: "day" }, `${dayLabel(s.date, today)} `),
    el("span", { class: "at" }, s.label),
    ...s.tags.map((t) => el("span", { class: "tag" }, ` ${TAG_LABELS[t] ?? t}`)),
  ];
  if (s.soldOut || !s.bookUrl) {
    return el("span", { class: "time sold", title: "Sold out" }, parts);
  }
  const when = fmt(s.date, { weekday: "long", day: "numeric", month: "long" });
  return el("a", {
    class: "time", href: s.bookUrl, target: "_blank", rel: "noopener", title: `Book ${when}, ${s.label} on filmhouse.sg`,
  }, parts);
}

function renderFilm(film, showings, today) {
  const collapsible = !state.date && showings.length > COLLAPSED_SESSIONS + 1;
  const open = expanded.has(film.id);
  const shown = collapsible && !open ? showings.slice(0, COLLAPSED_SESSIONS) : showings;
  const meta = [film.rating, film.runtime?.replace(/\s*mins?$/, " min"), film.genre].filter(Boolean).join(" · ");

  return el("li", { class: "film" },
    el("a", { class: "poster", href: film.url, target: "_blank", rel: "noopener", tabindex: "-1", "aria-hidden": "true" },
      el("img", { src: film.poster, alt: "", loading: "lazy", width: "44", height: "66" })),
    el("div", {},
      el("a", { class: "title", href: film.url, target: "_blank", rel: "noopener" }, film.title),
      el("div", { class: "meta" }, meta),
    ),
    el("div", { class: "times" },
      shown.map((s) => renderSession(s, today)),
      collapsible ? el("button", {
        type: "button", "aria-expanded": String(open),
        onclick: () => { open ? expanded.delete(film.id) : expanded.add(film.id); update(); },
      }, open ? "Less" : `+${showings.length - COLLAPSED_SESSIONS}`) : null,
    ),
  );
}

function update() {
  writeUrl();
  const now = singaporeNow();
  renderDays(now);
  renderFilters();

  const rows = films
    .filter(matchesFilm)
    .map((film) => ({ film, showings: visibleShowings(film, now) }))
    .filter((r) => r.showings.length);
  rows.sort(state.sort === "title"
    ? (a, b) => a.film.title.localeCompare(b.film.title)
    : (a, b) => {
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

async function main() {
  const response = await fetch("films.json", { cache: "no-cache" });
  const snapshot = await response.json();
  scrapedAt = snapshot.scrapedAt;
  films = snapshot.films.map((f) => ({
    ...f, showings: [...f.showings].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
  }));

  readUrl();
  els.search.value = state.q;
  const setFiltersOpen = (open) => {
    els.filters.hidden = !open;
    els.filtersToggle.setAttribute("aria-expanded", String(open));
  };
  setFiltersOpen(activeFilterCount() > 0 || state.sort !== "next");

  els.search.addEventListener("input", () => { state.q = els.search.value.trim(); update(); });
  els.filtersToggle.addEventListener("click", () => setFiltersOpen(els.filters.hidden));
  els.reset.addEventListener("click", () => {
    Object.assign(state, { date: "", q: "", genre: "", rating: "", tags: new Set(), hideSoldOut: false });
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
