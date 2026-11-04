require('dotenv').config({ path: __dirname + '/.env' });
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const fs = require('fs');

// ---- EDIT IF NEEDED ----
const BROWSER_PATH = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const PORT = 7000;
const TZ = 'Asia/Kolkata';
// ------------------------

const DB = './data.json';
const db = Object.assign(
  { contacts: [], schedules: [], rules: [], skip: [], commands: [], settings: { delayMaxSec: 300 } },
  fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB)) : {}
);
const save = () => fs.writeFileSync(DB, JSON.stringify(db, null, 2));
const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const digits = s => String(s || '').replace(/\D/g, '');
const fullNumber = s => { const d = digits(s); return d.length === 10 ? '91' + d : d; };

const logs = [];
const log = (m, ok = true) => {
  logs.unshift({ t: new Date().toLocaleString('en-IN', { timeZone: TZ }), m, ok });
  if (logs.length > 100) logs.length = 100;
  console.log(m);
};

// ---- AUTO RESTART ON BROWSER ERRORS ----
let restarting = false;
const FATAL = /detached Frame|Target closed|Session closed|Execution context was destroyed|Protocol error/i;

function handleBrowserError(e) {
  const msg = e?.message || String(e || '');
  if (!FATAL.test(msg) || restarting) return;
  restarting = true;
  status = 'restarting';
  log('Browser error detected, restarting: ' + msg, false);
  setTimeout(() => process.exit(1), 1000);
}

process.on('unhandledRejection', handleBrowserError);
process.on('uncaughtException', e => { handleBrowserError(e); if (!restarting) { console.error(e); process.exit(1); } });

// ---- WhatsApp ----
let status = 'starting';
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { executablePath: BROWSER_PATH, args: ['--no-sandbox'] },
});
client.on('qr', qr => { status = 'scan QR in terminal'; qrcode.generate(qr, { small: true }); });
client.on('ready', () => { status = 'ready'; log('WhatsApp connected'); });
client.on('disconnected', r => {
  status = 'disconnected';
  log('Disconnected: ' + r, false);
  handleBrowserError({ message: 'Protocol error: disconnected ' + r });
});
client.on('auth_failure', m => { status = 'auth failed'; log('Auth failure: ' + m, false); });
async function resolveChatId(number) {
  const full = fullNumber(number);
  const me = client.info?.wid;
  if (me && digits(me.user).slice(-10) === full.slice(-10)) return me._serialized;
  const wid = await client.getNumberId(full);
  return wid ? wid._serialized : null;
}
async function sendTo(contact, text, { force = false, label = '' } = {}) {
  try {
    if (status !== 'ready') throw new Error('WhatsApp not connected');
    if (!force && db.skip.includes(today())) { log(`SKIPPED (today is paused) → ${contact.name}: ${text}`); return false; }
    await sleep(Math.random() * db.settings.delayMaxSec * 1000);
        const chatId = await resolveChatId(contact.number);
    if (!chatId) throw new Error('Number is not on WhatsApp');
    try {
      await client.sendMessage(chatId, text);
    } catch (e) {
      const lid = client.info?.lid?._serialized;
      if (lid && chatId === client.info?.wid?._serialized) await client.sendMessage(lid, text);
      else throw e;
    }
    log(`SENT ${label}→ ${contact.name}: ${text}`);
    return true;
  } catch (e) {
    log(`FAILED → ${contact.name}: ${e.message}`, false);
    handleBrowserError(e);
    return false;
  }
}

// ---- Scheduler ----
const jobs = new Map();
function register(s) {
  if (jobs.has(s.id)) { jobs.get(s.id).stop(); jobs.delete(s.id); }
  if (!s.enabled) return;
  const [h, m] = s.time.split(':').map(Number);
  const days = s.days.length ? s.days.join(',') : '*';
  const task = cron.schedule(`${m} ${h} * * ${days}`, () => {
    const c = db.contacts.find(x => x.id === s.contactId);
    if (c) sendTo(c, s.text, { label: '(scheduled) ' });
  }, { timezone: TZ });
  jobs.set(s.id, task);
}
db.schedules.forEach(register);

