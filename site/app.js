const $ = (id) => document.getElementById(id);
const els = {
  dates: $("dates"), search: $("search"), genre: $("genre"), rating: $("rating"), sort: $("sort"),
  tags: $("tags"), hideSoldOut: $("hideSoldOut"), films: $("films"), count: $("count"),
  empty: $("empty"), reset: $("reset"), updated: $("updated"),
};

const RATING_ORDER = ["G", "PG", "PG13", "NC16", "M18", "R21", "TBA"];
const state = { date: "", q: "", genre: "", rating: "", tags: new Set(), hideSoldOut: false, sort: "next" };
let films = [];

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

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateLabel(isoDate, today) {
  if (isoDate === today) return "Today";
  if (isoDate === addDays(today, 1)) return "Tomorrow";
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-SG", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  });
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

// Showings that pass the session-level filters, with past sessions dropped.
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

function renderFilters(now) {
  const dates = [...new Set(films.flatMap((f) => f.showings).filter((s) => s.date >= now.date).map((s) => s.date))].sort();
  if (state.date && !dates.includes(state.date)) state.date = "";

  const chip = (value, label) => el("button", {
    type: "button", class: "chip", "aria-pressed": String(state.date === value),
    onclick: () => { state.date = value; update(); },
  }, label);
  els.dates.replaceChildren(chip("", "All dates"), ...dates.map((d) => chip(d, dateLabel(d, now.date))));
  // Keep the chosen date visible in the horizontally scrolling row (without scrolling the page).
  const pressed = els.dates.querySelector('[aria-pressed="true"]');
  els.dates.scrollLeft = pressed.offsetLeft - els.dates.offsetLeft - (els.dates.clientWidth - pressed.offsetWidth) / 2;

  const allTags = [...new Set(films.flatMap((f) => f.showings.flatMap((s) => s.tags)))].sort();
  els.tags.replaceChildren(...allTags.map((tag) => el("button", {
    type: "button", class: "chip small", "aria-pressed": String(state.tags.has(tag)),
    onclick: () => { state.tags.has(tag) ? state.tags.delete(tag) : state.tags.add(tag); update(); },
  }, tag)));
}

function renderShowtime(s) {
  const tags = s.tags.length ? el("span", { class: "tags" }, s.tags.join(" · ")) : null;
  if (s.soldOut || !s.bookUrl) {
    return el("span", { class: "time sold", title: "Sold out" }, el("span", {}, s.label), el("span", { class: "tags" }, "Sold out"));
  }
  return el("a", {
    class: "time", href: s.bookUrl, target: "_blank", rel: "noopener",
    title: `Book ${s.label} on filmhouse.sg`,
  }, el("span", {}, s.label), tags);
}

function renderFilm(film, showings, today) {
  const byDate = new Map();
  for (const s of showings) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
  const meta = [film.year, film.runtime?.replace(/mins?$/, " min"), film.rating, film.genre].filter(Boolean);
  return el("article", { class: "film" },
    el("a", { class: "poster", href: film.url, target: "_blank", rel: "noopener", tabindex: "-1", "aria-hidden": "true" },
      el("img", { src: film.poster, alt: "", loading: "lazy", width: "150", height: "225" })),
    el("div", { class: "body" },
      el("h2", {}, el("a", { href: film.url, target: "_blank", rel: "noopener" }, film.title)),
      el("p", { class: "meta" }, meta.join(" · ")),
      film.directors.length ? el("p", { class: "people" }, `Directed by ${film.directors.join(", ")}`) : null,
      el("div", { class: "showings" }, [...byDate].map(([date, list]) =>
        el("div", { class: "day" },
          state.date ? null : el("span", { class: "day-label" }, dateLabel(date, today)),
          el("div", { class: "times" }, list.map(renderShowtime))))),
    ),
  );
}

function update() {
  writeUrl();
  const now = singaporeNow();
  renderFilters(now);

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
  const sessions = rows.reduce((n, r) => n + r.showings.length, 0);
  els.count.textContent = rows.length ? `${rows.length} film${rows.length === 1 ? "" : "s"}, ${sessions} session${sessions === 1 ? "" : "s"}` : "";
  els.empty.hidden = rows.length > 0;
}

function syncInputs() {
  els.search.value = state.q;
  els.genre.value = state.genre;
  els.rating.value = state.rating;
  els.sort.value = state.sort;
  els.hideSoldOut.checked = state.hideSoldOut;
}

async function main() {
  const response = await fetch("films.json", { cache: "no-cache" });
  const snapshot = await response.json();
  films = snapshot.films.map((f) => ({
    ...f, showings: [...f.showings].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
  }));

  els.updated.textContent = `Updated ${timeAgo(snapshot.scrapedAt)}.`;
  els.updated.title = new Date(snapshot.scrapedAt).toLocaleString("en-SG");
  // The refresh runs every 15 minutes; flag it if GitHub has stopped running it.
  if (Date.now() - new Date(snapshot.scrapedAt) > 6 * 3600_000) els.updated.classList.add("stale");

  const genres = [...new Set(films.flatMap(genresOf))].sort();
  els.genre.append(...genres.map((g) => el("option", { value: g }, g)));
  const ratings = [...new Set(films.map((f) => f.rating).filter(Boolean))]
    .sort((a, b) => RATING_ORDER.indexOf(a) - RATING_ORDER.indexOf(b));
  els.rating.append(...ratings.map((r) => el("option", { value: r }, r)));

  readUrl();
  syncInputs();

  els.search.addEventListener("input", () => { state.q = els.search.value.trim(); update(); });
  els.genre.addEventListener("change", () => { state.genre = els.genre.value; update(); });
  els.rating.addEventListener("change", () => { state.rating = els.rating.value; update(); });
  els.sort.addEventListener("change", () => { state.sort = els.sort.value; update(); });
  els.hideSoldOut.addEventListener("change", () => { state.hideSoldOut = els.hideSoldOut.checked; update(); });
  els.reset.addEventListener("click", () => {
    Object.assign(state, { date: "", q: "", genre: "", rating: "", tags: new Set(), hideSoldOut: false });
    syncInputs();
    update();
  });

  update();
}

main().catch((error) => {
  console.error(error);
  els.count.textContent = "Couldn't load the film list. Try again shortly, or browse filmhouse.sg directly.";
});
