/* =====================================================================
 * ASHFALL LEGION  —  Authoritative online co-op survivors-like server
 * Node.js + Express (static) + ws (WebSocket)
 *
 * The server owns ALL game truth: positions, enemy AI, auto-attacks,
 * damage, XP, levels, bosses, chests, evolutions, leaderboard.
 * Clients only send: join / movement input / upgrade pick / ping.
 * ===================================================================== */

'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

/* =====================================================================
 * CONFIG  (tweak everything here)
 * ===================================================================== */
const CONFIG = {
  PORT: process.env.PORT || 3000,

  TICK_RATE: 20,                 // server simulation ticks per second
  SNAPSHOT_RATE: 20,             // state broadcasts per second (<= TICK_RATE)

  MAX_PLAYERS_DEFAULT: 50,
  MAX_PLAYERS_HARD: 100,         // absolute cap; extra connections spectate
  MAX_PLAYERS: 50,               // active value (clamped to HARD below)

  NAME_MAX_LEN: 16,
  INPUT_RATE_LIMIT: 80,          // max messages per second per socket

  // Run length
  DEBUG_RUN_MINUTES: 10,
  NORMAL_RUN_MINUTES: 30,
  RUN_MINUTES: 30,               // active value

  WORLD: { w: 6000, h: 6000 },   // playfield bounds (wraps softly via clamp)
  VIEW_RADIUS: 950,              // per-player culling radius for snapshots

  // Enemy scaling
  baseEnemyCap: 150,
  enemyCapMaxHard: 1200,
  baseSpawnRate: 7,              // spawns per second at 1 player, time 0
  enemyHPPerPlayer: 0.08,
  bossHPPerPlayer: 0.35,
  spawnRatePerPlayer: 0.06,

  GEM_MERGE_RADIUS: 26,          // merge nearby low gems when too many
  GEM_SOFT_CAP: 600,             // above this, aggressively merge

  REVIVE_RADIUS: 140,
  REVIVE_TIME: 5,                // seconds of ally proximity to revive
  REVIVE_LIMIT: 3,               // revives per player per run
  CONTACT_DAMAGE_CD: 0.5,        // seconds between an enemy's contact hits
};
CONFIG.MAX_PLAYERS = Math.min(CONFIG.MAX_PLAYERS_DEFAULT, CONFIG.MAX_PLAYERS_HARD);
CONFIG.RUN_MINUTES = CONFIG.NORMAL_RUN_MINUTES; // set to DEBUG_RUN_MINUTES for quick tests

const DT = 1 / CONFIG.TICK_RATE;

/* =====================================================================
 * STATIC DATA — characters / weapons / passives / evolutions / enemies
 * ===================================================================== */

const CHARACTERS = {
  knight: { name: 'Knight',  color: '#e8d8a0', startWeapon: 'arc',   hpMul: 1.10 },
  witch:  { name: 'Witch',   color: '#b98cff', startWeapon: 'ember', hpMul: 0.90, areaMul: 1.15 },
  ranger: { name: 'Ranger',  color: '#7fd6a0', startWeapon: 'arrow', hpMul: 1.00, armorMul: 0.95, amount: 1 },
  cleric: { name: 'Cleric',  color: '#ffe6b3', startWeapon: 'pulse', hpMul: 1.05, regen: 1.2, allyAura: true },
};

// Weapon definitions. dmg/interval scale per level (lv 1..8).
const WEAPONS = {
  arc:   { name: 'Arc Blade',    slot: 'melee',  baseDmg: 14, interval: 1.05, baseRange: 95,  evolveWith: 'war',     evolveTo: 'arc_evo' },
  ember: { name: 'Ember Orb',    slot: 'proj',   baseDmg: 18, interval: 1.30, projSpeed: 360, splash: 70, evolveWith: 'lens',  evolveTo: 'ember_evo' },
  arrow: { name: 'Spirit Arrow', slot: 'proj',   baseDmg: 12, interval: 0.85, projSpeed: 560, pierce: 1,  evolveWith: 'quick', evolveTo: 'arrow_evo' },
  pulse: { name: 'Holy Pulse',   slot: 'aura',   baseDmg: 10, interval: 1.40, baseRange: 130, heal: 6,    evolveWith: 'iron',  evolveTo: 'pulse_evo' },
  frost: { name: 'Frost Bell',   slot: 'aura',   baseDmg: 6,  interval: 1.10, baseRange: 150, slow: 0.45, evolveWith: 'magnet',evolveTo: 'frost_evo' },
  bone:  { name: 'Bone Orbit',   slot: 'orbit',  baseDmg: 11, interval: 0.45, baseRange: 90,  evolveWith: 'scholar',evolveTo: 'bone_evo' },

  // Evolutions (level locked at 8 visuals; stronger + changed behavior)
  arc_evo:   { name: 'Storm Cleaver',    slot: 'melee', baseDmg: 30, interval: 0.80, baseRange: 150, evolved: true },
  ember_evo: { name: 'Inferno Sun',      slot: 'proj',  baseDmg: 34, interval: 1.05, projSpeed: 380, splash: 95, burn: true, evolved: true },
  arrow_evo: { name: 'Phantom Barrage',  slot: 'proj',  baseDmg: 20, interval: 0.55, projSpeed: 620, pierce: 3, rain: true, evolved: true },
  pulse_evo: { name: 'Divine Sanctuary', slot: 'aura',  baseDmg: 22, interval: 1.00, baseRange: 190, heal: 14, evolved: true },
  frost_evo: { name: 'Winter Cathedral', slot: 'aura',  baseDmg: 14, interval: 0.90, baseRange: 210, slow: 0.7, freeze: true, evolved: true },
  bone_evo:  { name: 'Bone Tempest',     slot: 'orbit', baseDmg: 22, interval: 0.30, baseRange: 130, evolved: true },
};

const PASSIVES = {
  iron:    { name: 'Iron Heart',    stat: 'maxHp',     per: 0.12, type: 'mul' },
  war:     { name: 'War Emblem',    stat: 'might',     per: 0.12, type: 'mul' },
  lens:    { name: 'Silver Lens',   stat: 'area',      per: 0.10, type: 'mul' },
  quick:   { name: 'Quick Charm',   stat: 'cooldown',  per: 0.08, type: 'cdr' }, // reduces interval
  magnet:  { name: 'Magnet Stone',  stat: 'magnet',    per: 0.30, type: 'mul' },
  scholar: { name: 'Scholar Crown', stat: 'growth',    per: 0.10, type: 'mul' },
  gold:    { name: 'Gold Fang',     stat: 'greed',     per: 0.15, type: 'mul' },
  boots:   { name: 'Swift Boots',   stat: 'moveSpeed', per: 0.08, type: 'mul' },
};

// weapon -> required passive -> evolved id  (computed from WEAPONS)
const EVOLUTIONS = {};
for (const wid in WEAPONS) {
  const w = WEAPONS[wid];
  if (w.evolveWith && w.evolveTo) EVOLUTIONS[wid] = { passive: w.evolveWith, to: w.evolveTo };
}

