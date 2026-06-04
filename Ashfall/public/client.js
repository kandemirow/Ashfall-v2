/* =====================================================================
 * ASHFALL LEGION — client
 * Canvas render @60fps, WebSocket, interpolation @20Hz snapshots,
 * input -> server, HUD, menus, level-up UI, Web Audio sounds.
 * ===================================================================== */
'use strict';

/* ---------------------- DOM ---------------------- */
const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d', { alpha: false });

const menuEl = $('menu'), hudEl = $('hud'), levelupEl = $('levelup');
const deathEl = $('death'), gameoverEl = $('gameover'), toastEl = $('toast');
const nameInput = $('name-input'), charSelectEl = $('char-select'), playBtn = $('play-btn');
const connStatus = $('conn-status');

/* ---------------------- visual tables ---------------------- */
const ENEMY_STYLE = {
  bat:    { c: '#8a7ed0', r: 12, shape: 'tri' },
  ghoul:  { c: '#7ec88a', r: 15, shape: 'circle' },
  brute:  { c: '#c88a7e', r: 22, shape: 'square' },
  wraith: { c: '#9fd0ff', r: 14, shape: 'circle', ghost: true },
  crawl:  { c: '#c9b06f', r: 9,  shape: 'tri' },
  elite:  { c: '#ff8a5c', r: 28, shape: 'square' },
  bomber: { c: '#ff7a45', r: 16, shape: 'circle' },
  shooter:{ c: '#c97aff', r: 15, shape: 'square' },
  runner: { c: '#ffd86b', r: 14, shape: 'tri' },
  batlord:    { c: '#9b6fff', r: 50, shape: 'tri',    boss: true },
  graveknight:{ c: '#cfd2d6', r: 58, shape: 'square', boss: true },
  crimson:    { c: '#ff5470', r: 54, shape: 'circle', boss: true, ghost: true },
  reaper:     { c: '#ff2b2b', r: 70, shape: 'tri',    boss: true },
};
const GEM_COLOR = ['#5fd0ff', '#6fe09a', '#ff5870']; // tier 0/1/2
const WEAPON_ICON = {
  arc: '⚔️', ember: '🔥', arrow: '🏹', pulse: '✨', frost: '❄️', bone: '🦴',
  arc_evo: '🌩️', ember_evo: '☀️', arrow_evo: '👻', pulse_evo: '🛡️', frost_evo: '⛪', bone_evo: '🌀',
};
const PASSIVE_ICON = {
  iron: '❤️', war: '🗡️', lens: '🔮', quick: '⏱️', magnet: '🧲', scholar: '📜', gold: '💰', boots: '👢',
};

/* ---------------------- state ---------------------- */
let ws = null;
let myId = 0, spectator = false;
let chars = null, weaponDefs = null, passiveDefs = null, evoDefs = {};
let viewRadius = 950, worldSize = { w: 6000, h: 6000 };

let selectedChar = null;
let connected = false;

// interpolation buffers
let prevSnap = null, curSnap = null, prevTime = 0, curTime = 0;
let camX = 0, camY = 0;

// input
let inputMask = 0, lastSentMask = -1;
let controlsActive = false;

// settings
let muted = false, lowFx = false;

// fps / ping
let frames = 0, fpsTimer = 0, fps = 0;
let ping = 0, lastPingSent = 0;

// client-side effects + particle pool
const effects = [];
const particlePool = [];

/* =====================================================================
 * CANVAS SIZING
 * ===================================================================== */
let DPR = Math.min(window.devicePixelRatio || 1, 2);
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * DPR);
  canvas.height = Math.floor(window.innerHeight * DPR);
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
}
window.addEventListener('resize', resize);
resize();

/* =====================================================================
 * SOUND MANAGER (Web Audio)
 * ===================================================================== */
const Sound = (() => {
  let actx = null;
  function ensure() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } return actx; }
  function blip(freq, dur, type, vol, slide) {
    if (muted) return; const a = ensure(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * slide), a.currentTime + dur);
    g.gain.value = (vol || 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g); g.connect(a.destination);
    o.start(); o.stop(a.currentTime + dur);
  }
  return {
    resume() { const a = ensure(); if (a && a.state === 'suspended') a.resume(); },
    xp()      { blip(660, 0.07, 'square', 0.05, 1.4); },
    levelup() { blip(440, 0.12, 'sawtooth', 0.12, 2.2); setTimeout(() => blip(880, 0.18, 'sawtooth', 0.12, 1.5), 90); },
    hit()     { blip(180, 0.08, 'sawtooth', 0.10, 0.5); },
    damage()  { blip(120, 0.18, 'sawtooth', 0.16, 0.4); },
    chest()   { blip(520, 0.1, 'triangle', 0.14, 1.6); setTimeout(() => blip(780, 0.16, 'triangle', 0.14, 1.4), 110); },
    evolve()  { blip(330, 0.2, 'sawtooth', 0.18, 2.6); setTimeout(() => blip(990, 0.3, 'square', 0.16, 1.4), 150); },
    death()   { blip(220, 0.5, 'sawtooth', 0.2, 0.25); },
  };
})();

