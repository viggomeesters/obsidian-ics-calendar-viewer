export const ICS_PARSE_COMPONENT_CAP = 5000;
export const ICS_RENDER_ITEM_CAP = 1000;

export type IcsComponentName = string;
export type IcsItemType = "VEVENT" | "VTODO";
export type DatePrecision = "date" | "date-time" | "unknown";

export interface IcsProperty {
  name: string;
  params: Record<string, string[]>;
  value: string;
  raw: string;
  line: number;
}

export interface IcsComponent {
  name: IcsComponentName;
  properties: IcsProperty[];
  children: IcsComponent[];
  startLine: number;
  endLine: number;
}

export interface IcsDateValue {
  raw: string;
  display: string;
  sortKey: string;
  precision: DatePrecision;
  timezone?: string;
  isUtc: boolean;
}

export interface CalendarItem {
  id: string;
  type: IcsItemType;
  uid: string;
  summary: string;
  description: string;
  location: string;
  organizer: string;
  attendees: string[];
  status: string;
  start?: IcsDateValue;
  end?: IcsDateValue;
  due?: IcsDateValue;
  recurrence: string[];
  timezoneRefs: string[];
  sourceLines: [number, number];
  allDay: boolean;
  cancelled: boolean;
  warnings: string[];
}

export interface TimezoneSummary {
  id: string;
  line: number;
  observances: string[];
}

export interface IcsWarning {
  severity: "warning" | "error";
  message: string;
  line?: number;
}

export interface ParsedCalendar {
  rootComponents: IcsComponent[];
  items: CalendarItem[];
  timezones: TimezoneSummary[];
  warnings: IcsWarning[];
  componentCount: number;
  truncated: boolean;
}

interface UnfoldedLine {
  text: string;
  line: number;
}

export function parseIcsCalendar(data: string): ParsedCalendar {
  const unfolded = unfoldLines(data);
  const rootComponents: IcsComponent[] = [];
  const stack: IcsComponent[] = [];
  const warnings: IcsWarning[] = [];
  let componentCount = 0;
  let truncated = false;

  for (const line of unfolded) {
    const property = parsePropertyLine(line.text, line.line);
    if (!property) {
      if (line.text.trim()) {
        warnings.push({
          severity: "warning",
          message: "Ignoring malformed content line.",
          line: line.line,
        });
      }
      continue;
    }

    if (property.name === "BEGIN") {
      componentCount += 1;
      if (componentCount > ICS_PARSE_COMPONENT_CAP) {
        truncated = true;
        if (componentCount === ICS_PARSE_COMPONENT_CAP + 1) {
          warnings.push({
            severity: "warning",
            message: `Component parse cap reached at ${ICS_PARSE_COMPONENT_CAP}; later components are skipped.`,
            line: line.line,
          });
        }
        continue;
      }

      const component: IcsComponent = {
        name: property.value.toUpperCase(),
        properties: [],
        children: [],
        startLine: line.line,
        endLine: line.line,
      };
      const parent = stack.at(-1);
      if (parent) {
        parent.children.push(component);
      } else {
        rootComponents.push(component);
      }
      stack.push(component);
      continue;
    }

    if (property.name === "END") {
      const component = stack.pop();
      if (!component) {
        warnings.push({
          severity: "warning",
          message: `END:${property.value} has no matching BEGIN.`,
          line: line.line,
        });
        continue;
      }

      component.endLine = line.line;
      if (component.name !== property.value.toUpperCase()) {
        warnings.push({
          severity: "warning",
          message: `END:${property.value} closes ${component.name}.`,
          line: line.line,
        });
      }
      continue;
    }

    const current = stack.at(-1);
    if (!current) {
      warnings.push({
        severity: "warning",
        message: `Property ${property.name} appears outside a component.`,
        line: property.line,
      });
      continue;
    }

    current.properties.push(property);
  }

  for (const open of stack.reverse()) {
    warnings.push({
      severity: "warning",
      message: `${open.name} has no END marker.`,
      line: open.startLine,
    });
  }

  const components = flattenComponents(rootComponents);
  const timezones = components
    .filter((component) => component.name === "VTIMEZONE")
    .map(toTimezoneSummary);
  const knownTimezones = new Set(timezones.map((timezone) => timezone.id).filter(Boolean));
  const items = components
    .filter((component) => component.name === "VEVENT" || component.name === "VTODO")
    .slice(0, ICS_RENDER_ITEM_CAP)
    .map((component, index) => toCalendarItem(component, index, knownTimezones));

  const totalItems = components.filter((component) => component.name === "VEVENT" || component.name === "VTODO").length;
  if (totalItems > ICS_RENDER_ITEM_CAP) {
    warnings.push({
      severity: "warning",
      message: `Render cap reached at ${ICS_RENDER_ITEM_CAP}; ${totalItems - ICS_RENDER_ITEM_CAP} later items are hidden.`,
    });
  }

  if (rootComponents.length === 0 && data.trim()) {
    warnings.push({
      severity: "error",
      message: "No valid ICS components were parsed.",
    });
  }

  return {
    rootComponents,
    items,
    timezones,
    warnings,
    componentCount,
    truncated,
  };
}

