import { App, ItemView, Menu, Notice, Plugin, PluginSettingTab, Setting, ToggleComponent, WorkspaceLeaf, setIcon } from "obsidian";
import { execFile } from "child_process";
import * as path from "path";

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE = "apple-reminders-plus-view";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Reminder {
  id: string;
  name: string;
  completed: boolean;
  dueDate: string | null; // ISO "YYYY-MM-DD"
  priority: number;       // 0=none, 1=low, 5=medium, 9=high
  body: string;           // notes field
}

type SortKey = "default" | "name-az" | "name-za" | "due-date";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "default",  label: "Default" },
  { value: "name-az",  label: "A → Z" },
  { value: "name-za",  label: "Z → A" },
  { value: "due-date", label: "Due date" },
];

/** Width of the delete button (32px, now that it's padded to a 1:1 square)
 *  plus its right-side breathing gap, revealed behind a swiped reminder row. */
const SWIPE_REVEAL_WIDTH = 40;

// ─── Settings ─────────────────────────────────────────────────────────────────

type ListOrder = "native" | "alphabetical";

interface AppleRemindersSettings {
  /** Names of lists that may appear in the panel. `null` = not configured yet (show all). */
  enabledLists: string[] | null;
  /** List selected automatically when the panel loads. `null` = use the first enabled list. */
  defaultList: string | null;
  /** How lists are ordered in the panel's selector: as returned by Apple Reminders, or A→Z. */
  listOrder: ListOrder;
}

const DEFAULT_SETTINGS: AppleRemindersSettings = {
  enabledLists: null,
  defaultList: null,
  listOrder: "native",
};

function sortListNames(names: string[], order: ListOrder): string[] {
  if (order === "alphabetical") {
    return [...names].sort((a, b) => a.localeCompare(b));
  }
  return names;
}

// ─── Swift CLI bridge ─────────────────────────────────────────────────────────

interface BasePathAdapter {
  getBasePath(): string;
}

function hasBasePath(adapter: unknown): adapter is BasePathAdapter {
  return (
    !!adapter &&
    typeof (adapter as { getBasePath?: unknown }).getBasePath === "function"
  );
}

/** Resolve the path to the compiled CLI helper binary. */
let _cliBin: string | null = null;
function getCliBin(plugin: Plugin): string {
  if (_cliBin) return _cliBin;
  const adapter = plugin.app.vault.adapter;
  const pluginDir = hasBasePath(adapter)
    ? path.join(adapter.getBasePath(), plugin.app.vault.configDir, "plugins", plugin.manifest.id)
    : "";
  _cliBin = path.join(pluginDir, "bin", "reminders-cli");
  return _cliBin;
}