/* =====================================================================
 * MENU / CHARACTER SELECT
 * ===================================================================== */
const CHAR_META = {
  knight: { role: 'Balanced bruiser', bonus: '+10% HP · Arc Blade' },
  witch:  { role: 'Area damage',      bonus: '+15% Area, -10% HP · Ember Orb' },
  ranger: { role: 'Projectiles',      bonus: '+1 projectile · Spirit Arrow' },
  cleric: { role: 'Support / tank',   bonus: 'HP regen + ally aura · Holy Pulse' },
};
const CHAR_COLOR = { knight: '#e8d8a0', witch: '#b98cff', ranger: '#7fd6a0', cleric: '#ffe6b3' };

function buildCharSelect() {
  charSelectEl.innerHTML = '';
  for (const id of ['knight', 'witch', 'ranger', 'cleric']) {
    const m = CHAR_META[id];
    const div = document.createElement('div');
    div.className = 'char-card';
    div.innerHTML =
      `<div class="char-disc" style="background:${CHAR_COLOR[id]};color:${CHAR_COLOR[id]}"></div>
       <div class="char-name">${id[0].toUpperCase() + id.slice(1)}</div>
       <div class="char-role">${m.role}</div>
       <div class="char-bonus">${m.bonus}</div>`;
    div.onclick = () => {
      selectedChar = id;
      document.querySelectorAll('.char-card').forEach(c => c.classList.remove('sel'));
      div.classList.add('sel');
      checkReady();
    };
    charSelectEl.appendChild(div);
  }
}
buildCharSelect();

function checkReady() {
  playBtn.disabled = !(nameInput.value.trim().length > 0 && selectedChar);
}
nameInput.addEventListener('input', checkReady);

playBtn.onclick = () => { Sound.resume(); connect(); };

/* =====================================================================
 * WEBSOCKET
 * ===================================================================== */
function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host;
}

function connect() {
  if (connected) return;
  connStatus.textContent = 'Connecting…'; connStatus.className = 'conn';
  ws = new WebSocket(wsURL());

  ws.onopen = () => {
    connStatus.textContent = 'Connected — joining…'; connStatus.className = 'conn ok';
    send({ t: 'join', name: nameInput.value.trim().slice(0, 16), char: selectedChar });
  };
  ws.onclose = () => {
    connected = false; connStatus.textContent = 'Disconnected'; connStatus.className = 'conn err';
    menuEl.classList.remove('hidden'); hudEl.classList.add('hidden');
  };
  ws.onerror = () => { connStatus.textContent = 'Connection error'; connStatus.className = 'conn err'; };
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
}

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function handleMessage(m) {
  switch (m.t) {
    case 'welcome':
      myId = m.id; spectator = m.spectator;
      chars = m.chars; weaponDefs = m.weapons; passiveDefs = m.passives;
      evoDefs = m.evolutions || {};
      viewRadius = m.view; worldSize = m.world;
      connected = true; controlsActive = !spectator;
      menuEl.classList.add('hidden'); hudEl.classList.remove('hidden');
      if (m.full) toast('Room full — spectating');
      startPing();
      break;
    case 's':
      onSnapshot(m);
      break;
    case 'lvl':
      updateLevelUI(m.opts, m.pending || 0);
      break;
    case 'died':
      Sound.death(); deathEl.classList.remove('hidden');
      break;
    case 'revived':
      deathEl.classList.add('hidden'); toast('Revived!'); Sound.levelup();
      break;
    case 'chest':
      Sound.chest(); toast('Chest opened — reward!');
      break;
    case 'evo':
      Sound.evolve(); toast('EVOLUTION: ' + m.name);
      break;
    case 'boss':
      toast('⚔ ' + m.name);
      break;
    case 'over':
      showGameOver(m.reason);
      break;
    case 'restart':
      gameoverEl.classList.add('hidden'); deathEl.classList.add('hidden'); toast('New run!');
      break;
    case 'pong':
      ping = Math.round(performance.now() - m.ts);
      break;
  }
}

function startPing() {
  setInterval(() => { lastPingSent = performance.now(); send({ t: 'ping', ts: lastPingSent }); }, 2000);
}

/* =====================================================================
 * SNAPSHOT INTAKE + spawn client effects
 * ===================================================================== */
function onSnapshot(s) {
  prevSnap = curSnap; prevTime = curTime;
  curSnap = s; curTime = performance.now();
  if (!prevSnap) prevSnap = s, prevTime = curTime - 50;

  // process transient events into client effects
  if (s.X) for (const e of s.X) spawnEffect(e);

  // HUD reacts to own state changes (level up handled by 'lvl' msg)
  if (s.me) {
    if (s.me.dead) deathEl.classList.remove('hidden');
    else deathEl.classList.add('hidden');
  }
}

