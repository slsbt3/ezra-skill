// Ezra's worker hook (the ezra skill, EZRA.md: "הפעלה ראשונה אצל בעלים חדש", step 6). Copy it to <the Ezra folder>\hooks\.
// Runs from ~/.claude/settings.json on UserPromptSubmit ("start") and Stop ("stop"), for every Claude Code session on this machine.
//  start: if the session is a worker, its status.json gets status "עובד" and updatedAt from the clock, and the worker is told so.
//         A worker with an older skill version than skill-version.json is told to read the skill again.
//  stop:  if the worker did not touch its status.json during the turn, the turn is held once with a request to update it.
//  A session that is not a worker (Ezra included) is not changed. The hook never fails a session: every error goes to state\errors.log.
// Files (all in the Ezra folder):
//  hooks\map.json      { "bySession": { "<session id>": "<worker id>" }, "byCwd": { "<folder, lower case>": "<worker id>" }, "ignore": ["<session id>"] }
//                      Ezra's own session id goes in "ignore".
//  hooks\state\        log-YYYY-MM-DD.jsonl (start/stop per worker, for the punch clock), seen-<id>.json, turn-<session>.json,
//                      learned.json (sessions matched by the status.json they wrote), unknown\<session>.json (sessions to map), errors.log
// Where things are: the Ezra folder is the folder above this script, and the base folder ("folder" in projects.json is relative
// to it) is two folders above the Ezra folder, as with the board's CONFIG (roots ['Projects'], ezra ['Projects', 'Ezra']).
// Another layout: hooks\hook-config.json { "root": "D:/", "ezraDir": "D:/Projects/Ezra", "owner": "<the owner's name>" }.
const fs = require('fs'), path = require('path');
const BS = String.fromCharCode(92);
let CFG = {}; try { CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'hook-config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { /* none: the defaults */ }
const EZRA = process.env.EZRA_DIR || CFG.ezraDir || path.resolve(__dirname, '..');
const ROOT = process.env.EZRA_ROOT || CFG.root || path.resolve(EZRA, '..', '..');
const WAIT = CFG.owner ? 'מחכה ל' + CFG.owner : 'מחכה לבעלים';   // the board's "waiting for the owner" state, as in CONFIG.owner
const HOOKS = path.join(EZRA, 'hooks'), STATE = path.join(HOOKS, 'state');
const mode = process.argv[2];

const pad = n => String(n).padStart(2, '0');
function isoNow(d = new Date()) {
  const o = -d.getTimezoneOffset(), s = o >= 0 ? '+' : '-', a = Math.abs(o);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${s}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const writeJson = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 2)); fs.renameSync(f + '.tmp', f); };
const norm = p => String(p || '').split(BS).join('/').replace(/\/+$/, '').toLowerCase();
const logErr = e => { try { fs.mkdirSync(STATE, { recursive: true }); fs.appendFileSync(path.join(STATE, 'errors.log'), isoNow() + ' ' + mode + ' ' + (e && e.stack || e) + '\n'); } catch (x) { /* nothing more to do */ } };
const log = (id, ev, sid) => fs.appendFileSync(path.join(STATE, 'log-' + today() + '.jsonl'), JSON.stringify({ t: isoNow(), id, ev, sid: String(sid).slice(0, 8) }) + '\n');

function projects() { const p = readJson(path.join(EZRA, 'projects.json')); return Array.isArray(p) ? p : (p.projects || []); }
const statusFile = proj => path.join(ROOT, ...String(proj.folder).split(/[\\/]/), 'status.json');

// Which worker is this session? Ezra and ignored sessions are 'ezra'; an unknown session is null.
function whoIs(sid, cwd) {
  let map = {}; try { map = readJson(path.join(HOOKS, 'map.json')); } catch (e) { /* no map yet */ }
  if ((map.ignore || []).includes(sid)) return 'ezra';
  let learned = {}; try { learned = readJson(path.join(STATE, 'learned.json')); } catch (e) { /* none yet */ }
  return (map.bySession || {})[sid] || learned[sid] || (map.byCwd || {})[norm(cwd)] || null;
}

// An unknown session that wrote exactly one worker's status.json (and never Ezra's) is that worker from now on.
// Only a write counts: a Write or Edit of a status.json, or a shell command (or a script) that names one and writes.
function learn(sid, transcript) {
  if (!transcript || !fs.existsSync(transcript)) return null;
  const size = fs.statSync(transcript).size, want = Math.min(size, 3 * 1024 * 1024);
  const fd = fs.openSync(transcript, 'r'), buf = Buffer.alloc(want); fs.readSync(fd, buf, 0, want, size - want); fs.closeSync(fd);
  const projs = projects().map(p => ({ id: p.id, f: norm(p.folder) + '/status.json' })).sort((a, b) => b.f.length - a.f.length);
  const count = {};
  const WRITE_CMD = /writeFileSync|renameSync|copyFileSync|Set-Content|Out-File|Move-Item|Copy-Item/;
  for (const line of buf.toString('utf8').split('\n')) {
    if (line.indexOf('"tool_use"') < 0 || line.indexOf('status.json') < 0) continue;
    let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
    const blocks = msg && msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
    for (const b of blocks) {
      if (!b || b.type !== 'tool_use' || !b.input) continue;
      const i = b.input, fp = String(i.file_path || ''), body = String(i.command || i.content || i.new_string || '');
      let s = '';
      if (/^(Write|Edit|MultiEdit)$/.test(b.name) && /status\.json$/i.test(fp)) s = fp;
      else if (body.indexOf('status.json') >= 0 && WRITE_CMD.test(body)) s = body;
      if (!s) continue;
      let t = s.split(BS + BS).join('/').split(BS).join('/').toLowerCase();
      for (const p of projs) { if (t.includes(p.f)) { count[p.id] = (count[p.id] || 0) + 1; t = t.split(p.f).join(''); } }
    }
  }
  if (count.ezra) return null;
  const ids = Object.keys(count).sort((a, b) => count[b] - count[a]);
  if (!ids.length || (ids[1] && count[ids[0]] < 2 * count[ids[1]])) return null;
  const lf = path.join(STATE, 'learned.json'); let learned = {}; try { learned = readJson(lf); } catch (e) { /* new */ }
  learned[sid] = ids[0]; writeJson(lf, learned);
  return ids[0];
}