const ENEMIES = {
  bat:    { name: 'Bat',         hp: 16,  speed: 165, r: 12, dmg: 6,  xp: 1, color: '#7a6fb0' },
  ghoul:  { name: 'Ghoul',       hp: 28,  speed: 105, r: 15, dmg: 9,  xp: 1, color: '#6fb07a' },
  brute:  { name: 'Brute',       hp: 80,  speed: 70,  r: 22, dmg: 16, xp: 2, color: '#b07a6f' },
  wraith: { name: 'Wraith',      hp: 24,  speed: 150, r: 14, dmg: 8,  xp: 2, color: '#9fd0ff' },
  crawl:  { name: 'Crawler',     hp: 10,  speed: 120, r: 9,  dmg: 5,  xp: 1, color: '#c9b06f' },
  elite:  { name: 'Elite Brute', hp: 240, speed: 80,  r: 28, dmg: 24, xp: 6, color: '#ff8a5c' },
  // variety types
  bomber: { name: 'Bomber',      hp: 40,  speed: 95,  r: 16, dmg: 10, xp: 2, color: '#ff7a45', explode: 36 }, // AoE on death
  shooter:{ name: 'Hexer',       hp: 34,  speed: 70,  r: 15, dmg: 8,  xp: 2, color: '#c97aff', ranged: true }, // fires slow bolts
  runner: { name: 'Gold Runner', hp: 120, speed: 230, r: 14, dmg: 0,  xp: 3, color: '#ffd86b', flee: true }, // treasure event, flees
};

const BOSSES = {
  batlord:    { name: 'Giant Bat Lord',  hp: 2600,  speed: 95, r: 50, dmg: 26, xp: 60, color: '#9b6fff' },
  graveknight:{ name: 'Grave Knight',    hp: 4200,  speed: 75, r: 58, dmg: 36, xp: 90, color: '#cfd2d6' },
  crimson:    { name: 'Crimson Wraith',  hp: 6500,  speed: 130,r: 54, dmg: 40, xp: 130,color: '#ff5470' },
  reaper:     { name: 'The Last Reaper', hp: 14000, speed: 110,r: 70, dmg: 60, xp: 300,color: '#ff2b2b' },
};

// Boss schedule as fraction of total run length -> boss id
const BOSS_SCHEDULE = [
  { f: 0.166, id: 'batlord',    done: false },  // ~5 min @30
  { f: 0.500, id: 'graveknight',done: false },  // ~15 min
  { f: 0.760, id: 'crimson',    done: false },  // ~23 min
  { f: 0.980, id: 'reaper',     done: false },  // final
];

/* =====================================================================
 * WORLD STATE
 * ===================================================================== */
let nextId = 1;
const id = () => nextId++;

const world = {
  players: new Map(),     // sockId -> player
  enemies: new Map(),     // id -> enemy
  gems: new Map(),        // id -> gem
  projectiles: new Map(), // id -> projectile (player)
  enemyShots: new Map(),  // id -> enemy projectile (bosses / shooters)
  chests: new Map(),      // id -> chest (boss Anvil)
  events: [],             // transient visual events for this snapshot
  time: 0,                // elapsed run seconds
  running: false,
  gameOverAt: 0,
  eventCd: 35,            // seconds until next special event (treasure runner)
};

function resetWorld() {
  world.enemies.clear();
  world.gems.clear();
  world.projectiles.clear();
  world.enemyShots.clear();
  world.chests.clear();
  world.events.length = 0;
  world.time = 0;
  world.running = false;
  world.gameOverAt = 0;
  world.eventCd = 35;
  for (const b of BOSS_SCHEDULE) b.done = false;
  // respawn living players fresh at center
  for (const p of world.players.values()) respawnPlayer(p);
}

/* =====================================================================
 * SPATIAL GRID  (simple uniform grid for neighbour queries)
 * ===================================================================== */
const CELL = 200;
function makeGrid() { return new Map(); }
function gkey(x, y) { return ((x / CELL) | 0) + ':' + ((y / CELL) | 0); }
function gridInsert(grid, ent) {
  const k = gkey(ent.x, ent.y);
  let arr = grid.get(k);
  if (!arr) { arr = []; grid.set(k, arr); }
  arr.push(ent);
}
function gridQuery(grid, x, y, radius, out) {
  out.length = 0;
  const cx = (x / CELL) | 0, cy = (y / CELL) | 0;
  const range = Math.ceil(radius / CELL);
  for (let gx = cx - range; gx <= cx + range; gx++) {
    for (let gy = cy - range; gy <= cy + range; gy++) {
      const arr = grid.get(gx + ':' + gy);
      if (arr) for (let i = 0; i < arr.length; i++) out.push(arr[i]);
    }
  }
  return out;
}

/* =====================================================================
 * PLAYER
 * ===================================================================== */
function makePlayer(sock, name, charId) {
  const ch = CHARACTERS[charId] ? charId : 'knight';
  const c = CHARACTERS[ch];
  const p = {
    id: id(),
    sock,
    name,
    char: ch,
    color: c.color,
    x: CONFIG.WORLD.w / 2 + (Math.random() * 200 - 100),
    y: CONFIG.WORLD.h / 2 + (Math.random() * 200 - 100),
    input: 0,                 // bitmask up/down/left/right
    spectator: false,
    dead: false,
    reviveProgress: 0,
    revivesLeft: CONFIG.REVIVE_LIMIT,

    // base stats
    maxHp: 100, hp: 100,
    moveSpeed: 220, armor: 0,
    might: 1, area: 1, cooldown: 1, amount: 0,
    duration: 1, projectileSpeed: 1, magnet: 70,
    growth: 1, greed: 1, luck: 1, regen: 0,

    level: 1, xp: 0, nextXp: 16, gold: 0, kills: 0, revives: 0,

    weapons: {},  // wid -> { lv }
    passives: {}, // pid -> { lv }

    pendingChoices: [],       // queued level-up option sets
    activeChoice: null,       // current option set awaiting pick
    lastDamageBy: 0,
    msgTimes: [],             // rate limit window
  };
  // apply character bonus & start weapon
  applyCharacterBase(p);
  addWeapon(p, c.startWeapon);
  recomputeStats(p);
  p.hp = p.maxHp;
  return p;
}

function applyCharacterBase(p) {
  const c = CHARACTERS[p.char];
  p._hpMul = c.hpMul || 1;
  p._areaMul = c.areaMul || 1;
  p._armorMul = c.armorMul || 1;
  p._baseAmount = c.amount || 0;
  p._regen = c.regen || 0;
  p._allyAura = !!c.allyAura;
}

function respawnPlayer(p) {
  p.x = CONFIG.WORLD.w / 2 + (Math.random() * 200 - 100);
  p.y = CONFIG.WORLD.h / 2 + (Math.random() * 200 - 100);
  p.dead = false;
  p.spectator = false;
  p.reviveProgress = 0;
  p.revivesLeft = CONFIG.REVIVE_LIMIT;
  p.maxHp = 100; p.moveSpeed = 220; p.armor = 0;
  p.might = 1; p.area = 1; p.cooldown = 1; p.amount = 0;
  p.duration = 1; p.projectileSpeed = 1; p.magnet = 70;
  p.growth = 1; p.greed = 1; p.luck = 1;
  p.level = 1; p.xp = 0; p.nextXp = 16; p.gold = 0; p.kills = 0; p.revives = 0;
  p.weapons = {}; p.passives = {};
  p.pendingChoices = []; p.activeChoice = null;
  const c = CHARACTERS[p.char];
  applyCharacterBase(p);
  addWeapon(p, c.startWeapon);
  recomputeStats(p);
  p.hp = p.maxHp;
}

function addWeapon(p, wid) {
  if (p.weapons[wid]) return false;
  if (Object.keys(p.weapons).length >= 6) return false;
  p.weapons[wid] = { lv: 1, cd: 0, angle: Math.random() * Math.PI * 2 };
  return true;
}
function addPassive(p, pid) {
  if (p.passives[pid]) return false;
  if (Object.keys(p.passives).length >= 6) return false;
  p.passives[pid] = { lv: 1 };
  return true;
}

