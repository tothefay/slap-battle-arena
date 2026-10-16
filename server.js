// Slap Battle Arena - เซิร์ฟเวอร์เป็นผู้ตัดสินการตบ/หลบ/คะแนนทั้งหมด
const express = require('express'), http = require('http'), { Server } = require('socket.io');
const app = express(), srv = http.createServer(app), io = new Server(srv);
app.use(express.static(__dirname + '/public'));
const rooms = new Map(), DUR = 90000, now = () => Date.now();
const clean = s => String(s || '').replace(/[<>&"']/g, '').trim().slice(0, 12) || 'ผู้เล่น';
const fresh = () => ({ score: 0, hits: 0, dodges: 0, combo: 0, maxCombo: 0, energy: 0, anim: 'idle', animUntil: 0, busy: 0, dodgeUntil: 0, guardUntil: 0, end: 'idle' });
const mk = (tok, sid, name, char) => ({ tok, sid, name: clean(name), char: (char | 0) & 7, online: true, ...fresh() });
const other = (r, p) => r.players.find(x => x !== p);
function view(r) {
  const t = now();
  return {
    code: r.code, phase: r.phase, count: r.count, owner: r.owner, winner: r.winner,
    left: r.phase === 'play' ? Math.max(0, Math.ceil((r.endAt - t) / 1000)) : DUR / 1000,
    players: r.players.map(p => ({
      tok: p.tok, name: p.name, char: p.char, online: p.online, score: p.score, hits: p.hits, dodges: p.dodges,
      combo: p.combo, maxCombo: p.maxCombo, energy: p.energy,
      anim: t < p.animUntil ? p.anim : (r.phase === 'over' ? p.end : 'idle')
    }))
  };
}
const push = r => io.to(r.code).emit('state', view(r));
const fx = (r, type, tok, o) => io.to(r.code).emit('fx', { type, tok, ...o });
const setAnim = (p, a, ms) => { p.anim = a; p.animUntil = now() + ms; };
function newCode() { let c; do c = String(100000 + Math.floor(Math.random() * 900000)); while (rooms.has(c)); return c; }

function startGame(r) {
  r.players.forEach(p => Object.assign(p, fresh()));
  r.winner = null; r.phase = 'count'; r.count = 3; push(r);
  const step = () => {
    if (r.phase !== 'count') return;
    r.count--;
    if (r.count > 0) { push(r); r.ct = setTimeout(step, 1000); }
    else { r.phase = 'play'; r.endAt = now() + DUR; push(r); }
  };
  r.ct = setTimeout(step, 1000);
}
function finish(r) {
  r.phase = 'over';
  const [a, b] = r.players;
  r.winner = a.score === b.score ? 'draw' : (a.score > b.score ? a.tok : b.tok);
  r.players.forEach(p => { p.end = r.winner === 'draw' ? 'idle' : (r.winner === p.tok ? 'win' : 'lose'); p.animUntil = 0; });
  push(r);
}
function resolve(r, p, o, type) {
  if (r.phase !== 'play' || !o) return;
  const t = now();
  if (o.dodgeUntil > t) {                       // หลบทัน
    o.dodges++; o.score += 5; p.combo = 0; p.busy += 500;
    fx(r, 'dodge', o.tok); return push(r);
  }
  if (type === 'slap' && o.guardUntil > t && Math.random() < 0.6) { // ป้องกันสำเร็จ 60%
    p.combo = 0; fx(r, 'block', o.tok); return push(r);
  }
  p.hits++; p.combo++; p.maxCombo = Math.max(p.maxCombo, p.combo);
  p.score += type === 'special' ? 20 : 10;
  if (type === 'slap') p.energy = Math.min(100, p.energy + 20);
  setAnim(o, 'hit', 450);
  fx(r, type === 'special' ? 'special' : 'hit', o.tok, { combo: p.combo, by: p.tok });
  push(r);
}
function act(r, p, type) {
  const t = now();
  if (r.phase !== 'play' || t < p.busy) return;  // คูลดาวน์ตรวจที่เซิร์ฟเวอร์
  const o = other(r, p);
  if (type === 'dodge') { p.dodgeUntil = t + 400; p.busy = t + 900; setAnim(p, 'dodge', 400); }
  else if (type === 'guard') { p.guardUntil = t + 700; p.busy = t + 1000; setAnim(p, 'guard', 700); }
  else if (type === 'slap' || type === 'special') {
    if (type === 'special') { if (p.energy < 100) return; p.energy = 0; }
    p.busy = t + (type === 'slap' ? 650 : 1100);
    setAnim(p, type, type === 'slap' ? 350 : 600);
    setTimeout(() => resolve(r, p, o, type), 180);
  } else return;
  push(r);
}
function remove(r, tok) {
  r.players = r.players.filter(p => p.tok !== tok);
  clearTimeout(r.gt); clearTimeout(r.ct);
  if (!r.players.length) return rooms.delete(r.code);
  r.owner = r.players[0].tok; r.phase = 'lobby'; r.winner = null;
  r.players.forEach(p => Object.assign(p, fresh()));
  io.to(r.code).emit('peerLeft'); push(r);
}
function addPlayer(s, r, d) {
  const p = mk(d.tok, s.id, d.name, d.char);
  r.players.push(p); s.join(r.code); s.data = { code: r.code, tok: p.tok }; push(r);
}
function leave(s) {
  const r = rooms.get(s.data && s.data.code);
  if (!r) return;
  s.leave(r.code); remove(r, s.data.tok); s.data = {};
}
function create(s, d, pubRoom) {
  leave(s);
  const r = { code: newCode(), players: [], phase: 'lobby', count: 0, owner: d.tok, public: pubRoom, winner: null };
  rooms.set(r.code, r); addPlayer(s, r, d);
}
function join(s, d, r) {
  if (r.players.length >= 2 || r.players.some(p => p.tok === d.tok)) return s.emit('err', 'ห้องเต็มแล้ว');
  leave(s); addPlayer(s, r, d);
}
io.on('connection', s => {
  s.data = {};
  const R = () => rooms.get(s.data.code), P = r => r && r.players.find(p => p.tok === s.data.tok);
  s.on('create', d => d && d.tok && create(s, d, false));
  s.on('quick', d => {
    if (!d || !d.tok) return;
    const r = [...rooms.values()].find(x => x.public && x.players.length === 1 && x.phase === 'lobby' && x.players[0].tok !== d.tok);
    r ? join(s, d, r) : create(s, d, true);
  });
  s.on('join', d => {
    if (!d || !d.tok) return;
    const code = String(d.code || '').trim();
    if (!/^\d{6}$/.test(code)) return s.emit('err', 'รหัสห้องต้องเป็นตัวเลข 6 หลัก');
    const r = rooms.get(code);
    if (!r) return s.emit('err', 'ไม่พบห้องนี้ ตรวจสอบรหัสอีกครั้ง');
    join(s, d, r);
  });
  s.on('resume', d => {
    const r = d && rooms.get(d.code), p = r && r.players.find(x => x.tok === d.tok);
    if (!p) return s.emit('gone');
    clearTimeout(r.gt); p.online = true; p.sid = s.id; s.join(r.code); s.data = { code: r.code, tok: p.tok }; push(r);
  });
  s.on('setChar', c => { const r = R(), p = P(r); if (p && r.phase === 'lobby') { p.char = (c | 0) & 7; push(r); } });
  s.on('start', () => {
    const r = R(), p = P(r);
    if (r && p && r.owner === p.tok && r.players.length === 2 && r.players.every(x => x.online) && (r.phase === 'lobby' || r.phase === 'over')) startGame(r);
  });
  s.on('act', type => { const r = R(), p = P(r); if (p) act(r, p, type); });
  s.on('leave', () => leave(s));
  s.on('disconnect', () => {
    const r = R(), p = P(r);
    if (!p) return;
    if (r.phase === 'lobby') return remove(r, p.tok);
    p.online = false; push(r);
    r.gt = setTimeout(() => remove(r, p.tok), 10000); // รอเชื่อมต่อใหม่ 10 วินาที
  });
});
setInterval(() => { for (const r of rooms.values()) if (r.phase === 'play') now() >= r.endAt ? finish(r) : push(r); }, 100);
srv.listen(process.env.PORT || 3000, () => console.log('Slap Battle Arena พร้อมแล้ว'));
