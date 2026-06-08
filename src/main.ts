import {
  Notice,
  Plugin,
  TFile,
  TextFileView,
  ViewStateResult,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import {
  CalendarItem,
  ICS_RENDER_ITEM_CAP,
  ParsedCalendar,
  formatDateRange,
  groupItemsByDate,
  groupItemsByType,
  itemMatchesFilters,
  parseIcsCalendar,
} from "./ics";

const VIEW_TYPE_ICS_CALENDAR_VIEWER = "ics-calendar-viewer";
const ICS_EXTENSIONS = ["ics"];

type ViewMode = "events" | "source";
type GroupMode = "date" | "type";

interface IcsCalendarViewerState {
  file?: string;
  mode?: ViewMode;
  groupMode?: GroupMode;
  query?: string;
  startDate?: string;
  endDate?: string;
}

export default class IcsCalendarViewerPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(
      VIEW_TYPE_ICS_CALENDAR_VIEWER,
      (leaf) => new IcsCalendarViewerView(leaf),
    );
    this.registerExtensions(ICS_EXTENSIONS, VIEW_TYPE_ICS_CALENDAR_VIEWER);

    this.addCommand({
      id: "open-current-ics-in-viewer",
      name: "Open current ICS file in viewer",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isIcsFile(file)) return false;

        if (!checking) {
          void this.openIcsFile(file);
        }
        return true;
      },
    });
  }

  async openIcsFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_ICS_CALENDAR_VIEWER,
      state: { file: file.path },
      active: true,
    });
  }
}