function spawnEffect(e) {
  switch (e.k) {
    case 'slash': effects.push({ k: 'slash', x: e.x, y: e.y, r: e.r, evo: e.e, t: 0, life: 0.22 }); break;
    case 'boom':  effects.push({ k: 'ring', x: e.x, y: e.y, r: e.r, c: '#ff7a45', t: 0, life: 0.35 }); burst(e.x, e.y, 10, '#ff7a45'); Sound.hit(); break;
    case 'pulse': effects.push({ k: 'ring', x: e.x, y: e.y, r: e.r, c: '#ffe6b3', t: 0, life: 0.3 }); break;
    case 'frost': effects.push({ k: 'ring', x: e.x, y: e.y, r: e.r, c: '#9fd0ff', t: 0, life: 0.3 }); break;
    case 'levelup': burst(e.x, e.y, 18, '#e8c873'); effects.push({ k: 'ring', x: e.x, y: e.y, r: 60, c: '#e8c873', t: 0, life: 0.5 }); break;
    case 'evolve': burst(e.x, e.y, 30, '#b98cff'); effects.push({ k: 'ring', x: e.x, y: e.y, r: 90, c: '#b98cff', t: 0, life: 0.7 }); break;
    case 'death': if (!lowFx) burst(e.x, e.y, e.b ? 24 : 5, e.p ? '#d63a4f' : '#9a86b4'); if (e.b) Sound.death(); break;
    case 'hit':   if (e.p === 1 && nearMe(e.x, e.y, 60)) Sound.damage(); break;
    case 'chest': effects.push({ k: 'ring', x: e.x, y: e.y, r: 40, c: '#e8c873', t: 0, life: 0.5 }); break;
    case 'vacuum': effects.push({ k: 'ring', x: e.x, y: e.y, r: 1400, c: '#5fd0ff', t: 0, life: 0.5 }); break;
  }
}

function nearMe(x, y, d) {
  const me = curSnap && curSnap.me; if (!me) return false;
  return Math.hypot(me.x - x, me.y - y) < d;
}

function burst(x, y, n, color) {
  if (lowFx) n = Math.max(2, n >> 2);
  for (let i = 0; i < n; i++) {
    const p = particlePool.pop() || {};
    const a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 140;
    p.x = x; p.y = y; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
    p.life = 0.4 + Math.random() * 0.3; p.t = 0; p.c = color; p.r = 2 + Math.random() * 2.5;
    effects.push({ k: 'particle', p });
  }
}

/* =====================================================================
 * INPUT (keyboard + mobile stick)
 * ===================================================================== */
const KEYBITS = {
  KeyW: 1, ArrowUp: 1, KeyS: 2, ArrowDown: 2,
  KeyA: 4, ArrowLeft: 4, KeyD: 8, ArrowRight: 8,
};
window.addEventListener('keydown', (e) => {
  if (!controlsActive) return;
  if (e.code === 'Escape') { controlsActive = false; return; }
  const b = KEYBITS[e.code];
  if (b) { inputMask |= b; e.preventDefault(); pushInput(); }
});
window.addEventListener('keyup', (e) => {
  const b = KEYBITS[e.code];
  if (b) { inputMask &= ~b; pushInput(); }
});
function pushInput() {
  if (inputMask !== lastSentMask) { lastSentMask = inputMask; send({ t: 'in', k: inputMask }); }
}
// clicking the canvas re-enables controls
canvas.addEventListener('mousedown', () => { if (connected && !spectator) controlsActive = true; Sound.resume(); });

/* mobile joystick */
const stickEl = $('stick'), knobEl = $('stick-knob');
let stickId = null, stickCx = 0, stickCy = 0;
const isTouch = ('ontouchstart' in window);
if (isTouch) {
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd);
  canvas.addEventListener('touchcancel', onTouchEnd);
}
function onTouchStart(e) {
  if (!connected || spectator) return;
  controlsActive = true; Sound.resume();
  const t = e.changedTouches[0];
  stickId = t.identifier; stickCx = t.clientX; stickCy = t.clientY;
  stickEl.style.left = (stickCx - 65) + 'px'; stickEl.style.top = (stickCy - 65) + 'px';
  stickEl.classList.remove('hidden');
  e.preventDefault();
}
function onTouchMove(e) {
  if (stickId === null) return;
  for (const t of e.changedTouches) {
    if (t.identifier !== stickId) continue;
    let dx = t.clientX - stickCx, dy = t.clientY - stickCy;
    const d = Math.hypot(dx, dy), max = 50;
    if (d > max) { dx = dx / d * max; dy = dy / d * max; }
    knobEl.style.left = (37 + dx) + 'px'; knobEl.style.top = (37 + dy) + 'px';
    let mask = 0; const dead = 12;
    if (dy < -dead) mask |= 1; if (dy > dead) mask |= 2;
    if (dx < -dead) mask |= 4; if (dx > dead) mask |= 8;
    inputMask = mask; pushInput();
    e.preventDefault();
  }
}
function onTouchEnd(e) {
  for (const t of e.changedTouches) if (t.identifier === stickId) {
    stickId = null; inputMask = 0; pushInput();
    stickEl.classList.add('hidden'); knobEl.style.left = '37px'; knobEl.style.top = '37px';
  }
}

