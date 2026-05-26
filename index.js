#!/usr/bin/env node

/**
 * Codex Starter (codex-starter)
 * ─────────────────────────────
 * A beautiful TUI for starting new and resuming past Codex sessions.
 *
 * Usage:
 *   codex-starter            # Launch interactive TUI
 *   codex-starter --list     # Print sessions as a table (no TUI)
 *   codex-starter --list N   # Print the latest N sessions
 *   codex-starter --version  # Show version
 *   codex-starter --update   # Update to the latest version
 */

const blessed = require('blessed');
const fs = require('fs');
const path = require('path');
const { spawn, execSync, spawnSync } = require('child_process');
const os = require('os');

const APP_NAME = 'Codex Starter';
const LAUNCH_MODES = [
  { id: 'default', label: 'Default', description: 'Use your Codex config defaults', args: [] },
  { id: 'full-auto', label: 'Full Auto', description: 'Use --full-auto for workspace-write automation', args: ['--full-auto'] },
  { id: 'danger', label: 'Danger', description: 'Use --dangerously-bypass-approvals-and-sandbox', args: ['--dangerously-bypass-approvals-and-sandbox'] },
];

function detectCLI() {
  return { name: 'codex', cmd: 'codex' };
}
const CLI = detectCLI();

function getShellCommand(command) {
  const shellPath = process.env.SHELL || '/bin/sh';
  return { shellPath, shellArgs: ['-ic', command] };
}

function getLaunchMode(modeId) {
  return LAUNCH_MODES.find(mode => mode.id === modeId) || LAUNCH_MODES[0];
}

function getDefaultLaunchMode(meta) {
  return getLaunchMode(meta.defaultLaunchMode).id;
}

function setDefaultLaunchMode(meta, modeId) {
  const normalizedModeId = getLaunchMode(modeId).id;
  meta.defaultLaunchMode = normalizedModeId === 'default' ? undefined : normalizedModeId;
  if (normalizedModeId === 'default') delete meta.defaultLaunchMode;
  saveMeta(meta);
}

function buildCodexCommand({ sessionId, modeId }) {
  const mode = getLaunchMode(modeId);
  const parts = [CLI.cmd, ...mode.args];
  if (sessionId) parts.push('resume', sessionId);
  return parts.join(' ');
}

// ─── Color Palette (Ember Terminal) ──────────────────────────────────────────
const PROJECT_COLORS = [
  '#ff7a1a', '#ffd166', '#5ad1e6', '#a3e635',
  '#ffb347', '#ff5d73', '#5bd1b9', '#ff8f3f',
];

// ─── Paths ───────────────────────────────────────────────────────────────────
const CODEX_DIR = path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const META_FILE = path.join(CODEX_DIR, 'codex-starter-meta.json');

// ─── Session Meta ────────────────────────────────────────────────────
// Stores user-defined metadata for sessions in a simple JSON file.

function loadMeta() {
  try {
    if (fs.existsSync(META_FILE)) {
      return JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
    }
  } catch (e) { /* corrupt file, start fresh */ }
  return { sessions: {} };
}

function saveMeta(meta) {
  try {
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
  } catch (e) { /* silently fail */ }
}

function getSessionMeta(meta, sessionId) {
  return meta.sessions[sessionId] || {};
}

// ─── Data Layer ──────────────────────────────────────────────────────────────

function getProjectDisplayName(cwd) {
  if (!cwd) return '~';
  const normalized = path.normalize(cwd).replace(os.homedir(), '~');
  const parts = normalized.split(path.sep).filter(Boolean);
  if (parts.length === 0) return '~';
  return parts.slice(-3).join('/');
}

function readFirstLine(filePath, maxBytes = 512 * 1024) {
  const fd = fs.openSync(filePath, 'r');
  const chunks = [];
  const bufferSize = 64 * 1024;
  let offset = 0;

  try {
    while (offset < maxBytes) {
      const size = Math.min(bufferSize, maxBytes - offset);
      const buffer = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buffer, 0, size, offset);
      if (!bytesRead) break;
      const slice = buffer.subarray(0, bytesRead);
      const newlineIndex = slice.indexOf(10);
      if (newlineIndex !== -1) {
        chunks.push(slice.subarray(0, newlineIndex));
        break;
      }
      chunks.push(slice);
      offset += bytesRead;
      if (bytesRead < size) break;
    }
  } finally {
    fs.closeSync(fd);
  }

  return Buffer.concat(chunks).toString('utf-8');
}

function readHeadText(filePath, bytes = 256 * 1024) {
  const stat = fs.statSync(filePath);
  const size = Math.min(bytes, stat.size);
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(size);
  try {
    fs.readSync(fd, buffer, 0, size, 0);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf-8');
}

function readTailText(filePath, bytes = 16 * 1024) {
  const stat = fs.statSync(filePath);
  const size = Math.min(bytes, stat.size);
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(size);
  try {
    fs.readSync(fd, buffer, 0, size, stat.size - size);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf-8');
}

function extractTextParts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];

  const texts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string' && (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text')) {
      texts.push(part.text);
    }
  }
  return texts;
}

function isBoilerplateText(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return true;
  return (
    normalized.startsWith('# AGENTS.md instructions') ||
    normalized.startsWith('<environment_context>') ||
    normalized.startsWith('<permissions instructions>') ||
    normalized.startsWith('<collaboration_mode>') ||
    normalized.startsWith('<skills_instructions>') ||
    normalized.startsWith('You are Codex, a coding agent') ||
    normalized.startsWith('You are GPT-5.4.')
  );
}

function extractUserText(entry) {
  if (!entry || typeof entry !== 'object') return '';

  if (entry.type === 'response_item') {
    const payload = entry.payload || {};
    if (payload.type === 'message' && payload.role === 'user') {
      const texts = extractTextParts(payload.content).map(text => text.trim()).filter(Boolean);
      const meaningful = texts.filter(text => !isBoilerplateText(text));
      return (meaningful[0] || '').trim();
    }
  }

  if (entry.type === 'event_msg') {
    const payload = entry.payload || {};
    if (payload.type === 'user_message' && typeof payload.message === 'string') {
      return payload.message.trim();
    }
  }

  return '';
}

function extractAssistantText(entry) {
  if (!entry || typeof entry !== 'object') return '';

  if (entry.type === 'response_item') {
    const payload = entry.payload || {};
    if (payload.type === 'message' && payload.role === 'assistant') {
      return extractTextParts(payload.content).join('\n').trim();
    }
  }

  if (entry.type === 'event_msg') {
    const payload = entry.payload || {};
    if (payload.type === 'agent_message' && typeof payload.message === 'string') {
      return payload.message.trim();
    }
  }

  return '';
}

function getEntryTimestamp(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.timestamp) return entry.timestamp;
  if (entry.payload && entry.payload.timestamp) return entry.payload.timestamp;
  return null;
}

function trimTopic(text, max = 120) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= max) return clean;
  return `${clean.substring(0, max)}…`;
}

function walkSessionFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkSessionFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(fullPath);
  }
  return results;
}

