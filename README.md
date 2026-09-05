# Apple Reminders Plus for Obsidian

View and manage your Apple Reminders from a sidebar panel in Obsidian.

**macOS only.** Nothing is sent over the network — the plugin talks to the Reminders app directly through Apple's EventKit framework, entirely on your machine.

## Features

- **Sidebar panel** — see one Reminders list at a time, switch via the dropdown
- **Search** — filter the current list by name or notes
- **Sort** — Default, A → Z, Z → A, or Due date, from the sort icon next to search
- **Add** — type a name and press Enter (or click Add) to create a reminder
- **Complete** — check a reminder off; it's removed from the list immediately
- **Delete** — hover a reminder to reveal the delete button, or swipe it with a trackpad, like a native swipe-to-delete list
- **Priority & due dates** — high/medium priority reminders are marked (`!!`/`!`), overdue reminders are highlighted
- **Settings** — choose which lists show up in the panel, pick a default list to load first, and set list order (same as Apple Reminders, or alphabetical)

## Installation

### From the Community Plugins browser

Once this plugin is available in Obsidian's Community Plugins directory:

1. Open **Settings → Community plugins → Browse**
2. Search for "Apple Reminders Plus"
3. Install and enable it

### Manual installation

1. From the [latest release](https://github.com/isaquepereira/obsidian-apple-reminders-plus/releases), download `main.js`, `manifest.json`, `styles.css`, and `reminders-cli-macos-universal.zip`
2. Unzip `reminders-cli-macos-universal.zip` — it contains a `bin/reminders-cli` executable
3. Copy everything into `<your-vault>/.obsidian/plugins/apple-reminders-plus/`, so the folder looks like:
   ```
   <your-vault>/.obsidian/plugins/apple-reminders-plus/
     ├── main.js
     ├── manifest.json
     ├── styles.css
     └── bin/
         └── reminders-cli
   ```
4. If macOS complains the helper isn't executable, run `chmod +x bin/reminders-cli` in that folder
5. Reload Obsidian and enable **Apple Reminders Plus** under Community plugins

### Grant permissions

The first time the plugin talks to Reminders, macOS will ask if it can access Reminders — click **OK**. You can review or change this later at:

> System Settings → Privacy & Security → Reminders

## How it works

The plugin bundles a small, pre-compiled command-line helper (`bin/reminders-cli`) built from the Objective-C source in [`objc/reminders-cli.m`](objc/reminders-cli.m). It links against Apple's `EventKit` framework — the same API Apple's own Reminders app and Shortcuts use — and exposes a handful of subcommands (`lists`, `fetch`, `create`, `delete`, `complete`) that read and write reminders, printing JSON to stdout.

The Obsidian plugin (`main.ts`) calls this helper via Node's `child_process.execFile` and renders the result. There is no AppleScript, no network access, and no data leaves your machine. The helper ships as a universal binary (Intel and Apple Silicon).

You can inspect and rebuild the helper yourself — see [Development](#development) below.

## Development

### Requirements

- macOS with Xcode Command Line Tools (for `clang` and the `EventKit`/`AppKit` frameworks)
- Node.js

### Setup

```bash
npm install
```

### Build

```bash
npm run build          # compiles the CLI helper, type-checks, and bundles main.js (production)
npm run dev             # watches and rebuilds main.js on change (TypeScript/esbuild only)
npm run build:swift     # (re)compiles just the reminders-cli helper from objc/reminders-cli.m
```

### Lint

This project uses [`eslint-plugin-obsidianmd`](https://github.com/obsidianmd/eslint-plugin), the same linter used by Obsidian's plugin review process:

```bash
npm run lint
```

### Try it in a vault

Copy `main.js`, `manifest.json`, `styles.css`, and `bin/` into `<vault>/.obsidian/plugins/apple-reminders-plus/`, then reload Obsidian (or use a tool like [hot-reload](https://github.com/pjeby/hot-reload) during development).

## Roadmap / ideas

- [ ] Code block renderer (embed a reminder list inline in a note)
- [ ] Due date picker when creating reminders
- [ ] Natural language date parsing ("tomorrow", "next Monday")
- [ ] Auto-refresh on an interval

## License

[MIT](LICENSE)