/* settings buttons */
$('mute-btn').onclick = (e) => { muted = !muted; e.target.classList.toggle('off', muted); };
$('lowfx-btn').onclick = (e) => { lowFx = !lowFx; e.target.classList.toggle('off', lowFx); };
$('lvl-bank').onclick = (e) => { e.stopPropagation(); bankLevelUp(); };
$('lvl-reopen').onclick = (e) => { e.stopPropagation(); reopenLevelUp(); };

/* =====================================================================
 * LEVEL UP UI
 * ===================================================================== */
/* ---------------------- LEVEL-UP: bottom dock with banking ---------------------- */
let lvlOpts = null;      // current option set (front of server queue)
let lvlPending = 0;      // total level-ups waiting (shown + banked)
let lvlBanked = false;   // player chose to bank and hide the panel

function evolveHint(o) {
  // For weapon cards, show what passive evolves them (readability boost)
  if ((o.kind === 'wup' || o.kind === 'wnew') && evoDefs && evoDefs[o.wid]) {
    const pid = evoDefs[o.wid].passive;
    const pname = (passiveDefs && passiveDefs[pid] && passiveDefs[pid].name) || pid;
    return `<div class="card-evo">★ Max + ${pname} → evolves</div>`;
  }
  return '';
}

function updateLevelUI(opts, pending) {
  lvlPending = pending;
  if (opts) lvlOpts = opts;

  // badge that lets a banking player reopen the panel
  const badge = $('lvl-reopen');
  if (pending > 0) {
    badge.textContent = '⬆ ' + pending + ' upgrade' + (pending > 1 ? 's' : '') + ' ready — tap';
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  if (!opts || pending === 0) {
    // nothing left to choose
    levelupEl.classList.add('hidden');
    lvlBanked = false;
    lvlOpts = null;
    return;
  }

  if (lvlBanked) {
    // keep panel hidden, just leave the badge updated
    return;
  }
  renderLevelCards();
  Sound.levelup();
  flashLevelFx();
}

function renderLevelCards() {
  const wrap = $('lvl-cards'); wrap.innerHTML = '';
  for (const o of lvlOpts) {
    const card = document.createElement('div');
    card.className = 'card';
    let icon = '◈';
    if (o.kind === 'wup' || o.kind === 'wnew') icon = WEAPON_ICON[o.wid] || '⚔️';
    else if (o.kind === 'pup' || o.kind === 'pnew') icon = PASSIVE_ICON[o.pid] || '🔮';
    else if (o.kind === 'gold') icon = '💰';
    else if (o.kind === 'heal') icon = '✚';
    const tagText = { wup: 'UPGRADE', wnew: 'NEW WEAPON', pup: 'UPGRADE', pnew: 'NEW PASSIVE', gold: 'BONUS', heal: 'BONUS' }[o.kind] || '';
    card.innerHTML =
      `<div class="card-icon">${icon}</div>
       <div class="card-tag tag-${o.kind}">${tagText}</div>
       <div class="card-name">${o.name}${o.lv ? ' <span class="card-lv">Lv ' + o.lv + '</span>' : ''}</div>
       <div class="card-desc">${o.desc || ''}</div>
       ${evolveHint(o)}`;
    card.onclick = () => {
      send({ t: 'pick', id: o.id });
      // server will push the next state (more cards or clear); no manual hide
    };
    wrap.appendChild(card);
  }
  // pending badge inside the panel
  const q = $('lvl-queue');
  if (lvlPending > 1) { q.textContent = '+' + (lvlPending - 1) + ' more queued'; q.classList.remove('hidden'); }
  else q.classList.add('hidden');

  levelupEl.classList.remove('hidden');
}

function bankLevelUp() {
  lvlBanked = true;
  levelupEl.classList.add('hidden');
  // badge already reflects pending count
}

function reopenLevelUp() {
  if (!lvlOpts || lvlPending === 0) return;
  lvlBanked = false;
  renderLevelCards();
}

// brief screen-edge glow + shake hint so a new level-up grabs attention
let levelFx = 0;
function flashLevelFx() { levelFx = 0.6; }


function showGameOver(reason) {
  $('over-title').textContent = reason === 'survived' ? 'YOU SURVIVED' : 'LEGION FALLEN';
  $('over-sub').textContent = reason === 'survived'
    ? 'The Ashfall could not consume you.'
    : 'The whole legion was overwhelmed.';
  // team summary from the latest leaderboard snapshot
  const lb = curSnap && curSnap.lb;
  const sub = $('over-sub');
  if (lb && (lb.k && lb.k.length)) {
    const topKill = lb.k[0], topLvl = (lb.l && lb.l[0]) || topKill;
    let extra = document.getElementById('over-summary');
    if (!extra) { extra = document.createElement('div'); extra.id = 'over-summary'; extra.className = 'over-summary'; sub.parentNode.insertBefore(extra, sub.nextSibling); }
    extra.innerHTML =
      `<div>🏆 Most kills: <b>${topKill.n}</b> (${topKill.k})</div>` +
      `<div>⭐ Highest level: <b>${topLvl.n}</b> (Lv ${topLvl.l})</div>` +
      `<div>⏱ Survived: <b>${fmtTime(curSnap.tm || 0)}</b></div>`;
  }
  gameoverEl.classList.remove('hidden');
}

let toastTimer = null;
function toast(text) {
  toastEl.textContent = text; toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2600);
}