// Re-derive multiplier stats from passives + character
function recomputeStats(p) {
  let maxHp = 100, moveSpeed = 220, armor = 0;
  let might = 1, area = 1, magnet = 70, growth = 1, greed = 1;
  let amount = p._baseAmount || 0;

  maxHp *= p._hpMul;
  area *= p._areaMul;
  armor = Math.max(0, armor); // base 0

  for (const pid in p.passives) {
    const def = PASSIVES[pid]; const lv = p.passives[pid].lv;
    if (!def) continue;
    const amt = def.per * lv;
    switch (def.stat) {
      case 'maxHp':     maxHp *= (1 + amt); break;
      case 'might':     might *= (1 + amt); break;
      case 'area':      area *= (1 + amt); break;
      case 'magnet':    magnet *= (1 + amt); break;
      case 'growth':    growth *= (1 + amt); break;
      case 'greed':     greed  *= (1 + amt); break;
      case 'moveSpeed': moveSpeed *= (1 + amt); break;
    }
  }
  // cooldown: apply per-level reduction properly
  let cd = 1;
  if (p.passives.quick) cd = Math.max(0.4, Math.pow(1 - PASSIVES.quick.per, p.passives.quick.lv));

  const ratio = p.maxHp > 0 ? p.hp / p.maxHp : 1;
  p.maxHp = Math.round(maxHp);
  p.hp = Math.min(p.maxHp, Math.round(p.maxHp * ratio));
  p.moveSpeed = moveSpeed;
  p.armor = armor;
  p.might = might;
  p.area = area; // char area-mul already folded in above
  p.cooldown = cd;
  p.amount = amount;
  p.magnet = magnet;
  p.growth = growth;
  p.greed = greed;
}

/* =====================================================================
 * WEAPON STATS PER LEVEL
 * ===================================================================== */
function weaponDamage(def, lv, p) {
  const base = def.baseDmg * (1 + (lv - 1) * 0.18);
  return base * p.might;
}
function weaponInterval(def, lv, p) {
  const base = def.interval * (1 - (lv - 1) * 0.04);
  return Math.max(0.18, base * p.cooldown);
}
function weaponRange(def, lv, p) {
  return (def.baseRange || 0) * p.area * (1 + (lv - 1) * 0.05);
}
function weaponCount(def, lv, p) {
  let n = 1 + p.amount;
  if (def.slot === 'orbit') n = 3 + Math.floor((lv - 1) / 2) + p.amount;
  if (def.rain) n += 2;
  if (def.evolved && def.slot === 'proj') n += 1;
  return Math.max(1, Math.floor(n));
}

/* =====================================================================
 * EVENTS (transient visuals)
 * ===================================================================== */
function pushEvent(k, x, y, extra) {
  const e = { k, x: Math.round(x), y: Math.round(y) };
  if (extra) Object.assign(e, extra);
  world.events.push(e);
}

/* =====================================================================
 * AUTO ATTACKS (server authoritative)
 * ===================================================================== */
function fireWeapons(p, enemyGrid) {
  if (p.dead || p.spectator) return;
  const near = [];
  for (const wid in p.weapons) {
    const w = p.weapons[wid];
    const def = WEAPONS[wid];
    if (!def) continue;
    w.cd -= DT;

    if (def.slot === 'orbit') {
      // orbit: continuous rotation; damage on overlap each tick
      const count = weaponCount(def, w.lv, p);
      const radius = weaponRange(def, w.lv, p);
      w.angle = (w.angle + DT * 3.2) % (Math.PI * 2);
      gridQuery(enemyGrid, p.x, p.y, radius + 60, near);
      const dmg = weaponDamage(def, w.lv, p) * DT * 2.4; // dps-ish per tick
      for (let i = 0; i < count; i++) {
        const a = w.angle + (i / count) * Math.PI * 2;
        const ox = p.x + Math.cos(a) * radius, oy = p.y + Math.sin(a) * radius;
        for (let j = 0; j < near.length; j++) {
          const e = near[j];
          if (e.dead) continue;
          const dx = e.x - ox, dy = e.y - oy;
          if (dx * dx + dy * dy < (e.r + 16) * (e.r + 16)) {
            damageEnemy(e, dmg, p, false);
          }
        }
      }
      continue;
    }

    if (w.cd > 0) continue;
    w.cd = weaponInterval(def, w.lv, p);

    if (def.slot === 'melee') {
      const radius = weaponRange(def, w.lv, p);
      const dmg = weaponDamage(def, w.lv, p);
      gridQuery(enemyGrid, p.x, p.y, radius + 40, near);
      const sweeps = def.evolved ? 2 : 1; // storm cleaver = double sided
      for (let s = 0; s < sweeps; s++) {
        for (let j = 0; j < near.length; j++) {
          const e = near[j];
          if (e.dead) continue;
          const dx = e.x - p.x, dy = e.y - p.y;
          if (dx * dx + dy * dy < (radius + e.r) * (radius + e.r)) {
            damageEnemy(e, dmg, p, true);
          }
        }
      }
      pushEvent('slash', p.x, p.y, { r: Math.round(radius), e: def.evolved ? 1 : 0 });

    } else if (def.slot === 'aura') {
      const radius = weaponRange(def, w.lv, p);
      const dmg = weaponDamage(def, w.lv, p);
      gridQuery(enemyGrid, p.x, p.y, radius + 30, near);
      for (let j = 0; j < near.length; j++) {
        const e = near[j];
        if (e.dead) continue;
        const dx = e.x - p.x, dy = e.y - p.y;
        if (dx * dx + dy * dy < (radius + e.r) * (radius + e.r)) {
          damageEnemy(e, dmg, p, true);
          if (def.slow) { e.slow = def.slow; e.slowT = 1.2; }
          if (def.freeze && Math.random() < 0.25) { e.slow = 0.95; e.slowT = 1.0; }
        }
      }
      // healing pulse heals self + nearby allies
      if (def.heal) {
        for (const ally of world.players.values()) {
          if (ally.dead || ally.spectator) continue;
          const dx = ally.x - p.x, dy = ally.y - p.y;
          if (dx * dx + dy * dy < (radius + 40) * (radius + 40)) {
            ally.hp = Math.min(ally.maxHp, ally.hp + def.heal * (def.evolved ? 1 : 1));
          }
        }
      }
      pushEvent(def.slow ? 'frost' : 'pulse', p.x, p.y, { r: Math.round(radius) });

    } else if (def.slot === 'proj') {
      const count = weaponCount(def, w.lv, p);
      const speed = (def.projSpeed || 400) * p.projectileSpeed;
      const dmg = weaponDamage(def, w.lv, p);
      // target: nearest for arrow, random-near for ember
      gridQuery(enemyGrid, p.x, p.y, 700, near);
      for (let i = 0; i < count; i++) {
        let tx, ty, ang;
        if (near.length) {
          let tgt;
          if (wid.startsWith('arrow')) tgt = nearestOf(near, p.x, p.y);
          else tgt = near[(Math.random() * near.length) | 0];
          ang = Math.atan2(tgt.y - p.y, tgt.x - p.x);
        } else {
          ang = Math.random() * Math.PI * 2;
        }
        if (def.rain) ang += (i - count / 2) * 0.12;
        else if (count > 1) ang += (i - (count - 1) / 2) * 0.18;
        spawnProjectile(p, wid, ang, speed, dmg, def);
      }
    }
  }
}

function nearestOf(arr, x, y) {
  let best = null, bd = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i]; if (e.dead) continue;
    const dx = e.x - x, dy = e.y - y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = e; }
  }
  return best || arr[0];
}

function spawnProjectile(p, wid, ang, speed, dmg, def) {
  const pr = {
    id: id(), owner: p.id, wid,
    x: p.x, y: p.y,
    vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
    ang, dmg,
    life: 2.2,
    pierce: (def.pierce || 0) + (def.evolved ? 1 : 0),
    splash: def.splash || 0,
    burn: !!def.burn,
    hit: new Set(),
  };
  world.projectiles.set(pr.id, pr);
}