class IcsCalendarViewerView extends TextFileView {
  private mode: ViewMode = "events";
  private groupMode: GroupMode = "date";
  private query = "";
  private startDate = "";
  private endDate = "";
  private selectedId = "";

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_ICS_CALENDAR_VIEWER;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "ICS calendar viewer";
  }

  getIcon(): string {
    return "calendar-days";
  }

  getState(): Record<string, unknown> {
    return {
      ...super.getState(),
      mode: this.mode,
      groupMode: this.groupMode,
      query: this.query,
      startDate: this.startDate,
      endDate: this.endDate,
    };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    if (isViewerState(state)) {
      if (state.mode) this.mode = state.mode;
      if (state.groupMode) this.groupMode = state.groupMode;
      if (typeof state.query === "string") this.query = state.query;
      if (typeof state.startDate === "string") this.startDate = state.startDate;
      if (typeof state.endDate === "string") this.endDate = state.endDate;
    }
    this.render();
  }

  setViewData(data: string): void {
    this.data = data;
    this.render();
  }

  getViewData(): string {
    return this.data;
  }

  clear(): void {
    this.data = "";
    this.contentEl.empty();
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("ics-calendar-viewer");

    const header = container.createDiv({ cls: "ics-calendar-viewer__header" });
    this.renderTitle(header);
    this.renderToolbar(header);

    if (!this.file) {
      renderMessage(container, "No ICS file is attached to this viewer.");
      return;
    }

    if (!isIcsFile(this.file)) {
      renderMessage(container, "This viewer only supports .ics files.");
      return;
    }

    if (!this.data.trim()) {
      renderMessage(container, "This ICS file is empty.");
      return;
    }

    if (this.mode === "source") {
      renderSource(container, this.data);
      return;
    }

    const calendar = parseIcsCalendar(this.data);
    this.renderSummary(container, calendar);
    this.renderWarnings(container, calendar);
    this.renderEvents(container, calendar);
  }

  private renderTitle(parent: HTMLElement): void {
    const title = parent.createDiv({ cls: "ics-calendar-viewer__title" });
    title.createDiv({
      cls: "ics-calendar-viewer__filename",
      text: this.file?.name ?? "ICS file",
    });
    title.createDiv({
      cls: "ics-calendar-viewer__path",
      text: this.file?.path ?? "",
    });
  }

  private renderToolbar(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: "ics-calendar-viewer__toolbar" });
    const modeGroup = toolbar.createDiv({
      cls: "ics-calendar-viewer__segmented",
      attr: { "aria-label": "View mode" },
    });
    const eventsButton = createTextButton(modeGroup, "Events");
    const sourceButton = createTextButton(modeGroup, "Source");
    eventsButton.toggleClass("is-active", this.mode === "events");
    sourceButton.toggleClass("is-active", this.mode === "source");

    eventsButton.addEventListener("click", () => {
      this.mode = "events";
      this.render();
    });
    sourceButton.addEventListener("click", () => {
      this.mode = "source";
      this.render();
    });

    const refreshButton = createIconButton(toolbar, "refresh-cw", "Refresh file");
    refreshButton.addEventListener("click", () => {
      void this.reloadFile();
    });
  }

  private renderSummary(parent: HTMLElement, calendar: ParsedCalendar): void {
    const summary = parent.createDiv({ cls: "ics-calendar-viewer__summary" });
    renderMetric(summary, "Items", String(calendar.items.length));
    renderMetric(summary, "Timezones", String(calendar.timezones.length));
    renderMetric(summary, "Components", String(calendar.componentCount));
    renderMetric(summary, "Cap", String(ICS_RENDER_ITEM_CAP));

    if (calendar.timezones.length > 0) {
      const timezonePanel = parent.createDiv({ cls: "ics-calendar-viewer__timezone-panel" });
      timezonePanel.createDiv({ cls: "ics-calendar-viewer__section-title", text: "Timezones" });
      calendar.timezones.forEach((timezone) => {
        const row = timezonePanel.createDiv({ cls: "ics-calendar-viewer__timezone" });
        row.createSpan({ cls: "ics-calendar-viewer__timezone-id", text: timezone.id });
        row.createSpan({
          cls: "ics-calendar-viewer__timezone-detail",
          text: timezone.observances.length > 0 ? timezone.observances.join("; ") : `line ${timezone.line}`,
        });
      });
    }
  }

  private renderWarnings(parent: HTMLElement, calendar: ParsedCalendar): void {
    const warnings = [
      ...calendar.warnings.map((warning) => warning.line ? `${warning.message} (line ${warning.line})` : warning.message),
      ...calendar.items.flatMap((item) => item.warnings.map((warning) => `${item.summary}: ${warning}`)),
    ];

    if (warnings.length === 0) {
      return;
    }

    const panel = parent.createDiv({ cls: "ics-calendar-viewer__warnings" });
    panel.createDiv({ cls: "ics-calendar-viewer__section-title", text: "Warnings" });
    warnings.forEach((warning) => {
      const row = panel.createDiv({ cls: "ics-calendar-viewer__warning" });
      setIcon(row.createSpan({ cls: "ics-calendar-viewer__warning-icon" }), "triangle-alert");
      row.createSpan({ text: warning });
    });
  }

  private renderEvents(parent: HTMLElement, calendar: ParsedCalendar): void {
    const filterBar = parent.createDiv({ cls: "ics-calendar-viewer__filters" });
    const searchWrap = filterBar.createDiv({ cls: "ics-calendar-viewer__search" });
    setIcon(searchWrap.createSpan({ cls: "ics-calendar-viewer__search-icon" }), "search");
    const searchInput = searchWrap.createEl("input", {
      value: this.query,
      attr: {
        "aria-label": "Filter events",
        placeholder: "Filter summary, location, attendee, UID",
        spellcheck: "false",
        type: "search",
      },
    });
    searchInput.addEventListener("input", () => {
      this.query = searchInput.value;
      this.render();
    });

    const startInput = createDateInput(filterBar, "Start date", this.startDate);
    startInput.addEventListener("input", () => {
      this.startDate = startInput.value;
      this.render();
    });

    const endInput = createDateInput(filterBar, "End date", this.endDate);
    endInput.addEventListener("input", () => {
      this.endDate = endInput.value;
      this.render();
    });

    const groupControl = filterBar.createDiv({
      cls: "ics-calendar-viewer__segmented",
      attr: { "aria-label": "Group events" },
    });
    const dateButton = createTextButton(groupControl, "Date");
    const typeButton = createTextButton(groupControl, "Type");
    dateButton.toggleClass("is-active", this.groupMode === "date");
    typeButton.toggleClass("is-active", this.groupMode === "type");
    dateButton.addEventListener("click", () => {
      this.groupMode = "date";
      this.render();
    });
    typeButton.addEventListener("click", () => {
      this.groupMode = "type";
      this.render();
    });

    const filtered = calendar.items.filter((item) => itemMatchesFilters(item, this.query, this.startDate, this.endDate));
    const selected = filtered.find((item) => item.id === this.selectedId) ?? filtered[0];
    this.selectedId = selected?.id ?? "";

    const body = parent.createDiv({ cls: "ics-calendar-viewer__body" });
    const list = body.createDiv({ cls: "ics-calendar-viewer__list" });
    const detail = body.createDiv({ cls: "ics-calendar-viewer__detail" });

    if (filtered.length === 0) {
      list.createDiv({ cls: "ics-calendar-viewer__empty", text: "No matching events or tasks." });
      detail.createDiv({ cls: "ics-calendar-viewer__empty", text: "Adjust filters to select an item." });
      return;
    }

    const groups = this.groupMode === "date" ? groupItemsByDate(filtered) : groupItemsByType(filtered);
    groups.forEach((items, group) => {
      const section = list.createDiv({ cls: "ics-calendar-viewer__group" });
      section.createDiv({ cls: "ics-calendar-viewer__group-title", text: group });
      items.forEach((item) => {
        const button = section.createEl("button", {
          cls: "ics-calendar-viewer__item",
          attr: { type: "button" },
        });
        button.toggleClass("is-selected", item.id === selected.id);
        button.createDiv({ cls: "ics-calendar-viewer__item-title", text: item.summary });
        button.createDiv({ cls: "ics-calendar-viewer__item-meta", text: `${item.type} | ${formatDateRange(item)}` });
        if (item.location) {
          button.createDiv({ cls: "ics-calendar-viewer__item-location", text: item.location });
        }
        button.addEventListener("click", () => {
          this.selectedId = item.id;
          this.render();
        });
      });
    });

    renderDetail(detail, selected);
  }

  private async reloadFile(): Promise<void> {
    if (!this.file) {
      new Notice("No ICS file to refresh");
      return;
    }

    try {
      this.data = await this.app.vault.read(this.file);
      this.render();
    } catch (error) {
      this.contentEl.empty();
      this.contentEl.addClass("ics-calendar-viewer");
      renderMessage(this.contentEl, `Unable to read ICS file: ${getErrorMessage(error)}`);
    }
  }
}

