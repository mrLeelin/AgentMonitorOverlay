import type { BotInput, StudioBot } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import type { BotMarkdownField } from "./BotProfileFields.js";

interface SaveState {
  bot: StudioBot;
  changes: Partial<BotInput>;
  saving: boolean;
  saved: boolean;
  error: string;
}

// Keep the queue when switching Bots or closing Settings, so a late response cannot replace the next draft.
const editors = new Map<string, BotSettingsSave>();

export function botSettingsSave(link: HostLink, bot: StudioBot): BotSettingsSave {
  const key = `${link.url}\n${link.token}\n${bot.id}`;
  let editor = editors.get(key);
  if (!editor) editors.set(key, editor = new BotSettingsSave(link, bot));
  return editor;
}

class BotSettingsSave {
  private state: SaveState;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private request?: Promise<boolean>;
  private expected: Partial<Record<BotMarkdownField, string>> = {};
  private editingDocument?: BotMarkdownField;

  constructor(private link: HostLink, bot: StudioBot) {
    this.state = { bot, changes: {}, saving: false, saved: false, error: "" };
  }

  read = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(change: Partial<SaveState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  receive(bot: StudioBot) {
    if (bot !== this.state.bot) this.set({ bot });
  }

  beginDocumentEdit(field: BotMarkdownField, displayed: string): void {
    if (this.editingDocument === field) return;
    this.endDocumentEdit();
    this.editingDocument = field;
    this.expected[field] ??= displayed;
  }

  endDocumentEdit(): void {
    const field = this.editingDocument;
    this.editingDocument = undefined;
    if (field && !Object.hasOwn(this.state.changes, field)) delete this.expected[field];
  }

  change = <K extends keyof BotInput>(field: K, value: BotInput[K]) => {
    const { bot, changes } = this.state;
    if (Object.is(field in changes ? changes[field] : bot[field], value)) return;
    if (field === "purpose") this.expected.purpose ??= bot.purpose;
    if (field === "memory") this.expected.memory ??= bot.memory;
    this.set({ changes: { ...changes, [field]: value }, error: "", saved: false });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 450);
  };

  discard() {
    clearTimeout(this.timer);
    this.expected = {};
    this.editingDocument = undefined;
    this.set({ changes: {}, saved: false, error: "" });
  }

  async flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.request) {
      if (!await this.request) return false;
      return this.flush();
    }
    const { bot, changes } = this.state;
    if (!Object.keys(changes).length) return true;
    const invalid = changes.name?.trim() === "" ? "请填写名称。" : changes.purpose?.trim() === "" ? "请填写职责（SOUL.md）。" : "";
    if (invalid) {
      this.set({ error: invalid });
      return false;
    }
    this.set({ saving: true, error: "" });
    this.request = this.save(bot.id, changes).finally(() => {
      this.request = undefined;
      this.set({ saving: false });
    });
    return this.request;
  }

  private async save(id: string, changes: Partial<BotInput>): Promise<boolean> {
    try {
      const saved = await call(this.link, "PUT /api/bots/:id", { id }, { changes, expectedFiles: { ...this.expected } });
      const pending = { ...this.state.changes };
      for (const field of Object.keys(changes) as (keyof BotInput)[]) {
        if (Object.is(pending[field], changes[field])) delete pending[field];
        // The focused text stays as typed. Only a successful save of that text can advance its expected file version.
        if (field === "purpose" || field === "memory") this.expected[field] = field in pending || this.editingDocument === field ? saved[field] : undefined;
      }
      this.set({ bot: saved, changes: pending, saved: !Object.keys(pending).length });
      return true;
    } catch (error) {
      const latest = (await call(this.link, "GET /api/bots").catch(() => [])).find((bot) => bot.id === id);
      if (latest) this.receive(latest);
      this.set({ error: `保存失败。${error instanceof Error ? error.message : String(error)}` });
      return false;
    }
  }
}