function updateProjectiles(enemyGrid) {
  const near = [];
  for (const pr of world.projectiles.values()) {
    pr.x += pr.vx * DT; pr.y += pr.vy * DT;
    pr.life -= DT;
    if (pr.life <= 0 || pr.x < -200 || pr.y < -200 || pr.x > CONFIG.WORLD.w + 200 || pr.y > CONFIG.WORLD.h + 200) {
      world.projectiles.delete(pr.id); continue;
    }
    const owner = playerById(pr.owner);
    gridQuery(enemyGrid, pr.x, pr.y, 30 + (pr.splash || 0), near);
    let consumed = false;
    for (let j = 0; j < near.length; j++) {
      const e = near[j];
      if (e.dead || pr.hit.has(e.id)) continue;
      const dx = e.x - pr.x, dy = e.y - pr.y;
      if (dx * dx + dy * dy < (e.r + 10) * (e.r + 10)) {
        damageEnemy(e, pr.dmg, owner, true);
        pr.hit.add(e.id);
        if (pr.splash > 0) {
          const sp = [];
          gridQuery(enemyGrid, pr.x, pr.y, pr.splash, sp);
          for (let k = 0; k < sp.length; k++) {
            const se = sp[k];
            if (se.dead || se.id === e.id) continue;
            const sdx = se.x - pr.x, sdy = se.y - pr.y;
            if (sdx * sdx + sdy * sdy < pr.splash * pr.splash) damageEnemy(se, pr.dmg * 0.6, owner, false);
          }
          pushEvent('boom', pr.x, pr.y, { r: pr.splash });
        }
        if (pr.burn) { e.burn = 8; e.burnT = 2.5; }
        if (pr.pierce > 0) pr.pierce--;
        else { consumed = true; break; }
      }
    }
    if (consumed) world.projectiles.delete(pr.id);
  }
}

/* =====================================================================
 * ENEMIES
 * ===================================================================== */
function playerById(pid) {
  for (const p of world.players.values()) if (p.id === pid) return p;
  return null;
}
function alivePlayers() {
  const out = [];
  for (const p of world.players.values()) if (!p.dead && !p.spectator) out.push(p);
  return out;
}

function spawnEnemy(type, x, y, isBoss) {
  const def = isBoss ? BOSSES[type] : ENEMIES[type];
  const pc = alivePlayers().length || 1;
  const hpMul = isBoss ? (1 + pc * CONFIG.bossHPPerPlayer) : (1 + pc * CONFIG.enemyHPPerPlayer);
  const timeMul = 1 + world.time / 300; // grows over the run
  const e = {
    id: id(), type, boss: !!isBoss,
    x, y,
    hp: def.hp * hpMul * timeMul,
    maxHp: def.hp * hpMul * timeMul,
    speed: def.speed, r: def.r, dmg: def.dmg, xp: def.xp,
    target: 0, retargetCd: Math.random() * 1.5,
    atkCd: 0, slow: 0, slowT: 0, burn: 0, burnT: 0,
    // behavior flags
    explode: def.explode || 0,
    ranged: !!def.ranged, flee: !!def.flee,
    shootCd: isBoss ? 2.0 + Math.random() * 1.5 : (def.ranged ? 1.5 + Math.random() * 1.5 : 0),
    bossKind: isBoss ? type : null,
    dead: false,
  };
  world.enemies.set(e.id, e);
  return e;
}

function enemyScaling() {
  const pc = alivePlayers().length || 1;
  const cap = Math.min(CONFIG.enemyCapMaxHard, CONFIG.baseEnemyCap + pc * 12);
  const rate = CONFIG.baseSpawnRate * (1 + pc * CONFIG.spawnRatePerPlayer) * (1 + world.time / 240);
  return { cap, rate };
}

let spawnAccum = 0;
function spawnWave() {
  const ap = alivePlayers();
  if (!ap.length) return;
  const { cap, rate } = enemyScaling();
  if (world.enemies.size >= cap) return;

  spawnAccum += rate * DT;
  let n = Math.floor(spawnAccum);
  spawnAccum -= n;

  // pick weighted enemy types by time
  const t = world.time;
  const pool = [];
  pool.push('bat', 'ghoul', 'crawl');
  if (t > 60) pool.push('ghoul', 'wraith');
  if (t > 120) pool.push('bomber');
  if (t > 180) pool.push('brute', 'wraith', 'shooter');
  if (t > 300) pool.push('bomber', 'shooter');
  if (t > 360) pool.push('brute', 'elite');
  if (t > 600) pool.push('elite', 'brute');

  for (let i = 0; i < n && world.enemies.size < cap; i++) {
    // spawn around a random alive player on a ring just outside view
    const anchor = ap[(Math.random() * ap.length) | 0];
    const a = Math.random() * Math.PI * 2;
    const dist = CONFIG.VIEW_RADIUS + 80 + Math.random() * 160;
    const x = clamp(anchor.x + Math.cos(a) * dist, 20, CONFIG.WORLD.w - 20);
    const y = clamp(anchor.y + Math.sin(a) * dist, 20, CONFIG.WORLD.h - 20);
    const type = pool[(Math.random() * pool.length) | 0];
    spawnEnemy(type, x, y, false);
  }
}

function updateEnemies(enemyGrid) {
  const ap = alivePlayers();
  for (const e of world.enemies.values()) {
    if (e.dead) continue;

    // burn DOT
    if (e.burnT > 0) { e.burnT -= DT; damageEnemy(e, e.burn * DT, null, false); }

    // slow timer
    let spd = e.speed;
    if (e.slowT > 0) { e.slowT -= DT; spd *= (1 - e.slow); }

    // retarget occasionally; distribute across players
    e.retargetCd -= DT;
    if (e.retargetCd <= 0 || !playerById(e.target)) {
      e.retargetCd = 1.0 + Math.random() * 1.2;
      if (ap.length) {
        // bias to nearest but with random scatter so they don't all dogpile one player
        let best = null, bd = Infinity;
        for (const p of ap) {
          const dx = p.x - e.x, dy = p.y - e.y;
          let d = dx * dx + dy * dy;
          d *= 0.7 + Math.random() * 0.9; // scatter
          if (d < bd) { bd = d; best = p; }
        }
        e.target = best ? best.id : 0;
      }
    }
    const tgt = playerById(e.target);
    if (tgt && !tgt.dead) {
      const dx = tgt.x - e.x, dy = tgt.y - e.y;
      const d = Math.hypot(dx, dy) || 1;

      if (e.flee) {
        // treasure runner: sprint away from the nearest player
        e.x -= (dx / d) * spd * DT;
        e.y -= (dy / d) * spd * DT;
        e.x = clamp(e.x, e.r, CONFIG.WORLD.w - e.r);
        e.y = clamp(e.y, e.r, CONFIG.WORLD.h - e.r);
      } else if (e.ranged) {
        // hexer: keep medium distance, fire slow bolts at target
        const want = 260;
        const dir = d > want + 40 ? 1 : (d < want - 40 ? -1 : 0);
        e.x += (dx / d) * spd * DT * dir;
        e.y += (dy / d) * spd * DT * dir;
        e.shootCd -= DT;
        if (e.shootCd <= 0) {
          e.shootCd = 2.2;
          const sp = 230;
          spawnEnemyShot(e.x, e.y, (dx / d) * sp, (dy / d) * sp, e.dmg, '#c97aff', 7);
        }
      } else {
        e.x += (dx / d) * spd * DT;
        e.y += (dy / d) * spd * DT;
        // contact damage
        e.atkCd -= DT;
        if (d < e.r + 16 && e.atkCd <= 0) {
          e.atkCd = CONFIG.CONTACT_DAMAGE_CD;
          damagePlayer(tgt, e.dmg);
        }
      }

      // boss attack patterns
      if (e.boss) {
        e.shootCd -= DT;
        if (e.shootCd <= 0) {
          fireBossPattern(e, tgt, dx, dy, d);
        }
      }
    }
  }

  // light separation so enemies don't perfectly stack (cheap, grid-based)
  const near = [];
  let i = 0;
  for (const e of world.enemies.values()) {
    if (e.dead) continue;
    if ((i++ & 1) !== (world.tick & 1)) continue; // process half each tick
    gridQuery(enemyGrid, e.x, e.y, e.r * 2, near);
    for (let j = 0; j < near.length; j++) {
      const o = near[j];
      if (o === e || o.dead) continue;
      const dx = e.x - o.x, dy = e.y - o.y;
      const dd = dx * dx + dy * dy;
      const min = (e.r + o.r) * 0.8;
      if (dd > 0 && dd < min * min) {
        const d = Math.sqrt(dd);
        const push = (min - d) * 0.5;
        e.x += (dx / d) * push; e.y += (dy / d) * push;
      }
    }
  }
}