function runCLI(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 15000 }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) {
        const message = stderr.trim() || err.message;
        console.error("[Apple Reminders CLI]", message);
        reject(new Error(message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function fetchLists(bin: string): Promise<string[]> {
  const raw = await runCLI(bin, ["lists"]);
  if (!raw) return [];
  return JSON.parse(raw) as string[];
}

async function fetchIncomplete(bin: string, listName: string): Promise<Reminder[]> {
  const raw = await runCLI(bin, ["fetch", "--list", listName, "--completed", "false"]);
  if (!raw) return [];
  return JSON.parse(raw) as Reminder[];
}

async function cliCreate(bin: string, listName: string, name: string): Promise<void> {
  await runCLI(bin, ["create", "--list", listName, "--title", name]);
}

async function cliDelete(bin: string, id: string): Promise<void> {
  await runCLI(bin, ["delete", "--id", id]);
}

async function cliSetCompleted(bin: string, id: string, completed: boolean): Promise<void> {
  await runCLI(bin, ["complete", "--id", id, "--value", String(completed)]);
}

// ─── View ─────────────────────────────────────────────────────────────────────

export class RemindersView extends ItemView {
  private plugin!: AppleRemindersPlugin;
  private bin!: string;
  private lists: string[] = [];
  private incompleteReminders: Reminder[] = [];
  private selectedList = "";
  private searchQuery = "";
  private sortBy: SortKey = "default";
  private openRow: HTMLElement | null = null;

  // DOM refs
  private listSelectEl!: HTMLSelectElement;
  private countEl!: HTMLElement;
  private listEl!: HTMLElement;
  private newInputEl!: HTMLInputElement;

  setPlugin(plugin: AppleRemindersPlugin) {
    this.plugin = plugin;
    this.bin = getCliBin(plugin);
  }

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return "Apple Reminders Plus"; }
  getIcon()        { return "check-circle-2"; }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("ar-root");
    this.buildUI(root);
    document.addEventListener("click", this.handleDocumentClick);
    await this.loadLists();
  }

  async onClose() {
    document.removeEventListener("click", this.handleDocumentClick);
  }

  // ── Swipe-to-reveal ───────────────────────────────────────────────────────

  private handleDocumentClick = (e: MouseEvent) => {
    if (this.openRow && !this.openRow.contains(e.target as Node)) {
      this.closeOpenRow();
    }
  };

  private closeOpenRow() {
    if (!this.openRow) return;
    this.openRow.classList.remove("is-open");
    this.openRow = null;
  }

  // ── UI builder ────────────────────────────────────────────────────────────

  private buildUI(root: HTMLElement) {
    // Header
    const header = root.createDiv({ cls: "ar-header" });

    // Title row: [List name select]   [count]
    const headerTop = header.createDiv({ cls: "ar-header-top" });
    this.listSelectEl = headerTop.createEl("select", { cls: "ar-list-select" });
    this.listSelectEl.createEl("option", { value: "", text: "Loading…" });
    this.listSelectEl.addEventListener("change", () => {
      this.selectedList = this.listSelectEl.value;
      void this.loadIncomplete();
    });

    const headerActions = headerTop.createDiv({ cls: "ar-header-actions" });
    this.countEl = headerActions.createSpan({ cls: "ar-count", text: "—" });

    // Search + sort row
    const searchRow = header.createDiv({ cls: "ar-search-row" });
    const searchInput = searchRow.createEl("input", {
      cls: "ar-search",
      type: "text",
    });
    searchInput.placeholder = "Search…";
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      this.renderReminders();
    });

    const sortBtn = searchRow.createEl("button", {
      cls: "ar-btn ar-sort-btn",
      attr: { title: "Sort" },
    });
    setIcon(sortBtn, "arrow-up-down");
    sortBtn.addEventListener("click", (evt) => {
      const menu = new Menu();
      SORT_OPTIONS.forEach(({ value, label }) => {
        menu.addItem((item) =>
          item
            .setTitle(label)
            .setChecked(this.sortBy === value)
            .onClick(() => {
              this.sortBy = value;
              this.renderReminders();
            })
        );
      });
      menu.showAtMouseEvent(evt);
    });

    // Divider
    root.createEl("hr", { cls: "ar-divider" });

    // Scrollable list
    this.listEl = root.createDiv({ cls: "ar-list" });

    // Fixed add bar at the bottom
    const addBar = root.createDiv({ cls: "ar-add-bar" });
    this.newInputEl = addBar.createEl("input", {
      cls: "ar-new-input",
      type: "text",
    });
    this.newInputEl.placeholder = "New reminder…";
    this.newInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.handleAdd();
    });
    const addBtn = addBar.createEl("button", {
      cls: "ar-action-btn ar-action-btn--accent",
      text: "Add",
      attr: { title: "Add new reminder" },
    });
    addBtn.addEventListener("click", () => void this.handleAdd());
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  async loadLists() {
    try {
      const allLists = await fetchLists(this.bin);
      const { enabledLists, defaultList, listOrder } = this.plugin.settings;

      let visibleLists = allLists;
      if (enabledLists && enabledLists.length) {
        const filtered = allLists.filter((name) => enabledLists.includes(name));
        if (filtered.length) visibleLists = filtered;
      }
      this.lists = sortListNames(visibleLists, listOrder);

      this.listSelectEl.empty();
      if (!this.lists.length) {
        this.listSelectEl.createEl("option", { value: "", text: "No lists found" });
        return;
      }
      this.lists.forEach((name) =>
        this.listSelectEl.createEl("option", { value: name, text: name })
      );

      this.selectedList =
        this.selectedList && this.lists.includes(this.selectedList)
          ? this.selectedList
          : defaultList && this.lists.includes(defaultList)
          ? defaultList
          : this.lists[0];
      this.listSelectEl.value = this.selectedList;
      await this.loadIncomplete();
    } catch {
      new Notice(
        "Apple Reminders: Could not load lists.\n" +
        "Check System Settings → Privacy → Reminders."
      );
    }
  }

  private async loadIncomplete() {
    if (!this.selectedList) return;

    // Reset state
    this.incompleteReminders = [];

    // Show spinner
    this.listEl.empty();
    const state = this.listEl.createDiv({ cls: "ar-state" });
    state.createSpan({ cls: "ar-spinner" });
    state.appendText("Loading…");

    try {
      this.incompleteReminders = await fetchIncomplete(this.bin, this.selectedList);
      this.updateCount();
      this.renderReminders();
    } catch {
      this.listEl.empty();
      this.listEl.createDiv({
        cls: "ar-state",
        text: "Failed to load reminders.",
      });
    }
  }

  // ── State helpers ─────────────────────────────────────────────────────────

  private updateCount() {
    this.countEl.textContent = String(this.incompleteReminders.length);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private filtered(list: Reminder[]): Reminder[] {
    let out = [...list];

    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      out = out.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.body.toLowerCase().includes(q)
      );
    }

    switch (this.sortBy) {
      case "name-az":
        out.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "name-za":
        out.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case "due-date":
        out.sort((a, b) => {
          if (!a.dueDate && !b.dueDate) return 0;
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return a.dueDate.localeCompare(b.dueDate);
        });
        break;
    }

    return out;
  }

  private renderReminders() {
    this.openRow = null;
    this.listEl.empty();
    const incomplete = this.filtered(this.incompleteReminders);

    if (!incomplete.length) {
      this.listEl.createDiv({
        cls: "ar-state",
        text: this.searchQuery ? "No results." : "No reminders here 🎉",
      });
      return;
    }

    incomplete.forEach((r) => this.renderItem(r));
  }

  private renderItem(r: Reminder) {
    const row = this.listEl.createDiv({ cls: "ar-row" });
    const item = row.createDiv({ cls: "ar-item" });

    // Checkbox
    const cb = item.createEl("input", {
      cls: "ar-checkbox",
      type: "checkbox",
    });
    cb.checked = r.completed;
    cb.addEventListener("change", () => void this.handleToggleComplete(cb, r));

    // Body
    const body = item.createDiv({ cls: "ar-item-body" });

    const priorityPrefix =
      r.completed ? "" :
      r.priority >= 9 ? "!! " :
      r.priority >= 5 ? "! " : "";

    let nameCls = "ar-item-name";
    if (r.completed)         nameCls += " is-completed";
    else if (r.priority >= 9) nameCls += " is-priority-high";
    else if (r.priority >= 5) nameCls += " is-priority-med";

    body.createDiv({ cls: nameCls, text: priorityPrefix + r.name });

    if (r.body) {
      body.createDiv({ cls: "ar-item-notes", text: r.body });
    }

    if (r.dueDate) {
      const today = new Date().toISOString().slice(0, 10);
      const overdue = !r.completed && r.dueDate < today;
      body.createDiv({
        cls: "ar-item-due" + (overdue ? " is-overdue" : ""),
        text: this.formatDate(r.dueDate),
      });
    }

    // Actions — pinned behind .ar-item; revealed by sliding .ar-item left
    // (on hover, or once swiped open via a trackpad gesture).
    const actionsEl = row.createDiv({ cls: "ar-item-actions" });
    const delBtn = actionsEl.createEl("button", {
      cls: "ar-btn ar-btn-delete",
      attr: { title: "Delete" },
    });
    setIcon(delBtn, "trash-2");
    delBtn.addEventListener("click", () => void this.handleDelete(r));

    // Trackpad swipe-to-reveal: a horizontal wheel gesture drags .ar-item
    // over, snapping open or closed once the gesture settles.
    const revealWidth = SWIPE_REVEAL_WIDTH;
    row.setCssProps({ "--ar-reveal": `${revealWidth}px` });

    let offset = 0;
    let settleTimer: number | undefined;

    row.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
        e.preventDefault();

        if (this.openRow && this.openRow !== row) this.closeOpenRow();

        // Starting a fresh gesture (no drag currently in flight) — resync
        // with the row's actual state in case it was closed externally
        // (e.g. a click elsewhere, or another row being opened).
        if (settleTimer === undefined) {
          offset = row.classList.contains("is-open") ? revealWidth : 0;
        }

        offset = Math.min(revealWidth, Math.max(0, offset + e.deltaX));
        item.setCssStyles({ transform: `translateX(${-offset}px)` });

        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(() => {
          settleTimer = undefined;
          // Hysteresis: opening requires clearing 60%, closing requires
          // dropping below 25%. A single 50% cutoff was getting flipped
          // back closed by residual trackpad momentum wheel events landing
          // just under it right as the gesture settled.
          const wasOpen = row.classList.contains("is-open");
          const isOpen = wasOpen ? offset >= revealWidth * 0.25 : offset > revealWidth * 0.6;
          row.classList.toggle("is-open", isOpen);
          this.openRow = isOpen ? row : null;
          item.setCssStyles({ transform: "" });
        }, 150);
      },
      { passive: false }
    );
  }

  private async handleToggleComplete(cb: HTMLInputElement, r: Reminder) {
    const next = cb.checked;
    try {
      await cliSetCompleted(this.bin, r.id, next);
      // Only incomplete reminders are ever shown, so completing one removes it from view.
      this.incompleteReminders = this.incompleteReminders.filter((x) => x.id !== r.id);
      this.updateCount();
      this.renderReminders();
    } catch {
      cb.checked = !next;
      new Notice("Failed to update reminder.");
    }
  }

  private async handleDelete(r: Reminder) {
    try {
      await cliDelete(this.bin, r.id);
      this.incompleteReminders = this.incompleteReminders.filter((x) => x.id !== r.id);
      this.updateCount();
      this.renderReminders();
    } catch {
      new Notice("Failed to delete reminder.");
    }
  }

  private formatDate(iso: string): string {
    const [year, month, day] = iso.split("-").map(Number);
    // Construct with local midnight to avoid timezone drift
    const date     = new Date(year, month - 1, day);
    const today    = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);

    if (date.getTime() === today.getTime())    return "Today";
    if (date.getTime() === tomorrow.getTime()) return "Tomorrow";
    if (date < today) return `Overdue · ${date.toLocaleDateString()}`;
    return date.toLocaleDateString();
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private async handleAdd() {
    const name = this.newInputEl.value.trim();
    if (!name) return;
    if (!this.selectedList) {
      new Notice("Select a list first.");
      return;
    }
    try {
      await cliCreate(this.bin, this.selectedList, name);
      this.newInputEl.value = "";
      await this.loadIncomplete();
    } catch {
      new Notice("Failed to create reminder.");
    }
  }
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

