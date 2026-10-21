'use strict';

// Interactive first-run setup. Every question shows a default (auto-detected,
// or taken from the existing config when re-running with --setup): pressing
// Enter keeps it. Without an interactive terminal, the defaults are saved as-is.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const config = require('./config');

// Line reader that works for a terminal and for piped input alike. At end of
// input, every question falls back to its default.
function makeAsker(rl) {
  const lines = rl[Symbol.asyncIterator]();
  let closed = false;
  async function ask(question, def) {
    const suffix = def !== undefined && def !== '' ? ' [' + def + ']' : '';
    process.stdout.write(question + suffix + ': ');
    let a = '';
    if (!closed) {
      const next = await lines.next();
      if (next.done) closed = true; else a = String(next.value).trim();
    }
    if (closed) process.stdout.write('\n');
    return a === '' ? (def === undefined ? '' : String(def)) : a;
  }
  async function askYesNo(question, def) {
    for (;;) {
      const a = (await ask(question + ' (y/n)', def ? 'y' : 'n')).toLowerCase();
      if (a === 'y' || a === 'yes') return true;
      if (a === 'n' || a === 'no') return false;
    }
  }
  return { ask, askYesNo };
}

function expandHome(p) {
  return p.replace(/^~(?=$|[\\/])/, require('os').homedir());
}

// Defaults used without a terminal, and as the starting point of the questions.
function defaults(previous) {
  const terminals = config.terminalChoices();
  if (previous) return { ...previous, terminals };
  let dirs = config.detectConfigDirs();
  if (!dirs.length) dirs = [config.defaultConfigDir()];
  return {
    port: config.DEFAULT_PORT,
    profiles: dirs.map((dir) => ({ label: config.suggestLabel(dir), configDir: dir, command: config.defaultCommand() })),
    terminal: terminals[0].command,
    dangerFlag: config.DEFAULT_DANGER_FLAG,
    openBrowser: true,
    purgeUsageTranscripts: true,
    terminals,
  };
}

function toFile(d) {
  return {
    port: d.port,
    profiles: d.profiles.map((p) => ({
      label: p.label,
      configDir: p.configDir,
      command: p.command,
      ...(p.setConfigDirEnv !== undefined ? { setConfigDirEnv: p.setConfigDirEnv } : {}),
      ...(p.usage === false ? { usage: false } : {}),
    })),
    terminal: d.terminal,
    dangerFlag: d.dangerFlag,
    openBrowser: d.openBrowser,
    purgeUsageTranscripts: d.purgeUsageTranscripts,
  };
}

async function interactive(d) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const { ask, askYesNo } = makeAsker(rl);
  try {
    console.log('\nClaude Sessions setup. Press Enter to keep the value in [brackets].\n');

    // 1) Profiles: one column per Claude Code config folder.
    const candidates = [...d.profiles];
    for (const dir of config.detectConfigDirs()) {
      if (!candidates.some((p) => config.samePath(p.configDir, dir))) {
        candidates.push({ label: config.suggestLabel(dir), configDir: dir, command: config.defaultCommand() });
      }
    }
    console.log('Each profile is a Claude Code config folder (it contains a "projects" folder with the transcripts).');
    if (candidates.length) {
      console.log('Detected:');
      candidates.forEach((p) => console.log('  - ' + p.configDir));
    } else {
      console.log('No Claude Code config folder detected.');
    }
    const profiles = [];
    for (const p of candidates) {
      console.log('\n' + p.configDir);
      if (!(await askYesNo('  Show this folder', true))) continue;
      const label = await ask('  Column name', p.label);
      const command = await ask('  Command that starts Claude Code', p.command || config.defaultCommand());
      profiles.push({ ...p, label, command });
    }
    for (;;) {
      const extra = await ask('\nAdd another config folder (path, empty to continue)', '');
      if (!extra) break;
      const dir = path.resolve(expandHome(extra));
      if (!fs.existsSync(path.join(dir, 'projects'))) console.log('  Note: no "projects" folder there yet.');
      const label = await ask('  Column name', config.suggestLabel(dir));
      const command = await ask('  Command that starts Claude Code', config.defaultCommand());
      profiles.push({ label, configDir: dir, command });
    }
    if (!profiles.length) {
      console.log('\nAt least one profile is needed; using ' + config.defaultConfigDir() + '.');
      profiles.push({ label: 'Default', configDir: config.defaultConfigDir(), command: config.defaultCommand() });
    }
    console.log('\nNote: for a folder other than ' + config.defaultConfigDir() + ', CLAUDE_CONFIG_DIR is set'
      + ' automatically when running its command, so "claude" is usually enough.');

    // 2) Port.
    let port;
    for (;;) {
      port = Number(await ask('\nLocal port for the web UI', d.port));
      if (Number.isInteger(port) && port >= 1 && port <= 65535) break;
      console.log('  Enter a number between 1 and 65535.');
    }

    // 3) Terminal used by the "Open" button.
    console.log('\nTerminal used to resume a session ({script} is replaced by a generated script):');
    d.terminals.forEach((t, i) => console.log('  ' + (i + 1) + ') ' + t.name + ': ' + t.command));
    console.log('  c) custom command');
    const current = d.terminals.findIndex((t) => t.command === d.terminal);
    const choice = await ask('Choice', current >= 0 ? String(current + 1) : 'c');
    let terminal;
    if (/^\d+$/.test(choice) && d.terminals[Number(choice) - 1]) {
      terminal = d.terminals[Number(choice) - 1].command;
    } else {
      for (;;) {
        terminal = await ask('Custom terminal command', d.terminal);
        if (terminal.includes('{script}')) break;
        console.log('  The command must contain {script}.');
      }
    }

    // 4) Flag added when "Open" is clicked with Shift held.
    const flag = await ask('\nFlag added when Shift+clicking "Open" ("-" to disable)', d.dangerFlag || '-');
    const dangerFlag = flag === '-' ? '' : flag;

    // 5) Browser.
    const openBrowser = await askYesNo('\nOpen the browser on start', d.openBrowser !== false);

    return { port, profiles, terminal, dangerFlag, openBrowser, purgeUsageTranscripts: d.purgeUsageTranscripts !== false };
  } finally {
    rl.close();
  }
}

// Runs the setup and saves the result. Returns the normalized config.
async function run(previous) {
  const d = defaults(previous);
  const answers = process.stdin.isTTY ? await interactive(d) : d;
  if (!process.stdin.isTTY) {
    console.log('No interactive terminal: saving auto-detected defaults (run with --setup in a terminal to change them).');
  }
  const file = toFile(answers);
  const cfg = config.normalize(file);
  config.save(file);
  console.log('\nSaved ' + config.CONFIG_PATH);
  cfg.profiles.forEach((p) => console.log('  ' + p.label + ': ' + p.configDir + '  (' + p.command + ')'));
  console.log('');
  return cfg;
}

module.exports = { run, defaults };