// Boss bullet patterns by boss id (telegraph is the brief cadence between volleys)
function fireBossPattern(e, tgt, dx, dy, d) {
  const baseAng = Math.atan2(dy, dx);
  const sp = 175;
  switch (e.bossKind) {
    case 'batlord': {
      const shots = 10;
      for (let i = 0; i < shots; i++) {
        const a = (i / shots) * Math.PI * 2 + world.time * 0.5;
        spawnEnemyShot(e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, e.dmg * 0.5, e.color || '#9b6fff', 7);
      }
      if (Math.random() < 0.5) for (let i = 0; i < 3; i++) {
        spawnEnemy('bat', e.x + (Math.random() * 80 - 40), e.y + (Math.random() * 80 - 40), false);
      }
      e.shootCd = 2.6;
      break;
    }
    case 'graveknight': {
      // aimed 5-shot cone
      for (let i = -2; i <= 2; i++) {
        const a = baseAng + i * 0.16;
        spawnEnemyShot(e.x, e.y, Math.cos(a) * (sp + 60), Math.sin(a) * (sp + 60), e.dmg * 0.55, e.color || '#cfd2d6', 8);
      }
      e.shootCd = 1.9;
      break;
    }
    case 'crimson': {
      // fast spiral
      const shots = 6;
      for (let i = 0; i < shots; i++) {
        const a = (i / shots) * Math.PI * 2 + world.time * 2.2;
        spawnEnemyShot(e.x, e.y, Math.cos(a) * (sp + 40), Math.sin(a) * (sp + 40), e.dmg * 0.45, e.color || '#ff5470', 6);
      }
      e.shootCd = 0.85;
      break;
    }
    case 'reaper':
    default: {
      // dense ring + summon
      const shots = 16;
      for (let i = 0; i < shots; i++) {
        const a = (i / shots) * Math.PI * 2 + world.time * 0.8;
        spawnEnemyShot(e.x, e.y, Math.cos(a) * sp, Math.sin(a) * sp, e.dmg * 0.5, e.color || '#ff2b2b', 8);
      }
      if (Math.random() < 0.4) for (let i = 0; i < 4; i++) {
        spawnEnemy(Math.random() < 0.5 ? 'wraith' : 'bat', e.x + (Math.random() * 100 - 50), e.y + (Math.random() * 100 - 50), false);
      }
      e.shootCd = 1.8;
      break;
    }
  }
}

function damageEnemy(e, dmg, byPlayer, countCredit) {
  if (e.dead) return;
  e.hp -= dmg;
  if (byPlayer && countCredit) e.lastHitBy = byPlayer.id;
  if (e.hp <= 0) killEnemy(e, byPlayer);
}

function killEnemy(e, byPlayer) {
  if (e.dead) return;
  e.dead = true;
  const credit = byPlayer || playerById(e.lastHitBy);
  if (credit) credit.kills++;
  pushEvent('death', e.x, e.y, { b: e.boss ? 1 : 0 });

  if (e.boss) {
    pushEvent('chest', e.x, e.y);
    world.chests.set(e.id, { id: e.id, x: e.x, y: e.y });
    dropGem(e.x, e.y, 2);
    // also burst of gems
    for (let i = 0; i < 8; i++) dropGem(e.x + (Math.random() * 80 - 40), e.y + (Math.random() * 80 - 40), 1);
  } else {
    // bomber: area damage to nearby players on death
    if (e.explode) {
      pushEvent('boom', e.x, e.y, { r: 90 });
      for (const p of world.players.values()) {
        if (p.dead || p.spectator || p.invuln > 0) continue;
        const dx = p.x - e.x, dy = p.y - e.y;
        if (dx * dx + dy * dy < 90 * 90) damagePlayer(p, e.explode);
      }
    }
    // gold runner: jackpot of gems + gold drop
    if (e.flee) {
      pushEvent('levelup', e.x, e.y);
      for (let i = 0; i < 14; i++) dropGem(e.x + (Math.random() * 120 - 60), e.y + (Math.random() * 120 - 60), 1);
      dropSpecial(e.x, e.y, 'gold'); dropSpecial(e.x + 20, e.y, 'gold');
      world.enemies.delete(e.id);
      return;
    }
    // gem tier by enemy xp value
    let tier = 0;
    if (e.xp >= 6) tier = 2; else if (e.xp >= 2) tier = 1;
    dropGem(e.x, e.y, tier);
    // small chance of pickups
    const roll = Math.random();
    if (roll < 0.012) dropSpecial(e.x, e.y, 'heal');
    else if (roll < 0.020) dropSpecial(e.x, e.y, 'bomb');
    else if (roll < 0.026) dropSpecial(e.x, e.y, 'vacuum');
    else if (roll < 0.040) dropSpecial(e.x, e.y, 'gold');
  }
  world.enemies.delete(e.id);
}

/* =====================================================================
 * GEMS & PICKUPS
 * ===================================================================== */
const GEM_XP = [3, 9, 28];
function dropGem(x, y, tier) {
  const gid = id();
  world.gems.set(gid, { id: gid, x, y, tier, kind: 'xp', xp: GEM_XP[tier] });
}
function dropSpecial(x, y, kind) {
  const gid = id();
  world.gems.set(gid, { id: gid, x, y, tier: 0, kind });
}

function mergeGems() {
  if (world.gems.size <= CONFIG.GEM_SOFT_CAP) return;
  // merge low-tier xp gems that are very close
  const grid = makeGrid();
  for (const g of world.gems.values()) if (g.kind === 'xp' && g.tier === 0) gridInsert(grid, g);
  const seen = new Set(); const near = [];
  for (const g of world.gems.values()) {
    if (g.kind !== 'xp' || g.tier === 0 && seen.has(g.id)) continue;
    if (g.tier !== 0) continue;
    if (seen.has(g.id)) continue;
    gridQuery(grid, g.x, g.y, CONFIG.GEM_MERGE_RADIUS, near);
    let merged = 0;
    for (let i = 0; i < near.length; i++) {
      const o = near[i];
      if (o.id === g.id || seen.has(o.id)) continue;
      const dx = o.x - g.x, dy = o.y - g.y;
      if (dx * dx + dy * dy < CONFIG.GEM_MERGE_RADIUS * CONFIG.GEM_MERGE_RADIUS) {
        g.xp += o.xp; seen.add(o.id); world.gems.delete(o.id); merged++;
        if (merged >= 6) break;
      }
    }
    if (g.xp >= GEM_XP[1]) g.tier = 1;
    if (g.xp >= GEM_XP[2]) g.tier = 2;
  }
}

