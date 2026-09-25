/**
 * The live view, served as one self-contained document. It is read-only and has no dependencies: it follows the same
 * JSON the extension does, and every number it shows came from the battle's public lines or a decision already logged.
 * Sprites come from Showdown's image server, and nothing about our team is sent there. Showdown refuses to run its
 * client inside another page, so watching the real battle opens it in its own tab; the arena here animates from the
 * battle's own lines instead.
 */
export const PANEL_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>jevmon live</title><style>
:root{--bg:#0e1013;--panel:#161a20;--panel2:#1c222a;--line:#252c36;--text:#e6e9ee;--dim:#8b94a3;--accent:#7c6cf0;--good:#3fb950;--bad:#f0616d;--warn:#e3b341;--blue:#4b9fff;--us:#4b9fff;--them:#f08a4b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5;flex-wrap:wrap}
.brand{font-weight:700;letter-spacing:.3px;margin-right:4px}
.pill{border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:11px;color:var(--dim);white-space:nowrap}
.pill.on{color:var(--good);border-color:#1e4429}.pill.off{color:var(--bad);border-color:#4a2026}
.pill b{color:var(--text);font-weight:600}
.wrap{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:12px;padding:12px;align-items:start}
@media(max-width:900px){.wrap{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:12px;overflow:hidden}
.card>h2{margin:0;padding:9px 12px;font-size:11px;letter-spacing:.9px;text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:8px}
.card>div{padding:12px}
.empty{color:var(--dim);padding:22px 12px;text-align:center}
button{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:3px 10px;font:inherit;font-size:11px;cursor:pointer}
button:hover{border-color:var(--accent)}
/* result banner */
.outcome{margin:12px 12px 0;border-radius:10px;padding:12px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;border:1px solid var(--line)}
.outcome.win{background:linear-gradient(90deg,#123a1d,#161a20);border-color:#1e4429}
.outcome.loss{background:linear-gradient(90deg,#3a1418,#161a20);border-color:#4a2026}
.outcome.tie{background:var(--panel2)}
.outcome .big{font-size:22px;font-weight:800;letter-spacing:.5px}
.outcome.win .big{color:var(--good)}.outcome.loss .big{color:var(--bad)}
.outcome .detail{color:var(--dim)}.outcome .detail b{color:var(--text)}
/* arena */
.arena{padding:0!important}
.fieldbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);background:#12161b}
.side{padding:12px;display:grid;grid-template-columns:132px minmax(0,1fr);gap:12px;align-items:center}
.side.them{border-bottom:1px dashed var(--line)}
.sprite{width:120px;height:120px;object-fit:contain;image-rendering:pixelated;justify-self:center}
.sprite.gone{opacity:.25;filter:grayscale(1)}
.whohead{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--dim);margin-bottom:4px;flex-wrap:wrap}
.whohead b{font-size:12px}
.them .whohead b{color:var(--them)}.us .whohead b{color:var(--us)}
.nm{font-size:17px;font-weight:700;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.hpwrap{display:flex;align-items:center;gap:8px;margin:5px 0}
.hpbar{flex:1;height:9px;border-radius:5px;background:#222833;overflow:hidden}
.hpbar>i{display:block;height:100%;transition:width .5s ease}
.hpn{font-variant-numeric:tabular-nums;min-width:48px;text-align:right;font-weight:600}
.chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px}
.chip{font-size:11px;border-radius:5px;padding:1px 7px;background:var(--panel2);color:var(--dim);border:1px solid var(--line);white-space:nowrap}
.chip.up{color:#8ff0a4;border-color:#1e4429;background:#12261a}.chip.down{color:#ff9aa4;border-color:#4a2026;background:#2a1417}
.chip.setup{color:#1b1400;background:var(--warn);border-color:var(--warn);font-weight:700}
.chip.tera{color:#e9d5ff;background:#34214d;border-color:#553a7a}
.chip.fx{color:#b6c6ff;border-color:#2c3550}.chip.haz{color:#ffd28a;border-color:#4a3a1e}
.st{font-size:10px;text-transform:uppercase;border-radius:4px;padding:1px 5px;font-weight:700}
.st.brn{background:#5a2a1e;color:#ffb199}.st.par{background:#5a4f1e;color:#ffe9a1}.st.psn,.st.tox{background:#4a2352;color:#e6b3ff}
.st.slp{background:#2c3550;color:#b6c6ff}.st.frz{background:#1e4a55;color:#a9e9f5}
.sub{font-size:11px;color:var(--dim);margin-top:4px}
.pips{display:flex;gap:4px;margin-top:8px;flex-wrap:wrap}
.pip{width:40px;text-align:center}
.pip img{width:40px;height:40px;object-fit:contain;image-rendering:pixelated;display:block}
.pip .ph{height:3px;border-radius:2px;background:#222833;overflow:hidden}.pip .ph>i{display:block;height:100%}
.pip.ko img{opacity:.25;filter:grayscale(1)}.pip.act{outline:1px solid var(--line);border-radius:6px}
.pip.unk{opacity:.35}
/* ticker and animation */
.ticker{min-height:30px;padding:6px 12px;border-bottom:1px solid var(--line);font-weight:600;display:flex;gap:10px;align-items:center;background:#141920}
.ticker .now{animation:tick .35s ease}
.ticker .who{font-size:10px;text-transform:uppercase;letter-spacing:.5px}.ticker .who.us{color:var(--us)}.ticker .who.them{color:var(--them)}
@keyframes tick{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.sprite.hit{animation:hit .5s ease}.sprite.heal{animation:heal .7s ease}.sprite.boost{animation:boost .6s ease}.sprite.drop{animation:drop .6s ease}
@keyframes hit{0%,100%{transform:none;filter:none}20%{transform:translateX(-8px);filter:drop-shadow(0 0 8px #f0616d) brightness(1.6)}40%{transform:translateX(7px)}60%{transform:translateX(-5px)}80%{transform:translateX(3px)}}
@keyframes heal{0%,100%{filter:none}50%{filter:drop-shadow(0 0 12px #3fb950) brightness(1.25)}}
@keyframes boost{0%,100%{transform:none;filter:none}40%{transform:translateY(-10px);filter:drop-shadow(0 0 10px #e3b341)}}
@keyframes drop{0%,100%{transform:none;filter:none}40%{transform:translateY(6px);filter:drop-shadow(0 0 10px #4b9fff) saturate(.4)}}
.sprite.gone{transition:opacity .8s ease,filter .8s ease}
.watchbody{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.watchbody .go{background:var(--accent);color:#fff;border:0;border-radius:7px;padding:7px 14px;font-weight:700}
.watchbody .go:hover{text-decoration:none;filter:brightness(1.1)}
.note{font-size:11px;color:var(--dim)}
/* play-by-play */
.feed{max-height:520px;overflow:auto;padding:0!important}
.turn{border-bottom:1px solid #1d232b}
.turn>h3{margin:0;padding:6px 12px;font-size:11px;color:var(--dim);background:#12161b;position:sticky;top:0;letter-spacing:.6px;text-transform:uppercase}
.ev{display:grid;grid-template-columns:44px minmax(0,1fr);gap:8px;padding:3px 12px;font-size:12px;align-items:baseline}
.ev .w{font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--dim)}
.ev .w.us{color:var(--us)}.ev .w.them{color:var(--them)}
.ev.move .x{color:var(--text);font-weight:600}.ev.damage .x{color:#ffb0b6}.ev.heal .x{color:#8ff0a4}
.ev.boost .x{color:#8ff0a4}.ev.drop .x{color:#ff9aa4}.ev.status .x{color:#e6b3ff}.ev.faint .x{color:var(--bad);font-weight:700}
.ev.switch .x{color:#9ec5ff}.ev.field .x{color:#ffd28a}.ev.tera .x{color:#e9d5ff;font-weight:600}.ev.miss .x{color:var(--dim)}
.ev.result .x{color:var(--warn);font-weight:700}.ev.info .x{color:#c3c9d3}
.eot{padding:3px 12px 2px;font-size:10px;letter-spacing:.6px;text-transform:uppercase;color:#6d7686;border-top:1px dotted #252c36;margin-top:3px}
/* decisions (as before) */
.choice{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.choice .name{font-size:20px;font-weight:700}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
.tag{font-size:11px;border-radius:5px;padding:2px 7px;background:var(--panel2);color:var(--dim);border:1px solid var(--line)}
.tag b{color:var(--text);font-weight:600}
.row{display:grid;grid-template-columns:minmax(0,1fr) 46px;gap:10px;align-items:center;padding:5px 0}
.row .txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .pct{text-align:right;color:var(--dim);font-variant-numeric:tabular-nums}
.bar{height:7px;border-radius:4px;background:#222833;overflow:hidden;margin-top:4px}
.bar>i{display:block;height:100%;background:var(--accent)}
.row.sel .txt{color:#fff;font-weight:700}.row.sel .bar>i{background:var(--good)}
.row.cut .txt{color:var(--dim);text-decoration:line-through}.row.cut .bar>i{background:var(--bad)}
.meta{font-size:11px;color:var(--dim);display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.meta .ko{color:var(--warn)}.meta .first{color:var(--good)}.meta .second{color:var(--bad)}.meta .nil{color:var(--bad)}
.banner{border-left:3px solid var(--warn);background:#221d10;padding:8px 10px;border-radius:0 6px 6px 0;margin-bottom:10px;font-size:12px}
.banner b{color:var(--warn)}
.hist{max-height:300px;overflow:auto;padding:0!important}
.h{display:grid;grid-template-columns:38px 14px minmax(0,1fr);gap:8px;padding:6px 12px;border-bottom:1px solid #1d232b;font-size:12px;cursor:pointer}
.h:hover{background:var(--panel2)}.h.on{background:#1f2530}
.h .t{color:var(--dim);font-variant-numeric:tabular-nums}
.h .m{color:var(--good)}.h.g .m{color:var(--warn)}.h.f .m{color:var(--bad)}
.kv{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:12px}
.kv span:first-child{color:var(--dim)}
.res{display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:8px;padding:5px 12px;border-bottom:1px solid #1d232b;font-size:12px;align-items:center}
.res .o{font-weight:800;text-align:center;border-radius:4px;padding:1px 0}
.res .o.win{color:#0e1013;background:var(--good)}.res .o.loss{color:#0e1013;background:var(--bad)}.res .o.tie{background:var(--panel2)}
.res .r{color:var(--dim);font-variant-numeric:tabular-nums}
</style></head><body>
<header>
  <span class="brand">jevmon</span>
  <span class="pill" id="conn">connecting</span>
  <span class="pill" id="room">no battle</span>
  <span class="pill" id="turn">turn -</span>
  <span class="pill" id="record">record 0–0</span>
  <span class="pill" id="rating"></span>
  <span class="pill" id="ver"></span>
</header>
<div id="resultbar"></div>
<div class="wrap">
  <div>
    <div class="card"><h2><span>Battle</span><span id="arenahead"></span></h2><div class="ticker" id="ticker"><span class="note">Waiting for the first move.</span></div><div class="arena" id="arena"><div class="empty">Waiting for a battle.</div></div></div>
    <div class="card"><h2>Watch live</h2><div class="watchbody"><a class="go" id="watchlink" target="_blank" rel="noopener noreferrer" hidden>Watch on Showdown ↗</a>
      <span class="note" id="watchnote">The battle opens here once one starts.</span></div></div>
    <div class="card"><h2><span>Play-by-play</span><span id="feedhead"></span></h2><div class="feed" id="feed"><div class="empty">Nothing yet.</div></div></div>
  </div>
  <div>
    <div class="card"><h2><span>Jev's choice</span><span id="chead"></span></h2><div id="choice"><div class="empty">Waiting for the first decision.</div></div></div>
    <div class="card"><h2>Options it ranked</h2><div id="ranked"><div class="empty">-</div></div></div>
    <div class="card"><h2>Decisions</h2><div class="hist" id="hist"><div class="empty">-</div></div></div>
    <div class="card"><h2><span>Recorded battles</span><span id="sesshead"></span></h2><div id="session" style="padding:0"><div class="empty">No finished battles yet.</div></div></div>
  </div>
</div>
<script>
const $ = id => document.getElementById(id);
// Sections are redrawn only when their markup changes, so animated sprites do not restart on every update.
const drawn = {};
function put(id, html) { if (drawn[id] === html) return false; drawn[id] = html; $(id).innerHTML = html; return true; }
const SPRITES = 'https://play.pokemonshowdown.com/sprites/';
let decisions = [], feed = [], arena = null, result = null, results = [], picked = null, live = null;
const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct = v => v === null || v === undefined ? '-' : (Math.round(v * 100) + '%');
const hpColor = h => h > 50 ? '#3fb950' : h > 20 ? '#e3b341' : '#f0616d';
const STAT = { atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe', accuracy: 'Acc', evasion: 'Eva' };
const safeSprite = s => /^[a-z0-9-]{1,40}$/.test(s || '') ? s : 'substitute';
const safeRoom = r => /^battle-[a-z0-9-]{1,120}$/.test(r || '') ? r : null;
function spriteImg(sprite, back, cls) {
  const s = safeSprite(sprite);
  const first = SPRITES + (back ? 'ani-back/' : 'ani/') + s + '.gif', second = SPRITES + (back ? 'gen5-back/' : 'gen5/') + s + '.png';
  return '<img class="' + cls + '" alt="" referrerpolicy="no-referrer" src="' + first + '" data-fallback="' + second + '">';
}
// A missing animated sprite falls back to the static one, once.
document.addEventListener('error', e => {
  const img = e.target;
  if (img && img.tagName === 'IMG' && img.dataset.fallback) { const f = img.dataset.fallback; delete img.dataset.fallback; img.src = f; }
}, true);

/* ---------- arena ---------- */
function sideView(s, isUs) {
  if (!s) return '';
  const a = s.active;
  const left = s.teamSize ? Math.max(0, s.teamSize - s.team.filter(p => p.fainted).length) : null;
  const head = '<div class="whohead"><span><b>' + esc(s.name || (isUs ? 'Us' : 'Them')) + '</b>' + (s.rating ? ' · ' + esc(s.rating) : '') +
    '</span><span>' + (left !== null ? left + ' of ' + s.teamSize + ' left' : '') + '</span></div>';
  const hazards = Object.entries(s.hazards || {}).map(([k, v]) => '<span class="chip haz">' + esc(k) + (v > 1 ? ' ×' + v : '') + '</span>');
  const conds = (s.conditions || []).filter(c => !(k => k in (s.hazards || {}))(c)).map(c => '<span class="chip fx">' + esc(c) + '</span>');
  let mon = '<div class="empty" style="padding:8px 0">No Pokémon on the field.</div>';
  if (a) {
    const boosts = Object.entries(a.boosts || {}).map(([k, v]) => '<span class="chip ' + (v > 0 ? 'up' : 'down') + '">' + (STAT[k] || esc(k)) + ' ' + (v > 0 ? '+' : '') + v + '</span>');
    const settingUp = settingUpNow(s.side) ? '<span class="chip setup">setting up</span>' : '';
    const effects = (a.effects || []).map(x => '<span class="chip fx">' + esc(x) + '</span>');
    mon = '<div class="nm">' + esc(a.species) + (a.status ? '<span class="st ' + esc(a.status) + '">' + esc(a.status) + '</span>' : '') +
      (a.tera ? '<span class="chip tera">Tera ' + esc(a.tera) + '</span>' : '') + '</div>' +
      '<div class="hpwrap"><div class="hpbar"><i style="width:' + (a.fainted ? 0 : a.hp) + '%;background:' + hpColor(a.hp) + '"></i></div><div class="hpn">' + (a.fainted ? 'fnt' : a.hp + '%') + '</div></div>' +
      '<div class="chips">' + settingUp + boosts.join('') + effects.join('') + '</div>' +
      ((a.item || a.ability) ? '<div class="sub">' + [a.item, a.ability].filter(Boolean).map(esc).join(' · ') + '</div>' : '');
  }
  const known = s.team.map(p => '<div class="pip' + (p.fainted ? ' ko' : '') + (p.active ? ' act' : '') + '" title="' + esc(p.species + ' ' + (p.fainted ? 'fainted' : p.hp + '%') + (p.status ? ' ' + p.status : '')) + '">' +
    '<img alt="" referrerpolicy="no-referrer" src="' + SPRITES + 'gen5/' + safeSprite(p.sprite) + '.png"><div class="ph"><i style="width:' + (p.fainted ? 0 : p.hp) + '%;background:' + hpColor(p.hp) + '"></i></div></div>');
  const unseen = s.teamSize && s.teamSize > s.team.length ? Array(s.teamSize - s.team.length).fill('<div class="pip unk" title="not yet seen"><img alt="" src="' + SPRITES + 'gen5/substitute.png"></div>') : [];
  return '<div class="side ' + (isUs ? 'us' : 'them') + '">' +
    (a ? spriteImg(a.sprite, isUs, 'sprite' + (a.fainted ? ' gone' : '')) : '<div></div>') +
    '<div style="min-width:0">' + head + mon + (hazards.length || conds.length ? '<div class="chips" style="margin-top:6px">' + hazards.join('') + conds.join('') + '</div>' : '') +
    '<div class="pips">' + known.join('') + unseen.join('') + '</div></div></div>';
}
function settingUpNow(side) {
  if (!arena) return false;
  return feed.some(e => e.setup && e.side === side && e.turn >= arena.turn - 1);
}
function renderArena() {
  if (!arena) { put('arena', '<div class="empty">Waiting for a battle.</div>'); $('arenahead').textContent = ''; return; }
  const f = arena.field || {};
  const field = [f.weather ? f.weather.replace(/([a-z])([A-Z])/g, '$1 $2') : null, f.terrain, f.trickRoom ? 'Trick Room' : null].filter(Boolean);
  $('arenahead').textContent = 'turn ' + arena.turn + (arena.ended ? ' · finished' : '');
  put('arena', '<div class="fieldbar"><span class="chip">turn ' + esc(arena.turn) + '</span>' +
    (field.length ? field.map(x => '<span class="chip haz">' + esc(x) + '</span>').join('') : '<span class="chip">clear field</span>') + '</div>' +
    sideView(arena.them, false) + sideView(arena.us, true));
}

/* ---------- result, session, header ---------- */
function renderResult() {
  const r = result;
  if (!r) { put('resultbar', ''); return; }
  const word = r.outcome === 'win' ? 'Victory' : r.outcome === 'loss' ? 'Defeat' : 'Tie';
  const rating = r.rating ? ' · rating <b>' + r.rating.before + ' → ' + r.rating.after + '</b> (' + (r.rating.after >= r.rating.before ? '+' : '') + (r.rating.after - r.rating.before) + ')' : '';
 put('resultbar', '<div class="outcome ' + esc(r.outcome) + '"><span class="big">' + word + '</span><span class="detail">vs <b>' + esc(r.opponent || 'opponent') +
    '</b> · ' + r.turns + ' turns · knockouts <b>' + r.knockouts.dealt + '–' + r.knockouts.taken + '</b>' + rating + '</span></div>');
}
function renderSession() {
  const w = results.filter(r => r.outcome === 'win').length, l = results.filter(r => r.outcome === 'loss').length;
  $('record').innerHTML = 'record <b>' + w + '–' + l + '</b>';
  $('sesshead').textContent = results.length ? w + '–' + l : '';
  const latest = [...results].reverse().find(r => r.rating);
  const current = arena && !arena.ended && arena.us && arena.us.rating ? arena.us.rating : latest ? latest.rating.after : arena && arena.us && arena.us.rating;
  $('rating').innerHTML = current ? 'rating <b>' + esc(current) + '</b>' : ''; $('rating').hidden = !current;
  if (!results.length) { put('session', '<div class="empty">No finished battles yet.</div>'); return; }
  put('session', [...results].reverse().map(r => '<div class="res"><span class="o ' + esc(r.outcome) + '">' + (r.outcome === 'win' ? 'W' : r.outcome === 'loss' ? 'L' : 'T') + '</span>' +
    '<span>vs ' + esc(r.opponent || '?') + ' <span style="color:var(--dim)">· ' + r.turns + ' turns · ' + r.knockouts.dealt + '–' + r.knockouts.taken + '</span></span>' +
    '<span class="r">' + (r.rating ? r.rating.before + ' → ' + r.rating.after : '') + '</span></div>').join(''));
}

/* ---------- play-by-play ---------- */
function renderFeed() {
  if (!feed.length) { put('feed', '<div class="empty">Nothing yet.</div>'); $('feedhead').textContent = ''; return; }
  const us = arena && arena.us ? arena.us.side : null;
  const turns = new Map();
  for (const e of feed) { if (!turns.has(e.turn)) turns.set(e.turn, []); turns.get(e.turn).push(e); }
  $('feedhead').textContent = feed.length + ' events';
  const keepScroll = $('feed').scrollTop;
  put('feed', [...turns.entries()].sort((a, b) => b[0] - a[0]).map(([turn, evs]) => {
    let endShown = false;
    const rows = evs.map(e => {
      const who = e.side ? (us ? (e.side === us ? 'us' : 'them') : e.side) : '';
      const divider = e.phase === 'end' && !endShown ? (endShown = true, '<div class="eot">End of turn</div>') : '';
      return divider + '<div class="ev ' + esc(e.tone) + '"><span class="w ' + who + '">' + (who === 'us' ? 'us' : who === 'them' ? 'them' : '') + '</span>' +
        '<span class="x">' + esc(e.text) + (e.setup ? ' <span class="chip setup">setup</span>' : '') + '</span></div>';
    }).join('');
    return '<div class="turn"><h3>' + (turn === 0 ? 'Lead' : 'Turn ' + turn) + '</h3>' + rows + '</div>';
  }).join(''));
  $('feed').scrollTop = keepScroll;
}

/* ---------- watch live ---------- */
// Showdown refuses to run inside another page, so the real battle opens in its own tab, spectating like anyone else.
function renderWatch() {
  const room = safeRoom(live && live.room), link = $('watchlink');
  if (room) { link.href = 'https://play.pokemonshowdown.com/' + room; link.hidden = false;
    $('watchnote').textContent = 'Opens Showdown\'s own battle screen in a new tab, as a spectator. The arena on this page follows the same battle.'; }
  else { link.hidden = true; $('watchnote').textContent = 'The battle opens here once one starts.'; }
}

/* ---------- ticker and animation ---------- */
function sideClass(side) { return arena && arena.us ? (side === arena.us.side ? 'us' : 'them') : ''; }
function renderTicker() {
  const key = feed.filter(e => ['move', 'switch', 'faint', 'tera', 'result', 'miss'].includes(e.tone));
  const e = key[key.length - 1] || feed[feed.length - 1];
  if (!e) return;
  const who = sideClass(e.side);
  put('ticker', '<span class="now"><span class="who ' + who + '">' + (who || '') + '</span> ' + esc(e.text) + '</span>');
}
function animate(events) {
  const last = {};
  for (const e of events) if (e.side && ['damage', 'heal', 'boost', 'drop'].includes(e.tone)) last[e.side] = e.tone === 'damage' ? 'hit' : e.tone;
  for (const [side, kind] of Object.entries(last)) {
    const img = document.querySelector('.side.' + sideClass(side) + ' .sprite');
    if (!img) continue;
    img.classList.remove('hit', 'heal', 'boost', 'drop'); void img.offsetWidth; img.classList.add(kind);
  }
}

/* ---------- Jev's decisions ---------- */
function view() { return picked !== null ? decisions[picked] : decisions[decisions.length - 1]; }
function label(d, id) { const a = d.ranked.find(x => x.id === id); return a ? a.label : id; }
function renderChoice(d) {
  const c = d.choice;
  $('chead').textContent = 'turn ' + d.turn + (picked === null ? ' · latest' : ' · history');
  const bits = [];
  bits.push('<span class="tag">confidence <b>' + pct(c.confidence) + '</b></span>');
  bits.push('<span class="tag">' + c.latencyMs + ' ms</span>');
  if (c.payloadDetail) bits.push('<span class="tag">payload <b>' + esc(c.payloadDetail) + '</b> ' + (c.payloadBytes || 0).toLocaleString() + ' B</span>');
  if (c.inputTokens) bits.push('<span class="tag">' + c.inputTokens.toLocaleString() + ' in / ' + (c.outputTokens || 0) + ' out</span>');
  bits.push('<span class="tag">' + esc(d.requestKind) + '</span>');
  if (c.dryRun) bits.push('<span class="tag">dry run</span>');
  if (c.fallback) bits.push('<span class="tag" style="color:#f0616d">fallback' + (c.fallbackReason ? ': ' + esc(c.fallbackReason) : '') + '</span>');
  let html = '';
  if (d.guard) html += '<div class="banner"><b>Guard overruled the model.</b> It chose ' + esc(label(d, d.guard.from)) + '; the next-ranked action was used instead. ' + esc(d.guard.reason) + '</div>';
  html += '<div class="choice"><span class="name">' + esc(c.label) + '</span><span style="color:var(--dim)">' + (c.executed ? 'sent' : 'not sent') + '</span></div>' +
    '<div class="tags">' + bits.join('') + '</div>';
  const t = d.incomingThreat;
  if (t && t.worstCasePercentOfMaxHP !== null && t.worstCasePercentOfMaxHP !== undefined) {
    html += '<div class="kv" style="margin-top:8px"><span>Worst incoming if we stay</span><span>' + t.worstCasePercentOfMaxHP + '%' + (t.conditionalKO === 'all-sampled-rolls' ? ' — knocks us out' : '') + '</span></div>';
  }
  const r = d.risk || {};
  for (const [who, v] of [['Our turn', r.ours], ['Their turn', r.theirs]]) {
    if (v) html += '<div class="kv"><span>' + who + ' may be lost</span><span>' + v.sources.map(x => esc(x.source) + ' ' + x.chanceItLosesTheTurnPercent + '%').join(', ') + ' → acts ' + v.chanceItActsAtAllPercent + '%</span></div>';
  }
  $('choice').innerHTML = html;
}
function renderRanked(d) {
  if (!d.ranked.length) { $('ranked').innerHTML = '<div class="empty">-</div>'; return; }
  const top = Math.max(0.0001, ...d.ranked.map(a => a.probability || 0));
  $('ranked').innerHTML = d.ranked.map(a => {
    const meta = [];
    if (a.substitute) {
      const b = a.substitute.breaks;
      const cls = b === 'all-sampled-rolls' ? ' class="first"' : b === 'none-sampled' ? ' class="nil"' : '';
      const says = b === 'all-sampled-rolls' ? ' · breaks it' : b === 'none-sampled' ? ' · does not break it' : ' · may break it';
      meta.push('<span' + cls + '>sub ' + a.substitute.damageHP[0] + '-' + a.substitute.damageHP[1] + ' of ' + a.substitute.shellHP[1] + ' HP' + says + '</span>');
    } else if (a.damagePercent) meta.push('<span>' + a.damagePercent[0] + '-' + a.damagePercent[1] + '%</span>');
    if (a.ko) meta.push('<span class="ko">KO ' + esc(a.ko.replace('-sampled-rolls', '')) + '</span>');
    if (a.order === 'ours-first') meta.push('<span class="first">moves first</span>');
    if (a.order === 'theirs-first') meta.push('<span class="second">moves second</span>');
    if (a.switchIn && a.switchIn.hp !== null && a.switchIn.hp !== undefined) meta.push('<span>' + Math.round(a.switchIn.hp) + '% hp</span>');
    if (a.pointless) meta.push('<span class="nil">' + esc(a.pointless) + '</span>');
    if (a.skippedByGuard) meta.push('<span class="nil">skipped by guard</span>');
    const cls = a.chosen ? ' sel' : a.skippedByGuard ? ' cut' : '';
    return '<div class="row' + cls + '"><div style="min-width:0"><div class="txt">' + (a.chosen ? '▸ ' : '') + esc(a.label) + '</div>' +
      '<div class="bar"><i style="width:' + Math.round((a.probability || 0) / top * 100) + '%"></i></div>' +
      (meta.length ? '<div class="meta">' + meta.join('') + '</div>' : '') + '</div><div class="pct">' + pct(a.probability) + '</div></div>';
  }).join('');
}
function renderHist() {
  if (!decisions.length) { $('hist').innerHTML = '<div class="empty">No decisions yet.</div>'; return; }
  $('hist').innerHTML = decisions.map((d, i) => {
    const on = (picked === null ? i === decisions.length - 1 : i === picked);
    const cls = d.choice.fallback ? ' f' : d.guard ? ' g' : '';
    const mark = d.choice.fallback ? '✗' : d.guard ? '⚠' : '✓';
    return '<div class="h' + cls + (on ? ' on' : '') + '" data-i="' + i + '"><div class="t">t' + d.turn + '</div><div class="m">' + mark + '</div>' +
      '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(d.choice.label) + ' <span style="color:var(--dim)">' + pct(d.choice.confidence) + '</span></div></div>';
  }).reverse().join('');
  for (const el of $('hist').querySelectorAll('.h')) {
    el.onclick = () => { const i = Number(el.dataset.i); picked = i === decisions.length - 1 ? null : i; renderDecisions(); };
  }
}
function renderDecisions() {
  renderHist();
  const d = view();
  if (!d) { $('choice').innerHTML = '<div class="empty">Waiting for the first decision.</div>'; $('ranked').innerHTML = '<div class="empty">-</div>'; return; }
  $('ver').textContent = d.choice.instructionsVersion || ''; $('ver').hidden = !d.choice.instructionsVersion;
  renderChoice(d); renderRanked(d);
}

/* ---------- wiring ---------- */
function applyLive(l) {
  live = l || live;
  const room = safeRoom(live && live.room);
  $('room').innerHTML = room ? '<a href="https://play.pokemonshowdown.com/' + room + '" target="_blank" rel="noopener noreferrer">#' + esc(room.replace(/^battle-gen9randombattle-/, '').replace(/-.*$/, '')) + ' ↗</a>' : 'no battle';
  $('turn').textContent = 'turn ' + (arena ? arena.turn : live && live.turn ? live.turn : '-');
}
function render() { applyLive(); renderResult(); renderArena(); renderTicker(); renderFeed(); renderSession(); renderDecisions(); renderWatch(); }
function take(m) {
  if (m.reset) {
    decisions = m.decisions || []; feed = m.feed || []; arena = m.arena || null; result = m.result || null; picked = null;
  } else {
    for (const d of m.decisions || []) if (!decisions.some(x => x.rqid === d.rqid && x.turn === d.turn && x.time === d.time)) decisions.push(d);
    const last = feed.length ? feed[feed.length - 1].seq : 0;
    for (const e of m.feed || []) if (e.seq > last) feed.push(e);
    if ('arena' in m) arena = m.arena;
    if ('result' in m) result = m.result;
  }
  if (m.results) results = m.results;
  if (decisions.length > 60) decisions = decisions.slice(-60);
  if (feed.length > 800) feed = feed.slice(-800);
  if (m.live) live = m.live;
}
async function boot() {
  try {
    const r = await fetch('/state');
    const s = await r.json();
    take({ ...s, reset: true });
    $('conn').textContent = 'live'; $('conn').className = 'pill on';
    render();
  } catch { $('conn').textContent = 'offline'; $('conn').className = 'pill off'; setTimeout(boot, 2000); return; }
  const es = new EventSource('/events');
  es.onmessage = e => {
    const m = JSON.parse(e.data), before = feed.length ? feed[feed.length - 1].seq : 0;
    take(m); render();
    if (!m.reset) animate(feed.filter(x => x.seq > before));
  };
  es.onerror = () => { $('conn').textContent = 'reconnecting'; $('conn').className = 'pill off'; };
  es.onopen = () => { $('conn').textContent = 'live'; $('conn').className = 'pill on'; };
}
boot();
</script></body></html>`;