/* =====================================================================
 * INTERPOLATION HELPERS
 * ===================================================================== */
function mapById(list) { const m = new Map(); if (list) for (const e of list) m.set(e.i, e); return m; }

function lerpEntities(prevList, curList, alpha, cb) {
  const pm = mapById(prevList);
  if (!curList) return;
  for (const c of curList) {
    const p = pm.get(c.i);
    const x = p ? p.x + (c.x - p.x) * alpha : c.x;
    const y = p ? p.y + (c.y - p.y) * alpha : c.y;
    cb(c, x, y);
  }
}

/* =====================================================================
 * RENDER LOOP
 * ===================================================================== */
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  // fps
  frames++; fpsTimer += dt;
  if (fpsTimer >= 0.5) { fps = Math.round(frames / fpsTimer); frames = 0; fpsTimer = 0; }

  // interpolation alpha
  let alpha = 1;
  if (curSnap && prevSnap) {
    const span = Math.max(1, curTime - prevTime);
    alpha = Math.min(1.3, (now - curTime) / span); // small extrapolation tolerance
    alpha = Math.max(0, alpha);
  }

  render(alpha, dt);
  updateHud();
  requestAnimationFrame(frame);
}

function render(alpha, dt) {
  const W = canvas.width, H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0a0710';
  ctx.fillRect(0, 0, W, H);

  if (!curSnap) { return; }

  // camera follows self (interpolated)
  let mePrev = prevSnap && prevSnap.me, meCur = curSnap.me;
  let mx = meCur.x, my = meCur.y;
  if (mePrev) { mx = mePrev.x + (meCur.x - mePrev.x) * alpha; my = mePrev.y + (meCur.y - mePrev.y) * alpha; }
  camX = mx; camY = my;

  ctx.save();
  ctx.scale(DPR, DPR);
  const vw = window.innerWidth, vh = window.innerHeight;
  ctx.translate(vw / 2 - camX, vh / 2 - camY);

  drawBackground(vw, vh);

  // gems
  lerpEntities(prevSnap.G, curSnap.G, alpha, drawGem);
  // chests / anvils
  if (curSnap.C) for (const c of curSnap.C) drawChest(c.x, c.y);
  // enemies
  lerpEntities(prevSnap.E, curSnap.E, alpha, drawEnemy);
  // enemy projectiles (boss / hexer bullets)
  lerpEntities(prevSnap.S, curSnap.S, alpha, drawEnemyShot);
  // player projectiles
  lerpEntities(prevSnap.R, curSnap.R, alpha, drawProjectile);
  // players (others + self)
  lerpEntities(prevSnap.P, curSnap.P, alpha, drawPlayer);
  // effects on top
  drawEffects(dt);

  ctx.restore();

  // screen-space overlays (CSS-pixel coords; scale by DPR so they sit correctly)
  ctx.save();
  ctx.scale(DPR, DPR);
  drawOffscreenArrows(vw, vh, mx, my);
  drawMinimap(vw, vh, mx, my);
  drawLevelEdgeGlow(vw, vh, dt);
  ctx.restore();
}

// Yellow bullet for enemy shots
function drawEnemyShot(s, x, y) {
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = s.c || '#ff5470';
  ctx.shadowColor = s.c || '#ff5470'; ctx.shadowBlur = lowFx ? 0 : 8;
  ctx.beginPath(); ctx.arc(0, 0, s.r || 7, 0, 7); ctx.fill();
  ctx.restore();
}