export function itemMatchesFilters(
  item: CalendarItem,
  textFilter: string,
  startDateFilter: string,
  endDateFilter: string,
): boolean {
  const normalized = textFilter.trim().toLowerCase();
  if (normalized) {
    const haystack = [
      item.summary,
      item.description,
      item.location,
      item.organizer,
      item.uid,
      item.status,
      ...item.attendees,
    ].join(" ").toLowerCase();
    if (!haystack.includes(normalized)) {
      return false;
    }
  }

  const itemDate = item.start?.sortKey || item.due?.sortKey || item.end?.sortKey || "";
  const itemDay = itemDate.slice(0, 10);
  if (startDateFilter && itemDay && itemDay < startDateFilter) {
    return false;
  }
  if (endDateFilter && itemDay && itemDay > endDateFilter) {
    return false;
  }
  return true;
}

export function groupItemsByDate(items: CalendarItem[]): Map<string, CalendarItem[]> {
  const groups = new Map<string, CalendarItem[]>();
  for (const item of items) {
    const key = item.start?.sortKey.slice(0, 10) || item.due?.sortKey.slice(0, 10) || "Undated";
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return sortGroupedItems(groups);
}

export function groupItemsByType(items: CalendarItem[]): Map<string, CalendarItem[]> {
  const groups = new Map<string, CalendarItem[]>();
  for (const item of items) {
    const group = groups.get(item.type) ?? [];
    group.push(item);
    groups.set(item.type, group);
  }
  return sortGroupedItems(groups);
}

export function formatDateRange(item: CalendarItem): string {
  const start = item.start?.display || item.due?.display || "";
  const end = item.end?.display || "";
  if (start && end) {
    return `${start} - ${end}`;
  }
  return start || end || "No date";
}

function sortGroupedItems(groups: Map<string, CalendarItem[]>): Map<string, CalendarItem[]> {
  const sorted = new Map<string, CalendarItem[]>();
  [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, items]) => {
      sorted.set(key, sortItems(items));
    });
  return sorted;
}

function sortItems(items: CalendarItem[]): CalendarItem[] {
  return [...items].sort((left, right) => {
    const leftKey = left.start?.sortKey || left.due?.sortKey || left.end?.sortKey || "";
    const rightKey = right.start?.sortKey || right.due?.sortKey || right.end?.sortKey || "";
    return leftKey.localeCompare(rightKey) || left.summary.localeCompare(right.summary);
  });
}