function loadSessionQuick(filePath) {
  const stat = fs.statSync(filePath);
  const sessionLabel = path.basename(filePath, '.jsonl');
  const headText = readHeadText(filePath);

  let sessionId = sessionLabel;
  let firstTs = null;
  let lastTs = null;
  let cwd = '';
  let version = '';
  let modelProvider = '';
  let source = '';
  let originator = '';
  let firstUserMsg = '';
  let userMsgCount = 0;
  let assistantMsgCount = 0;
  let customTitle = '';

  const firstLine = readFirstLine(filePath);
  if (firstLine) {
    try {
      const metaEntry = JSON.parse(firstLine);
      if (metaEntry.type === 'session_meta') {
        const payload = metaEntry.payload || {};
        sessionId = payload.id || sessionLabel;
        firstTs = payload.timestamp || metaEntry.timestamp || null;
        cwd = payload.cwd || '';
        version = payload.cli_version || '';
        modelProvider = payload.model_provider || '';
        source = payload.source || '';
        originator = payload.originator || '';
      }
    } catch (_) { /* ignore */ }
  }

  for (const line of headText.split('\n').filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      const ts = getEntryTimestamp(entry);
      if (!firstTs && ts) firstTs = ts;
      if (ts) lastTs = ts;

      const userText = extractUserText(entry);
      if (userText) {
        userMsgCount++;
        if (!firstUserMsg) firstUserMsg = userText;
      }

      const assistantText = extractAssistantText(entry);
      if (assistantText) assistantMsgCount++;

      if (entry.type === 'response_item') {
        const payload = entry.payload || {};
        if (payload.type === 'custom-title' && payload.customTitle) customTitle = payload.customTitle;
      }
      if (entry.type === 'custom-title' && entry.customTitle) customTitle = entry.customTitle;
    } catch (_) { /* ignore */ }
  }

  if (stat.size > headText.length) {
    for (const line of readTailText(filePath).split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        const ts = getEntryTimestamp(entry);
        if (ts) lastTs = ts;
        if (!customTitle && entry.type === 'custom-title' && entry.customTitle) customTitle = entry.customTitle;
      } catch (_) { /* ignore */ }
    }
  }

  if (!firstUserMsg) {
    const fullLines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    for (const line of fullLines) {
      try {
        const entry = JSON.parse(line);
        const ts = getEntryTimestamp(entry);
        if (!firstTs && ts) firstTs = ts;
        if (ts) lastTs = ts;
        const userText = extractUserText(entry);
        if (userText) {
          userMsgCount++;
          if (!firstUserMsg) firstUserMsg = userText;
        }
        const assistantText = extractAssistantText(entry);
        if (assistantText) assistantMsgCount++;
      } catch (_) { /* ignore */ }
    }
  }

  const estimatedMessages = Math.max(userMsgCount + assistantMsgCount, userMsgCount);

  let durationStr = '';
  if (firstTs && lastTs) {
    const diffMs = new Date(lastTs).getTime() - new Date(firstTs).getTime();
    if (diffMs > 0) {
      const hours = Math.floor(diffMs / 3600000);
      const minutes = Math.floor((diffMs % 3600000) / 60000);
      durationStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }
  }

  return {
    sessionId,
    project: getProjectDisplayName(cwd),
    topic: trimTopic(firstUserMsg) || '(no user messages)',
    customTitle,
    firstTs,
    lastTs: lastTs || firstTs,
    version,
    gitBranch: '',
    cwd,
    source,
    originator,
    modelProvider,
    fileSize: stat.size,
    duration: durationStr,
    estimatedMessages,
    filePath,
    _detailLoaded: false,
  };
}

function loadSessionDetail(session) {
  if (session._detailLoaded) return session;
  const lines = fs.readFileSync(session.filePath, 'utf-8').split('\n').filter(Boolean);

  const userMessages = [];
  const assistantSnippets = [];
  const toolsUsed = new Set();
  let totalMessages = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'session_meta') {
        const payload = entry.payload || {};
        session.sessionId = payload.id || session.sessionId;
        session.firstTs = payload.timestamp || session.firstTs;
        session.cwd = payload.cwd || session.cwd;
        session.project = getProjectDisplayName(session.cwd);
        session.version = payload.cli_version || session.version;
        session.modelProvider = payload.model_provider || session.modelProvider;
        session.source = payload.source || session.source;
        session.originator = payload.originator || session.originator;
      }

      const userText = extractUserText(entry);
      if (userText) {
        totalMessages++;
        userMessages.push(userText.substring(0, 300));
      }

      const assistantText = extractAssistantText(entry);
      if (assistantText) {
        totalMessages++;
        assistantSnippets.push(assistantText.substring(0, 400));
      }

      if (entry.type === 'response_item') {
        const payload = entry.payload || {};
        if (payload.type === 'function_call' && payload.name) toolsUsed.add(payload.name);
      }
      if (entry.type === 'custom-title' && entry.customTitle) session.customTitle = entry.customTitle;
    } catch (_) { /* ignore */ }
  }

  session.userMessages = userMessages;
  session.assistantSnippets = assistantSnippets;
  session.totalMessages = totalMessages || session.estimatedMessages;
  session.estimatedMessages = session.totalMessages;
  session.toolsUsed = Array.from(toolsUsed);
  session._detailLoaded = true;
  if (userMessages.length > 0) session.topic = trimTopic(userMessages[0]) || session.topic;
  return session;
}

function isInteractiveSession(session) {
  return session.source !== 'exec' && session.originator !== 'codex_exec';
}

function loadAllSessions() {
  const sessions = [];
  for (const filePath of walkSessionFiles(SESSIONS_DIR)) {
    try {
      const session = loadSessionQuick(filePath);
      if (session.firstTs && session.topic !== '(no user messages)' && isInteractiveSession(session)) {
        sessions.push(session);
      }
    } catch (_) { /* ignore */ }
  }
  sessions.sort((a, b) => (new Date(b.lastTs || 0).getTime()) - (new Date(a.lastTs || 0).getTime()));
  return sessions;
}

// ─── Formatting Helpers ──────────────────────────────────────────────────────