function updatePickups() {
  for (const p of world.players.values()) {
    if (p.dead || p.spectator) continue;
    const mag = p.magnet;
    for (const g of world.gems.values()) {
      const dx = p.x - g.x, dy = p.y - g.y;
      const d2 = dx * dx + dy * dy;
      // magnet pull
      if (g.kind === 'xp' && d2 < mag * mag) {
        const d = Math.sqrt(d2) || 1;
        g.x += (dx / d) * 420 * DT; g.y += (dy / d) * 420 * DT;
      }
      // pickup
      if (d2 < 26 * 26) {
        collectPickup(p, g);
        world.gems.delete(g.id);
      }
    }
  }
}

function collectPickup(p, g) {
  switch (g.kind) {
    case 'xp':
      gainXp(p, g.xp);
      break;
    case 'gold':
      p.gold += Math.round(10 * p.greed);
      break;
    case 'heal':
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.3);
      pushEvent('pulse', p.x, p.y, { r: 40 });
      break;
    case 'vacuum':
      for (const gg of world.gems.values()) {
        if (gg.kind === 'xp') {
          const dx = p.x - gg.x, dy = p.y - gg.y;
          if (dx * dx + dy * dy < 1400 * 1400) { gainXp(p, gg.xp); world.gems.delete(gg.id); }
        }
      }
      pushEvent('vacuum', p.x, p.y);
      break;
    case 'bomb': {
      const grid = makeGrid();
      for (const e of world.enemies.values()) if (!e.dead) gridInsert(grid, e);
      const near = []; gridQuery(grid, p.x, p.y, 350, near);
      for (let i = 0; i < near.length; i++) damageEnemy(near[i], 400, p, false);
      pushEvent('boom', p.x, p.y, { r: 350 });
      break;
    }
  }
}

/* =====================================================================
 * XP / LEVEL / UPGRADES
 * ===================================================================== */
function requiredXp(level) { return 10 + Math.floor(Math.pow(level, 1.35) * 6); }

function gainXp(p, amount) {
  p.xp += amount * p.growth;
  // small shared XP to very-close allies (co-op feel)
  for (const a of world.players.values()) {
    if (a === p || a.dead || a.spectator) continue;
    const dx = a.x - p.x, dy = a.y - p.y;
    if (dx * dx + dy * dy < 220 * 220) {
      a.xp += amount * 0.15 * a.growth;
      checkLevel(a);
    }
  }
  checkLevel(p);
}

function checkLevel(p) {
  while (p.xp >= p.nextXp) {
    p.xp -= p.nextXp;
    p.level++;
    p.nextXp = requiredXp(p.level);
    p.hp = Math.min(p.maxHp, p.hp + 5);
    queueLevelUp(p);
    pushEvent('levelup', p.x, p.y);
  }
}

function queueLevelUp(p) {
  const opts = buildChoices(p);
  p.pendingChoices.push(opts);
  sendLevelState(p);
}

// Count of level-ups not yet consumed (the one shown + those queued behind it)
function pendingCount(p) {
  return (p.activeChoice ? 1 : 0) + p.pendingChoices.length;
}

// Always reflect the current banking state to the client (opts + pending badge count).
function sendLevelState(p) {
  if (!p.activeChoice && p.pendingChoices.length) {
    p.activeChoice = p.pendingChoices.shift();
  }
  send(p.sock, { t: 'lvl', opts: p.activeChoice || null, pending: pendingCount(p) });
}

// Build 3-4 valid options. Each option has a stable id the client echoes back.
function buildChoices(p) {
  const opts = [];
  const wKeys = Object.keys(p.weapons);
  const pKeys = Object.keys(p.passives);

  // upgrade existing weapons (not maxed / not evolved)
  for (const wid of wKeys) {
    const def = WEAPONS[wid];
    if (def.evolved) continue;
    if (p.weapons[wid].lv < 8) {
      opts.push({ id: 'wlv:' + wid, kind: 'wup', wid, name: def.name, lv: p.weapons[wid].lv + 1, desc: 'Level ' + (p.weapons[wid].lv + 1) });
    }
  }
  // new weapons
  if (wKeys.length < 6) {
    for (const wid in WEAPONS) {
      if (WEAPONS[wid].evolved) continue;
      if (!p.weapons[wid]) opts.push({ id: 'wnew:' + wid, kind: 'wnew', wid, name: WEAPONS[wid].name, lv: 1, desc: 'New weapon' });
    }
  }
  // upgrade passives
  for (const pid of pKeys) {
    if (p.passives[pid].lv < 5) opts.push({ id: 'plv:' + pid, kind: 'pup', pid, name: PASSIVES[pid].name, lv: p.passives[pid].lv + 1, desc: 'Level ' + (p.passives[pid].lv + 1) });
  }
  // new passives
  if (pKeys.length < 6) {
    for (const pid in PASSIVES) if (!p.passives[pid]) opts.push({ id: 'pnew:' + pid, kind: 'pnew', pid, name: PASSIVES[pid].name, lv: 1, desc: 'New passive' });
  }
  // always-available fallback rewards
  opts.push({ id: 'gold', kind: 'gold', name: 'Gold Cache', lv: 0, desc: '+100 gold' });
  opts.push({ id: 'heal', kind: 'heal', name: 'Healing Light', lv: 0, desc: 'Restore 40% HP' });

  // shuffle and take up to 4
  shuffle(opts);
  const n = Math.min(4, Math.max(3, opts.length));
  return opts.slice(0, n);
}

// server validates the chosen option id against the active set
function applyChoice(p, optId) {
  if (!p.activeChoice) return;
  const opt = p.activeChoice.find(o => o.id === optId);
  if (!opt) return; // invalid / cheat attempt -> ignore
  switch (opt.kind) {
    case 'wup':  if (p.weapons[opt.wid] && p.weapons[opt.wid].lv < 8) p.weapons[opt.wid].lv++; break;
    case 'wnew': addWeapon(p, opt.wid); break;
    case 'pup':  if (p.passives[opt.pid] && p.passives[opt.pid].lv < 5) p.passives[opt.pid].lv++; break;
    case 'pnew': addPassive(p, opt.pid); break;
    case 'gold': p.gold += Math.round(100 * p.greed); break;
    case 'heal': p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.4); break;
  }
  recomputeStats(p);
  p.activeChoice = null;
  sendLevelState(p); // advance to next banked level-up (or clear)
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } }

/* =====================================================================
 * CHEST / EVOLUTION
 * ===================================================================== */
function tryPickupChests() {
  for (const c of world.chests.values()) {
    for (const p of world.players.values()) {
      if (p.dead || p.spectator) continue;
      const dx = p.x - c.x, dy = p.y - c.y;
      if (dx * dx + dy * dy < 40 * 40) {
        openChest(p);
        world.chests.delete(c.id);
        break;
      }
    }
  }
}

function openChest(p) {
  // evolution first: weapon lv8 + matching passive present
  for (const wid in p.weapons) {
    const evo = EVOLUTIONS[wid];
    if (!evo) continue;
    if (p.weapons[wid].lv >= 8 && p.passives[evo.passive]) {
      delete p.weapons[wid];
      p.weapons[evo.to] = { lv: 8, cd: 0, angle: Math.random() * Math.PI * 2 };
      pushEvent('evolve', p.x, p.y);
      send(p.sock, { t: 'evo', name: WEAPONS[evo.to].name });
      recomputeStats(p);
      return;
    }
  }
  // otherwise random reward: a level-up choice + gold
  p.gold += Math.round(150 * p.greed);
  queueLevelUp(p);
  send(p.sock, { t: 'chest' });
}

/* =====================================================================
 * BOSS SCHEDULING
 * ===================================================================== */
