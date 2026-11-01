import { fuzzyFilter, type FuzzyItem } from './fuzzy';

export interface Command {
  id: string;
  title: string;
  category: string;
  /** Combos shown in the palette and menus (already normalised). */
  keys?: string[];
  /** Hidden commands still run; they just don't clutter the palette. */
  hidden?: boolean;
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

/**
 * Every user-reachable action lives here. The palette, menus and keybindings
 * all read from one registry, which is what stops features from becoming
 * shortcut-only secrets.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  register(command: Command): void {
    this.commands.set(command.id, command);
  }

  registerAll(commands: readonly Command[]): void {
    for (const command of commands) this.register(command);
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  all(): Command[] {
    return [...this.commands.values()];
  }

  /** Palette entries: visible, and enabled unless a command says otherwise. */
  paletteEntries(): Command[] {
    return this.all()
      .filter((command) => !command.hidden && (command.enabled?.() ?? true))
      .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  }

  search(query: string, limit = 50): FuzzyItem<Command>[] {
    const entries = this.paletteEntries();
    if (query.trim() === '') {
      return entries.slice(0, limit).map((item) => ({ item, score: 0, positions: [] }));
    }
    return fuzzyFilter(entries, query.trim(), (command) => `${command.category}: ${command.title}`, limit);
  }

  async run(id: string): Promise<boolean> {
    const command = this.commands.get(id);
    if (!command) return false;
    if (command.enabled && !command.enabled()) return false;
    await command.run();
    return true;
  }

  isEnabled(id: string): boolean {
    const command = this.commands.get(id);
    if (!command) return false;
    return command.enabled?.() ?? true;
  }
}