function renderDetail(parent: HTMLElement, item: CalendarItem): void {
  parent.createDiv({ cls: "ics-calendar-viewer__detail-title", text: item.summary });
  const badges = parent.createDiv({ cls: "ics-calendar-viewer__badges" });
  badges.createSpan({ cls: "ics-calendar-viewer__badge", text: item.type });
  if (item.allDay) badges.createSpan({ cls: "ics-calendar-viewer__badge", text: "All day" });
  if (item.cancelled) badges.createSpan({ cls: "ics-calendar-viewer__badge is-warning", text: "Cancelled" });

  const fields = parent.createDiv({ cls: "ics-calendar-viewer__fields" });
  renderField(fields, "When", formatDateRange(item));
  renderField(fields, "Due", item.due?.display ?? "");
  renderField(fields, "Location", item.location);
  renderField(fields, "Organizer", item.organizer);
  renderField(fields, "Attendees", item.attendees.join(", "));
  renderField(fields, "Status", item.status);
  renderField(fields, "UID", item.uid);
  renderField(fields, "Timezone", item.timezoneRefs.join(", "));
  renderField(fields, "Source lines", `${item.sourceLines[0]}-${item.sourceLines[1]}`);

  if (item.description) {
    parent.createDiv({ cls: "ics-calendar-viewer__section-title", text: "Description" });
    parent.createEl("pre", { cls: "ics-calendar-viewer__description", text: item.description });
  }

  if (item.recurrence.length > 0) {
    parent.createDiv({ cls: "ics-calendar-viewer__section-title", text: "Recurrence" });
    const list = parent.createEl("ul", { cls: "ics-calendar-viewer__recurrence" });
    item.recurrence.forEach((recurrence) => {
      list.createEl("li", { text: recurrence });
    });
  }

  if (item.warnings.length > 0) {
    parent.createDiv({ cls: "ics-calendar-viewer__section-title", text: "Item warnings" });
    const list = parent.createEl("ul", { cls: "ics-calendar-viewer__item-warnings" });
    item.warnings.forEach((warning) => {
      list.createEl("li", { text: warning });
    });
  }
}