// The session's effort (low, medium, high, xhigh, max), for the coffee on its desk in the office: the last "effort" field in the
// end of its transcript, that is, the effort of its last reply. A new session, with no reply yet: nothing.
function lastEffort(transcript) {
  try {
    if (!transcript || !fs.existsSync(transcript)) return null;
    const size = fs.statSync(transcript).size, want = Math.min(size, 512 * 1024);
    const fd = fs.openSync(transcript, 'r'), buf = Buffer.alloc(want); fs.readSync(fd, buf, 0, want, size - want); fs.closeSync(fd);
    const m = [...buf.toString('utf8').matchAll(/"effort":"(low|medium|high|xhigh|max)"/g)];
    return m.length ? m[m.length - 1][1] : null;
  } catch (e) { return null; }
}

function main(input) {
  fs.mkdirSync(path.join(STATE, 'unknown'), { recursive: true });
  const sid = input.session_id || '', cwd = input.cwd || process.cwd();
  let id = whoIs(sid, cwd);
  if (id === 'ezra') return null; // Ezra (and any ignored session): not a worker, not unknown either
  if (mode === 'start') {
    if (!id) { // remember it, so Ezra can map it; say nothing to a session that is not a worker
      const u = path.join(STATE, 'unknown', sid + '.json');
      if (!fs.existsSync(u)) writeJson(u, { session: sid, cwd, transcript: input.transcript_path || '', first: isoNow() });
      return null;
    }
    const proj = projects().find(p => p.id === id); if (!proj) return null;
    const f = statusFile(proj), s = readJson(f), now = isoNow();
    s.status = 'עובד'; s.updatedAt = now;
    const ef = lastEffort(input.transcript_path); if (ef) s.effort = ef;
    writeJson(f, s);
    writeJson(path.join(STATE, 'turn-' + sid + '.json'), { id, start: now, mtime: fs.statSync(f).mtimeMs });
    writeJson(path.join(STATE, 'seen-' + id + '.json'), { session: sid, cwd, t: now });
    log(id, 'start', sid);
    // The skill's version: skill-version.json against "skill" in the card. An older skill, or none, and the worker is told to read
    // it again; otherwise only the number. So a worker catches up on its next turn.
    let sv = null; try { sv = readJson(path.join(EZRA, 'skill-version.json')); } catch (e) { /* no version file: nothing to say */ }
    const ver = sv && sv.version ? String(sv.version) : '';
    const older = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0; } return false; };
    const home = path.join(require('os').homedir(), '.claude', 'skills', 'ezra');
    const sdir = fs.existsSync(path.join(home, 'SKILL.md')) ? home : path.join(EZRA, 'skill-copy'); // a machine without the skill reads Ezra's copy
    const chl = fs.existsSync(path.join(sdir, 'CHANGELOG.md')) ? ' (מה השתנה מאז הגרסה שלך: CHANGELOG.md באותה תיקייה)' : '';
    const skillNote = !ver ? '' : (!s.skill || older(s.skill, ver))
      ? ` הסקיל עודכן: בכרטיס שלך ${s.skill ? 'כתוב ' + s.skill : 'אין גרסת סקיל'}, והגרסה האחרונה היא ${ver}. תקרא שוב את ${path.join(sdir, 'SKILL.md')}${chl}, ואז תכתוב בכרטיס "skill": "${ver}".`
      : ` סקיל ${ver}.`;
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext:
      `hook של עזרא: הכרטיס שלך (${id}) סומן "עובד" ב־${now.slice(11, 16)}. במהלך התור ובסופו, תכתוב בו בעצמך את now ואת המצב האמיתי (עובד / ${WAIT} / ממתין / הסתיים), עם updatedAt מהשעון. הכרטיס הוא הדיווח: הודעה לעזרא רק כשיש לו מה לעשות (בקשה לעובד אחר, קובץ משותף, תקלה, דבר דחוף, "מוכן לאתחול").${skillNote}` } };
  }
  if (mode === 'stop') {
    if (!id) { id = learn(sid, input.transcript_path); if (!id) return null; }
    const proj = projects().find(p => p.id === id); if (!proj) return null;
    const f = statusFile(proj), tf = path.join(STATE, 'turn-' + sid + '.json');
    let turn = null; try { turn = readJson(tf); } catch (e) { /* the turn started before the hook knew this session */ }
    const touched = !turn || fs.statSync(f).mtimeMs > turn.mtime + 1;
    if (!touched && !input.stop_hook_active) {
      return { decision: 'block', reason: `hook של עזרא: לא עדכנת את status.json שלך (${id}) בתור הזה. לפני שאתה מסיים: now במשפט, והמצב האמיתי (עובד / ${WAIT} עם waitingForGuy ופריט guy / ממתין / הסתיים), עם updatedAt מהשעון.` };
    }
    log(id, 'stop', sid);
    try { fs.unlinkSync(tf); } catch (e) { /* already gone */ }
    return null;
  }
  return null;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  try { const out = main(raw ? JSON.parse(raw) : {}); if (out) process.stdout.write(JSON.stringify(out)); }
  catch (e) { logErr(e); }
  process.exit(0);
});