// Edge arrows pointing to off-screen bosses, anvils, and allies
function drawOffscreenArrows(vw, vh, mx, my) {
  const cx = vw / 2, cy = vh / 2, margin = 46;
  const pts = [];
  if (curSnap.E) for (const e of curSnap.E) { if (e.f & 1) pts.push({ x: e.x, y: e.y, c: '#ff5470', label: 'BOSS' }); }
  if (curSnap.C) for (const c of curSnap.C) pts.push({ x: c.x, y: c.y, c: '#e8c873', label: 'ANVIL' });
  if (curSnap.P) for (const p of curSnap.P) { if (p.i !== myId && !p.d) pts.push({ x: p.x, y: p.y, c: 'rgba(150,200,160,0.8)', label: '' }); }

  ctx.save();
  ctx.font = 'bold 10px Inter, system-ui, sans-serif'; ctx.textAlign = 'center';
  for (const pt of pts) {
    const sx = cx + (pt.x - mx), sy = cy + (pt.y - my);
    if (sx > margin && sx < vw - margin && sy > margin && sy < vh - margin) continue; // on screen
    const ang = Math.atan2(pt.y - my, pt.x - mx);
    const ex = cx + Math.cos(ang) * (Math.min(vw, vh) / 2 - margin);
    const ey = cy + Math.sin(ang) * (Math.min(vw, vh) / 2 - margin);
    ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
    ctx.fillStyle = pt.c; ctx.shadowColor = pt.c; ctx.shadowBlur = lowFx ? 0 : 8;
    ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-8, -7); ctx.lineTo(-8, 7); ctx.closePath(); ctx.fill();
    ctx.restore();
    if (pt.label) { ctx.fillStyle = pt.c; ctx.fillText(pt.label, ex, ey - 12); }
  }
  ctx.restore();
}

// Small corner minimap of the whole world with dots
function drawMinimap(vw, vh, mx, my) {
  const size = Math.min(150, vw * 0.26);
  const pad = 12, x0 = vw - size - pad, y0 = vh - size - pad;
  const ws = worldSize || { w: 6000, h: 6000 };
  const sx = size / ws.w, sy = size / ws.h;
  ctx.save();
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = 'rgba(10,7,16,0.7)';
  ctx.strokeStyle = 'rgba(185,140,255,0.35)'; ctx.lineWidth = 1.5;
  ctx.fillRect(x0, y0, size, size); ctx.strokeRect(x0, y0, size, size);
  const dot = (wx, wy, c, r) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x0 + wx * sx, y0 + wy * sy, r, 0, 7); ctx.fill(); };
  if (curSnap.C) for (const c of curSnap.C) dot(c.x, c.y, '#e8c873', 3);
  if (curSnap.E) for (const e of curSnap.E) { if (e.f & 1) dot(e.x, e.y, '#ff5470', 3.5); }
  if (curSnap.P) for (const p of curSnap.P) { if (!p.d) dot(p.x, p.y, p.i === myId ? '#fff7d8' : '#8fd6a0', p.i === myId ? 3.5 : 2.5); }
  ctx.restore();
}

// Pulsing edge glow when a new level-up is available
function drawLevelEdgeGlow(vw, vh, dt) {
  if (levelFx > 0) levelFx = Math.max(0, levelFx - dt);
  const persist = (lvlPending > 0) ? 0.18 : 0;
  const a = Math.max(persist, levelFx) ;
  if (a <= 0) return;
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
  ctx.save();
  const g = ctx.createLinearGradient(0, 0, 0, vh);
  const col = `rgba(232,200,115,${(a * (0.4 + 0.6 * pulse)).toFixed(3)})`;
  g.addColorStop(0, col); g.addColorStop(0.12, 'rgba(0,0,0,0)');
  g.addColorStop(0.88, 'rgba(0,0,0,0)'); g.addColorStop(1, col);
  ctx.fillStyle = g; ctx.fillRect(0, 0, vw, vh);
  ctx.restore();
}

function drawBackground(vw, vh) {
  // subtle grid + arena boundary
  const grid = 120;
  const left = camX - vw / 2 - grid, right = camX + vw / 2 + grid;
  const top = camY - vh / 2 - grid, bottom = camY + vh / 2 + grid;
  ctx.strokeStyle = 'rgba(185,140,255,0.05)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.floor(left / grid) * grid; x < right; x += grid) { ctx.moveTo(x, top); ctx.lineTo(x, bottom); }
  for (let y = Math.floor(top / grid) * grid; y < bottom; y += grid) { ctx.moveTo(left, y); ctx.lineTo(right, y); }
  ctx.stroke();
  // world bounds
  ctx.strokeStyle = 'rgba(214,58,79,0.25)'; ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, worldSize.w, worldSize.h);
}