function updateBosses() {
  const frac = world.time / (CONFIG.RUN_MINUTES * 60);
  for (const b of BOSS_SCHEDULE) {
    if (!b.done && frac >= b.f) {
      b.done = true;
      const ap = alivePlayers();
      if (!ap.length) continue;
      const anchor = ap[(Math.random() * ap.length) | 0];
      const a = Math.random() * Math.PI * 2;
      const x = clamp(anchor.x + Math.cos(a) * (CONFIG.VIEW_RADIUS - 100), 50, CONFIG.WORLD.w - 50);
      const y = clamp(anchor.y + Math.sin(a) * (CONFIG.VIEW_RADIUS - 100), 50, CONFIG.WORLD.h - 50);
      spawnEnemy(b.id, x, y, true);
      broadcast({ t: 'boss', name: BOSSES[b.id].name + ' has risen!' });
    }
  }
}

/* =====================================================================
 * PLAYER DAMAGE / DEATH / REVIVE
 * ===================================================================== */
function damagePlayer(p, dmg) {
  if (p.dead || p.spectator) return;
  const real = Math.max(1, dmg - p.armor);
  p.hp -= real;
  pushEvent('hit', p.x, p.y);
  if (p.hp <= 0) {
    p.hp = 0; p.dead = true; p.reviveProgress = 0;
    pushEvent('death', p.x, p.y, { p: 1 });
    send(p.sock, { t: 'died' });
  }
}

function updatePlayers() {
  for (const p of world.players.values()) {
    if (p.spectator) continue;

    if (p.dead) {
      // revive if any alive ally nearby long enough and revives remain
      if (p.revivesLeft > 0) {
        let near = false;
        for (const a of world.players.values()) {
          if (a === p || a.dead || a.spectator) continue;
          const dx = a.x - p.x, dy = a.y - p.y;
          if (dx * dx + dy * dy < CONFIG.REVIVE_RADIUS * CONFIG.REVIVE_RADIUS) { near = true; break; }
        }
        if (near) {
          p.reviveProgress += DT;
          if (p.reviveProgress >= CONFIG.REVIVE_TIME) {
            p.dead = false; p.hp = Math.round(p.maxHp * 0.5);
            p.revivesLeft--; p.revives++;
            p.reviveProgress = 0;
            send(p.sock, { t: 'revived' });
            pushEvent('levelup', p.x, p.y);
          }
        } else {
          p.reviveProgress = Math.max(0, p.reviveProgress - DT * 0.5);
        }
      }
      continue;
    }

    // movement from input bitmask
    let mx = 0, my = 0;
    if (p.input & 1) my -= 1;
    if (p.input & 2) my += 1;
    if (p.input & 4) mx -= 1;
    if (p.input & 8) mx += 1;
    if (mx || my) {
      const len = Math.hypot(mx, my) || 1;
      p.x = clamp(p.x + (mx / len) * p.moveSpeed * DT, 16, CONFIG.WORLD.w - 16);
      p.y = clamp(p.y + (my / len) * p.moveSpeed * DT, 16, CONFIG.WORLD.h - 16);
    }

    // regen
    if (p._regen) p.hp = Math.min(p.maxHp, p.hp + p._regen * DT);
  }

  // team wipe check
  if (world.running) {
    let anyAlive = false, anyPlayer = false;
    for (const p of world.players.values()) {
      if (p.spectator) continue;
      anyPlayer = true;
      if (!p.dead) anyAlive = true;
    }
    if (anyPlayer && !anyAlive && !world.gameOverAt) {
      world.gameOverAt = Date.now();
      broadcast({ t: 'over', reason: 'wipe' });
      setTimeout(() => { resetWorld(); world.running = true; broadcast({ t: 'restart' }); }, 6000);
    }
  }
}

/* =====================================================================
 * MAIN GAME LOOP (fixed step)
 * ===================================================================== */
world.tick = 0;
function gameLoop() {
  world.tick++;
  if (alivePlayers().length > 0) world.running = true;

  if (world.running && !world.gameOverAt) {
    world.time += DT;
    // run end
    if (world.time >= CONFIG.RUN_MINUTES * 60 && !world.gameOverAt) {
      world.gameOverAt = Date.now();
      broadcast({ t: 'over', reason: 'survived' });
      setTimeout(() => { resetWorld(); broadcast({ t: 'restart' }); }, 8000);
    }
  }

  // build enemy spatial grid once per tick
  const enemyGrid = makeGrid();
  for (const e of world.enemies.values()) if (!e.dead) gridInsert(enemyGrid, e);

  if (world.running && !world.gameOverAt) {
    spawnWave();
    updateBosses();
    updateEvents();
  }
  updateEnemies(enemyGrid);
  updateEnemyShots();
  applyAllyAuras();
  for (const p of world.players.values()) fireWeapons(p, enemyGrid);
  updateProjectiles(enemyGrid);
  updatePlayers();
  updatePickups();
  tryPickupChests();
  if (world.gems.size > CONFIG.GEM_SOFT_CAP) mergeGems();
}

/* =====================================================================
 * ENEMY PROJECTILES (bosses + ranged enemies)
 * ===================================================================== */
function spawnEnemyShot(x, y, vx, vy, dmg, color, r) {
  const sid = id();
  world.enemyShots.set(sid, { id: sid, x, y, vx, vy, dmg, color: color || '#ff5470', r: r || 7, life: 4.5 });
}

function updateEnemyShots() {
  const W = CONFIG.WORLD;
  for (const s of world.enemyShots.values()) {
    s.x += s.vx * DT; s.y += s.vy * DT;
    s.life -= DT;
    if (s.life <= 0 || s.x < -60 || s.y < -60 || s.x > W.w + 60 || s.y > W.h + 60) {
      world.enemyShots.delete(s.id); continue;
    }
    for (const p of world.players.values()) {
      if (p.dead || p.spectator || p.invuln > 0) continue;
      const dx = p.x - s.x, dy = p.y - s.y;
      if (dx * dx + dy * dy < (p.r + s.r) * (p.r + s.r)) {
        damagePlayer(p, s.dmg);
        world.enemyShots.delete(s.id);
        break;
      }
    }
  }
}

// Cleric-style support: players flagged with _allyAura heal nearby living allies.
function applyAllyAuras() {
  for (const p of world.players.values()) {
    if (!p._allyAura || p.dead || p.spectator) continue;
    for (const a of world.players.values()) {
      if (a === p || a.dead || a.spectator) continue;
      const dx = a.x - p.x, dy = a.y - p.y;
      if (dx * dx + dy * dy < 220 * 220) {
        a.hp = Math.min(a.maxHp, a.hp + 4 * DT);
      }
    }
  }
}

// Special timed events (treasure runner that flees and drops a jackpot)
function updateEvents() {
  world.eventCd -= DT;
  if (world.eventCd <= 0) {
    world.eventCd = 55 + Math.random() * 35;
    const ap = alivePlayers();
    if (!ap.length) return;
    const anchor = ap[(Math.random() * ap.length) | 0];
    const a = Math.random() * Math.PI * 2;
    const x = clamp(anchor.x + Math.cos(a) * 260, 40, CONFIG.WORLD.w - 40);
    const y = clamp(anchor.y + Math.sin(a) * 260, 40, CONFIG.WORLD.h - 40);
    spawnEnemy('runner', x, y, false);
    broadcast({ t: 'boss', name: 'Gold Runner appeared — catch it!' });
  }
}

/* =====================================================================
 * SNAPSHOT BUILDING (per-player culling, short field names)
 * ===================================================================== */
function buildLeaderboard() {
  const arr = [];
  for (const p of world.players.values()) {
    if (p.spectator) continue;
    arr.push({ n: p.name, k: p.kills, l: p.level });
  }
  const byKills = [...arr].sort((a, b) => b.k - a.k).slice(0, 5);
  const byLevel = [...arr].sort((a, b) => b.l - a.l).slice(0, 5);
  return { k: byKills, l: byLevel };
}