// ---- Auto-replies ----
client.on('message', async msg => {
  try {
    log(`INCOMING type=${msg.type} from=${msg.from} body="${msg.body}"`);
    if (msg.type !== 'chat' || msg.fromMe || msg.from.endsWith('@g.us')) return;

    let phone = '';
    if (msg.from.endsWith('@lid')) {
      try {
        const r = await client.getContactLidAndPhone([msg.from]);
        phone = digits(r?.[0]?.pn);
      } catch (e) { log('LID lookup failed: ' + e.message, false); }
    }
    if (!phone) {
      const ct = await msg.getContact();
      phone = digits(ct.number || ct.id?.user);
    }
    if (!phone) phone = digits(msg.from);

    const num = phone.slice(-10);
    const c = db.contacts.find(x => digits(x.number).slice(-10) === num);
    if (!c) return log(`NO CONTACT MATCH for ${phone} (from=${msg.from})`, false);

    const text = msg.body.trim();
    for (const r of db.rules) {
      if (r.contactId !== 'all' && r.contactId !== c.id) continue;
      let hit = false;
      try { hit = new RegExp(r.words, 'i').test(text); } catch { continue; }
      if (!hit) continue;
      await sleep(2000 + Math.random() * 3000);
      await msg.reply(r.reply);
      log(`AUTO-REPLY → ${c.name}: "${text}" → "${r.reply}"`);
      return;
    }
    log(`NO RULE MATCHED for ${c.name}: "${text}"`, false);
  } catch (e) {
    log('Auto-reply error: ' + e.message, false);
    handleBrowserError(e);
  }
});

// ---- CUSTOM COMMANDS (send from your "Message yourself" chat; configured in dashboard) ----
async function isSelfChat(msg) {
  const me = client.info?.wid;
  const myLid = client.info?.lid?._serialized;
  if (msg.to === me?._serialized || (myLid && msg.to === myLid)) return true;
  if (msg.from !== me?._serialized) return false;
  try {
    const ct = await client.getContactById(msg.to);
    if (ct?.isMe) return true;
  } catch {}
  try {
    const r = await client.getContactLidAndPhone([msg.to]);
    if (digits(r?.[0]?.pn) === digits(me?.user)) return true;
  } catch {}
  return false;
}
client.on('message_create', async msg => {
  try {
    if (!msg.fromMe) return;
    const body = (msg.body || '').trim();
    if (!body.startsWith('/')) return;

        const isSelf = await isSelfChat(msg);
    log(`CMD-CHECK body="${body}" from=${msg.from} to=${msg.to} self=${isSelf}`, isSelf);
    if (!isSelf) return;

    const word = body.split(/\s+/)[0].toLowerCase();

    if (word === '/cmds') {
      const list = db.commands.map(c => {
        const t = db.contacts.find(x => x.id === c.contactId);
        return `• ${c.cmd} → ${t ? t.name : '(deleted contact)'}`;
      }).join('\n') || 'No commands configured.';
      return void (await client.sendMessage(msg.to, list));
    }

    const c = db.commands.find(x => x.cmd.toLowerCase() === word);
    if (!c) return log(`NO COMMAND "${word}" configured`, false);

    const target = db.contacts.find(x => x.id === c.contactId);
    if (!target) {
      log(`COMMAND ${c.cmd}: contact missing`, false);
      return void (await client.sendMessage(msg.to, `✖ ${c.cmd}: contact not found. Fix it in the dashboard.`));
    }

    const time = new Date().toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
    const text = c.text.replace(/\{time\}/g, time);

    log(`COMMAND ${c.cmd} → ${target.name} (waiting for send delay)`);
    const ok = await sendTo(target, text, { force: true, label: `(${c.cmd}) ` });
    await client.sendMessage(msg.to, ok ? `✔ ${c.cmd} sent to ${target.name}` : `✖ ${c.cmd} failed, check dashboard log`);
  } catch (e) {
    log('Command error: ' + e.message, false);
    handleBrowserError(e);
  }
});

// ---- API ----
const app = express();

const PASSWORD = process.env.WA_PASSWORD;
if (!PASSWORD) { console.error('Set WA_PASSWORD in .env'); process.exit(1); }
app.use((req, res, next) => {
  const h = req.headers.authorization || '';
  const [, p] = Buffer.from(h.split(' ')[1] || '', 'base64').toString().split(':');
  if (p === PASSWORD) return next();
  res.set('WWW-Authenticate', 'Basic realm="wa-bot"').status(401).send('Password required');
});

app.use(express.json());
app.use(express.static('public'));

app.get('/api/state', (req, res) => res.json({
  status, logs, contacts: db.contacts, schedules: db.schedules, rules: db.rules,
  commands: db.commands, settings: db.settings, pausedToday: db.skip.includes(today()),
}));