function drawGem(g, x, y) {
  if (g.k && g.k !== 'xp') { drawSpecial(g.k, x, y); return; }
  const c = GEM_COLOR[g.v] || GEM_COLOR[0];
  const s = 4 + g.v * 1.5;
  ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
  ctx.fillStyle = c; ctx.shadowColor = c; ctx.shadowBlur = lowFx ? 0 : 8;
  ctx.fillRect(-s, -s, s * 2, s * 2);
  ctx.restore();
}
function drawSpecial(kind, x, y) {
  ctx.save(); ctx.translate(x, y);
  if (kind === 'gold') { ctx.fillStyle = '#e8c873'; ctx.beginPath(); ctx.arc(0, 0, 6, 0, 7); ctx.fill(); }
  else if (kind === 'heal') { ctx.fillStyle = '#6fe09a'; ctx.fillRect(-2, -7, 4, 14); ctx.fillRect(-7, -2, 14, 4); }
  else if (kind === 'bomb') { ctx.fillStyle = '#ff7a45'; ctx.beginPath(); ctx.arc(0, 0, 8, 0, 7); ctx.fill(); ctx.fillStyle = '#000'; ctx.font = '10px serif'; ctx.textAlign = 'center'; ctx.fillText('✦', 0, 4); }
  else if (kind === 'vacuum') { ctx.strokeStyle = '#5fd0ff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 8, 0, 7); ctx.stroke(); }
  ctx.restore();
}

function drawChest(x, y) {
  ctx.save(); ctx.translate(x, y);
  const pulse = 1 + Math.sin(performance.now() / 200) * 0.08;
  ctx.scale(pulse, pulse);
  ctx.fillStyle = '#e8c873'; ctx.shadowColor = '#e8c873'; ctx.shadowBlur = lowFx ? 0 : 16;
  ctx.fillRect(-14, -10, 28, 20);
  ctx.fillStyle = '#a8842e'; ctx.fillRect(-14, -2, 28, 4);
  ctx.fillStyle = '#fff7d8'; ctx.fillRect(-3, -3, 6, 8);
  ctx.restore();
}

function drawEnemy(e, x, y) {
  const st = ENEMY_STYLE[e.t] || ENEMY_STYLE.ghoul;
  const r = st.r;
  ctx.save(); ctx.translate(x, y);
  ctx.globalAlpha = st.ghost ? 0.55 : 1;
  ctx.fillStyle = (e.f & 2) ? '#9fd0ff' : st.c; // frozen tint
  if (!lowFx && st.boss) { ctx.shadowColor = st.c; ctx.shadowBlur = 20; }
  if (st.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill(); }
  else if (st.shape === 'square') { ctx.fillRect(-r, -r, r * 2, r * 2); }
  else { ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r, r); ctx.lineTo(-r, r); ctx.closePath(); ctx.fill(); }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  // boss hp bar
  if ((e.f & 1) && e.H) {
    const w = r * 2.4, ratio = Math.max(0, e.h / e.H);
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(-w / 2, -r - 14, w, 6);
    ctx.fillStyle = '#d63a4f'; ctx.fillRect(-w / 2, -r - 14, w * ratio, 6);
  }
  ctx.restore();
}

function drawProjectile(pr, x, y) {
  ctx.save(); ctx.translate(x, y);
  const w = pr.w;
  if (w.startsWith('arrow')) {
    ctx.rotate(pr.a); ctx.fillStyle = '#bfe6ff'; ctx.shadowColor = '#7fd0ff'; ctx.shadowBlur = lowFx ? 0 : 6;
    ctx.fillRect(-7, -1.5, 14, 3);
  } else { // ember
    ctx.fillStyle = '#ff8a45'; ctx.shadowColor = '#ff7a45'; ctx.shadowBlur = lowFx ? 0 : 10;
    ctx.beginPath(); ctx.arc(0, 0, w.includes('evo') ? 8 : 5, 0, 7); ctx.fill();
  }
  ctx.restore();
}

function drawPlayer(p, x, y) {
  const isMe = p.i === myId;
  ctx.save(); ctx.translate(x, y);

  // persistent weapon visuals (orbits / auras)
  if (p.w) for (const [wid, lv] of p.w) {
    if (wid === 'bone' || wid === 'bone_evo') drawBoneOrbit(lv, wid === 'bone_evo');
    if (wid === 'pulse_evo') drawAura(190, 'rgba(255,230,179,0.10)');
    if (wid === 'frost_evo') drawAura(210, 'rgba(159,208,255,0.10)');
  }

  if (p.d) ctx.globalAlpha = 0.4; // dead ghost

  // self highlight ring
  if (isMe) {
    ctx.strokeStyle = '#fff7d8'; ctx.lineWidth = 2.5;
    ctx.shadowColor = '#fff7d8'; ctx.shadowBlur = lowFx ? 0 : 14;
    ctx.beginPath(); ctx.arc(0, 0, 20, 0, 7); ctx.stroke(); ctx.shadowBlur = 0;
  }

  // body
  ctx.fillStyle = p.col || '#e8d8a0';
  ctx.beginPath(); ctx.arc(0, 0, 14, 0, 7); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.beginPath(); ctx.arc(0, -3, 5, 0, 7); ctx.fill();
  ctx.globalAlpha = 1;

  // name + hp
  ctx.font = '11px Spectral, serif'; ctx.textAlign = 'center';
  ctx.fillStyle = isMe ? '#fff7d8' : '#cdbce0';
  ctx.fillText(p.n + (p.d ? ' †' : ''), 0, -24);
  const w = 30, ratio = Math.max(0, p.h / p.H);
  ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(-w / 2, -20, w, 4);
  ctx.fillStyle = p.d ? '#6fe09a' : '#d63a4f';
  ctx.fillRect(-w / 2, -20, w * (p.d ? p.rp : ratio), 4);

  ctx.restore();
}