function formatTimestamp(ts) {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((todayStart.getTime() - targetStart.getTime()) / 86400000);
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7) return `${diffDays}d ago ${time}`;
  if (diffDays < 365) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / 1048576).toFixed(1)}M`;
}

function getProjectColor(projectName, colorMap) {
  if (!colorMap.has(projectName)) {
    colorMap.set(projectName, PROJECT_COLORS[colorMap.size % PROJECT_COLORS.length]);
  }
  return colorMap.get(projectName);
}

function esc(text) {
  return text.replace(/\{/g, '\\{');
}

function copyToClipboard(text) {
  const commands = [
    ['pbcopy', []],
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ];

  for (const [cmd, args] of commands) {
    const result = spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}

// ─── CLI Mode (--list) ───────────────────────────────────────────────────────

function runListMode(limit) {
  const sessions = loadAllSessions();
  const display = sessions.slice(0, limit || 30);
  const C = {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m',
    magenta: '\x1b[35m', blue: '\x1b[34m', white: '\x1b[37m',
  };
  console.log(`\n${C.cyan}${C.bold}🚀 Codex Sessions${C.reset} ${C.dim}(${sessions.length} total, showing ${display.length})${C.reset}\n`);
  console.log(`${C.dim}${'─'.repeat(110)}${C.reset}`);
  console.log(`${C.bold}${'#'.padStart(3)}  ${'Time'.padEnd(18)} ${'Project'.padEnd(24)} ${'Mode'.padEnd(10)} ${'Msgs'.padStart(5)}  ${'Size'.padStart(6)}  Topic${C.reset}`);
  console.log(`${C.dim}${'─'.repeat(110)}${C.reset}`);
  display.forEach((s, i) => {
    const mode = (s.source || s.originator || 'unknown').substring(0, 9);
    console.log(`${C.dim}${`${i+1}`.padStart(3)}${C.reset}  ${C.yellow}${formatTimestamp(s.lastTs).padEnd(18)}${C.reset} ${C.magenta}${s.project.substring(0,23).padEnd(24)}${C.reset} ${C.green}${mode.padEnd(10)}${C.reset} ${C.blue}${`${s.estimatedMessages}`.padStart(5)}${C.reset}  ${C.dim}${formatFileSize(s.fileSize).padStart(6)}${C.reset}  ${C.white}${s.topic.substring(0,42)}${C.reset}`);
  });
  console.log(`${C.dim}${'─'.repeat(110)}${C.reset}`);
  console.log(`\n${C.dim}Resume: ${C.cyan}${CLI.name} resume <session-id>${C.reset}\n`);
}

// ─── TUI Application ────────────────────────────────────────────────────────

function createApp() {
  const allSessions = loadAllSessions();
  const meta = loadMeta();

  // Apply meta customTitles — these take priority over JSONL titles
  // so renames persist even after continuing a conversation
  for (const session of allSessions) {
    const sm = meta.sessions[session.sessionId];
    if (sm && sm.customTitle) {
      session.customTitle = sm.customTitle;
    }
  }

  let filteredSessions = [...allSessions];
  let selectedIndex = -1;  // -1 = "New Session", 0+ = session index
  let filterText = '';
  let isSearchMode = false;
  let sortMode = 'time';
  let launchModeId = getDefaultLaunchMode(meta);

  const projectColorMap = new Map();
  const uniqueProjects = [...new Set(allSessions.map(s => s.project))];
  uniqueProjects.forEach(p => getProjectColor(p, projectColorMap));

  // ─── Screen ────────────────────────────────────────────────────────────
  const screen = blessed.screen({
    smartCSR: false,
    fastCSR: false,
    title: APP_NAME,
    fullUnicode: true,
    autoPadding: true,
    dockBorders: true,
  });

  // Force screen-level fill color so no terminal bg leaks through
  screen.style = { bg: 233 };  // 233 = xterm color closest to #141414

  // ─── Header ────────────────────────────────────────────────────────────
  const header = blessed.box({
    parent: screen, top: 0, left: 0, width: '100%', height: 3,
    tags: true, style: { fg: 'white', bg: '#141414' },
  });

  function updateHeader() {
    const title = `{bold}{#ff7a1a-fg}${APP_NAME}{/}`;
    const count = `{#a3e635-fg}${filteredSessions.length}{/}{#8a8178-fg}/${allSessions.length} sessions{/}`;
    const proj = `{#ffd166-fg}${uniqueProjects.length}{/}{#8a8178-fg} projects{/}`;
    const sort = `{#5bd1b9-fg}[${sortMode}]{/}`;
    const launchMode = `{#ff5d73-fg}[${getLaunchMode(launchModeId).label}]{/}`;
    const search = isSearchMode
      ? `{#ffb347-fg}/ ${filterText}▌{/}`
      : (filterText ? `{#ffb347-fg}/ ${filterText}{/}` : '');
    let parts = [title, count, proj];
    parts.push(sort);
    parts.push(launchMode);
    if (search) parts.push(search);
    header.setContent(`\n ${parts.join(' {#3a3f46-fg}│{/} ')}`);
  }

  blessed.line({ parent: screen, top: 3, left: 0, width: '100%', orientation: 'horizontal', style: { fg: '#3a3f46', bg: '#141414' } });

  // ─── Left Panel: blessed.list for correct scroll tracking ──────────────
  const listPanel = blessed.list({
    parent: screen,
    top: 4, left: 0, width: '50%', height: '100%-7',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: '▐', style: { fg: '#8a8178' } },
    style: {
      bg: '#141414',
      fg: '#e7dccf',
      selected: { bg: '#8a3b12', fg: 'white', bold: true },
    },
    keys: false,
    vi: false,
    mouse: true,
    interactive: true,
  });

  blessed.line({ parent: screen, top: 4, left: '50%', height: '100%-7', orientation: 'vertical', style: { fg: '#3a3f46', bg: '#141414' } });

  // ─── Right Panel ───────────────────────────────────────────────────────
  const detailPanel = blessed.box({
    parent: screen,
    top: 4, left: '50%+1', width: '50%-1', height: '100%-7',
    tags: true, scrollable: true, alwaysScroll: true,
    scrollbar: { ch: '▐', style: { fg: '#8a8178' } },
    style: { bg: '#141414' },
    mouse: true,
  });

  blessed.line({ parent: screen, bottom: 2, left: 0, width: '100%', orientation: 'horizontal', style: { fg: '#3a3f46', bg: '#141414' } });

  // ─── Footer ────────────────────────────────────────────────────────────
  const footer = blessed.box({
    parent: screen, bottom: 0, left: 0, width: '100%', height: 2,
    tags: true, style: { fg: '#e7dccf', bg: '#141414' },
  });

  function updateFooter() {
    if (isSearchMode) {
      const keys = [
        '{#ffb347-fg}{bold}↵{/} {#ffb347-fg}Confirm{/}',
        '{#ff7a1a-fg}{bold}↑↓{/} {#ff7a1a-fg}Navigate{/}',
        '{#8a8178-fg}{bold}⌫{/} {#8a8178-fg}Delete char{/}',
        '{#8a8178-fg}{bold}Esc{/} {#8a8178-fg}Clear{/}',
      ];
      footer.setContent(`\n ${keys.join(' {#3a3f46-fg}│{/} ')}`);
      return;
    }
    const keys = [
        '{#a3e635-fg}{bold}n{/} {#a3e635-fg}New{/}',
        '{#ff7a1a-fg}{bold}↵{/} {#ff7a1a-fg}Resume{/}',
        '{#ff5d73-fg}{bold}d{/} {#ff5d73-fg}Danger{/}',
        '{#ff5d73-fg}{bold}m{/} {#ff5d73-fg}Mode{/}',
        '{#ffb347-fg}{bold}/{/} {#ffb347-fg}Search{/}',
        '{#5ad1e6-fg}{bold}p{/} {#5ad1e6-fg}Project{/}',
        '{#5bd1b9-fg}{bold}s{/} {#5bd1b9-fg}Sort{/}',
      '{#8a8178-fg}{bold}c{/} {#8a8178-fg}Copy ID{/}',
      '{#ff8f3f-fg}{bold}r{/} {#ff8f3f-fg}Rename{/}',
      '{#ff5d73-fg}{bold}x{/} {#ff5d73-fg}Delete{/}',
      '{#8a8178-fg}{bold}q{/} {#8a8178-fg}Quit{/}',
    ];
    footer.setContent(`\n ${keys.join(' {#3a3f46-fg}│{/} ')}`);
  }

  // ─── Build list items from sessions ────────────────────────────────────
  function buildListItems() {
    const listW = Math.floor((screen.width || 100) / 2) - 2;

    return filteredSessions.map((session) => {
      const color = getProjectColor(session.project, projectColorMap);
      const proj = `{${color}-fg}${session.project.substring(0, 14).padEnd(14)}{/}`;
      const time = `{#ffb347-fg}${formatTimestamp(session.lastTs).padEnd(18)}{/}`;
      const msgs = `{#ff7a1a-fg}${String(session.estimatedMessages).padStart(4)}{/}{#8a8178-fg}msg{/}`;
      const size = `{#8a8178-fg}${formatFileSize(session.fileSize).padStart(6)}{/}`;

      const topicMaxLen = Math.max(20, listW - 2);
      let topic = session.topic;
      topic = truncateDisplayText(topic, topicMaxLen);

      const branch = session.gitBranch
        ? `{#5bd1b9-fg}${session.gitBranch.substring(0, 25)}{/}`
        : '';
      const dur = session.duration ? `{#8a8178-fg}${session.duration}{/}` : '';

      // Compose a multi-line string for each list item.
      // blessed.list renders each item as a single row, so we pack info densely.
      // Line: project | time | msgs | size
      // (topic + branch shown on next visual line via padding trick)
      let line1 = ` ${proj} ${time} ${msgs} ${size}`;
      let line2 = `   {#e7dccf-fg}${esc(topic)}{/}`;
      let line3 = branch ? `   ${branch}  ${dur}` : (dur ? `   ${dur}` : '');

      // blessed.list items are single-line, but we can use \n inside them
      // if the list height per item supports it. Unfortunately blessed.list
      // doesn't natively support multi-line items well.
      //
      // So we use a compact two-line format:
      return `${line1}\n${line2}${line3 ? '\n' + line3 : ''}`;
    });
  }

  // ─── Populate list ─────────────────────────────────────────────────────
  // Index 0 = "New Session", index 1+ = sessions
  const NEW_SESSION_LABEL = ' {#a3e635-fg}{bold}+ New Conversation{/}';

  function refreshList() {
    const listW = Math.floor((screen.width || 100) / 2) - 2;

    const sessionItems = filteredSessions.map((session) => {
      const color = getProjectColor(session.project, projectColorMap);
      const proj = `{${color}-fg}${session.project.substring(0, 12).padEnd(12)}{/}`;
      const time = `{#ffb347-fg}${formatTimestamp(session.lastTs).padEnd(16)}{/}`;

      const fixedLen = 12 + 1 + 16 + 1 + 3;
      const topicMaxLen = Math.max(10, listW - fixedLen);
      let topic = session.customTitle || session.topic;

      if (topic.length > topicMaxLen) topic = topic.substring(0, topicMaxLen) + '…';

      let label = `${proj} ${time} `;
      if (session.customTitle) {
        label += `{#5bd1b9-fg}{bold}${esc(topic)}{/}`;
      } else {
        label += `{#e7dccf-fg}${esc(topic)}{/}`;
      }

      return label;
    });

    const items = [NEW_SESSION_LABEL, ...sessionItems];

    listPanel.setItems(items);
    listPanel.select(selectedIndex + 1);  // +1 because index 0 is "New Session"
    screen.render();
  }

  // ─── Render Detail Panel ───────────────────────────────────────────────
  function renderDetail() {
    if (selectedIndex === -1) {
      const cli = CLI.name;
      const launchMode = getLaunchMode(launchModeId);
      const launchCommand = buildCodexCommand({ modeId: launchModeId });
      let c = '';
      c += `\n {#a3e635-fg}{bold}Start a New Conversation{/}\n`;
      c += ` {#3a3f46-fg}${'─'.repeat(44)}{/}\n\n`;
      c += ` {#e7dccf-fg}Open a fresh Codex session and start{/}\n`;
      c += ` {#e7dccf-fg}working in the current directory.{/}\n\n`;
      c += ` {#8a8178-fg}Working Dir{/}  {#5ad1e6-fg}${process.cwd()}{/}\n`;
      c += ` {#8a8178-fg}CLI{/}          {#5bd1b9-fg}${cli}{/}\n`;
      c += ` {#8a8178-fg}Launch Mode{/}  {#ff5d73-fg}${launchMode.label}{/}\n`;
      c += ` {#8a8178-fg}Command{/}      {#8a8178-fg}${launchCommand}{/}\n\n`;
      c += ` {#8a8178-fg}${launchMode.description}{/}\n\n`;
      c += ` {#3a3f46-fg}${'─'.repeat(44)}{/}\n`;
      c += ` {#a3e635-fg}{bold}↵ Enter{/}{#a3e635-fg} or {/}{#a3e635-fg}{bold}n{/}{#a3e635-fg} to launch{/}\n`;
      c += ` {#ff5d73-fg}{bold}m{/}{#ff5d73-fg} to change startup mode{/}\n`;
      detailPanel.setContent(c);
      detailPanel.setScroll(0);
      return;
    }

    if (filteredSessions.length === 0 || !filteredSessions[selectedIndex]) {
      detailPanel.setContent('\n  {#8a8178-fg}No session selected{/}');
      return;
    }

    const session = filteredSessions[selectedIndex];
    loadSessionDetail(session);
    const launchMode = getLaunchMode(launchModeId);
    const resumeCommand = buildCodexCommand({ sessionId: session.sessionId, modeId: launchModeId });

    // Meta customTitle takes priority over JSONL
    const sm = meta.sessions[session.sessionId];
    if (sm && sm.customTitle) session.customTitle = sm.customTitle;

    const color = getProjectColor(session.project, projectColorMap);
    let c = '';
    const sep = ` {#3a3f46-fg}${'─'.repeat(44)}{/}`;

    // Title
    c += `\n {${color}-fg}{bold}█ ${session.project}{/}\n`;
    if (session.customTitle) {
      c += ` {#5bd1b9-fg}{bold}${esc(session.customTitle)}{/}\n`;
    }
    c += sep + '\n\n';

    const fields = [
      ['Session', `{#5ad1e6-fg}${session.sessionId}{/}`],
      ['Started', `{#ffb347-fg}${session.firstTs ? new Date(session.firstTs).toLocaleString() : '?'}{/}`],
      ['Last active', `{#ffb347-fg}${session.lastTs ? new Date(session.lastTs).toLocaleString() : '?'}{/}`],
      ['Duration', `{#a3e635-fg}${session.duration || '<1m'}{/}`],
      ['Messages', `{#ff7a1a-fg}${session.totalMessages || session.estimatedMessages}{/}`],
      ['Size', `{#ffd166-fg}${formatFileSize(session.fileSize)}{/}`],
    ];
    if (session.gitBranch) fields.push(['Branch', `{#5bd1b9-fg} ${session.gitBranch}{/}`]);
    if (session.version) fields.push(['Codex', `{#8a8178-fg}v${session.version}{/}`]);
    if (session.cwd) fields.push(['Directory', `{#8a8178-fg}${session.cwd}{/}`]);
    if (session.modelProvider) fields.push(['Provider', `{#5bd1b9-fg}${session.modelProvider}{/}`]);
    if (session.source || session.originator) fields.push(['Mode', `{#8a8178-fg}${session.source || session.originator}{/}`]);
    fields.push(['Resume with', `{#ff5d73-fg}${launchMode.label}{/}`]);

    for (const [label, value] of fields) {
      c += ` {#8a8178-fg}${label.padEnd(12)}{/} ${value}\n`;
    }

    if (session.toolsUsed && session.toolsUsed.length > 0) {
      c += `\n {#5ad1e6-fg}{bold}Tools Used{/}\n`;
      const chips = session.toolsUsed.slice(0, 10).map(t => `{#3a3f46-fg}[{/}{#5ad1e6-fg}${t}{/}{#3a3f46-fg}]{/}`).join(' ');
      c += ` ${chips}\n`;
      if (session.toolsUsed.length > 10) c += ` {#8a8178-fg}+${session.toolsUsed.length - 10} more{/}\n`;
    }

    c += `\n {#ffd166-fg}{bold}Conversation{/}\n`;
    c += sep + '\n';

    const detailHeight = detailPanel.height || screen.height || 24;
    const previewLimit = Math.max(10, Math.floor(Math.max(0, detailHeight - 18) / 3));
    const msgs = (session.userMessages || []).slice(0, previewLimit);
    const assists = (session.assistantSnippets || []);

    if (msgs.length === 0) {
      c += `\n  {#8a8178-fg}(no readable messages){/}\n`;
    } else {
      msgs.forEach((msg, i) => {
        const clean = esc(msg.replace(/\n/g, ' ').trim());
        const trunc = clean.length > 80 ? clean.substring(0, 80) + '…' : clean;
        c += `\n {#ff7a1a-fg}{bold}You >{/} ${trunc}\n`;
        if (assists[i]) {
          const aClean = esc(assists[i].replace(/\n/g, ' ').trim());
          const aTrunc = aClean.length > 80 ? aClean.substring(0, 80) + '…' : aClean;
          c += ` {#a3e635-fg}Codex >{/} {#8a8178-fg}${aTrunc}{/}\n`;
        }
      });
    }

    c += `\n${sep}`;
    c += `\n {#a3e635-fg}{bold}↵ Enter{/}{#a3e635-fg} to resume this conversation{/}`;
    c += `\n {#8a8178-fg}${resumeCommand}{/}\n`;
    c += ` {#8a8178-fg}${launchMode.description}{/}\n`;

    detailPanel.setContent(c);
    detailPanel.setScroll(0);
  }

  // ─── Render All ────────────────────────────────────────────────────────
  function renderAll() {
    updateHeader();
    refreshList();
    renderDetail();
    updateFooter();
    listPanel.focus();
    screen.render();
  }

  // ─── Filter ────────────────────────────────────────────────────────────
  function applyFilter() {
    if (!filterText) {
      filteredSessions = [...allSessions];
    } else {
      const terms = filterText.toLowerCase().split(/\s+/);
      filteredSessions = allSessions.filter(s => {
        const haystack = [s.project, s.topic, s.customTitle || '', s.gitBranch || '', s.sessionId, ...(s.userMessages || [])].join(' ').toLowerCase();

        return terms.every(t => {
          return haystack.includes(t);
        });
      });
    }
    selectedIndex = Math.min(selectedIndex, Math.max(-1, filteredSessions.length - 1));
    // When filtering, select first result; when clearing, select New Session
    if (filterText && filteredSessions.length > 0) {
      selectedIndex = 0;
    }
    listPanel.childBase = 0;  // reset scroll to top
    renderAll();
  }

  // ─── Sort ──────────────────────────────────────────────────────────────
  function cycleSort() {
    const modes = ['time', 'size', 'messages', 'project'];
    sortMode = modes[(modes.indexOf(sortMode) + 1) % modes.length];
    const sorters = {
      time: (a, b) => (new Date(b.lastTs || 0).getTime()) - (new Date(a.lastTs || 0).getTime()),
      size: (a, b) => b.fileSize - a.fileSize,
      messages: (a, b) => b.estimatedMessages - a.estimatedMessages,
      project: (a, b) => a.project.localeCompare(b.project) || (new Date(b.lastTs || 0).getTime()) - (new Date(a.lastTs || 0).getTime()),
    };
    allSessions.sort(sorters[sortMode]);
    selectedIndex = 0;
    applyFilter();
  }

  function cycleLaunchMode() {
    const currentIndex = LAUNCH_MODES.findIndex(mode => mode.id === launchModeId);
    launchModeId = LAUNCH_MODES[(currentIndex + 1) % LAUNCH_MODES.length].id;
    setDefaultLaunchMode(meta, launchModeId);
    renderAll();
  }

  // ─── Project Picker ────────────────────────────────────────────────────
  let popupOpen = false;

  function showProjectPicker() {
    const projects = ['  All Projects', ...uniqueProjects.map(p => `  ${p}`)];
    const popup = blessed.list({
      parent: screen, top: 'center', left: 'center',
      width: Math.min(50, Math.max(...projects.map(p => p.length)) + 8),
      height: Math.min(projects.length + 4, 20),
      label: ' {bold}{#ff7a1a-fg}Filter by Project{/} ',
      tags: true, border: { type: 'line' },
      style: {
        border: { fg: '#ff7a1a' }, bg: '#1d1f24', fg: '#e7dccf',
        selected: { bg: '#8a3b12', fg: 'white', bold: true },
        label: { fg: '#ff7a1a' },
      },
      items: projects, keys: true, vi: true, mouse: true,
    });
    popupOpen = true;
    popup.focus(); screen.render();
    popup.on('select', (item, index) => {
      filterText = index === 0 ? '' : uniqueProjects[index - 1];
      popup.destroy(); popupOpen = false; selectedIndex = 0; applyFilter();
    });
    popup.key(['escape', 'q'], () => { popup.destroy(); popupOpen = false; screen.render(); });
  }

  // ─── Key Bindings ──────────────────────────────────────────────────────

  // Monkey-patch listPanel.select: update selection WITHOUT scrolling.
  const _origSelect = listPanel.select.bind(listPanel);
  listPanel.select = function(index) {
    const sb = this.childBase;
    _origSelect(index);
    this.childBase = sb;
  };

  // Prevent blessed's internal select-on-click from double-firing moveSelection
  let suppressSelectEvent = false;

  listPanel.on('select item', (item, index) => {
    if (suppressSelectEvent) return;
    selectedIndex = index - 1;  // list index 0 = New Session = -1
    renderDetail(); updateHeader(); screen.render();
  });

  function moveSelection(delta) {
    const newIdx = selectedIndex + delta;
    // -1 = New Session, 0..length-1 = sessions
    if (newIdx >= -1 && newIdx < filteredSessions.length) {
      selectedIndex = newIdx;
      const listIdx = selectedIndex + 1;  // list index (0 = New Session row)
      suppressSelectEvent = true;
      listPanel.select(listIdx);
      suppressSelectEvent = false;

      // Scroll only if selection went out of viewport
      const base = listPanel.childBase;
      const visible = listPanel.height;
      if (listIdx < base) {
        listPanel.childBase = listIdx;
      } else if (listIdx >= base + visible) {
        listPanel.childBase = listIdx - visible + 1;
      }

      renderDetail();
      updateHeader();
      screen.render();
    }
  }

  screen.key(['down'], () => {
    if (renameMode || popupOpen) return;
    if (isSearchMode) { isSearchMode = false; updateHeader(); updateFooter(); screen.render(); }
    moveSelection(1);
  });
  screen.key(['up'], () => {
    if (renameMode || popupOpen) return;
    if (isSearchMode) { isSearchMode = false; updateHeader(); updateFooter(); screen.render(); }
    moveSelection(-1);
  });
  screen.key(['home'], () => {
    if (renameMode || popupOpen) return;
    if (isSearchMode) { isSearchMode = false; }
    selectedIndex = -1;
    suppressSelectEvent = true; listPanel.select(0); suppressSelectEvent = false;
    listPanel.childBase = 0;
    renderDetail(); updateHeader(); screen.render();
  });
  screen.key(['end'], () => {
    if (renameMode || popupOpen) return;
    if (isSearchMode) { isSearchMode = false; }
    selectedIndex = Math.max(0, filteredSessions.length - 1);
    suppressSelectEvent = true; listPanel.select(selectedIndex + 1); suppressSelectEvent = false;
    listPanel.childBase = Math.max(0, selectedIndex + 1 - listPanel.height + 1);
    renderDetail(); updateHeader(); screen.render();
  });
  screen.key(['pagedown', 'C-d'], () => {
    if (renameMode || popupOpen) return;
    if (isSearchMode) { isSearchMode = false; updateHeader(); screen.render(); }
    moveSelection(Math.floor((listPanel.height || 20) / 2));
  });
  screen.key(['pageup', 'C-u'], () => {
    if (renameMode || popupOpen) return;
    if (isSearchMode) { isSearchMode = false; updateHeader(); screen.render(); }
    moveSelection(-Math.floor((listPanel.height || 20) / 2));
  });

  // Search
  screen.key(['/'], () => {
    if (renameMode || isSearchMode) return;
    isSearchMode = true;
    if (!filterText) filterText = '';  // keep existing filterText if any
    updateHeader(); updateFooter(); screen.render();
  });

  screen.on('keypress', (ch, key) => {
    // ── Rename mode: capture all input ──
    if (renameMode) {
      if (key.name === 'return' || key.name === 'enter') {
        const session = renameSession;
        const value = renameValue;
        closeRename();
        submitRename(session, value);
        return;
      }
      if (key.name === 'escape') {
        closeRename();
        listPanel.focus();
        screen.render();
        return;
      }
      if (key.name === 'backspace') {
        if (renameValue.length > 0) {
          renameValue = [...renameValue].slice(0, -1).join('');
          renderRenameInput();
        }
        return;
      }
      if (ch && ch.length >= 1 && ch.charCodeAt(0) >= 32 && !key.ctrl && !key.meta) {
        renameValue += ch;
        renderRenameInput();
      }
      return;  // swallow all keys while in rename mode
    }

    // Backspace: delete search char, or exit search mode if empty
    if (key.name === 'backspace') {
      if (filterText) {
        filterText = filterText.slice(0, -1);
        selectedIndex = -1;
        isSearchMode = !!filterText;
        applyFilter();
      } else if (isSearchMode) {
        isSearchMode = false;
        applyFilter();
      }
      return;
    }

    // Vim-like navigation (only when NOT in search mode)
    if (!isSearchMode && !popupOpen) {
      if (ch === 'j') { moveSelection(1); return; }
      if (ch === 'k') { moveSelection(-1); return; }
      if (ch === 'G') {
        selectedIndex = Math.max(0, filteredSessions.length - 1);
        suppressSelectEvent = true; listPanel.select(selectedIndex + 1); suppressSelectEvent = false;
        listPanel.childBase = Math.max(0, selectedIndex + 1 - listPanel.height + 1);
        renderDetail(); updateHeader(); screen.render();
        return;
      }
      if (ch === 'g') {
        selectedIndex = -1;
        suppressSelectEvent = true; listPanel.select(0); suppressSelectEvent = false;
        listPanel.childBase = 0;
        renderDetail(); updateHeader(); screen.render();
        return;
      }
    }

    if (!isSearchMode) return;
    if (key.name === 'return' || key.name === 'enter') { isSearchMode = false; searchJustConfirmed = true; renderAll(); return; }
    if (key.name === 'escape') { isSearchMode = false; filterText = ''; applyFilter(); return; }
    // Only accept printable characters (exclude control chars like \r \n \t)
    if (ch && ch.length === 1 && ch.charCodeAt(0) >= 32 && !key.ctrl && !key.meta) { filterText += ch; selectedIndex = -1; applyFilter(); }
  });

  // ─── Resume Session ─────────────────────────────────────────────────────

  function resumeSession(session, overrideModeId = null) {
    process.stdout.write('\x1b[0m');
    screen.destroy();

    const label = CLI.name;
    const effectiveModeId = overrideModeId || launchModeId;
    setDefaultLaunchMode(meta, effectiveModeId);
    const launchMode = getLaunchMode(effectiveModeId);
    const command = buildCodexCommand({ sessionId: session.sessionId, modeId: effectiveModeId });

    console.log(`\n\x1b[36m⚡ Resuming conversation with ${label}\x1b[0m`);
    console.log(`\x1b[90m   Session: ${session.sessionId}\x1b[0m`);
    console.log(`\x1b[90m   Project: ${session.project}  │  Messages: ${session.estimatedMessages}  │  Mode: ${session.source || session.originator || 'unknown'}\x1b[0m`);
    console.log(`\x1b[90m   Resume mode: ${launchMode.label}\x1b[0m`);
    console.log('');

    const { shellPath, shellArgs } = getShellCommand(command);
    const child = spawn(shellPath, shellArgs, { stdio: 'inherit', cwd: session.cwd || process.cwd() });
    child.on('error', (err) => {
      console.error(`\x1b[31mFailed to resume: ${err.message}\x1b[0m`);
      console.log(`\x1b[33mManual: ${command}\x1b[0m`);
      process.exit(1);
    });
    child.on('exit', (code) => process.exit(code || 0));
  }

  function startNewSession(overrideModeId = null) {
    process.stdout.write('\x1b[0m');
    screen.destroy();

    const label = CLI.name;
    const effectiveModeId = overrideModeId || launchModeId;
    setDefaultLaunchMode(meta, effectiveModeId);
    const launchMode = getLaunchMode(effectiveModeId);
    const command = buildCodexCommand({ modeId: effectiveModeId });

    console.log(`\n\x1b[36m✨ Starting new conversation with ${label}\x1b[0m`);
    console.log(`\x1b[90m   Launch mode: ${launchMode.label}\x1b[0m`);
    console.log('');

    const { shellPath, shellArgs } = getShellCommand(command);
    const child = spawn(shellPath, shellArgs, { stdio: 'inherit', cwd: process.cwd() });
    child.on('error', (err) => {
      console.error(`\x1b[31mFailed to start: ${err.message}\x1b[0m`);
      process.exit(1);
    });
    child.on('exit', (code) => process.exit(code || 0));
  }

  // Track the rename confirm popup and its session for Enter handling
  let renameConfirmPopup = null;
  let renameConfirmSession = null;
  let searchJustConfirmed = false;

  screen.key(['enter'], () => {
    if (renameMode) return;
    if (renameJustFinished) return;
    if (searchJustConfirmed) { searchJustConfirmed = false; return; }
    // Handle rename confirm popup Enter
    if (renameConfirmPopup && popupOpen) {
      const session = renameConfirmSession;
      renameConfirmPopup.destroy();
      renameConfirmPopup = null;
      renameConfirmSession = null;
      popupOpen = false;
      resumeSession(session);
      return;
    }
    if (isSearchMode) { isSearchMode = false; renderAll(); return; }
    if (popupOpen) return;
    if (selectedIndex === -1) { startNewSession(); return; }
    if (filteredSessions.length === 0) return;
    resumeSession(filteredSessions[selectedIndex]);
  });

  // Quick shortcut: n = new session
  screen.key(['n'], () => {
    if (renameMode || isSearchMode) return;
    startNewSession();
  });

  // Copy session ID
  screen.key(['c'], () => {
    if (renameMode || isSearchMode) return;
    if (filteredSessions.length === 0) return;
    const sid = filteredSessions[selectedIndex].sessionId;
    try {
      if (!copyToClipboard(sid)) throw new Error('clipboard unavailable');
      footer.setContent(`\n  {#a3e635-fg}{bold}✓ Copied:{/} {#5ad1e6-fg}${sid}{/}`);
      screen.render();
      setTimeout(() => { updateFooter(); screen.render(); }, 1500);
    } catch (e) {
      footer.setContent(`\n  {#ff5d73-fg}{bold}Clipboard unavailable{/} {#8a8178-fg}${sid}{/}`);
      screen.render();
      setTimeout(() => { updateFooter(); screen.render(); }, 1500);
    }
  });

  // ─── Quick dangerous resume (d key) ────────────────────────────────────
  screen.key(['d'], () => {
    if (renameMode || isSearchMode || popupOpen) return;
    if (selectedIndex === -1) { startNewSession('danger'); return; }
    if (selectedIndex < 0 || selectedIndex >= filteredSessions.length) return;
    resumeSession(filteredSessions[selectedIndex], 'danger');
  });

  // ─── Delete Session ───────────────────────────────────────────────────
  function deleteSession(session) {
    try {
      // Delete the .jsonl file
      if (fs.existsSync(session.filePath)) {
        fs.unlinkSync(session.filePath);
      }
      // Clean up meta entry
      if (meta.sessions[session.sessionId]) {
        delete meta.sessions[session.sessionId];
        saveMeta(meta);
      }
      // Remove from in-memory arrays
      const allIdx = allSessions.indexOf(session);
      if (allIdx !== -1) allSessions.splice(allIdx, 1);
      const filtIdx = filteredSessions.indexOf(session);
      if (filtIdx !== -1) filteredSessions.splice(filtIdx, 1);
      // Adjust selection
      if (selectedIndex >= filteredSessions.length) {
        selectedIndex = Math.max(-1, filteredSessions.length - 1);
      }
    } catch (e) { /* silently fail */ }
  }

  function showDeleteConfirm(session) {
    const topic = (session.customTitle || session.topic || '').substring(0, 30);
    const confirmPopup = blessed.box({
      parent: screen, top: 'center', left: 'center',
      width: 50, height: 9,
      label: ' {bold}{#ff5d73-fg}Delete Session?{/} ',
      tags: true, border: { type: 'line' },
      style: {
        border: { fg: '#ff5d73' }, bg: '#1d1f24', fg: '#e7dccf',
        label: { fg: '#ff5d73' },
      },
      content:
        `\n  {#e7dccf-fg}${esc(topic)}{/}\n`
        + `  {#8a8178-fg}${session.sessionId}{/}\n\n`
        + `  {#ff5d73-fg}{bold}y{/}{#e7dccf-fg} Delete  {/}{#8a8178-fg}n / Esc{/}{#e7dccf-fg} Cancel{/}`,
    });
    popupOpen = true;
    confirmPopup.focus();
    screen.render();

    confirmPopup.key(['y'], () => {
      confirmPopup.destroy();
      popupOpen = false;
      deleteSession(session);
      footer.setContent(`\n  {#ff5d73-fg}{bold}✗ Deleted:{/} {#8a8178-fg}${session.sessionId}{/}`);
      renderAll();
      setTimeout(() => { updateFooter(); screen.render(); }, 1500);
    });
    confirmPopup.key(['n', 'escape', 'q'], () => {
      confirmPopup.destroy();
      popupOpen = false;
      screen.render();
    });
  }

  screen.key(['x', 'delete'], () => {
    if (renameMode || isSearchMode || popupOpen) return;
    if (selectedIndex < 0 || selectedIndex >= filteredSessions.length) return;
    showDeleteConfirm(filteredSessions[selectedIndex]);
  });

  // ─── Rename Session ───────────────────────────────────────────────────
  const stringWidth = require('string-width');
  let renameMode = false;
  let renameJustFinished = false;
  let renameValue = '';
  let renameSession = null;
  let renamePopup = null;
  let renameDisplay = null;
  const renameMaxWidth = 46;

  function renderRenameInput() {
    let display = renameValue;
    while (stringWidth(display) > renameMaxWidth && display.length > 0) {
      display = display.substring(1);
    }
    renameDisplay.setContent(display + '▌');
    screen.render();
  }

  function showRenameInput(session) {
    renameSession = session;
    renameValue = session.customTitle || '';

    renamePopup = blessed.box({
      parent: screen, top: 'center', left: 'center',
      width: 52, height: 7,
      label: ' {bold}{#5bd1b9-fg}Rename Session{/} ',
      tags: true, border: { type: 'line' },
      style: {
        border: { fg: '#5bd1b9' }, bg: '#1d1f24', fg: '#e7dccf',
        label: { fg: '#5bd1b9' },
      },
    });

    renameDisplay = blessed.box({
      parent: renamePopup,
      top: 1, left: 1, right: 1, height: 1,
      tags: false,
      style: { fg: 'white', bg: '#141414' },
    });

    blessed.box({
      parent: renamePopup,
      top: 3, left: 1, right: 1, height: 1,
      tags: true,
      style: { bg: '#1d1f24' },
      content: '  {#a3e635-fg}{bold}Enter{/}{#e7dccf-fg} Save  {/}{#8a8178-fg}Esc{/}{#e7dccf-fg} Cancel{/}',
    });

    popupOpen = true;
    renameMode = true;
    renderRenameInput();
  }

  function closeRename() {
    renameMode = false;
    if (renamePopup) { renamePopup.destroy(); renamePopup = null; }
    popupOpen = false;
    renameSession = null;
    renameDisplay = null;
  }

  function submitRename(session, newTitle) {
    newTitle = (newTitle || '').trim();

    // Save to meta
    if (!meta.sessions[session.sessionId]) meta.sessions[session.sessionId] = {};
    meta.sessions[session.sessionId].customTitle = newTitle || undefined;
    if (!newTitle) delete meta.sessions[session.sessionId].customTitle;
    saveMeta(meta);

    // Update in-memory session
    session.customTitle = newTitle;

    // Also append to JSONL so the title survives future resumes
    if (newTitle && fs.existsSync(session.filePath)) {
      try {
        const entry = JSON.stringify({ type: 'custom-title', customTitle: newTitle });
        fs.appendFileSync(session.filePath, '\n' + entry);
      } catch (e) { /* silently fail */ }
    }

    renderAll();

    // Ask whether to resume this session after rename
    // We use renameJustFinished flag to prevent the Enter key from rename
    // from immediately triggering resume
    renameJustFinished = true;
    setTimeout(() => { renameJustFinished = false; }, 200);

    setTimeout(() => {
      const titleLabel = newTitle ? `{#5bd1b9-fg}${esc(newTitle)}{/}` : '{#8a8178-fg}(title cleared){/}';
      renameConfirmSession = session;
      renameConfirmPopup = blessed.box({
        parent: screen, top: 'center', left: 'center',
        width: 48, height: 8,
        label: ' {bold}{#a3e635-fg}Renamed{/} ',
        tags: true, border: { type: 'line' },
        style: {
          border: { fg: '#a3e635' }, bg: '#1d1f24', fg: '#e7dccf',
          label: { fg: '#a3e635' },
        },
        content: `\n  ${titleLabel}\n\n  {#a3e635-fg}{bold}Enter{/}{#e7dccf-fg} Resume  {/}{#8a8178-fg}Esc{/}{#e7dccf-fg} Back to list{/}`,
      });
      popupOpen = true;
      renameConfirmPopup.focus();
      screen.render();

      renameConfirmPopup.key(['escape', 'q'], () => {
        renameConfirmPopup.destroy();
        renameConfirmPopup = null;
        renameConfirmSession = null;
        popupOpen = false;
        renderAll();
      });
    }, 50);
  }

  screen.key(['r'], () => {
    if (isSearchMode || popupOpen) return;
    if (selectedIndex < 0 || selectedIndex >= filteredSessions.length) return;
    showRenameInput(filteredSessions[selectedIndex]);
  });

  screen.key(['m'], () => { if (!renameMode && !isSearchMode && !popupOpen) cycleLaunchMode(); });
  screen.key(['s'], () => { if (!renameMode && !isSearchMode) cycleSort(); });
  screen.key(['p'], () => { if (!renameMode && !isSearchMode) showProjectPicker(); });
  screen.key(['escape'], () => {
    if (renameMode) return;  // handled in keypress
    if (isSearchMode) { isSearchMode = false; filterText = ''; applyFilter(); return; }
    filterText = ''; selectedIndex = -1; applyFilter();
  });
  screen.key(['q', 'C-c'], () => { if (renameMode) return; process.stdout.write('\x1b[0m'); screen.destroy(); process.exit(0); });

  // Remove blessed's built-in wheel handlers (they call select which changes selection)
  listPanel.removeAllListeners('element wheeldown');
  listPanel.removeAllListeners('element wheelup');

  // Mouse wheel on list — scroll viewport, keep selection in view
  function clampSelection() {
    const base = listPanel.childBase;
    const visible = listPanel.height;
    const listIdx = selectedIndex + 1;  // +1 for New Session row
    if (listIdx < base) {
      selectedIndex = base - 1;  // -1 to convert back
      suppressSelectEvent = true; listPanel.select(base); suppressSelectEvent = false;
      renderDetail(); updateHeader();
    } else if (listIdx >= base + visible) {
      selectedIndex = base + visible - 1 - 1;  // -1 for list→session offset
      suppressSelectEvent = true; listPanel.select(base + visible - 1); suppressSelectEvent = false;
      renderDetail(); updateHeader();
    }
  }

  listPanel.on('element wheeldown', () => {
    const maxBase = Math.max(0, listPanel.items.length - listPanel.height);
    if (listPanel.childBase < maxBase) {
      listPanel.childBase++;
      clampSelection();
      screen.render();
    }
  });
  listPanel.on('element wheelup', () => {
    if (listPanel.childBase > 0) {
      listPanel.childBase--;
      clampSelection();
      screen.render();
    }
  });

  // Mouse wheel on detail
  detailPanel.on('wheeldown', () => { detailPanel.scroll(2); screen.render(); });
  detailPanel.on('wheelup', () => { detailPanel.scroll(-2); screen.render(); });

  // ─── Go! ───────────────────────────────────────────────────────────────
  renderAll();
  listPanel.focus();
}