class AppleRemindersSettingTab extends PluginSettingTab {
  private plugin: AppleRemindersPlugin;
  private cachedLists: string[] = [];

  constructor(app: App, plugin: AppleRemindersPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    void this.loadAndRender();
  }

  private async loadAndRender(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", { text: "Loading lists…" });

    try {
      this.cachedLists = await fetchLists(getCliBin(this.plugin));
    } catch {
      containerEl.empty();
      containerEl.createEl("p", {
        text:
          "Could not load reminders lists. Check System Settings → Privacy → Reminders.",
      });
      return;
    }

    this.render();
  }

  private render(): void {
    const { containerEl } = this;
    containerEl.empty();

    const settings = this.plugin.settings;
    const allLists = sortListNames(this.cachedLists, settings.listOrder);
    const enabled = new Set(
      settings.enabledLists && settings.enabledLists.length
        ? settings.enabledLists
        : allLists
    );

    new Setting(containerEl)
      .setName("List order")
      .setDesc("How lists are ordered in the panel's list selector.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("native", "Same order as Apple Reminders")
          .addOption("alphabetical", "Alphabetical (A → Z)")
          .setValue(settings.listOrder)
          .onChange((value) => void this.applyListOrder(value as ListOrder));
      });

    new Setting(containerEl)
      .setName("Default list")
      .setDesc("The list selected automatically when the panel loads.")
      .addDropdown((dropdown) => {
        const visible = allLists.filter((n) => enabled.has(n));
        for (const name of visible) dropdown.addOption(name, name);
        dropdown.setValue(
          settings.defaultList && enabled.has(settings.defaultList)
            ? settings.defaultList
            : visible[0] ?? ""
        );
        dropdown.onChange((value) => void this.applyDefaultList(value));
      });