function drawBoneOrbit(lv, evo) {
  const count = (evo ? 5 : 3) + Math.floor((lv - 1) / 2);
  const radius = (evo ? 130 : 90);
  const t = performance.now() / 1000 * 3.2;
  for (let i = 0; i < count; i++) {
    const a = t + (i / count) * Math.PI * 2;
    const ox = Math.cos(a) * radius, oy = Math.sin(a) * radius;
    ctx.fillStyle = '#e8e2d0'; ctx.shadowColor = '#fff'; ctx.shadowBlur = lowFx ? 0 : 6;
    ctx.beginPath(); ctx.arc(ox, oy, 6, 0, 7); ctx.fill();
  }
  ctx.shadowBlur = 0;
}
function drawAura(r, color) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
}

function drawEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const fx = effects[i];
    fx.t += dt;
    if (fx.k === 'particle') {
      const p = fx.p; p.t += dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92;
      const a = 1 - p.t / p.life;
      if (a <= 0) { particlePool.push(p); effects.splice(i, 1); continue; }
      ctx.globalAlpha = a; ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      continue;
    }
    const prog = fx.t / fx.life;
    if (prog >= 1) { effects.splice(i, 1); continue; }
    if (fx.k === 'ring') {
      ctx.globalAlpha = 1 - prog; ctx.strokeStyle = fx.c; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(fx.x, fx.y, fx.r * prog, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
    } else if (fx.k === 'slash') {
      ctx.globalAlpha = 1 - prog; ctx.strokeStyle = fx.evo ? '#cfe8ff' : '#fff7d8';
      ctx.lineWidth = fx.evo ? 6 : 4;
      ctx.beginPath(); ctx.arc(fx.x, fx.y, fx.r, -0.6 + prog * 2, 1.2 + prog * 2); ctx.stroke();
      if (fx.evo) { ctx.beginPath(); ctx.arc(fx.x, fx.y, fx.r, Math.PI - 0.6 + prog * 2, Math.PI + 1.2 + prog * 2); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
  }
}

/* =====================================================================
 * HUD UPDATE
 * ===================================================================== */
function fmtTime(sec) { const m = Math.floor(sec / 60), s = sec % 60; return m + ':' + (s < 10 ? '0' : '') + s; }

let lastWeaponSig = '', lastPassiveSig = '';
function updateHud() {
  if (!curSnap || !curSnap.me) return;
  const me = curSnap.me;

  $('hud-time').textContent = fmtTime(curSnap.tm || 0);
  $('hud-players').textContent = (curSnap.pc || 0) + '/' + (curSnap.cap || 0);
  $('hud-ping').textContent = ping + 'ms';
  $('hud-fps').textContent = fps;

  $('hud-name').textContent = nameInput.value.trim() || 'Hero';
  $('hud-level').textContent = me.lv;
  $('hud-kills').textContent = me.kills;
  $('hud-gold').textContent = me.gold;

  const hpRatio = Math.max(0, me.hp / me.mhp);
  $('hp-fill').style.width = (hpRatio * 100) + '%';
  $('hp-text').textContent = me.hp + ' / ' + me.mhp;
  $('xp-fill').style.width = Math.min(100, (me.xp / me.nx) * 100) + '%';

  // loadout (only rebuild when changed)
  const wsig = JSON.stringify(me.w);
  if (wsig !== lastWeaponSig) {
    lastWeaponSig = wsig; const row = $('weapon-row'); row.innerHTML = '';
    for (const [wid, lv] of me.w) {
      const d = document.createElement('div');
      const evo = wid.includes('_evo');
      d.className = 'slot' + (evo ? ' evo' : '');
      d.innerHTML = `${WEAPON_ICON[wid] || '⚔️'}<span class="lv">${evo ? '★' : lv}</span>`;
      row.appendChild(d);
    }
  }
  const psig = JSON.stringify(me.ps);
  if (psig !== lastPassiveSig) {
    lastPassiveSig = psig; const row = $('passive-row'); row.innerHTML = '';
    for (const [pid, lv] of me.ps) {
      const d = document.createElement('div'); d.className = 'slot passive';
      d.innerHTML = `${PASSIVE_ICON[pid] || '🔮'}<span class="lv">${lv}</span>`;
      row.appendChild(d);
    }
  }

  // leaderboard
  if (curSnap.lb) {
    fillLb('lb-kills', curSnap.lb.k, 'k');
    fillLb('lb-level', curSnap.lb.l, 'l');
  }

  // death overlay revive bar
  if (me.dead) {
    $('revive-fill').style.width = (me.rp * 100) + '%';
    $('death-rev').textContent = 'Revives left: ' + me.rev;
  }
}

function fillLb(elId, arr, field) {
  const ol = $(elId); ol.innerHTML = '';
  const myName = nameInput.value.trim();
  for (const e of arr) {
    const li = document.createElement('li');
    if (e.n === myName) li.className = 'me';
    li.innerHTML = `<span>${e.n}</span><b>${e[field]}</b>`;
    ol.appendChild(li);
  }
}

/* =====================================================================
 * GO
 * ===================================================================== */
requestAnimationFrame(frame);