function unfoldLines(data: string): UnfoldedLine[] {
  const rawLines = data.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: UnfoldedLine[] = [];

  rawLines.forEach((raw, index) => {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length > 0) {
      const previous = lines[lines.length - 1];
      previous.text += raw.slice(1);
      return;
    }
    lines.push({ text: raw, line: index + 1 });
  });

  return lines;
}

function parsePropertyLine(line: string, lineNumber: number): IcsProperty | null {
  const colonIndex = findUnquotedColon(line);
  if (colonIndex <= 0) {
    return null;
  }

  const head = line.slice(0, colonIndex);
  const value = unescapeIcsText(line.slice(colonIndex + 1));
  const [rawName, ...rawParams] = head.split(";");
  const name = rawName.trim().toUpperCase();
  if (!name) {
    return null;
  }

  return {
    name,
    params: parseParams(rawParams),
    value,
    raw: line,
    line: lineNumber,
  };
}

function findUnquotedColon(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      quoted = !quoted;
    }
    if (char === ":" && !quoted) {
      return index;
    }
  }
  return -1;
}

function parseParams(rawParams: string[]): Record<string, string[]> {
  const params: Record<string, string[]> = {};
  for (const rawParam of rawParams) {
    const equalsIndex = rawParam.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = rawParam.slice(0, equalsIndex).trim().toUpperCase();
    const rawValue = rawParam.slice(equalsIndex + 1).trim();
    params[key] = splitParamValues(rawValue).map((value) => stripQuotes(value.trim()));
  }
  return params;
}

