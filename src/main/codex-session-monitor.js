'use strict';

// Read-only fallback for Codex Desktop versions that do not dispatch lifecycle hooks.
// Processes ONLY Codex Desktop rollout files; never uploads transcripts or sends raw prompts,
// commands, source patches, final answers, approval contents or tool outputs to the renderer.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_READ = 256 * 1024; // bytes per file per scan
const MAX_LINE = 1024 * 1024; // discard unusually large JSONL records
const DIR = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');

function sessionDirs(root, at = Date.now()) {
  const dirs = new Set();
  for (let d = 0; d < 3; d++) {
    const date = new Date(at - d * 86400000);
    const y = String(date.getFullYear());
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    dirs.add(path.join(root, y, m, day));
  }
  return [...dirs];
}

function toDisplayEvent(record, sessionId, cwd = '') {
  if (!record || typeof record !== 'object' || !record.payload || typeof record.payload !== 'object') return null;
  const p = record.payload;
  const base = { provider: 'codex', session_id: sessionId, cwd, bridge_source: 'rollout' };
  if (record.type === 'event_msg') {
    if (p.type === 'task_started') return { ...base, hook_event_name: 'UserPromptSubmit', turn_id: p.turn_id };
    if (p.type === 'task_complete') return { ...base, hook_event_name: 'Stop', turn_id: p.turn_id };
    if (p.type === 'turn_aborted') return { ...base, hook_event_name: 'Interrupt', turn_id: p.turn_id };
    return null;
  }
  if (record.type !== 'response_item') return null;
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    if (!p.name || typeof p.name !== 'string') return null;
    return { ...base, hook_event_name: 'PreToolUse', tool_name: p.name.slice(0, 100), tool_input: {} };
  }
  if (p.type === 'web_search_call') return { ...base, hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_input: {} };
  return null;
}

function createSessionMonitor({ root = DIR, onEvent = () => {}, intervalMs = 1500, now = () => Date.now() } = {}) {
  const cursors = new Map();
  let initialized = false;
  let polling = false;
  let stopped = false;
  let timer = null;

  async function readHeadMetadata(file) {
    let fd;
    try {
      fd = await fs.promises.open(file, 'r');
      const buf = Buffer.alloc(16384);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      const head = buf.subarray(0, bytesRead).toString('utf8');
      // Do not parse or retain full session_meta: base_instructions can be sensitive/huge.
      const desktop = /"originator"\s*:\s*"Codex Desktop"/i.test(head);
      const cwd = /"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(head);
      let folder = '';
      if (cwd) { try { folder = JSON.parse('"' + cwd[1] + '"'); } catch {} }
      return { desktop, cwd: folder };
    } catch { return { desktop: false, cwd: '' }; }
    finally { await fd?.close().catch(() => {}); }
  }

  function acceptLine(line, state) {
    if (!state.desktop || !line.length || line.length > MAX_LINE) return;
    let record;
    try { record = JSON.parse(line.toString('utf8')); } catch { return; }
    const evt = toDisplayEvent(record, state.sessionId, state.cwd);
    if (evt) onEvent(evt);
  }

  async function readNew(file, state, size) {
    if (size < state.offset) { state.offset = size; state.partial = Buffer.alloc(0); }
    if (size <= state.offset) return;
    let fd;
    try {
      fd = await fs.promises.open(file, 'r');
      const length = Math.min(MAX_READ, size - state.offset);
      const chunk = Buffer.alloc(length);
      const read = await fd.read(chunk, 0, length, state.offset);
      state.offset += read.bytesRead;
      let data = Buffer.concat([state.partial, chunk.subarray(0, read.bytesRead)]);
      let pos = 0, end;
      while ((end = data.indexOf(10, pos)) !== -1) {
        acceptLine(data.subarray(pos, end), state);
        pos = end + 1;
      }
      data = data.subarray(pos);
      // Huge single records are opaque; don't keep them in memory.
      state.partial = data.length < MAX_LINE ? Buffer.from(data) : Buffer.alloc(0);
    } catch { /* Missing or busy session file: try again next scan. */ }
    finally { await fd?.close().catch(() => {}); }
  }

  async function poll() {
    if (polling || stopped) return;
    polling = true;
    try {
      const candidates = [];
      for (const folder of sessionDirs(root, now())) {
        const entries = await fs.promises.readdir(folder).catch(() => []);
        for (const name of entries) {
          if (/^rollout-.*\.jsonl$/i.test(name)) candidates.push(path.join(folder, name));
        }
      }
      for (const file of candidates.slice(-150)) {
        let stat;
        try { stat = await fs.promises.stat(file); } catch { continue; }
        if (!stat.isFile()) continue;
        let state = cursors.get(file);
        if (!state) {
          const { desktop, cwd } = await readHeadMetadata(file);
          state = {
            desktop, cwd,
            sessionId: path.basename(file, '.jsonl').match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i)?.[1] || path.basename(file, '.jsonl'),
            offset: initialized ? 0 : stat.size,
            partial: Buffer.alloc(0),
          };
          cursors.set(file, state);
        }
        if (state.desktop) await readNew(file, state, stat.size);
      }
      // Cap state without retaining transcript content.
      if (cursors.size > 300) {
        for (const key of [...cursors.keys()].slice(0, cursors.size - 150)) cursors.delete(key);
      }
      initialized = true;
    } finally { polling = false; }
  }

  async function start() {
    await poll();
    if (!stopped && !timer) {
      timer = setInterval(() => { poll().catch(() => {}); }, intervalMs);
      timer.unref?.();
    }
  }
  function stop() { stopped = true; if (timer) clearInterval(timer); timer = null; cursors.clear(); }
  return { start, poll, stop };
}

module.exports = { createSessionMonitor, toDisplayEvent, sessionDirs };