function renderSource(parent: HTMLElement, data: string): void {
  const source = parent.createDiv({ cls: "ics-calendar-viewer__source" });
  const pre = source.createEl("pre");
  data.split("\n").forEach((line, index) => {
    const row = pre.createDiv({ cls: "ics-calendar-viewer__source-line" });
    row.createSpan({ cls: "ics-calendar-viewer__line-number", text: String(index + 1) });
    row.createSpan({ cls: "ics-calendar-viewer__source-code", text: line });
  });
}

function renderMetric(parent: HTMLElement, label: string, value: string): void {
  const metric = parent.createDiv({ cls: "ics-calendar-viewer__metric" });
  metric.createSpan({ cls: "ics-calendar-viewer__metric-value", text: value });
  metric.createSpan({ cls: "ics-calendar-viewer__metric-label", text: label });
}

function renderField(parent: HTMLElement, label: string, value: string): void {
  if (!value) return;
  const row = parent.createDiv({ cls: "ics-calendar-viewer__field" });
  row.createDiv({ cls: "ics-calendar-viewer__field-label", text: label });
  row.createDiv({ cls: "ics-calendar-viewer__field-value", text: value });
}

function renderMessage(parent: HTMLElement, message: string): void {
  parent.createDiv({ cls: "ics-calendar-viewer__message", text: message });
}

function createTextButton(parent: HTMLElement, text: string): HTMLButtonElement {
  return parent.createEl("button", {
    text,
    attr: { type: "button" },
  });
}

function createIconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: "ics-calendar-viewer__icon-button",
    attr: { "aria-label": label, title: label, type: "button" },
  });
  setIcon(button, icon);
  return button;
}

function createDateInput(parent: HTMLElement, label: string, value: string): HTMLInputElement {
  const wrap = parent.createDiv({ cls: "ics-calendar-viewer__date-field" });
  wrap.createSpan({ text: label });
  return wrap.createEl("input", {
    value,
    attr: {
      "aria-label": label,
      type: "date",
    },
  });
}

function isIcsFile(file: TFile | null): file is TFile {
  return file?.extension.toLowerCase() === "ics";
}

function isViewerState(state: unknown): state is IcsCalendarViewerState {
  if (!state || typeof state !== "object") return false;
  const candidate = state as IcsCalendarViewerState;
  return (candidate.mode === undefined || candidate.mode === "events" || candidate.mode === "source")
    && (candidate.groupMode === undefined || candidate.groupMode === "date" || candidate.groupMode === "type")
    && (candidate.query === undefined || typeof candidate.query === "string")
    && (candidate.startDate === undefined || typeof candidate.startDate === "string")
    && (candidate.endDate === undefined || typeof candidate.endDate === "string");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