    new Setting(containerEl).setName("Visible lists").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Choose which reminders lists show up in the panel's list selector.",
    });

    allLists.forEach((name) => {
      new Setting(containerEl).setName(name).addToggle((toggle) =>
        toggle
          .setValue(enabled.has(name))
          .onChange((value) => void this.applyListToggle(name, value, toggle, allLists, enabled))
      );
    });
  }

  private async applyListOrder(value: ListOrder): Promise<void> {
    this.plugin.settings.listOrder = value;
    await this.plugin.saveSettings();
    this.render();
  }

  private async applyDefaultList(value: string): Promise<void> {
    this.plugin.settings.defaultList = value || null;
    await this.plugin.saveSettings();
  }

  private async applyListToggle(
    name: string,
    value: boolean,
    toggle: ToggleComponent,
    allLists: string[],
    enabled: Set<string>
  ): Promise<void> {
    if (value) enabled.add(name);
    else enabled.delete(name);

    if (enabled.size === 0) {
      enabled.add(name);
      toggle.setValue(true);
      new Notice("At least one list must stay enabled.");
      return;
    }

    const settings = this.plugin.settings;
    settings.enabledLists = allLists.filter((n) => enabled.has(n));
    if (settings.defaultList && !enabled.has(settings.defaultList)) {
      settings.defaultList = null;
    }
    await this.plugin.saveSettings();
    this.render();
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class AppleRemindersPlugin extends Plugin {
  settings!: AppleRemindersSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => {
      const view = new RemindersView(leaf);
      view.setPlugin(this);
      return view;
    });

    this.addRibbonIcon("check-circle-2", "Apple Reminders Plus", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-panel",
      name: "Open panel",
      callback: () => void this.activateView(),
    });

    this.addSettingTab(new AppleRemindersSettingTab(this.app, this));
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<AppleRemindersSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof RemindersView) void leaf.view.loadLists();
    });
  }

  async activateView() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
      await this.app.workspace.revealLeaf(leaf);
    }
  }
}