// ─── Exports for Testing ────────────────────────────────────────────────────
// When required as a module (e.g. by tests), export helpers without launching
// the CLI / TUI.  The entry-point logic only runs when executed directly.

if (typeof module !== 'undefined') {
  module.exports = {
    // Data helpers
    getProjectDisplayName,
    extractUserText,
    loadSessionQuick,
    loadSessionDetail,
    isInteractiveSession,
    loadAllSessions,
    // Formatting
    formatTimestamp,
    formatFileSize,
    getProjectColor,
    esc,
    // Meta
    loadMeta,
    saveMeta,
    getSessionMeta,
    getDefaultLaunchMode,
    setDefaultLaunchMode,
    // Constants
    LAUNCH_MODES,
    PROJECT_COLORS,
    CODEX_DIR,
    SESSIONS_DIR,
    META_FILE,
    // CLI
    detectCLI,
    getShellCommand,
    getLaunchMode,
    buildCodexCommand,
    // List mode (for integration tests)
    runListMode,
    // TUI (for interaction tests)
    createApp,
  };
}

// ─── Entry Point ─────────────────────────────────────────────────────────────
// Only run CLI/TUI when executed directly (not when required as a module).

if (require.main === module) {
  const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));

  const args = process.argv.slice(2);

  if (args.includes('--version') || args.includes('-v') || args.includes('-V')) {
    console.log(`codex-starter v${PKG.version}`);
    process.exit(0);
  }

  if (args.includes('--update') || args.includes('-u')) {
    const C = {
      reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
      cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m',
      red: '\x1b[31m',
    };
    console.log(`\n${C.cyan}🔄 Checking for updates…${C.reset}\n`);

    try {
      const latest = execSync('npm view codex-starter version 2>/dev/null', {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      }).toString().trim();

      if (latest === PKG.version) {
        console.log(`${C.green}✓ Already on the latest version (v${PKG.version})${C.reset}\n`);
        process.exit(0);
      }

      console.log(`${C.yellow}  Current: v${PKG.version}${C.reset}`);
      console.log(`${C.green}  Latest:  v${latest}${C.reset}\n`);
      console.log(`${C.cyan}📦 Updating…${C.reset}\n`);

      try {
        execSync('npm install -g codex-starter@latest', { stdio: 'inherit', timeout: 60000 });
        console.log(`\n${C.green}${C.bold}✓ Updated to v${latest}${C.reset}\n`);
      } catch (e) {
        console.error(`\n${C.red}✗ Update failed. Try manually:${C.reset}`);
        console.log(`${C.yellow}  npm install -g codex-starter@latest${C.reset}\n`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`${C.red}✗ Could not check for updates (network error or npm not found)${C.reset}\n`);
      process.exit(1);
    }

    process.exit(0);
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
\x1b[36m🚀 Codex Starter\x1b[0m  \x1b[2mv${PKG.version}\x1b[0m

Usage:
  codex-starter              Launch interactive TUI
  codex-starter --list [N]   Print latest N sessions (default: 30)
  codex-starter --version    Show version
  codex-starter --update     Update to the latest version
  codex-starter --help       Show this help

TUI Keyboard Shortcuts:
  ↑/↓           Navigate sessions
  Enter         Start new / resume selected session
  n             Start new session
  m             Cycle launch mode (default/full-auto/danger, remembered)
  d             Resume/start in dangerous mode and remember it
  /             Search (fuzzy filter)
  p             Filter by project
  s             Cycle sort mode (time/size/messages/project)
  c             Copy session ID
  x / Delete    Delete selected session
  Home / End    Jump to top / bottom
  Ctrl-D/U      Page down / up
  Esc           Clear filter
  q / Ctrl-C    Quit
`);
    process.exit(0);
  }

  if (args.includes('--list') || args.includes('-l')) {
    const limitIdx = args.indexOf('--list') !== -1 ? args.indexOf('--list') : args.indexOf('-l');
    const limit = parseInt(args[limitIdx + 1]) || 30;
    runListMode(limit);
    process.exit(0);
  }

  createApp();
}
