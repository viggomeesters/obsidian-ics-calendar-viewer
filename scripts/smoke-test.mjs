import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

const tempParser = "scripts/.tmp-ics-parser.mjs";

await esbuild.build({
  bundle: true,
  entryPoints: ["src/ics.ts"],
  format: "esm",
  logLevel: "silent",
  outfile: tempParser,
  platform: "node",
  target: "es2022",
});

const {
  ICS_PARSE_COMPONENT_CAP,
  ICS_RENDER_ITEM_CAP,
  groupItemsByDate,
  itemMatchesFilters,
  parseIcsCalendar,
} = await import(pathToFileURL(path.resolve(tempParser)).href);

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const main = fs.readFileSync("src/main.ts", "utf8");
const parser = fs.readFileSync("src/ics.ts", "utf8");
const styles = fs.readFileSync("styles.css", "utf8");

const fixture = (name) => fs.readFileSync(`test-fixtures/${name}.ics`, "utf8");
const single = parseIcsCalendar(fixture("single-event"));
const multi = parseIcsCalendar(fixture("multi-event"));
const timezone = parseIcsCalendar(fixture("timezone"));
const recurrence = parseIcsCalendar(fixture("recurrence"));
const allDay = parseIcsCalendar(fixture("all-day"));
const cancelled = parseIcsCalendar(fixture("cancelled"));
const malformed = parseIcsCalendar(fixture("malformed"));
const large = parseIcsCalendar(fixture("large"));

const generatedLarge = parseIcsCalendar(generateLargeCalendar(ICS_RENDER_ITEM_CAP + 5));

const securitySource = `${main}\n${parser}\n${styles}`;
const forbiddenRuntimePatterns = [
  /fetch\s*\(/,
  /XMLHttpRequest/,
  /WebSocket/,
  /navigator\.clipboard/,
  /child_process/,
  /spawn\s*\(/,
  /exec\s*\(/,
  /write\s*\(/,
  /modify\s*\(/,
  /eval\s*\(/,
  /new Function/,
  /!important/,
];

const assertions = [
  [manifest.id === "ics-calendar-viewer", "manifest id is ics-calendar-viewer"],
  [manifest.name === "ICS Calendar Viewer", "manifest name is ICS Calendar Viewer"],
  [main.includes("this.registerExtensions(ICS_EXTENSIONS, VIEW_TYPE_ICS_CALENDAR_VIEWER)"), "plugin registers .ics extension"],
  [main.includes("renderSource(container, this.data)"), "source view is reachable"],
  [parser.includes("VTIMEZONE"), "parser handles VTIMEZONE"],
  [parser.includes("VEVENT") && parser.includes("VTODO"), "parser handles VEVENT and VTODO"],
  [single.items.length === 1 && single.items[0].summary === "Project check-in", "single event parses"],
  [multi.items.length === 3 && multi.items.some((item) => item.type === "VTODO"), "multi event and VTODO parse"],
  [timezone.timezones.length === 1 && timezone.items[0].timezoneRefs.includes("Europe/Amsterdam"), "timezone summary parses"],
  [recurrence.items[0].recurrence.length === 2, "recurrence fields parse"],
  [recurrence.items[0].warnings.some((warning) => warning.includes("does not fully expand")), "recurrence warning exists"],
  [allDay.items[0].allDay === true, "all-day event detected"],
  [cancelled.items[0].cancelled === true, "cancelled event detected"],
  [malformed.warnings.length > 0 && malformed.items[0].warnings.length > 0, "malformed fixture warns without throwing"],
  [large.items.length === 12, "large fixture parses"],
  [generatedLarge.items.length === ICS_RENDER_ITEM_CAP, "render cap is enforced"],
  [generatedLarge.warnings.some((warning) => warning.message.includes("Render cap")), "render cap warning exists"],
  [ICS_PARSE_COMPONENT_CAP >= ICS_RENDER_ITEM_CAP, "component cap covers render cap"],
  [itemMatchesFilters(single.items[0], "Room 1", "", ""), "location filter matches"],
  [itemMatchesFilters(single.items[0], "attendee@example", "", ""), "attendee filter matches"],
  [!itemMatchesFilters(single.items[0], "missing", "", ""), "text filter excludes misses"],
  [groupItemsByDate(multi.items).has("2026-06-10"), "date grouping uses parsed event dates"],
  [forbiddenRuntimePatterns.every((pattern) => !pattern.test(securitySource)), "runtime source avoids forbidden APIs and style overrides"],
];

const failures = assertions.filter(([passes]) => !passes).map(([, label]) => label);

try {
  fs.unlinkSync(tempParser);
} catch {
  // The test result should not depend on cleanup success.
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`);
  }
  process.exit(1);
}

console.log("ICS Calendar Viewer smoke checks passed.");

function generateLargeCalendar(count) {
  const events = [];
  for (let index = 0; index < count; index += 1) {
    const day = String((index % 28) + 1).padStart(2, "0");
    events.push([
      "BEGIN:VEVENT",
      `UID:generated-${index}@example.test`,
      `DTSTART:202608${day}T090000Z`,
      `DTEND:202608${day}T093000Z`,
      `SUMMARY:Generated large event ${index}`,
      "END:VEVENT",
    ].join("\n"));
  }

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ICS Calendar Viewer//Generated Large//EN",
    ...events,
    "END:VCALENDAR",
  ].join("\n");
}