app.post('/api/contacts', (req, res) => {
  const { name, number } = req.body;
  if (!name || digits(number).length < 10) return res.status(400).json({ error: 'Name and a 10-digit number are required' });
  db.contacts.push({ id: uid(), name: name.trim(), number: fullNumber(number) });
  save(); res.json({ ok: true });
});
app.delete('/api/contacts/:id', (req, res) => {
  db.schedules.filter(s => s.contactId === req.params.id).forEach(s => { jobs.get(s.id)?.stop(); jobs.delete(s.id); });
  db.contacts = db.contacts.filter(c => c.id !== req.params.id);
  db.schedules = db.schedules.filter(s => s.contactId !== req.params.id);
  db.rules = db.rules.filter(r => r.contactId !== req.params.id);
  db.commands = db.commands.filter(c => c.contactId !== req.params.id);
  save(); res.json({ ok: true });
});

app.post('/api/schedules', (req, res) => {
  const { contactId, time, days, text } = req.body;
  if (!db.contacts.find(c => c.id === contactId) || !/^\d{2}:\d{2}$/.test(time) || !text)
    return res.status(400).json({ error: 'Pick a contact, a time, and write a message' });
  const s = { id: uid(), contactId, time, days: days || [], text, enabled: true };
  db.schedules.push(s); register(s); save(); res.json({ ok: true });
});
app.put('/api/schedules/:id', (req, res) => {
  const s = db.schedules.find(x => x.id === req.params.id);
  if (!s) return res.sendStatus(404);
  s.enabled = !!req.body.enabled; register(s); save(); res.json({ ok: true });
});
app.delete('/api/schedules/:id', (req, res) => {
  jobs.get(req.params.id)?.stop(); jobs.delete(req.params.id);
  db.schedules = db.schedules.filter(s => s.id !== req.params.id);
  save(); res.json({ ok: true });
});

app.post('/api/rules', (req, res) => {
  const { contactId, words, reply } = req.body;
  if (!words || !reply) return res.status(400).json({ error: 'Words and a reply are required' });
  try { new RegExp(words, 'i'); } catch { return res.status(400).json({ error: 'Those words are not a valid pattern' }); }
  db.rules.push({ id: uid(), contactId: contactId || 'all', words, reply });
  save(); res.json({ ok: true });
});

app.delete('/api/rules/:id', (req, res) => {
  db.rules = db.rules.filter(r => r.id !== req.params.id);
  save(); res.json({ ok: true });
});

app.post('/api/commands', (req, res) => {
  let { cmd, contactId, text } = req.body;
  cmd = String(cmd || '').trim().toLowerCase();
  if (cmd && !cmd.startsWith('/')) cmd = '/' + cmd;
  if (!/^\/[a-z0-9_]+$/.test(cmd)) return res.status(400).json({ error: 'Command must look like /login (letters, numbers, _)' });
  if (cmd === '/cmds') return res.status(400).json({ error: '/cmds is reserved' });
  if (!db.contacts.find(c => c.id === contactId)) return res.status(400).json({ error: 'Pick a contact' });
  if (!text) return res.status(400).json({ error: 'Message is required' });
  if (db.commands.find(c => c.cmd === cmd)) return res.status(400).json({ error: cmd + ' already exists' });
  db.commands.push({ id: uid(), cmd, contactId, text });
  save(); res.json({ ok: true });
});
app.delete('/api/commands/:id', (req, res) => {
  db.commands = db.commands.filter(c => c.id !== req.params.id);
  save(); res.json({ ok: true });
});

app.post('/api/send-now', async (req, res) => {
  const c = db.contacts.find(x => x.id === req.body.contactId);
  if (!c || !req.body.text) return res.status(400).json({ error: 'Pick a contact and write a message' });
  res.json({ ok: true });
  sendTo(c, req.body.text, { force: true, label: '(manual) ' });
});

app.post('/api/pause-today', (req, res) => {
  db.skip = db.skip.filter(d => d !== today());
  if (req.body.on) db.skip.push(today());
  save(); res.json({ ok: true });
});
app.post('/api/settings', (req, res) => {
  db.settings.delayMaxSec = Math.max(0, Math.min(900, Number(req.body.delayMaxSec) || 0));
  save(); res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => console.log(`UI: http://localhost:${PORT}`));
client.initialize();