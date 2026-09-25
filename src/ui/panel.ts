/**
 * The live view, served as one self-contained document. It is read-only and has no dependencies: it follows the same
 * JSON the extension does, and every number it shows came from the battle's public lines or a decision already logged.
 * Sprites come from Showdown's image server, and nothing about our team is sent there. Showdown refuses to run its
 * client inside another page, so watching the real battle opens it in its own tab; the arena here animates from the
 * battle's own lines instead.
 *
 * Three pages: Live (the battle in progress), Performance (rating and record over time, by build) and Replays (any
 * recorded battle played back through the same view, with a full-screen presentation mode for recording).
 */
export const PANEL_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>jevmon live</title><style>
:root{--bg:#0e1013;--panel:#161a20;--panel2:#1c222a;--line:#252c36;--text:#e6e9ee;--dim:#8b94a3;--accent:#7c6cf0;--search:#2cc3b5;--good:#3fb950;--bad:#f0616d;--warn:#e3b341;--blue:#4b9fff;--us:#4b9fff;--them:#f08a4b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5;flex-wrap:wrap}
.brand{font-weight:700;letter-spacing:.3px;margin-right:4px}
.tabs{display:flex;gap:4px;margin-right:6px}
.tabs button{border-radius:999px;padding:3px 12px;font-size:12px;color:var(--dim)}
.tabs button.on{color:#fff;background:var(--accent);border-color:var(--accent)}
.pill{border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:11px;color:var(--dim);white-space:nowrap}
.pill.on{color:var(--good);border-color:#1e4429}.pill.off{color:var(--bad);border-color:#4a2026}
.pill.rp{color:#1b1400;background:var(--warn);border-color:var(--warn);font-weight:700}
.pill b{color:var(--text);font-weight:600}
.wrap{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:12px;padding:12px;align-items:start}
@media(max-width:900px){.wrap{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:12px;overflow:hidden}
.card>h2{margin:0;padding:9px 12px;font-size:11px;letter-spacing:.9px;text-transform:uppercase;color:var(--dim);border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:8px}
.card>div{padding:12px}
.empty{color:var(--dim);padding:22px 12px;text-align:center}
button{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:3px 10px;font:inherit;font-size:11px;cursor:pointer}
button:hover{border-color:var(--accent)}
[hidden]{display:none!important}
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
.hpbar>i{display:block;height:100%;transition:width .5s ease,background .5s ease}
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
.sprite.hit,.bsprite.hit{animation:hit .5s ease}.sprite.heal,.bsprite.heal{animation:heal .7s ease}.sprite.boost,.bsprite.boost{animation:boost .6s ease}.sprite.drop,.bsprite.drop{animation:drop .6s ease}
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
/* decisions */
.choice{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.choice .name{font-size:20px;font-weight:700}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
.tag{font-size:11px;border-radius:5px;padding:2px 7px;background:var(--panel2);color:var(--dim);border:1px solid var(--line)}
.tag b{color:var(--text);font-weight:600}
.tag.agree{color:#8ff0a4;border-color:#1e4429;background:#12261a}.tag.split{color:#ffd28a;border-color:#4a3a1e;background:#221d10}
.how{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;margin-top:10px;font-size:12px}
.how span:nth-child(odd){color:var(--dim)}
.how .j{color:#b9b0ff}.how .s{color:#7fe3d8}
.legend{display:flex;gap:14px;font-size:11px;color:var(--dim);margin-bottom:6px}
.legend i{display:inline-block;width:14px;height:6px;border-radius:3px;margin-right:5px;vertical-align:middle}
.row{display:grid;grid-template-columns:minmax(0,1fr) 46px;gap:10px;align-items:center;padding:5px 0}
.row .txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .pct{text-align:right;color:var(--dim);font-variant-numeric:tabular-nums}
.bar{height:6px;border-radius:4px;background:#222833;overflow:hidden;margin-top:3px}
.bar>i{display:block;height:100%;background:var(--accent)}
.bar.s>i{background:var(--search)}
.row.sel .txt{color:#fff;font-weight:700}.row.sel .bar:not(.s)>i{background:var(--good)}
.row.cut .txt{color:var(--dim);text-decoration:line-through}.row.cut .bar>i{background:var(--bad)}
.meta{font-size:11px;color:var(--dim);display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.meta .ko{color:var(--warn)}.meta .first{color:var(--good)}.meta .second{color:var(--bad)}.meta .nil{color:var(--bad)}
.banner{border-left:3px solid var(--warn);background:#221d10;padding:8px 10px;border-radius:0 6px 6px 0;margin-bottom:10px;font-size:12px}
.banner b{color:var(--warn)}
.banner.info{border-color:var(--search);background:#10211f}.banner.info b{color:var(--search)}
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
/* replay controls */
.rbar{position:sticky;top:47px;z-index:4;margin:12px 12px 0;padding:8px 12px;border:1px solid #4a3a1e;border-radius:10px;background:#1b1810;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rbar .title{font-weight:700;color:var(--warn)}
.rbar input[type=range]{flex:1;min-width:160px;accent-color:var(--warn)}
.rbar select{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;font:inherit;font-size:11px;padding:2px 4px}
.rbar .big{font-size:14px;padding:3px 12px}
/* performance */
.page{padding:12px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:12px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}
.stat .k{font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:var(--dim)}
.stat .v{font-size:24px;font-weight:800;margin-top:4px;font-variant-numeric:tabular-nums}
.stat .d{font-size:11px;color:var(--dim);margin-top:2px}
.form{display:flex;gap:3px;flex-wrap:wrap;margin-top:8px}
.form b{width:16px;height:16px;border-radius:3px;font-size:10px;display:flex;align-items:center;justify-content:center;color:#0e1013}
.form b.w{background:var(--good)}.form b.l{background:var(--bad)}.form b.t{background:var(--dim)}
.chart{width:100%;height:260px;display:block}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{padding:7px 12px;text-align:left;border-bottom:1px solid #1d232b;font-variant-numeric:tabular-nums}
th{font-size:11px;color:var(--dim);font-weight:600;letter-spacing:.5px;text-transform:uppercase}
td.num,th.num{text-align:right}
.up{color:var(--good)}.dn{color:var(--bad)}
/* replay list */
.rl{display:grid;grid-template-columns:34px minmax(0,1.4fr) minmax(0,1fr) 110px 80px;gap:10px;align-items:center;padding:7px 12px;border-bottom:1px solid #1d232b;font-size:12px}
.rl:hover{background:var(--panel2)}
.rl .o{font-weight:800;text-align:center;border-radius:4px;padding:1px 0}
.rl .o.win{color:#0e1013;background:var(--good)}.rl .o.loss{color:#0e1013;background:var(--bad)}.rl .o.tie{background:var(--panel2)}
.rl .dim{color:var(--dim)}
.rl button{justify-self:end;background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700}
.filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.filters input{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:3px 8px;font:inherit;font-size:12px}
/* presentation stage */
#stage{position:fixed;inset:0;z-index:50;background:radial-gradient(ellipse at 70% 20%,#23213f 0%,#12141c 45%,#0a0b0f 100%);color:#fff;overflow:hidden;font-size:15px}
#stage .top{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:center;padding:18px 28px;font-weight:700;letter-spacing:.3px}
#stage .top .vs{font-size:20px}#stage .top .vs .u{color:var(--us)}#stage .top .vs .t{color:var(--them)}
#stage .top .meta2{color:#b8bfd0;font-weight:600;font-size:14px}
/* The battlefield holds the left of the screen; the bot's call has its own column on the right, so neither covers the other. */
#stage .field{position:absolute;left:0;top:64px;bottom:120px;right:36vw}
#stage .ground{position:absolute;border-radius:50%;background:radial-gradient(ellipse,#2d3450 0%,rgba(45,52,80,0) 70%)}
#stage .g1{width:46%;height:16%;right:6%;top:40%}#stage .g2{width:52%;height:18%;left:2%;bottom:0}
.bsprite{position:absolute;image-rendering:pixelated;object-fit:contain;transition:opacity .6s ease,filter .6s ease}
.bsprite.them{width:min(24vh,30%);height:min(24vh,30%);right:14%;top:12%}
.bsprite.us{width:min(32vh,38%);height:min(32vh,38%);left:9%;bottom:4%}
.bsprite.gone{opacity:0;filter:grayscale(1)}
.hpcard{position:absolute;background:rgba(18,20,30,.82);border:1px solid #33395a;border-radius:12px;padding:12px 16px;min-width:min(300px,40%);max-width:46%;backdrop-filter:blur(4px)}
.hpcard.them{left:4%;top:6%}.hpcard.us{right:4%;bottom:10%}
.hpcard .n{font-size:20px;font-weight:800;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.hpcard .o2{font-size:12px;color:#aab2c5;margin-bottom:4px}
.hpcard .hpbar{height:12px;margin-top:6px}.hpcard .hpn{font-size:15px}
.hpcard .pips{margin-top:8px}.hpcard .pip{width:30px}.hpcard .pip img{width:30px;height:30px}
.caption{position:absolute;left:50%;bottom:4vh;transform:translateX(-50%);width:min(900px,86vw);text-align:center;font-size:24px;font-weight:700;padding:14px 22px;border-radius:14px;background:rgba(10,11,16,.78);border:1px solid #2c3146;min-height:62px}
.caption .who{font-size:12px;letter-spacing:1px;text-transform:uppercase;display:block;margin-bottom:2px}
.caption .who.us{color:var(--us)}.caption .who.them{color:var(--them)}
.caption.pop{animation:tick .35s ease}
.think{position:absolute;right:2vw;top:78px;width:32vw;max-height:calc(100vh - 220px);overflow:hidden;background:rgba(16,18,28,.92);border:1px solid #3c3f6b;border-radius:14px;padding:16px 18px;box-shadow:0 12px 40px rgba(0,0,0,.45);opacity:.35;transform:translateY(6px);transition:opacity .45s ease,transform .45s cubic-bezier(.2,.8,.2,1)}
.think.show{opacity:1;transform:none}
.think .wait{color:#8088a0;font-size:14px}
.think h3{margin:0 0 2px;font-size:13px;letter-spacing:1.2px;text-transform:uppercase;color:#b9b0ff}
.think .pick{font-size:22px;font-weight:800;margin:4px 0 10px}
.think .opt{margin:9px 0}.think .opt .l{display:flex;justify-content:space-between;font-size:14px;font-weight:600}
.think .opt.sel .l{color:#8ff0a4}
.think .bar{height:7px}
.think .foot{font-size:12px;color:#aab2c5;margin-top:10px}
.think .legend{margin:8px 0 0}
.splash{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(6,7,10,.8);animation:tick .6s ease}
.splash .w1{font-size:80px;font-weight:900;letter-spacing:4px}
.splash.win .w1{color:var(--good)}.splash.loss .w1{color:var(--bad)}
.splash .w2{font-size:22px;color:#cfd5e2;margin-top:6px}
.mark{position:absolute;right:22px;bottom:14px;font-size:12px;color:#8088a0;letter-spacing:.4px}
.sctl{position:absolute;left:22px;bottom:14px;display:flex;gap:6px;align-items:center;transition:opacity .4s ease}
.sctl.idle{opacity:0}
.sctl button{background:rgba(28,34,42,.9)}
.sturn{position:absolute;left:50%;top:18px;transform:translateX(-50%);font-size:14px;color:#cfd5e2;font-weight:700;letter-spacing:1px}
</style></head><body>
<header>
  <span class="brand">jevmon</span>
  <span class="tabs"><button id="tab-live" class="on">Live</button><button id="tab-perf">Performance</button><button id="tab-replay">Replays</button></span>
  <span class="pill" id="conn">connecting</span>
  <span class="pill rp" id="replaypill" hidden>REPLAY</span>
  <span class="pill" id="room">no battle</span>
  <span class="pill" id="turn">turn -</span>
  <span class="pill" id="record">record 0–0</span>
  <span class="pill" id="rating"></span>
  <span class="pill" id="ver"></span>
</header>
<section id="page-live">
<div class="rbar" id="rbar" hidden>
  <span class="title" id="rtitle">Replay</span>
  <button id="r-start" title="Back to the start">⏮</button>
  <button id="r-prev" title="Previous turn (←)">◀</button>
  <button id="r-play" class="big" title="Play / pause (space)">▶</button>
  <button id="r-next" title="Next step (→)">▶|</button>
  <button id="r-end" title="Jump to the end">⏭</button>
  <select id="r-speed" title="Speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="4">4×</option></select>
  <input type="range" id="r-seek" min="0" max="0" value="0" title="Turn">
  <span class="note" id="r-pos"></span>
  <button id="r-present" title="Full-screen presentation for recording (P)">🎬 Present</button>
  <button id="r-close">Back to live</button>
</div>
<div id="resultbar"></div>
<div class="wrap">
  <div>
    <div class="card"><h2><span>Battle</span><span id="arenahead"></span></h2><div class="ticker" id="ticker"><span class="note">Waiting for the first move.</span></div><div class="arena" id="arena"><div class="empty">Waiting for a battle.</div></div></div>
    <div class="card" id="watchcard"><h2>Watch live</h2><div class="watchbody"><a class="go" id="watchlink" target="_blank" rel="noopener noreferrer" hidden>Watch on Showdown ↗</a>
      <span class="note" id="watchnote">The battle opens here once one starts.</span></div></div>
    <div class="card"><h2><span>Play-by-play</span><span id="feedhead"></span></h2><div class="feed" id="feed"><div class="empty">Nothing yet.</div></div></div>
  </div>
  <div>
    <div class="card"><h2><span>Jev's choice &amp; search</span><span id="chead"></span></h2><div id="choice"><div class="empty">Waiting for the first decision.</div></div></div>
    <div class="card"><h2><span>Options</span><span class="note">bars: Jev · search · right: blended</span></h2><div id="ranked"><div class="empty">-</div></div></div>
    <div class="card"><h2>Decisions</h2><div class="hist" id="hist"><div class="empty">-</div></div></div>
    <div class="card" id="sesscard"><h2><span>Recorded battles</span><span id="sesshead"></span></h2><div id="session" style="padding:0"><div class="empty">No finished battles yet.</div></div></div>
  </div>
</div>
</section>
<section id="page-perf" class="page" hidden><div id="perf"><div class="empty">Loading the record…</div></div></section>
<section id="page-replay" class="page" hidden>
  <div class="card"><h2><span>Recorded battles</span><span class="filters"><input id="rfilter" placeholder="Filter: opponent, version, win, loss"><span class="note" id="rcount"></span></span></h2>
    <div id="rlist" style="padding:0"><div class="empty">Loading…</div></div></div>
</section>
<div id="stage" hidden></div>
<script>
const $ = id => document.getElementById(id);
// Sections are redrawn only when their markup changes, so animated sprites do not restart on every update.
const drawn = {};
function put(id, html) { if (drawn[id] === html) return false; drawn[id] = html; $(id).innerHTML = html; return true; }
const SPRITES = 'https://play.pokemonshowdown.com/sprites/';
// L is the live battle, R a replay; V is whichever the Live page is showing.
const L = { decisions: [], feed: [], arena: null, result: null, picked: null };
let R = null, mode = 'live', page = 'live', results = [], live = null;
const V = () => (mode === 'replay' && R ? R.view : L);
const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct = v => v === null || v === undefined ? '-' : (Math.round(v * 100) + '%');
const hpColor = h => h > 50 ? '#3fb950' : h > 20 ? '#e3b341' : '#f0616d';
const STAT = { atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe', accuracy: 'Acc', evasion: 'Eva' };
const safeSprite = s => /^[a-z0-9-]{1,40}$/.test(s || '') ? s : 'substitute';
const safeRoom = r => /^battle-[a-z0-9-]{1,120}$/.test(r || '') ? r : null;
const roomNo = r => String(r || '').replace(/^battle-gen9randombattle-/, '').replace(/-.*$/, '');
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
  return '<div class="side ' + (isUs ? 'us' : 'them') + '">' +
    (a ? spriteImg(a.sprite, isUs, 'sprite' + (a.fainted ? ' gone' : '')) : '<div></div>') +
    '<div style="min-width:0">' + head + mon + (hazards.length || conds.length ? '<div class="chips" style="margin-top:6px">' + hazards.join('') + conds.join('') + '</div>' : '') +
    '<div class="pips">' + pips(s) + '</div></div></div>';
}
function pips(s) {
  const known = s.team.map(p => '<div class="pip' + (p.fainted ? ' ko' : '') + (p.active ? ' act' : '') + '" title="' + esc(p.species + ' ' + (p.fainted ? 'fainted' : p.hp + '%') + (p.status ? ' ' + p.status : '')) + '">' +
    '<img alt="" referrerpolicy="no-referrer" src="' + SPRITES + 'gen5/' + safeSprite(p.sprite) + '.png"><div class="ph"><i style="width:' + (p.fainted ? 0 : p.hp) + '%;background:' + hpColor(p.hp) + '"></i></div></div>');
  const unseen = s.teamSize && s.teamSize > s.team.length ? Array(s.teamSize - s.team.length).fill('<div class="pip unk" title="not yet seen"><img alt="" src="' + SPRITES + 'gen5/substitute.png"></div>') : [];
  return known.join('') + unseen.join('');
}
function settingUpNow(side) {
  const v = V();
  if (!v.arena) return false;
  return v.feed.some(e => e.setup && e.side === side && e.turn >= v.arena.turn - 1);
}
function renderArena() {
  const arena = V().arena;
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
  const r = V().result;
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
  const arena = L.arena;
  const current = arena && !arena.ended && arena.us && arena.us.rating ? arena.us.rating : latest ? latest.rating.after : arena && arena.us && arena.us.rating;
  $('rating').innerHTML = current ? 'rating <b>' + esc(current) + '</b>' : ''; $('rating').hidden = !current;
  if (!results.length) { put('session', '<div class="empty">No finished battles yet.</div>'); return; }
  put('session', [...results].reverse().slice(0, 40).map(r => '<div class="res"><span class="o ' + esc(r.outcome) + '">' + (r.outcome === 'win' ? 'W' : r.outcome === 'loss' ? 'L' : 'T') + '</span>' +
    '<span>vs ' + esc(r.opponent || '?') + ' <span style="color:var(--dim)">· ' + r.turns + ' turns · ' + r.knockouts.dealt + '–' + r.knockouts.taken + '</span></span>' +
    '<span class="r">' + (r.rating ? r.rating.before + ' → ' + r.rating.after : '') + '</span></div>').join(''));
}

/* ---------- play-by-play ---------- */
function renderFeed() {
  const feed = V().feed, arena = V().arena;
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
  $('feed').scrollTop = mode === 'replay' ? 0 : keepScroll;
}

/* ---------- watch live ---------- */
// Showdown refuses to run inside another page, so the real battle opens in its own tab, spectating like anyone else.
function renderWatch() {
  $('watchcard').hidden = mode === 'replay';
  const room = safeRoom(live && live.room), link = $('watchlink');
  if (room) { link.href = 'https://play.pokemonshowdown.com/' + room; link.hidden = false;
    $('watchnote').textContent = 'Opens Showdown\'s own battle screen in a new tab, as a spectator. The arena on this page follows the same battle.'; }
  else { link.hidden = true; $('watchnote').textContent = 'The battle opens here once one starts.'; }
}

/* ---------- ticker and animation ---------- */
function sideClass(side) { const a = V().arena; return a && a.us ? (side === a.us.side ? 'us' : 'them') : ''; }
function keyEvent(feed) {
  const key = feed.filter(e => ['move', 'switch', 'faint', 'tera', 'result', 'miss'].includes(e.tone));
  return key[key.length - 1] || feed[feed.length - 1];
}
function renderTicker() {
  const e = mode === 'replay' ? V().feed[V().feed.length - 1] : keyEvent(V().feed);
  if (!e) { put('ticker', '<span class="note">' + (mode === 'replay' ? 'Press play.' : 'Waiting for the first move.') + '</span>'); return; }
  const who = sideClass(e.side);
  put('ticker', '<span class="now"><span class="who ' + who + '">' + (who || '') + '</span> ' + esc(e.text) + '</span>');
}
function animate(events, selector) {
  const last = {};
  for (const e of events) if (e.side && ['damage', 'heal', 'boost', 'drop'].includes(e.tone)) last[e.side] = e.tone === 'damage' ? 'hit' : e.tone;
  for (const [side, kind] of Object.entries(last)) {
    for (const img of document.querySelectorAll(selector(sideClass(side)))) {
      img.classList.remove('hit', 'heal', 'boost', 'drop'); void img.offsetWidth; img.classList.add(kind);
    }
  }
}

/* ---------- decisions: Jev beside the search ---------- */
function view() { const v = V(); return v.picked !== null ? v.decisions[v.picked] : v.decisions[v.decisions.length - 1]; }
function label(d, id) { const a = d.ranked.find(x => x.id === id); return a ? a.label : id; }
const DECIDED = { blend: 'blend of Jev and the search', provider: 'Jev', search: 'the search alone' };
function howRows(d) {
  const h = d.how;
  if (!h) return '';
  const rows = [];
  if (h.jevPick) rows.push(['Jev picked', '<span class="j">' + esc(h.jevPick) + '</span>']);
  if (h.searchPick) rows.push(['Search picked', '<span class="s">' + esc(h.searchPick) + '</span>']);
  rows.push(['Decided by', esc(DECIDED[h.decidedBy] || h.decidedBy) + (h.agreed ? ' — they agreed' : h.jevPick && h.searchPick ? ' — they disagreed' : '')]);
  if (h.nearTie) rows.push(['Near tie', 'the search\'s ' + esc(h.nearTie.searchBest) + ' was too close to call, so Jev\'s ranking chose ' + esc(h.nearTie.chosen)]);
  if (h.teraHeldBack) rows.push(['Tera held back', esc(h.teraHeldBack.from) + ' → ' + esc(h.teraHeldBack.to) + ': the search did not want the Tera']);
  if (h.pivot) rows.push(['Pivot', esc(h.pivot.from) + ' played as ' + esc(h.pivot.to)]);
  if (h.search) rows.push(['Search', h.search.worlds + ' worlds · ' + h.search.ms + ' ms' + (h.search.solver ? ' · endgame solver' : '') + (h.search.extended ? ' · extended' : '')]);
  return '<div class="how">' + rows.map(([k, v]) => '<span>' + k + '</span><span>' + v + '</span>').join('') + '</div>';
}
function renderChoice(d) {
  const c = d.choice;
  $('chead').textContent = 'turn ' + d.turn + (V().picked === null ? (mode === 'replay' ? '' : ' · latest') : ' · history');
  const bits = [];
  if (d.how && d.how.jevPick && d.how.searchPick) bits.push(d.how.agreed ? '<span class="tag agree">Jev + search agree</span>' : '<span class="tag split">Jev and search disagree</span>');
  bits.push('<span class="tag">Jev confidence <b>' + pct(c.confidence) + '</b></span>');
  bits.push('<span class="tag">' + c.latencyMs + ' ms</span>');
  if (mode !== 'replay' && c.payloadDetail) bits.push('<span class="tag">payload <b>' + esc(c.payloadDetail) + '</b> ' + (c.payloadBytes || 0).toLocaleString() + ' B</span>');
  if (mode !== 'replay' && c.inputTokens) bits.push('<span class="tag">' + c.inputTokens.toLocaleString() + ' in / ' + (c.outputTokens || 0) + ' out</span>');
  bits.push('<span class="tag">' + esc(d.requestKind) + '</span>');
  if (c.dryRun) bits.push('<span class="tag">dry run</span>');
  if (c.fallback) bits.push('<span class="tag" style="color:#f0616d">fallback' + (c.fallbackReason ? ': ' + esc(c.fallbackReason) : '') + '</span>');
  let html = '';
  if (d.guard) html += '<div class="banner"><b>Guard overruled the model.</b> It chose ' + esc(label(d, d.guard.from)) + '; the next-ranked action was used instead. ' + esc(d.guard.reason) + '</div>';
  if (d.how && d.how.teraHeldBack) html += '<div class="banner info"><b>Tera held back.</b> ' + esc(d.how.teraHeldBack.from) + ' was played as ' + esc(d.how.teraHeldBack.to) + ': the search ranked the plain move at least as high.</div>';
  html += '<div class="choice"><span class="name">' + esc(c.label) + '</span><span style="color:var(--dim)">' + (c.executed ? 'sent' : 'not sent') + '</span></div>' +
    '<div class="tags">' + bits.join('') + '</div>' + howRows(d);
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
  const topJ = Math.max(0.0001, ...d.ranked.map(a => a.probability || 0));
  const topS = Math.max(0.0001, ...d.ranked.map(a => (a.search && a.search.share) || 0));
  const anySearch = d.ranked.some(a => a.search);
  $('ranked').innerHTML = (anySearch ? '<div class="legend"><span><i style="background:var(--accent)"></i>Jev</span><span><i style="background:var(--search)"></i>Search (share of its visits)</span></div>' : '') + d.ranked.map(a => {
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
    if (a.search) meta.push('<span>Jev ' + pct(a.probability) + ' · search ' + pct(a.search.share) + (a.search.score !== null && a.search.score !== undefined ? ' (win ' + pct(a.search.score) + ')' : '') + '</span>');
    if (a.pointless) meta.push('<span class="nil">' + esc(a.pointless) + '</span>');
    if (a.skippedByGuard) meta.push('<span class="nil">skipped by guard</span>');
    const cls = a.chosen ? ' sel' : a.skippedByGuard ? ' cut' : '';
    const right = a.blended !== null && a.blended !== undefined ? a.blended : a.probability;
    return '<div class="row' + cls + '"><div style="min-width:0"><div class="txt">' + (a.chosen ? '▸ ' : '') + esc(a.label) + '</div>' +
      '<div class="bar"><i style="width:' + Math.round((a.probability || 0) / topJ * 100) + '%"></i></div>' +
      (anySearch ? '<div class="bar s"><i style="width:' + Math.round(((a.search && a.search.share) || 0) / topS * 100) + '%"></i></div>' : '') +
      (meta.length ? '<div class="meta">' + meta.join('') + '</div>' : '') + '</div><div class="pct">' + pct(right) + '</div></div>';
  }).join('');
}
function renderHist() {
  const v = V();
  if (!v.decisions.length) { $('hist').innerHTML = '<div class="empty">No decisions yet.</div>'; return; }
  $('hist').innerHTML = v.decisions.map((d, i) => {
    const on = (v.picked === null ? i === v.decisions.length - 1 : i === v.picked);
    const cls = d.choice.fallback ? ' f' : d.guard ? ' g' : '';
    const mark = d.choice.fallback ? '✗' : d.guard ? '⚠' : '✓';
    const who = d.how && d.how.jevPick && d.how.searchPick ? (d.how.agreed ? ' <span style="color:var(--dim)">agreed</span>' : ' <span style="color:var(--warn)">split</span>') : '';
    return '<div class="h' + cls + (on ? ' on' : '') + '" data-i="' + i + '"><div class="t">t' + d.turn + '</div><div class="m">' + mark + '</div>' +
      '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(d.choice.label) + ' <span style="color:var(--dim)">' + pct(d.choice.confidence) + '</span>' + who + '</div></div>';
  }).reverse().join('');
  for (const el of $('hist').querySelectorAll('.h')) {
    el.onclick = () => { const i = Number(el.dataset.i); v.picked = i === v.decisions.length - 1 ? null : i; renderDecisions(); };
  }
}
function renderDecisions() {
  renderHist();
  const d = view();
  if (!d) { $('choice').innerHTML = '<div class="empty">' + (mode === 'replay' ? 'The first decision comes up as the replay plays.' : 'Waiting for the first decision.') + '</div>'; $('ranked').innerHTML = '<div class="empty">-</div>'; return; }
  $('ver').textContent = d.choice.instructionsVersion || ''; $('ver').hidden = !d.choice.instructionsVersion;
  renderChoice(d); renderRanked(d);
}

/* ---------- header and wiring ---------- */
function applyLive() {
  const room = safeRoom(mode === 'replay' && R ? R.room : live && live.room);
  $('room').innerHTML = room ? '<a href="https://play.pokemonshowdown.com/' + room + '" target="_blank" rel="noopener noreferrer">#' + esc(roomNo(room)) + ' ↗</a>' : 'no battle';
  const a = V().arena;
  $('turn').textContent = 'turn ' + (a ? a.turn : live && live.turn ? live.turn : '-');
  $('replaypill').hidden = mode !== 'replay';
  $('rbar').hidden = mode !== 'replay';
  $('sesscard').hidden = mode === 'replay';
}
function render() {
  applyLive(); renderSession();
  if (page !== 'live') return;
  renderResult(); renderArena(); renderTicker(); renderFeed(); renderDecisions(); renderWatch();
}
function take(m) {
  if (m.reset) {
    L.decisions = m.decisions || []; L.feed = m.feed || []; L.arena = m.arena || null; L.result = m.result || null; L.picked = null;
  } else {
    for (const d of m.decisions || []) if (!L.decisions.some(x => x.rqid === d.rqid && x.turn === d.turn && x.time === d.time)) L.decisions.push(d);
    const last = L.feed.length ? L.feed[L.feed.length - 1].seq : 0;
    for (const e of m.feed || []) if (e.seq > last) L.feed.push(e);
    if ('arena' in m) L.arena = m.arena;
    if ('result' in m) L.result = m.result;
  }
  if (m.results) results = m.results;
  if (L.decisions.length > 60) L.decisions = L.decisions.slice(-60);
  if (L.feed.length > 800) L.feed = L.feed.slice(-800);
  if (m.live) live = m.live;
}
function showPage(p) {
  page = p;
  for (const k of ['live', 'perf', 'replay']) { $('page-' + k).hidden = k !== p; $('tab-' + k).classList.toggle('on', k === p); }
  $('resultbar').hidden = p !== 'live';
  if (p === 'perf') renderPerf();
  if (p === 'replay') loadBattles();
  if (p === 'live') { for (const k in drawn) delete drawn[k]; render(); }
}
$('tab-live').onclick = () => showPage('live');
$('tab-perf').onclick = () => showPage('perf');
$('tab-replay').onclick = () => showPage('replay');

/* ---------- performance ---------- */
async function fetchBattles() {
  try { const r = await fetch('/battles'); if (r.ok) { const list = await r.json(); if (Array.isArray(list) && list.length >= results.length) results = list; } } catch { /* keep what we have */ }
  return results;
}
function perfRating(games) {
  const rated = games.filter(g => g.opponentRating);
  if (!rated.length) return null;
  const w = rated.filter(g => g.outcome === 'win').length, l = rated.filter(g => g.outcome === 'loss').length;
  return Math.round(rated.reduce((s, g) => s + g.opponentRating, 0) / rated.length + 400 * (w - l) / rated.length);
}
const shortVer = v => String(v || 'unknown').replace(/^2026-\d\d-\d\d-/, '');
const localTime = iso => { const t = new Date(iso); return isNaN(t) ? '' : t.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
let perfRetry = null;
async function renderPerf() {
  const all = await fetchBattles();
  const games = all.filter(g => g.outcome);
  // The server may still be reading the logs just after it starts: try again rather than show nothing.
  if (!games.length) {
    $('perf').innerHTML = '<div class="empty">Reading the record…</div>';
    if (!perfRetry && page === 'perf') perfRetry = setTimeout(() => { perfRetry = null; if (page === 'perf') renderPerf(); }, 1500);
    return;
  }
  const w = games.filter(g => g.outcome === 'win').length, l = games.filter(g => g.outcome === 'loss').length;
  const rated = games.filter(g => g.rating);
  const current = rated.length ? rated[rated.length - 1].rating.after : null;
  const peak = rated.length ? Math.max(...rated.map(g => g.rating.after)) : null;
  let streak = 0, kind = null;
  for (const g of [...games].reverse()) { if (kind === null) kind = g.outcome; if (g.outcome !== kind) break; streak++; }
  const last20 = games.slice(-20);
  const w20 = last20.filter(g => g.outcome === 'win').length;
  const stat = (k, v, d, extra) => '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div>' + (d ? '<div class="d">' + d + '</div>' : '') + (extra || '') + '</div>';
  let html = '<div class="stats">' +
    stat('Record', w + '–' + l, Math.round(100 * w / Math.max(1, w + l)) + '% of ' + games.length + ' battles') +
    stat('Rating', current !== null ? current : '-', peak !== null ? 'peak ' + peak : '') +
    stat('Streak', streak + (kind === 'win' ? ' W' : kind === 'loss' ? ' L' : ''), 'current run') +
    stat('Last 20', w20 + '–' + (last20.length - w20), 'performance ' + (perfRating(last20) || '-'),
      '<div class="form">' + last20.map(g => '<b class="' + (g.outcome === 'win' ? 'w' : g.outcome === 'loss' ? 'l' : 't') + '">' + (g.outcome === 'win' ? 'W' : g.outcome === 'loss' ? 'L' : 'T') + '</b>').join('') + '</div>') +
    '</div>';
  html += '<div class="card"><h2><span>Rating over time</span><span class="note">each dot is a battle · shading marks the build that played it</span></h2><div>' + ratingChart(rated) + '</div></div>';
  // Builds in the order they first played.
  const order = [], byVer = new Map();
  for (const g of games) { const v = g.version || 'unknown'; if (!byVer.has(v)) { byVer.set(v, []); order.push(v); } byVer.get(v).push(g); }
  html += '<div class="card"><h2><span>By build</span><span class="note">performance = average opponent + 400 × (wins − losses) / games</span></h2><div style="padding:0"><table><thead><tr><th>Build</th><th class="num">Games</th><th class="num">W–L</th><th class="num">Win %</th><th class="num">Avg opponent</th><th class="num">Performance</th><th class="num">Rating</th></tr></thead><tbody>' +
    order.slice().reverse().map(v => {
      const gs = byVer.get(v), gw = gs.filter(g => g.outcome === 'win').length, gl = gs.filter(g => g.outcome === 'loss').length;
      const opp = gs.filter(g => g.opponentRating), avg = opp.length ? Math.round(opp.reduce((s, g) => s + g.opponentRating, 0) / opp.length) : '-';
      const r = gs.filter(g => g.rating), from = r.length ? r[0].rating.before : null, to = r.length ? r[r.length - 1].rating.after : null;
      const delta = from !== null ? to - from : null;
      return '<tr><td>' + esc(shortVer(v)) + '</td><td class="num">' + gs.length + '</td><td class="num">' + gw + '–' + gl + '</td><td class="num">' + Math.round(100 * gw / Math.max(1, gw + gl)) + '%</td><td class="num">' + avg +
        '</td><td class="num"><b>' + (perfRating(gs) || '-') + '</b></td><td class="num">' + (from !== null ? from + ' → ' + to + ' <span class="' + (delta >= 0 ? 'up' : 'dn') + '">(' + (delta >= 0 ? '+' : '') + delta + ')</span>' : '-') + '</td></tr>';
    }).join('') + '</tbody></table></div></div>';
  $('perf').innerHTML = html;
}
function ratingChart(rated) {
  if (rated.length < 2) return '<div class="empty">Not enough rated battles yet.</div>';
  const W = 1000, H = 260, P = { l: 46, r: 12, t: 14, b: 22 };
  const ys = rated.map(g => g.rating.after), lo = Math.floor((Math.min(...ys, ...rated.map(g => g.rating.before)) - 20) / 50) * 50, hi = Math.ceil((Math.max(...ys) + 20) / 50) * 50;
  const x = i => P.l + i * (W - P.l - P.r) / (rated.length - 1), y = v => P.t + (hi - v) * (H - P.t - P.b) / Math.max(1, hi - lo);
  let svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">';
  // Build bands, alternating in shade; a band too narrow for its name keeps it in the tooltip only.
  let start = 0, band = 0;
  for (let i = 1; i <= rated.length; i++) {
    if (i === rated.length || (rated[i].version || '') !== (rated[start].version || '')) {
      const x0 = start ? (x(start - 1) + x(start)) / 2 : P.l, x1 = i === rated.length ? W - P.r : (x(i - 1) + x(i)) / 2;
      const name = shortVer(rated[start].version);
      svg += '<rect x="' + x0 + '" y="' + P.t + '" width="' + Math.max(0, x1 - x0) + '" height="' + (H - P.t - P.b) + '" fill="' + (band % 2 ? '#1a1f28' : '#151920') + '"><title>' + esc(name) + ' · ' + (i - start) + ' rated battles</title></rect>';
      if (x1 - x0 > name.length * 6.5 + 8) svg += '<text x="' + (x0 + 4) + '" y="' + (P.t + 12) + '" fill="#6d7686" font-size="11">' + esc(name) + '</text>';
      start = i; band++;
    }
  }
  for (let v = lo; v <= hi; v += 50) svg += '<line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#252c36"/><text x="' + (P.l - 6) + '" y="' + (y(v) + 4) + '" fill="#8b94a3" font-size="11" text-anchor="end">' + v + '</text>';
  svg += '<polyline fill="none" stroke="#7c6cf0" stroke-width="2" points="' + rated.map((g, i) => x(i) + ',' + y(g.rating.after)).join(' ') + '"/>';
  svg += rated.map((g, i) => '<circle cx="' + x(i) + '" cy="' + y(g.rating.after) + '" r="3" fill="' + (g.outcome === 'win' ? '#3fb950' : g.outcome === 'loss' ? '#f0616d' : '#8b94a3') + '"><title>' +
    esc((g.outcome === 'win' ? 'Win' : g.outcome === 'loss' ? 'Loss' : 'Tie') + ' vs ' + (g.opponent || '?') + ' · ' + g.rating.before + ' → ' + g.rating.after + (g.finishedAt ? ' · ' + localTime(g.finishedAt) : '')) + '</title></circle>').join('');
  return svg + '</svg>';
}

/* ---------- replays: list ---------- */
async function loadBattles() {
  await fetchBattles();
  renderBattleList();
}
function renderBattleList() {
  const q = ($('rfilter').value || '').trim().toLowerCase();
  const list = [...results].filter(g => g.file).reverse().filter(g => !q || [g.opponent, shortVer(g.version), g.outcome, roomNo(g.room)].some(s => String(s || '').toLowerCase().includes(q)));
  $('rcount').textContent = list.length + ' battles';
  if (!list.length) { $('rlist').innerHTML = '<div class="empty">No recorded battles match.</div>'; return; }
  $('rlist').innerHTML = list.map(g => '<div class="rl"><span class="o ' + esc(g.outcome) + '">' + (g.outcome === 'win' ? 'W' : g.outcome === 'loss' ? 'L' : 'T') + '</span>' +
    '<span>vs <b>' + esc(g.opponent || '?') + '</b>' + (g.opponentRating ? ' <span class="dim">(' + g.opponentRating + ')</span>' : '') + '<br><span class="dim">#' + esc(roomNo(g.room)) + ' · ' + g.turns + ' turns · KOs ' + g.knockouts.dealt + '–' + g.knockouts.taken + '</span></span>' +
    '<span class="dim">' + (g.finishedAt ? esc(localTime(g.finishedAt)) : '') + '<br>' + esc(shortVer(g.version)) + '</span>' +
    '<span class="dim">' + (g.rating ? g.rating.before + ' → <b style="color:var(--text)">' + g.rating.after + '</b>' : '') + '</span>' +
    '<button data-room="' + esc(g.room) + '">▶ Replay</button></div>').join('');
  for (const b of $('rlist').querySelectorAll('button')) b.onclick = () => openReplay(b.dataset.room);
}
$('rfilter').oninput = renderBattleList;

/* ---------- replays: player ---------- */
// A beat's length at 1×. Decisions hold longest, so the reasoning can be read (and filmed) before the turn plays.
const BEAT = { decision: 2600, move: 1100, switch: 1200, faint: 1300, damage: 900, heal: 800, tera: 1300, result: 2200, field: 800, status: 900, boost: 800, drop: 800, miss: 800, info: 650 };
let timer = null, playing = false;
async function openReplay(room) {
  const r = safeRoom(room);
  if (!r) return;
  showPage('live');
  mode = 'replay';
  R = { room: r, steps: [], at: 0, view: { decisions: [], feed: [], arena: null, result: null, picked: null }, final: null, turns: [] };
  $('rtitle').textContent = 'Loading replay #' + roomNo(r) + '…';
  for (const k in drawn) delete drawn[k];
  render();
  let data;
  try { const res = await fetch('/replay/' + r); if (!res.ok) throw new Error(String(res.status)); data = await res.json(); }
  catch { $('rtitle').textContent = 'Replay unavailable'; return; }
  if (!R || R.room !== r) return;
  R.steps = data.steps; R.final = data.result;
  // Turn starts, for the slider and for stepping back a turn.
  let lastTurn = -1;
  data.steps.forEach((s, i) => { const t = s.type === 'arena' ? s.arena.turn : s.type === 'decision' ? s.decision.turn : s.event.turn; if (t > lastTurn) { R.turns.push({ turn: t, at: i }); lastTurn = t; } });
  const opp = data.result ? data.result.opponent : null;
  $('rtitle').textContent = 'Replay #' + roomNo(r) + (opp ? ' vs ' + opp : '') + (data.result ? ' · ' + (data.result.outcome === 'win' ? 'won' : data.result.outcome === 'loss' ? 'lost' : 'tied') : '');
  $('r-seek').max = String(Math.max(0, R.turns.length - 1));
  seek(0); play();
}
function closeReplay() { pause(); mode = 'live'; R = null; closeStage(); for (const k in drawn) delete drawn[k]; render(); }
function clone(x) { return x === null || x === undefined ? x : JSON.parse(JSON.stringify(x)); }
/** One step of the timeline applied to the replay's view: a recorded arena, a decision, or an event with its effects. */
function apply(step) {
  const v = R.view;
  if (step.type === 'arena') { v.arena = clone(step.arena); return; }
  if (step.type === 'decision') { v.decisions.push(step.decision); v.picked = null; return; }
  const e = step.event;
  v.feed.push(e);
  if (e.tone === 'result' && /won the battle|tie/.test(e.text) && R.final) v.result = R.final;
  const a = v.arena, fx = e.fx;
  if (!a || !fx || !e.side) return;
  const s = a.us && a.us.side === e.side ? a.us : a.them && a.them.side === e.side ? a.them : null;
  if (!s) return;
  if (fx.species && e.tone === 'switch') {
    const known = s.team.find(p => p.species === fx.species) || null;
    for (const p of s.team) p.active = false;
    if (known) known.active = true;
    s.active = { species: fx.species, sprite: fx.sprite || (known && known.sprite), hp: fx.hp !== undefined ? fx.hp : known ? known.hp : 100, fainted: false,
      status: fx.status !== undefined ? fx.status : known ? known.status : null, boosts: {}, effects: [], ...(known && known.tera ? { tera: known.tera } : {}) };
    if (known) { known.hp = s.active.hp; }
    return;
  }
  const m = s.active;
  if (!m) return;
  const entry = s.team.find(p => p.active) || s.team.find(p => p.species === m.species);
  if (fx.hp !== undefined) { m.hp = fx.hp; if (entry) entry.hp = fx.hp; }
  if (fx.faint) { m.fainted = true; m.hp = 0; if (entry) { entry.fainted = true; entry.hp = 0; } }
  if (fx.status !== undefined && e.tone !== 'switch') { m.status = fx.status; if (entry) entry.status = fx.status; }
  if (fx.stat) { m.boosts = m.boosts || {}; if (fx.stage) m.boosts[fx.stat] = fx.stage; else delete m.boosts[fx.stat]; }
  if (fx.clearBoosts) m.boosts = {};
  if (fx.tera) m.tera = fx.tera;
}
function seek(i) {
  if (!R) return;
  R.view = { decisions: [], feed: [], arena: null, result: null, picked: null };
  const end = Math.max(0, Math.min(R.steps.length, i));
  for (let k = 0; k < end; k++) apply(R.steps[k]);
  R.at = end;
  refreshReplay([]);
}
function turnIndex() { let t = 0; for (let k = 0; k < R.turns.length; k++) if (R.turns[k].at <= R.at) t = k; return t; }
function refreshReplay(fresh) {
  for (const k of ['arena', 'feed', 'ticker']) delete drawn[k];
  render();
  const ti = turnIndex();
  $('r-seek').value = String(ti);
  $('r-pos').textContent = R.turns.length ? 'turn ' + R.turns[ti].turn + ' · step ' + R.at + '/' + R.steps.length : '';
  $('r-play').textContent = playing ? '⏸' : '▶';
  if (fresh.length) animate(fresh, cls => '.side.' + cls + ' .sprite');
  if (stageOn) renderStage(fresh);
}
function stepOnce() {
  if (!R || R.at >= R.steps.length) { pause(); return null; }
  const step = R.steps[R.at++];
  apply(step);
  return step;
}
function beat(step) {
  const speed = Number($('r-speed').value) || 1;
  if (!step) return 0;
  if (step.type === 'arena') return 0;
  if (step.type === 'decision') return (stageOn ? 3400 : BEAT.decision) / speed;
  return (BEAT[step.event.tone] || 800) / speed;
}
function tick() {
  timer = null;
  if (!playing || !R) return;
  // Arenas carry no time of their own: take them with the step after.
  const fresh = [];
  let step = stepOnce();
  while (step && step.type === 'arena' && R.at < R.steps.length) step = stepOnce();
  if (step && step.type === 'event') fresh.push(step.event);
  refreshReplay(fresh);
  if (!step || R.at >= R.steps.length) { pause(); refreshReplay([]); return; }
  timer = setTimeout(tick, beat(step));
}
function play() { if (!R) return; if (R.at >= R.steps.length) seek(0); playing = true; $('r-play').textContent = '⏸'; if (!timer) timer = setTimeout(tick, 250); }
function pause() { playing = false; if (timer) { clearTimeout(timer); timer = null; } if ($('r-play')) $('r-play').textContent = '▶'; }
$('r-play').onclick = () => (playing ? pause() : play());
$('r-next').onclick = () => { pause(); const fresh = []; let s = stepOnce(); while (s && s.type === 'arena') s = stepOnce(); if (s && s.type === 'event') fresh.push(s.event); refreshReplay(fresh); };
$('r-prev').onclick = () => { pause(); const ti = turnIndex(); const target = R.turns[Math.max(0, R.at > R.turns[ti].at + 1 ? ti : ti - 1)]; seek(target ? target.at : 0); };
$('r-start').onclick = () => { pause(); seek(0); };
$('r-end').onclick = () => { pause(); seek(R.steps.length); };
$('r-seek').oninput = () => { pause(); const t = R.turns[Number($('r-seek').value)]; if (t) seek(t.at); };
$('r-close').onclick = closeReplay;
$('r-present').onclick = () => (stageOn ? closeStage() : openStage());

/* ---------- presentation stage (for recording) ---------- */
let stageOn = false, idleTimer = null, lastDecisionShown = -1;
function openStage() {
  if (!R) return;
  stageOn = true; $('stage').hidden = false; lastDecisionShown = -1;
  renderStage([]);
  try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); } catch { /* not allowed */ }
  wake();
}
function closeStage() {
  stageOn = false; $('stage').hidden = true; $('stage').innerHTML = '';
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* ignore */ }
}
function wake() {
  const c = document.querySelector('#stage .sctl');
  if (c) c.classList.remove('idle');
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { const el = document.querySelector('#stage .sctl'); if (el) el.classList.add('idle'); }, 2200);
}
document.addEventListener('mousemove', () => { if (stageOn) wake(); });
function hpCard(s, isUs) {
  if (!s) return '';
  const a = s.active;
  const left = s.teamSize ? Math.max(0, s.teamSize - s.team.filter(p => p.fainted).length) : null;
  const boosts = a ? Object.entries(a.boosts || {}).map(([k, v]) => '<span class="chip ' + (v > 0 ? 'up' : 'down') + '">' + (STAT[k] || esc(k)) + ' ' + (v > 0 ? '+' : '') + v + '</span>').join('') : '';
  return '<div class="hpcard ' + (isUs ? 'us' : 'them') + '"><div class="o2">' + esc(s.name || '') + (s.rating ? ' · ' + esc(s.rating) : '') + (left !== null ? ' · ' + left + ' left' : '') + '</div>' +
    (a ? '<div class="n">' + esc(a.species) + (a.status ? '<span class="st ' + esc(a.status) + '">' + esc(a.status) + '</span>' : '') + (a.tera ? '<span class="chip tera">Tera ' + esc(a.tera) + '</span>' : '') + '</div>' +
      '<div class="hpwrap"><div class="hpbar"><i style="width:' + (a.fainted ? 0 : a.hp) + '%;background:' + hpColor(a.hp) + '"></i></div><div class="hpn">' + (a.fainted ? 'fnt' : a.hp + '%') + '</div></div>' +
      (boosts ? '<div class="chips">' + boosts + '</div>' : '') : '') +
    '<div class="pips">' + pips(s) + '</div></div>';
}
function thinkCard(d) {
  if (!d) return '<div class="think" id="think"><h3>The bot\'s call</h3><div class="wait">Its first decision appears here.</div></div>';
  const opts = d.ranked.slice(0, 3);
  const topJ = Math.max(0.0001, ...opts.map(a => a.probability || 0)), topS = Math.max(0.0001, ...opts.map(a => (a.search && a.search.share) || 0));
  const h = d.how || {};
  const verdict = h.jevPick && h.searchPick ? (h.agreed ? 'Jev and the search agreed.' : 'Jev and the search disagreed; the blend decided.') : '';
  return '<div class="think" id="think"><h3>Turn ' + d.turn + ' · the bot\'s call</h3><div class="pick">' + esc(d.choice.label) + '</div>' +
    opts.map(a => '<div class="opt' + (a.chosen ? ' sel' : '') + '"><div class="l"><span>' + (a.chosen ? '✓ ' : '') + esc(a.label) + '</span><span>' + pct(a.blended !== null && a.blended !== undefined ? a.blended : a.probability) + '</span></div>' +
      '<div class="bar"><i style="width:' + Math.round((a.probability || 0) / topJ * 100) + '%"></i></div>' +
      (a.search ? '<div class="bar s"><i style="width:' + Math.round(((a.search && a.search.share) || 0) / topS * 100) + '%"></i></div>' : '') + '</div>').join('') +
    '<div class="legend"><span><i style="background:var(--accent)"></i>Jev (LLM)</span><span><i style="background:var(--search)"></i>Search (lookahead)</span></div>' +
    (verdict ? '<div class="foot">' + verdict + (d.guard ? ' A safety rule overruled the first pick.' : '') + '</div>' : '') + '</div>';
}
function renderStage(fresh) {
  if (!stageOn || !R) return;
  const v = R.view, a = v.arena;
  const us = a && a.us, them = a && a.them;
  const d = v.decisions[v.decisions.length - 1];
  const e = v.feed[v.feed.length - 1];
  const who = e && e.side ? sideClass(e.side) : '';
  const done = R.at >= R.steps.length && R.final;
  const splash = done ? '<div class="splash ' + esc(R.final.outcome) + '"><div class="w1">' + (R.final.outcome === 'win' ? 'VICTORY' : R.final.outcome === 'loss' ? 'DEFEAT' : 'TIE') + '</div>' +
    '<div class="w2">vs ' + esc(R.final.opponent || '') + ' · knockouts ' + R.final.knockouts.dealt + '–' + R.final.knockouts.taken + (R.final.rating ? ' · rating ' + R.final.rating.before + ' → ' + R.final.rating.after + ' (' + (R.final.rating.after >= R.final.rating.before ? '+' : '') + (R.final.rating.after - R.final.rating.before) + ')' : '') + '</div></div>' : '';
  const html = '<div class="top"><span class="vs"><span class="u">' + esc(us ? us.name : '') + '</span> vs <span class="t">' + esc(them ? them.name : '') + '</span></span><span class="meta2">Gen 9 Random Battle · Pokémon Showdown ladder</span></div>' +
    '<div class="sturn">' + (a ? 'TURN ' + a.turn : '') + '</div>' +
    '<div class="field"><div class="ground g1"></div><div class="ground g2"></div>' +
    (them && them.active ? spriteImg(them.active.sprite, false, 'bsprite them' + (them.active.fainted ? ' gone' : '')) : '') +
    (us && us.active ? spriteImg(us.active.sprite, true, 'bsprite us' + (us.active.fainted ? ' gone' : '')) : '') +
    hpCard(them, false) + hpCard(us, true) + '</div>' + thinkCard(d) +
    '<div class="caption' + (fresh.length ? ' pop' : '') + '">' + (e ? '<span class="who ' + who + '">' + (who === 'us' ? esc(us ? us.name : 'us') : who === 'them' ? esc(them ? them.name : 'them') : '') + '</span>' + esc(e.text) : '') + '</div>' +
    '<div class="mark">jevmon · an LLM + search Pokémon bot</div>' + splash +
    '<div class="sctl"><button id="s-play">' + (playing ? '⏸' : '▶') + '</button><button id="s-prev">◀</button><button id="s-next">▶|</button><button id="s-exit">Exit</button><span class="note">space · ← → · P</span></div>';
  // Sprites keep their element when the Pokémon is the same, so a hit animates rather than reloads.
  const stage = $('stage');
  const keep = {};
  for (const img of stage.querySelectorAll('.bsprite')) keep[img.classList.contains('us') ? 'us' : 'them'] = img;
  stage.innerHTML = html;
  for (const side of ['us', 'them']) {
    const old = keep[side], now = stage.querySelector('.bsprite.' + side);
    if (old && now && old.getAttribute('src') === now.getAttribute('src')) { old.className = now.className; now.replaceWith(old); }
  }
  // The call slides in when a new decision arrives.
  const think = $('think');
  if (think && d) {
    const di = v.decisions.length - 1;
    if (di !== lastDecisionShown) { lastDecisionShown = di; think.classList.remove('show'); void think.offsetWidth; setTimeout(() => think.classList.add('show'), 30); }
    else think.classList.add('show');
  }
  $('s-play').onclick = () => (playing ? pause() : play());
  $('s-prev').onclick = () => $('r-prev').onclick();
  $('s-next').onclick = () => $('r-next').onclick();
  $('s-exit').onclick = closeStage;
  if (fresh.length) animate(fresh, cls => '#stage .bsprite.' + cls);
}
document.addEventListener('keydown', ev => {
  if (mode !== 'replay' || (ev.target && /INPUT|SELECT/.test(ev.target.tagName))) return;
  if (ev.key === ' ') { ev.preventDefault(); playing ? pause() : play(); }
  else if (ev.key === 'ArrowRight') { ev.preventDefault(); $('r-next').onclick(); }
  else if (ev.key === 'ArrowLeft') { ev.preventDefault(); $('r-prev').onclick(); }
  else if (ev.key === 'p' || ev.key === 'P') { stageOn ? closeStage() : openStage(); }
  else if (ev.key === 'Escape' && stageOn) closeStage();
});

/* ---------- boot ---------- */
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
    const m = JSON.parse(e.data), before = L.feed.length ? L.feed[L.feed.length - 1].seq : 0;
    take(m);
    if (mode === 'live') { render(); if (!m.reset) animate(L.feed.filter(x => x.seq > before), cls => '.side.' + cls + ' .sprite'); }
    else renderSession();
  };
  es.onerror = () => { $('conn').textContent = 'reconnecting'; $('conn').className = 'pill off'; };
  es.onopen = () => { $('conn').textContent = 'live'; $('conn').className = 'pill on'; };
  // A link straight to a replay, for sharing a battle: ?replay=battle-…
  const q = new URLSearchParams(location.search).get('replay');
  if (q) openReplay(q);
}
boot();
</script></body></html>`;
