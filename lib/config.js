'use strict';

// Configuration file: ~/.claude-sessions/config.json
// (override the location with the CLAUDE_SESSIONS_CONFIG environment variable).

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

const HOME = os.homedir();
const CONFIG_PATH = process.env.CLAUDE_SESSIONS_CONFIG
  || path.join(HOME, '.claude-sessions', 'config.json');

const DEFAULT_PORT = 4317;
const DEFAULT_DANGER_FLAG = '--allow-dangerously-skip-permissions';
const COLORS = ['#6ba4ff', '#e0a95a', '#b98cff', '#57c78a', '#ff7eb6', '#4fd1c5', '#f6e05e', '#a0aec0'];

// Claude Code's default config folder (what it uses without CLAUDE_CONFIG_DIR).
function defaultConfigDir() {
  return path.join(HOME, '.claude');
}

function samePath(a, b) {
  const norm = s => path.resolve(String(s)).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

function isClaudeConfigDir(dir) {
  try { return fs.statSync(path.join(dir, 'projects')).isDirectory(); } catch { return false; }
}

// Candidate Claude Code config folders: CLAUDE_CONFIG_DIR, ~/.claude, any
// ~/.claude-* / ~/.claude_* folder, and ~/.config/claude, as long as they
// contain a `projects` folder (where Claude Code stores transcripts).
function detectConfigDirs() {
  const found = [];
  const add = (dir) => {
    if (!dir || found.some(d => samePath(d, dir))) return;
    if (isClaudeConfigDir(dir)) found.push(path.resolve(dir));
  };
  add(process.env.CLAUDE_CONFIG_DIR);
  add(defaultConfigDir());
  let entries = [];
  try { entries = fs.readdirSync(HOME); } catch { /* unreadable home */ }
  for (const name of entries.sort()) {
    if (/^\.claude[-_.].+/i.test(name)) add(path.join(HOME, name));
  }
  add(path.join(HOME, '.config', 'claude'));
  return found;
}

// "~/.claude" -> "Default", "~/.claude-work" -> "Work".
function suggestLabel(dir) {
  if (samePath(dir, defaultConfigDir())) return 'Default';
  const base = path.basename(dir).replace(/^\.?claude[-_.]?/i, '');
  if (!base) return path.basename(dir);
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function commandExists(cmd) {
  try {
    execSync(process.platform === 'win32' ? 'where ' + cmd : 'command -v ' + cmd,
             { stdio: 'ignore', shell: process.platform === 'win32' ? undefined : '/bin/sh' });
    return true;
  } catch { return false; }
}

// Terminal commands that can run the generated resume script, best first.
// {script} = script path, {cwd} = session folder, {title} = window title.
function terminalChoices() {
  if (process.platform === 'win32') {
    const list = [];
    if (commandExists('wt')) list.push({ name: 'Windows Terminal', command: 'wt -d "{cwd}" cmd /k "{script}"' });
    list.push({ name: 'Command Prompt', command: 'start "{title}" cmd /k "{script}"' });
    return list;
  }
  if (process.platform === 'darwin') {
    const list = [];
    if (fs.existsSync('/Applications/iTerm.app')) list.push({ name: 'iTerm2', command: 'open -a iTerm "{script}"' });
    list.push({ name: 'Terminal', command: 'open -a Terminal "{script}"' });
    return list;
  }
  const linux = [
    ['x-terminal-emulator', 'x-terminal-emulator -e sh "{script}"'],
    ['gnome-terminal', 'gnome-terminal -- sh "{script}"'],
    ['konsole', 'konsole -e sh "{script}"'],
    ['xfce4-terminal', 'xfce4-terminal -x sh "{script}"'],
    ['kitty', 'kitty sh "{script}"'],
    ['alacritty', 'alacritty -e sh "{script}"'],
    ['xterm', 'xterm -e sh "{script}"'],
  ];
  const list = linux.filter(([bin]) => commandExists(bin)).map(([name, command]) => ({ name, command }));
  return list.length ? list : [{ name: 'xterm', command: 'xterm -e sh "{script}"' }];
}

function defaultCommand() {
  return 'claude';
}

// Normalizes a raw config object; throws on anything unusable.
function normalize(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('not a JSON object');
  const port = Number(raw.port || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  if (!Array.isArray(raw.profiles) || !raw.profiles.length) throw new Error('no profile configured');
  const profiles = raw.profiles.map((p, i) => {
    if (!p || typeof p.configDir !== 'string' || !p.configDir.trim()) throw new Error('profile ' + (i + 1) + ': missing configDir');
    const configDir = path.resolve(p.configDir.replace(/^~(?=$|[\\/])/, HOME));
    return {
      label: String(p.label || suggestLabel(configDir)),
      configDir,
      command: String(p.command || defaultCommand()),
      setConfigDirEnv: p.setConfigDirEnv === undefined ? !samePath(configDir, defaultConfigDir()) : !!p.setConfigDirEnv,
      usage: p.usage === undefined ? true : !!p.usage,
      color: typeof p.color === 'string' && p.color ? p.color : COLORS[i % COLORS.length],
    };
  });
  if (typeof raw.terminal !== 'string' || !raw.terminal.includes('{script}')) throw new Error('terminal must contain {script}');
  return {
    port,
    profiles,
    terminal: raw.terminal,
    dangerFlag: typeof raw.dangerFlag === 'string' ? raw.dangerFlag.trim() : DEFAULT_DANGER_FLAG,
    openBrowser: raw.openBrowser === undefined ? true : !!raw.openBrowser,
    purgeUsageTranscripts: raw.purgeUsageTranscripts === undefined ? true : !!raw.purgeUsageTranscripts,
  };
}

// Returns the normalized config, or null if there is none (or it is invalid).
function load() {
  let text;
  try { text = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch { return null; }
  try { return normalize(JSON.parse(text)); }
  catch (e) {
    console.error('Invalid configuration in ' + CONFIG_PATH + ': ' + e.message);
    return null;
  }
}

function save(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

module.exports = {
  CONFIG_PATH, DEFAULT_PORT, DEFAULT_DANGER_FLAG, COLORS,
  defaultConfigDir, detectConfigDirs, suggestLabel, terminalChoices, defaultCommand,
  commandExists, normalize, load, save, samePath,
};
