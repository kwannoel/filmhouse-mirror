// Scrapes https://filmhouse.sg/films/ into site/films.json.
// Filmhouse has no CORS-enabled API, so the static site reads this snapshot instead.
import { writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";

const SOURCE_URL = "https://filmhouse.sg/films/";
const OUT_FILE = new URL("../site/films.json", import.meta.url);
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const clean = (text) => text.replace(/\s+/g, " ").trim();

// Today's date in Singapore, which is what the showtime headings are relative to.
function singaporeToday() {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" })
    .format(new Date())
    .split("-")
    .map(Number);
  return { y, m, d };
}

// "Tuesday 27th October" has no year; pick the year that puts it closest to today.
function parseHeadingDate(heading, today) {
  const match = heading.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTHS.indexOf(match[2].toLowerCase()) + 1;
  if (!month) return null;
  let year = today.y;
  if (month < today.m - 6) year += 1;
  else if (month > today.m + 6) year -= 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// "3:20 pm" -> "15:20"
function parseTime(label) {
  const match = label.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toLowerCase() === "pm") hour += 12;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function parseFilm($, el, today) {
  const $el = $(el);
  const link = $el.find("a.liveeventtitle");
  const url = (link.attr("href") ?? "").replace(/^http:/, "https:");
  const [, id, slug] = url.match(/\/film\/(\d+)\/([^/?#]+)/) ?? [];

  const facts = $el.find(".running-time span").map((_, s) => clean($(s).text())).get();
  const year = facts.find((f) => /^\d{4}$/.test(f)) ?? null;
  const runtime = facts.find((f) => /^\d+\s*mins?$/i.test(f)) ?? null;
  const rating = facts.find((f) => /^\(.*\)$/.test(f))?.slice(1, -1) ?? null;
  const genre = facts.find((f) => f !== year && f !== runtime && !/^\(.*\)$/.test(f)) ?? null;

  let directors = [];
  let cast = [];
  $el.find(".film-info span").each((_, s) => {
    const text = clean($(s).text());
    if (text.startsWith("Directed by ")) directors = text.slice(12).split(/\s*[|,]\s*/).filter(Boolean);
    if (text.startsWith("Starring ")) cast = text.slice(9).split(/\s*,\s*/).filter(Boolean);
  });


  const showings = [];
  let date = null;
  $el.find(".performance-list-items").children().each((_, child) => {
    const $child = $(child);
    if ($child.hasClass("heading")) {
      date = parseHeadingDate(clean($child.text()), today);
      return;
    }
    if (child.tagName !== "li" || !date) return;
    const button = $child.find("a.film_book_button, a.soldfilm_book_button").first();
    const label = clean(button.find(".time").text());
    showings.push({
      date,
      time: parseTime(label),
      label,
      soldOut: button.hasClass("soldfilm_book_button"),
      bookUrl: button.attr("href") ?? null,
      tags: $child.find(".movietag .tag").map((_, t) => clean($(t).text())).get(),
    });
  });

  return {
    id: id ? Number(id) : null,
    slug: slug ?? null,
    title: clean(link.text()),
    url,
    poster: $el.find(".film_img img").attr("src") ?? null,
    year,
    runtime,
    rating,
    genre,
    directors,
    cast,
    showings,
  };
}

async function main() {
  const response = await fetch(SOURCE_URL, {
    headers: { "User-Agent": "filmhouse-mirror (+https://github.com/kwannoel/filmhouse-mirror)" },
  });
  if (!response.ok) throw new Error(`${SOURCE_URL} returned ${response.status}`);
  const $ = cheerio.load(await response.text());
  const today = singaporeToday();

  const films = $(".jacrofilm-list > .jacro-event")
    .map((_, el) => parseFilm($, el, today))
    .get()
    .filter((film) => film.title);

  // A layout change on their side would silently empty the site; fail the run instead.
  if (films.length === 0) throw new Error("No films found; the page layout may have changed");

  const snapshot = { source: SOURCE_URL, scrapedAt: new Date().toISOString(), films };
  await writeFile(OUT_FILE, JSON.stringify(snapshot, null, 2) + "\n");
  const showings = films.reduce((n, f) => n + f.showings.length, 0);
  console.log(`Wrote ${films.length} films, ${showings} showings`);
}

await main();