function splitParamValues(value: string): string[] {
  const values: string[] = [];
  let quoted = false;
  let current = "";

  for (const char of value) {
    if (char === "\"") {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  values.push(current);
  return values;
}

function stripQuotes(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1);
  }
  return value;
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function flattenComponents(components: IcsComponent[]): IcsComponent[] {
  const flattened: IcsComponent[] = [];
  for (const component of components) {
    flattened.push(component);
    flattened.push(...flattenComponents(component.children));
  }
  return flattened;
}

function toTimezoneSummary(component: IcsComponent): TimezoneSummary {
  const id = firstValue(component, "TZID") || "(missing TZID)";
  const observances = component.children
    .filter((child) => child.name === "STANDARD" || child.name === "DAYLIGHT")
    .map((child) => {
      const name = firstValue(child, "TZNAME") || child.name;
      const offsetFrom = firstValue(child, "TZOFFSETFROM") || "?";
      const offsetTo = firstValue(child, "TZOFFSETTO") || "?";
      return `${name} ${offsetFrom} -> ${offsetTo}`;
    });

  return {
    id,
    line: component.startLine,
    observances,
  };
}

function toCalendarItem(component: IcsComponent, index: number, knownTimezones: Set<string>): CalendarItem {
  const type = component.name === "VTODO" ? "VTODO" : "VEVENT";
  const uid = firstValue(component, "UID") || `${type.toLowerCase()}-${index + 1}`;
  const summary = firstValue(component, "SUMMARY") || "(no summary)";
  const description = firstValue(component, "DESCRIPTION") || "";
  const location = firstValue(component, "LOCATION") || "";
  const organizer = firstValue(component, "ORGANIZER") || "";
  const attendees = values(component, "ATTENDEE");
  const status = firstValue(component, "STATUS") || "";
  const startProperty = firstProperty(component, "DTSTART");
  const endProperty = firstProperty(component, "DTEND");
  const dueProperty = firstProperty(component, "DUE");
  const start = startProperty ? parseIcsDate(startProperty) : undefined;
  const end = endProperty ? parseIcsDate(endProperty) : undefined;
  const due = dueProperty ? parseIcsDate(dueProperty) : undefined;
  const recurrence = recurrenceValues(component);
  const timezoneRefs = collectTimezoneRefs(component);
  const warnings = itemWarnings(component, recurrence, timezoneRefs, knownTimezones);

  return {
    id: `${type}-${uid}-${component.startLine}`,
    type,
    uid,
    summary,
    description,
    location,
    organizer,
    attendees,
    status,
    start,
    end,
    due,
    recurrence,
    timezoneRefs,
    sourceLines: [component.startLine, component.endLine],
    allDay: [startProperty, endProperty, dueProperty].some((property) => property ? isDateOnly(property) : false),
    cancelled: status.toUpperCase() === "CANCELLED",
    warnings,
  };
}

function firstProperty(component: IcsComponent, name: string): IcsProperty | undefined {
  return component.properties.find((property) => property.name === name);
}

function firstValue(component: IcsComponent, name: string): string {
  return firstProperty(component, name)?.value ?? "";
}

function values(component: IcsComponent, name: string): string[] {
  return component.properties
    .filter((property) => property.name === name)
    .map((property) => property.value)
    .filter(Boolean);
}

function recurrenceValues(component: IcsComponent): string[] {
  return component.properties
    .filter((property) => ["RRULE", "RDATE", "EXDATE", "RECURRENCE-ID"].includes(property.name))
    .map((property) => `${property.name}: ${property.value}`);
}

function collectTimezoneRefs(component: IcsComponent): string[] {
  const refs = new Set<string>();
  for (const property of component.properties) {
    const tzid = property.params.TZID?.[0];
    if (tzid) {
      refs.add(tzid);
    }
  }
  return [...refs].sort();
}

function itemWarnings(
  component: IcsComponent,
  recurrence: string[],
  timezoneRefs: string[],
  knownTimezones: Set<string>,
): string[] {
  const warnings: string[] = [];
  if (recurrence.length > 0) {
    warnings.push("Recurrence is summarized only; this viewer does not fully expand repeating events.");
  }

  for (const tzid of timezoneRefs) {
    if (!knownTimezones.has(tzid)) {
      warnings.push(`Timezone ${tzid} is referenced without a matching VTIMEZONE definition.`);
    }
  }

  for (const property of component.properties) {
    if (["DTSTART", "DTEND", "DUE"].includes(property.name)) {
      const parsed = parseIcsDate(property);
      if (parsed.precision === "unknown") {
        warnings.push(`${property.name} has an unsupported date format: ${property.value}`);
      }
      if (!parsed.timezone && !parsed.isUtc && parsed.precision === "date-time") {
        warnings.push(`${property.name} is a floating local time without TZID or UTC marker.`);
      }
    }
  }

  return [...new Set(warnings)];
}

function parseIcsDate(property: IcsProperty): IcsDateValue {
  const raw = property.value;
  const timezone = property.params.TZID?.[0];
  const isUtc = raw.endsWith("Z");
  const normalized = raw.replace(/Z$/, "");

  if (isDateOnly(property)) {
    const year = normalized.slice(0, 4);
    const month = normalized.slice(4, 6);
    const day = normalized.slice(6, 8);
    return {
      raw,
      display: `${year}-${month}-${day}${timezone ? ` (${timezone})` : ""}`,
      sortKey: `${year}-${month}-${day}`,
      precision: "date",
      timezone,
      isUtc,
    };
  }

  const match = normalized.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/);
  if (!match) {
    return {
      raw,
      display: raw,
      sortKey: raw,
      precision: "unknown",
      timezone,
      isUtc,
    };
  }

  const [, year, month, day, hour, minute, second = "00"] = match;
  const zoneLabel = timezone ? ` (${timezone})` : isUtc ? " (UTC)" : " (floating)";
  return {
    raw,
    display: `${year}-${month}-${day} ${hour}:${minute}:${second}${zoneLabel}`,
    sortKey: `${year}-${month}-${day}T${hour}:${minute}:${second}`,
    precision: "date-time",
    timezone,
    isUtc,
  };
}

function isDateOnly(property: IcsProperty): boolean {
  return property.params.VALUE?.some((value) => value.toUpperCase() === "DATE") === true
    || /^\d{8}$/.test(property.value);
}