function snapshotFor(p) {
  const R = CONFIG.VIEW_RADIUS, R2 = R * R;
  const ex = p.x, ey = p.y;

  // players (always include all that are within view OR self)
  const players = [];
  for (const o of world.players.values()) {
    if (o.spectator) continue;
    const dx = o.x - ex, dy = o.y - ey;
    if (o === p || dx * dx + dy * dy < R2 * 1.6) {
      players.push({
        i: o.id, n: o.name, x: Math.round(o.x), y: Math.round(o.y),
        h: Math.round(o.hp), H: o.maxHp, l: o.level,
        col: o.color, d: o.dead ? 1 : 0,
        rp: o.dead ? +(o.reviveProgress / CONFIG.REVIVE_TIME).toFixed(2) : 0,
        // compact weapon list for visual orbits/auras
        w: Object.keys(o.weapons).map(wid => [wid, o.weapons[wid].lv]),
      });
    }
  }

  // enemies (bosses always included so the client can draw off-screen arrows)
  const enemies = [];
  for (const e of world.enemies.values()) {
    if (e.dead) continue;
    const dx = e.x - ex, dy = e.y - ey;
    if (e.boss || dx * dx + dy * dy < R2) {
      const o = { i: e.id, x: Math.round(e.x), y: Math.round(e.y), t: e.type, f: 0 };
      if (e.boss) { o.f |= 1; o.h = Math.round(e.hp); o.H = Math.round(e.maxHp); }
      if (e.slowT > 0) o.f |= 2;
      enemies.push(o);
    }
  }

  // enemy projectiles (boss / hexer bullets)
  const shots = [];
  for (const s of world.enemyShots.values()) {
    const dx = s.x - ex, dy = s.y - ey;
    if (dx * dx + dy * dy < R2) shots.push({ i: s.id, x: Math.round(s.x), y: Math.round(s.y), c: s.color, r: s.r });
  }

  // gems
  const gems = [];
  for (const g of world.gems.values()) {
    const dx = g.x - ex, dy = g.y - ey;
    if (dx * dx + dy * dy < R2) gems.push({ i: g.id, x: Math.round(g.x), y: Math.round(g.y), v: g.tier, k: g.kind });
  }

  // projectiles
  const proj = [];
  for (const pr of world.projectiles.values()) {
    const dx = pr.x - ex, dy = pr.y - ey;
    if (dx * dx + dy * dy < R2) proj.push({ i: pr.id, x: Math.round(pr.x), y: Math.round(pr.y), w: pr.wid, a: +pr.ang.toFixed(2) });
  }

  // chests / anvils (always included so the client can guide players to them)
  const chests = [];
  for (const c of world.chests.values()) {
    chests.push({ i: c.id, x: Math.round(c.x), y: Math.round(c.y) });
  }

  // events near this player
  const evs = [];
  for (const e of world.events) {
    const dx = e.x - ex, dy = e.y - ey;
    if (dx * dx + dy * dy < R2 * 1.2) evs.push(e);
  }

  return {
    t: 's',
    me: {
      i: p.id, x: Math.round(p.x), y: Math.round(p.y),
      hp: Math.round(p.hp), mhp: p.maxHp, lv: p.level,
      xp: Math.round(p.xp), nx: p.nextXp, gold: p.gold, kills: p.kills,
      dead: p.dead ? 1 : 0, spec: p.spectator ? 1 : 0,
      rev: p.revivesLeft, rp: +(p.reviveProgress / CONFIG.REVIVE_TIME).toFixed(2),
      w: Object.keys(p.weapons).map(wid => [wid, p.weapons[wid].lv]),
      ps: Object.keys(p.passives).map(pid => [pid, p.passives[pid].lv]),
    },
    P: players, E: enemies, S: shots, G: gems, R: proj, C: chests, X: evs,
    tm: Math.floor(world.time),
    rt: CONFIG.RUN_MINUTES * 60,
    pc: alivePlayers().length,
    cap: CONFIG.MAX_PLAYERS,
    lb: buildLeaderboard(),
    over: world.gameOverAt ? 1 : 0,
  };
}

function broadcastSnapshots() {
  for (const p of world.players.values()) {
    if (p.sock.readyState === 1) {
      try { p.sock.send(JSON.stringify(snapshotFor(p))); } catch (e) {}
    }
  }
  world.events.length = 0; // clear transient events after they've been sent
}

/* =====================================================================
 * NETWORKING
 * ===================================================================== */
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function send(sock, obj) { if (sock && sock.readyState === 1) { try { sock.send(JSON.stringify(obj)); } catch (e) {} } }
function broadcast(obj) { const s = JSON.stringify(obj); for (const p of world.players.values()) if (p.sock.readyState === 1) { try { p.sock.send(s); } catch (e) {} } }

function sanitizeName(raw) {
  let n = String(raw || '').replace(/[^\w \-]/g, '').trim();
  if (!n) n = 'Hero' + ((Math.random() * 9000 + 1000) | 0);
  return n.slice(0, CONFIG.NAME_MAX_LEN);
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (sock) => {
  sock.isAlive = true;
  sock.on('pong', () => { sock.isAlive = true; });

  sock.on('message', (raw) => {
    // crude per-socket rate limit
    const now = Date.now();
    sock._t = sock._t || [];
    sock._t.push(now);
    while (sock._t.length && now - sock._t[0] > 1000) sock._t.shift();
    if (sock._t.length > CONFIG.INPUT_RATE_LIMIT) return;

    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'join': {
        if (world.players.has(sock)) return;
        const name = sanitizeName(msg.name);
        const charId = CHARACTERS[msg.char] ? msg.char : 'knight';
        const nonSpec = [...world.players.values()].filter(p => !p.spectator).length;

        const p = makePlayer(sock, name, charId);
        if (nonSpec >= CONFIG.MAX_PLAYERS) {
          p.spectator = true; // room full -> spectator
        }
        world.players.set(sock, p);
        send(sock, {
          t: 'welcome', id: p.id, spectator: p.spectator,
          weapons: WEAPONS, passives: PASSIVES, chars: CHARACTERS,
          evolutions: EVOLUTIONS,
          world: CONFIG.WORLD, view: CONFIG.VIEW_RADIUS,
          full: p.spectator,
        });
        world.running = true;
        break;
      }
      case 'in': {
        const p = world.players.get(sock);
        if (p) p.input = msg.k & 15;
        break;
      }
      case 'pick': {
        const p = world.players.get(sock);
        if (p && typeof msg.id === 'string') applyChoice(p, msg.id);
        break;
      }
      case 'reqlvl': {
        const p = world.players.get(sock);
        if (p) sendLevelState(p);
        break;
      }
      case 'ping': {
        send(sock, { t: 'pong', ts: msg.ts });
        break;
      }
    }
  });

  sock.on('close', () => { world.players.delete(sock); });
  sock.on('error', () => { world.players.delete(sock); });
});

// heartbeat to drop dead sockets
setInterval(() => {
  wss.clients.forEach((s) => {
    if (s.isAlive === false) { world.players.delete(s); return s.terminate(); }
    s.isAlive = false;
    try { s.ping(); } catch (e) {}
  });
}, 15000);

/* =====================================================================
 * START LOOPS
 * ===================================================================== */
setInterval(gameLoop, 1000 / CONFIG.TICK_RATE);
setInterval(broadcastSnapshots, 1000 / CONFIG.SNAPSHOT_RATE);

server.listen(CONFIG.PORT, () => {
  console.log('==============================================');
  console.log('  ASHFALL LEGION server running');
  console.log('  http://localhost:' + CONFIG.PORT);
  console.log('  Tick: ' + CONFIG.TICK_RATE + ' TPS | Max players: ' + CONFIG.MAX_PLAYERS + ' (hard ' + CONFIG.MAX_PLAYERS_HARD + ')');
  console.log('  Run length: ' + CONFIG.RUN_MINUTES + ' min');
  console.log('==============================================');
});
