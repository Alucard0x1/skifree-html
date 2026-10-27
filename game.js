/* SkiFree — HTML5 port.
 *
 * Mechanics reconstructed from the shipped Windows 3.1 / Win32 builds:
 *   - HUD fields Time/Dist/Speed/Style and the "<-- that's you!" line come
 *     straight from the RT_STRING resources of the original executable.
 *   - Timer-driven main loop (SetTimer), GDI sprite blitting (BitBlt), WAV
 *     playback via WINMM sndPlaySoundA.
 *   - Course lengths 540 m (slalom) and 1040 m (tree slalom / freestyle) with
 *     the yeti released once the course is behind you.
 *
 * Sprite artwork here is drawn from scratch; the original bitmaps are not
 * redistributed.
 */
(() => {
  'use strict';

  // Safari < 16 has no roundRect; the sprites lean on it.
  if (typeof CanvasRenderingContext2D !== 'undefined' &&
      !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      const radius = Math.min(typeof r === 'number' ? r : 0, Math.abs(w) / 2, Math.abs(h) / 2);
      this.moveTo(x + radius, y);
      this.arcTo(x + w, y, x + w, y + h, radius);
      this.arcTo(x + w, y + h, x, y + h, radius);
      this.arcTo(x, y + h, x, y, radius);
      this.arcTo(x, y, x + w, y, radius);
      this.closePath();
      return this;
    };
  }

  // ---------------------------------------------------------------- config
  const MODES = {
    slalom: {
      label: 'Slalom', length: 540, treeDensity: 1, gates: true,
      rockDensity: 0.6, dogDensity: 0.35, padDensity: 0.5, timed: true,
    },
    tree: {
      label: 'Tree Slalom', length: 1040, treeDensity: 2.6, gates: true,
      rockDensity: 0.5, dogDensity: 0.25, padDensity: 0.4, timed: true,
    },
    freestyle: {
      label: 'Freestyle', length: 1040, treeDensity: 1.3, gates: false,
      rockDensity: 0.8, dogDensity: 0.3, padDensity: 0.9, timed: false,
    },
  };

  const PX_PER_M = 14;            // world px per metre of vertical drop
  const WORLD_W = 1500;           // wrap-around width of the hill
  const SKIER_R = 7;
  const DIRS = [
    [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0],
  ];
  const YETI_LEAD = 120;          // metres past the finish before the yeti comes

  // ---------------------------------------------------------------- dom
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  const el = {
    hud: document.getElementById('hud'),
    time: document.getElementById('hud-time'),
    dist: document.getElementById('hud-dist'),
    speed: document.getElementById('hud-speed'),
    style: document.getElementById('hud-style'),
    mode: document.getElementById('hud-mode'),
    menu: document.getElementById('menu'),
    over: document.getElementById('over'),
    overTitle: document.getElementById('over-title'),
    overLine: document.getElementById('over-line'),
    overDist: document.getElementById('over-dist'),
    overTime: document.getElementById('over-time'),
    overStyle: document.getElementById('over-style'),
    overBest: document.getElementById('over-best'),
    paused: document.getElementById('paused'),
    pauseBtn: document.getElementById('btn-pause'),
    soundBtn: document.getElementById('btn-sound'),
    touch: document.getElementById('touch'),
    again: document.getElementById('again'),
    tomenu: document.getElementById('tomenu'),
    resume: document.getElementById('resume'),
  };

  // ---------------------------------------------------------------- audio
  const sound = {
    on: localStorage.getItem('skifree.sound') !== 'off',
    ac: null,
    ensure() {
      if (!this.ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ac = new AC();
      }
      if (this.ac && this.ac.state === 'suspended') this.ac.resume();
      return this.ac;
    },
    blip(freq, dur = 0.12, type = 'triangle', gain = 0.14, slide = 0) {
      if (!this.on) return;
      const ac = this.ensure();
      if (!ac) return;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, ac.currentTime);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), ac.currentTime + dur);
      g.gain.setValueAtTime(gain, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      o.connect(g).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + dur + 0.02);
    },
    noise(dur = 0.22, gain = 0.16) {
      if (!this.on) return;
      const ac = this.ensure();
      if (!ac) return;
      const frames = Math.floor(ac.sampleRate * dur);
      const buf = ac.createBuffer(1, frames, ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
      const src = ac.createBufferSource();
      const g = ac.createGain();
      g.gain.value = gain;
      src.buffer = buf;
      src.connect(g).connect(ac.destination);
      src.start();
    },
    jump() { this.blip(420, 0.16, 'triangle', 0.1, 380); },
    crash() { this.noise(0.3, 0.2); this.blip(150, 0.2, 'square', 0.08, -90); },
    gate() { this.blip(760, 0.09, 'sine', 0.1); },
    roar() { this.blip(90, 0.7, 'sawtooth', 0.16, -40); },
    caught() { this.noise(0.5, 0.24); this.blip(70, 0.6, 'sawtooth', 0.16, -30); },
  };
  el.soundBtn.classList.toggle('muted', !sound.on);
  el.soundBtn.addEventListener('click', () => {
    sound.on = !sound.on;
    localStorage.setItem('skifree.sound', sound.on ? 'on' : 'off');
    el.soundBtn.classList.toggle('muted', !sound.on);
    if (sound.on) sound.gate();
  });

  // ---------------------------------------------------------------- state
  const view = { w: 0, h: 0, scale: 1, dpr: 1, mobile: false };
  const game = {
    state: 'menu',            // menu | playing | paused | over
    mode: 'freestyle',
    cfg: MODES.freestyle,
    t: 0,                     // run time (s)
    distance: 0,              // metres of vertical drop covered
    style: 0,
    gateCleared: 0,
    gateTotal: 0,
    finished: false,
    finishTime: 0,
    yeti: null,
    shake: 0,
    best: Number(localStorage.getItem('skifree.best') || 0),
    skier: null,
    objects: [],
    trail: [],
    particles: [],
    spawnedTo: 0,
  };

  function makeSkier() {
    return {
      x: WORLD_W * 0.5,
      y: 0,
      startY: 0,
      dir: 4,                 // down-right, like the original's opening move
      dx: 1, dy: 1,
      speed: 15,              // m/s
      angle: Math.PI / 2,
      air: 0,                 // seconds of airtime left
      airTotal: 0,
      crash: 0,
      grace: 0.6,
      turn: 0,
      tuck: 0,
      vx: 0, vy: 0,
      gatesPassed: new Set(),
    };
  }

  function reset(mode) {
    game.mode = mode;
    game.cfg = MODES[mode];
    game.t = 0;
    game.distance = 0;
    game.style = 0;
    game.gateCleared = 0;
    game.gateTotal = 0;
    game.finished = false;
    game.finishTime = 0;
    game.yeti = null;
    game.shake = 0;
    game.objects = [];
    game.trail = [];
    game.particles = [];
    const s = makeSkier();
    s.startY = 0;
    s.y = 0;
    game.skier = s;
    game.spawnedTo = 0;
    spawnAhead(view.h / view.scale * 1.4);
    buildGates();
  }

  function buildGates() {
    if (!game.cfg.gates) return;
    const gap = 8 * PX_PER_M;
    const total = Math.floor(game.cfg.length / 60);
    game.gateTotal = total;
    for (let i = 1; i <= total; i++) {
      const y = i * 60 * PX_PER_M;
      const x = WORLD_W * 0.5 + Math.sin(i * 1.7) * WORLD_W * 0.12;
      game.objects.push({ kind: 'gate', x, y, gap, index: i, r: 0 });
    }
  }

  // ---------------------------------------------------------------- world
  function rand(seed) {
    // deterministic hash -> [0,1)
    let t = seed + 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function spawnAhead(extra) {
    const targetY = game.skier.y + view.h / view.scale + extra;
    const cfg = game.cfg;
    const startX = WORLD_W * 0.5;
    while (game.spawnedTo < targetY) {
      const band = game.spawnedTo;
      const bandH = 90;
      const n = Math.round(5.4 * cfg.treeDensity);
      for (let i = 0; i < n; i++) {
        const h = rand(band * 7 + i * 31);
        const h2 = rand(band * 13 + i * 17);
        const x = h * WORLD_W;
        const y = band + h2 * bandH;
        // keep the opening run clear: the skier starts heading down-right
        if (y < 460) {
          const lane = startX + y * 0.9;
          if (Math.abs(((x - lane + WORLD_W * 1.5) % WORLD_W) - WORLD_W * 0.5) < 150) continue;
        }
        if (Math.abs(x - game.skier.x) < 40 && Math.abs(y - game.skier.y) < 55) continue;
        const roll = h2;
        if (roll < 0.62) {
          game.objects.push({ kind: 'tree', x, y, r: 6.5, size: 0.85 + h * 0.6, seed: band + i });
        } else if (roll < 0.62 + 0.16 * cfg.rockDensity) {
          game.objects.push({ kind: 'rock', x, y, r: 7, size: 0.85 + h * 0.5 });
        } else if (roll < 0.78 + 0.14 * cfg.rockDensity) {
          game.objects.push({ kind: 'stump', x, y, r: 6, size: 0.9 + h * 0.3 });
        } else if (roll < 0.8 + 0.12 * cfg.dogDensity) {
          game.objects.push({ kind: 'dog', x, y, r: 7, t: 0, seed: band });
        } else if (roll < 0.84 + 0.14 * cfg.padDensity) {
          game.objects.push({ kind: 'pad', x, y, r: 11, pulse: h * 6.28 });
        }
      }
      game.spawnedTo = band + bandH;
    }
    // drop anything well behind the camera
    const cutoff = game.skier.y - 600;
    if (game.objects.length > 1600) {
      game.objects = game.objects.filter((o) => o.y > cutoff || o.kind === 'gate');
    }
  }

  function wrapX(x) {
    return ((x % WORLD_W) + WORLD_W) % WORLD_W;
  }

  function nearestDir(dx, dy) {
    if (!dx && !dy) return null;
    let best = 4;
    let bestDot = -Infinity;
    for (let i = 0; i < 8; i++) {
      const [ux, uy] = DIRS[i];
      const len = Math.hypot(ux, uy);
      const dot = (dx * ux + dy * uy) / len;
      if (dot > bestDot) { bestDot = dot; best = i; }
    }
    return best;
  }

  // ---------------------------------------------------------------- input
  const keys = new Set();
  const touchDir = { x: 0, y: 0 };

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) e.preventDefault();
    if (game.state === 'menu' && (k === 'Enter' || k === ' ')) { start('freestyle'); return; }
    if (game.state === 'over' && (k === 'Enter' || k === 'r' || k === 'R')) { start(game.mode); return; }
    if (k === 'p' || k === 'P' || k === 'F3') { togglePause(); return; }
    if (k === 'r' || k === 'R') { if (game.state !== 'menu') start(game.mode); return; }
    if (k === 'Escape') { if (game.state === 'playing') togglePause(); return; }
    if (k === ' ' || k === 'Spacebar') { hop(); return; }
    // NumPad control, as advertised by the original help bitmap
    if (/^[1-9]$/.test(k) && !keys.has('__numpad_off')) {
      const map = { 7: 0, 8: 1, 9: 2, 6: 3, 3: 4, 2: 5, 1: 6, 4: 7 };
      if (map[k] !== undefined && game.state === 'playing') {
        setDir(map[k]);
        return;
      }
    }
    keys.add(k.toLowerCase());
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  function setDir(i) {
    const s = game.skier;
    if (!s) return;
    s.dir = i;
    const [ux, uy] = DIRS[i];
    const len = Math.hypot(ux, uy);
    s.dx = ux / len;
    s.dy = uy / len;
    s.turn = 0.1;
  }

  function readKeyboard() {
    let vx = 0;
    let vy = 0;
    if (keys.has('arrowleft') || keys.has('a')) vx -= 1;
    if (keys.has('arrowright') || keys.has('d')) vx += 1;
    if (keys.has('arrowup') || keys.has('w')) vy -= 1;
    if (keys.has('arrowdown') || keys.has('s')) vy += 1;
    return { vx, vy };
  }

  // touch: drag to steer, quick tap to hop
  let dragStart = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (game.state !== 'playing') return;
    dragStart = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    dragStart.moved = Math.max(dragStart.moved, Math.hypot(dx, dy));
    if (Math.hypot(dx, dy) > 14) {
      const dir = nearestDir(dx, dy);
      if (dir !== null) setDir(dir);
    }
  });
  canvas.addEventListener('pointerup', () => {
    if (!dragStart) return;
    const quick = performance.now() - dragStart.t < 260 && dragStart.moved < 14;
    if (quick) hop();
    dragStart = null;
  });
  canvas.addEventListener('pointercancel', () => { dragStart = null; });

  el.touch.querySelectorAll('button').forEach((b) => {
    const dir = Number(b.dataset.dir);
    const press = (ev) => {
      ev.preventDefault();
      if (game.state !== 'playing') return;
      setDir(dir);
      b.classList.add('held');
    };
    const release = () => b.classList.remove('held');
    b.addEventListener('pointerdown', press);
    b.addEventListener('pointerup', release);
    b.addEventListener('pointerleave', release);
    b.addEventListener('pointercancel', release);
  });

  // ---------------------------------------------------------------- actions
  function hop() {
    const s = game.skier;
    if (game.state !== 'playing' || !s || s.air > 0 || s.crash > 0) return;
    s.air = 0.34;
    s.airTotal = 0.34;
    sound.jump();
    burst(s.x, s.y, 5);
  }

  function togglePause() {
    if (game.state === 'playing') {
      game.state = 'paused';
      el.paused.classList.remove('hidden');
      el.pauseBtn.classList.add('hidden');
    } else if (game.state === 'paused') {
      game.state = 'playing';
      el.paused.classList.add('hidden');
      el.pauseBtn.classList.remove('hidden');
    }
  }

  function burst(x, y, n, spread = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (20 + Math.random() * 70) * spread;
      game.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.4 + Math.random() * 0.35,
        max: 0.75, r: 1 + Math.random() * 1.8,
      });
    }
  }

  // ---------------------------------------------------------------- loop
  let last = performance.now();

  function frame(now) {
    const dtRaw = (now - last) / 1000;
    last = now;
    const dt = Math.min(0.05, dtRaw);
    if (game.state === 'playing') update(dt);
    else if (game.state === 'over') updateOver(dt);
    render(dt);
    requestAnimationFrame(frame);
  }

  function updateOver(dt) {
    for (const p of game.particles) {
      p.x += p.vx * dt * 0.25;
      p.y += p.vy * dt * 0.25;
      p.life -= dt;
    }
    game.particles = game.particles.filter((p) => p.life > 0);
  }

  function update(dt) {
    const s = game.skier;
    game.t += dt;

    const kb = readKeyboard();
    if (kb.vx || kb.vy) {
      const dir = nearestDir(kb.vx, kb.vy);
      if (dir !== null && dir !== s.dir) setDir(dir);
    }

    // speed ramps with progress down the hill, like the original's ever-faster run
    const targetSpeed = 16 + Math.min(30, game.distance * 0.025);
    s.speed += (targetSpeed - s.speed) * Math.min(1, dt * 1.6);
    if (s.grace > 0) s.grace -= dt;

    const grounded = s.air <= 0 && s.crash <= 0;
    if (s.air > 0) s.air = Math.max(0, s.air - dt);

    if (s.crash > 0) {
      s.crash -= dt;
      if (s.crash <= 0) {
        s.speed = Math.max(9, s.speed * 0.55);
        setDir(4);
      }
    }

    const moveScale = s.crash > 0 ? 0 : 1;
    const px = s.speed * PX_PER_M;
    s.vx = s.dx * px * moveScale;
    s.vy = s.dy * px * moveScale;

    s.x = wrapX(s.x + s.vx * dt);
    s.y += s.vy * dt;

    // distance = best (lowest) point reached down the hill
    const travelled = (s.y - s.startY) / PX_PER_M;
    if (travelled > game.distance) game.distance = travelled;

    if (grounded) {
      s.tuck += dt;
      s.angle += shortestAngle(s.angle, dirAngle(s)) * Math.min(1, dt * 14);
      if (Math.random() < dt * 26) {
        const px2 = -s.dy;
        const py2 = s.dx;
        for (const side of [-1, 1]) {
          game.trail.push({
            x: s.x - s.dx * 8 + px2 * 4.4 * side,
            y: s.y - s.dy * 8 + py2 * 4.4 * side,
            side, a: 1,
          });
        }
        if (game.trail.length > 420) game.trail.splice(0, 2);
      }
    }

    for (const p of game.trail) p.a -= dt * 0.14;
    game.trail = game.trail.filter((p) => p.a > 0.02);

    for (const p of game.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - dt * 2.4;
      p.vy *= 1 - dt * 2.4;
      p.life -= dt;
    }
    game.particles = game.particles.filter((p) => p.life > 0);

    // obstacles
    for (const o of game.objects) {
      if (o.kind === 'dog') {
        o.t += dt;
        o.x = wrapX(o.x + Math.cos(o.t * 1.4 + (o.seed || 0)) * 28 * dt);
        o.y += Math.sin(o.t * 0.9 + (o.seed || 0)) * 12 * dt;
      }
      if (o.kind === 'pad') o.pulse += dt * 6;

      const dist = Math.hypot(o.x - s.x, o.y - s.y);
      if (dist > 26) continue;
      const reach = o.r + SKIER_R;

      if (o.kind === 'pad') {
        if (dist < reach && s.air <= 0 && s.crash <= 0) {
          s.air = 0.85;
          s.airTotal = 0.85;
          sound.jump();
          burst(o.x, o.y, 10, 1.4);
        }
        continue;
      }

      if (o.kind === 'gate') {
        if (s.gatesPassed.has(o.index)) continue;
        const half = o.gap / 2;
        if (s.y >= o.y && s.y - s.vy * dt < o.y) {
          const off = s.x - o.x;
          if (Math.abs(off) < half) {
            s.gatesPassed.add(o.index);
            game.gateCleared++;
            game.style += 500;
            sound.gate();
          }
        }
        continue;
      }

      if (dist > reach) continue;

      if (o.kind === 'rock' || o.kind === 'stump' || o.kind === 'dog') {
        if (s.air > 0) continue;   // sails over the small stuff
      }
      if (s.crash > 0 || s.air > 0 || s.grace > 0) continue;
      crash();
      break;
    }

    // yeti
    const yetiAt = game.cfg.length + YETI_LEAD;
    if (!game.yeti && game.distance > yetiAt) {
      game.yeti = { x: s.x - 30, y: s.y - 210, t: 0 };
      sound.roar();
    }
    if (game.yeti) {
      const y = game.yeti;
      y.t += dt;
      // always a touch faster than the skier, so the mountain wins in the end
      const sp = (s.speed + 1.6) * PX_PER_M;
      const dx = s.x - y.x;
      const dy = s.y - y.y;
      const len = Math.hypot(dx, dy) || 1;
      y.x = wrapX(y.x + (dx / len) * sp * dt);
      y.y += (dy / len) * sp * dt;
      if (Math.hypot(s.x - y.x, s.y - y.y) < 22 && s.crash <= 0) {
        caught();
        return;
      }
    }

    // style from airtime
    if (s.air > 0) {
      game.style += Math.round(s.speed * dt * 60);
    }

    // finish line
    if (!game.finished && game.distance >= game.cfg.length) {
      game.finished = true;
      game.finishTime = game.t;
      sound.gate();
    }

    spawnAhead(300);
    updateHud();
  }

  function shortestAngle(from, to) {
    let d = to - from;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function dirAngle(s) {
    return Math.atan2(s.dy, s.dx) - Math.PI / 2;
  }

  function crash() {
    const s = game.skier;
    s.crash = 1.05;
    s.grace = 1.4;
    // back off a touch so the skier does not wake up inside the same tree
    s.x = wrapX(s.x - s.dx * 16);
    s.y -= s.dy * 16;
    s.vx = 0;
    s.vy = 0;
    game.shake = 8;
    game.style = Math.max(0, game.style - 200);
    sound.crash();
    burst(s.x, s.y, 16, 1.6);
  }

  function caught() {
    const s = game.skier;
    game.state = 'over';
    sound.caught();
    burst(s.x, s.y, 26, 2);
    const best = Math.max(game.best, Math.floor(game.distance));
    game.best = best;
    localStorage.setItem('skifree.best', String(best));
    el.overTitle.textContent = 'The yeti got you';
    el.overLine.textContent = "and that one had a full belly already. <-- that's you!";
    el.overDist.textContent = `${Math.floor(game.distance)} m`;
    el.overTime.textContent = `${game.t.toFixed(1)} s`;
    el.overStyle.textContent = String(game.style);
    el.overBest.textContent = `${best} m`;
    el.over.classList.remove('hidden');
    el.hud.classList.add('hidden');
    el.pauseBtn.classList.add('hidden');
    el.touch.classList.add('hidden');
  }

  function updateHud() {
    const mm = Math.floor(game.t / 60);
    const ss = game.t % 60;
    el.time.textContent = `${String(mm).padStart(2, '0')}:${ss.toFixed(1).padStart(4, '0')}`;
    el.dist.textContent = `${String(Math.floor(game.distance)).padStart(4, '0')}m`;
    el.speed.textContent = `${game.skier.speed.toFixed(1)}m/s`;
    el.style.textContent = String(game.style).padStart(7, '0');
    const cfg = game.cfg;
    const bits = [cfg.label];
    if (cfg.gates) bits.push(`gates ${game.gateCleared}/${game.gateTotal}`);
    if (game.finished) bits.push(`finished ${game.finishTime.toFixed(1)}s`);
    if (game.yeti) bits.push('YETI!');
    el.mode.textContent = bits.join(' · ');
  }

  // ---------------------------------------------------------------- render
  function resize() {
    view.dpr = Math.min(2, window.devicePixelRatio || 1);
    view.mobile = window.matchMedia('(pointer: coarse)').matches;
    view.scale = view.mobile ? 1.2 : 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * view.dpr);
    canvas.height = Math.floor(h * view.dpr);
    view.w = w;
    view.h = h;
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));

  function snowTexture(cx, cy, w, h, time) {
    // deterministic speckle + moguls so the hill scrolls without shimmering
    const cell = 64;
    const x0 = Math.floor((cx - w) / cell);
    const x1 = Math.ceil((cx + w) / cell);
    const y0 = Math.floor((cy - h) / cell);
    const y1 = Math.ceil((cy + h) / cell);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const h1 = rand(gx * 73856093 + gy * 19349663);
        const px = gx * cell + h1 * cell;
        const py = gy * cell + rand(gx * 83492791 + gy * 2654435761) * cell;
        if (h1 > 0.9) {
          ctx.fillStyle = 'rgba(205, 224, 242, 0.55)';
          ctx.beginPath();
          ctx.ellipse(px - cx, py - cy, 18 + h1 * 26, 6 + h1 * 4, 0, 0, Math.PI * 2);
          ctx.fill();
        } else if (h1 < 0.08) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
          ctx.fillRect(px - cx, py - cy, 2, 2);
        } else if (h1 > 0.44 && h1 < 0.5) {
          ctx.fillStyle = 'rgba(196, 216, 236, 0.5)';
          ctx.fillRect(px - cx, py - cy, 3, 3);
        }
      }
    }
  }

  function render(dt) {
    const s = game.skier;
    const w = view.w;
    const h = view.h;
    ctx.setTransform(view.dpr * view.scale, 0, 0, view.dpr * view.scale, 0, 0);
    const vw = w / view.scale;
    const vh = h / view.scale;

    ctx.fillStyle = '#f7fbff';
    ctx.fillRect(0, 0, vw, vh);

    if (!s) return;

    let camX = Math.round(s.x - vw * 0.5);
    let camY = Math.round(s.y - vh * 0.4);
    if (game.shake > 0) {
      camX += (Math.random() - 0.5) * game.shake;
      camY += (Math.random() - 0.5) * game.shake;
      game.shake = Math.max(0, game.shake - dt * 40);
    }

    ctx.save();
    snowTexture(camX, camY, vw, vh, game.t);

    const drawX = (x) => {
      let sx = x - camX;
      if (sx < -WORLD_W / 2) sx += WORLD_W;
      if (sx > WORLD_W / 2) sx -= WORLD_W;
      return sx;
    };

    // finish line
    const finishY = s.startY + game.cfg.length * PX_PER_M;
    if (finishY - camY > -60 && finishY - camY < vh + 60) drawFinish(finishY - camY, vw);

    // trail
    if (game.trail.length > 2) {
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      for (const side of [-1, 1]) {
        ctx.strokeStyle = 'rgba(176, 202, 228, 0.8)';
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < game.trail.length; i++) {
          const p = game.trail[i];
          if (p.side !== side) continue;
          const prev = game.trail[i - 2];
          const sx = drawX(p.x);
          const sy = p.y - camY;
          if (!prev || prev.side !== side || Math.abs(p.y - prev.y) > 60 ||
              Math.abs(p.x - prev.x) > 200) {
            ctx.moveTo(sx, sy);
            pen = true;
          } else if (pen) {
            ctx.lineTo(sx, sy);
          }
        }
        ctx.stroke();
      }
    }

    // objects
    for (const o of game.objects) {
      const sy = o.y - camY;
      if (sy < -80 || sy > vh + 80) continue;
      const sx = drawX(o.x);
      if (sx < -110 || sx > vw + 110) continue;
      switch (o.kind) {
        case 'tree': drawTree(sx, sy, (o.size || 1) * 1.15); break;
        case 'rock': drawRock(sx, sy, (o.size || 1) * 1.15); break;
        case 'stump': drawStump(sx, sy, (o.size || 1) * 1.15); break;
        case 'dog': drawDog(sx, sy, o.t || 0); break;
        case 'pad': drawPad(sx, sy, o.pulse || 0); break;
        case 'gate': drawGate(sx, sy, o, s); break;
        default: break;
      }
    }

    // particles
    for (const p of game.particles) {
      ctx.fillStyle = `rgba(255,255,255,${Math.max(0, p.life / p.max)})`;
      ctx.beginPath();
      ctx.arc(drawX(p.x), p.y - camY, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // yeti
    if (game.yeti) {
      drawYeti(drawX(game.yeti.x), game.yeti.y - camY, game.yeti.t);
    }

    // skier
    drawSkier(drawX(s.x), s.y - camY, s);

    ctx.restore();
  }

  // ---------------------------------------------------------------- sprites
  function drawTree(x, y, size) {
    const s = size;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.fillStyle = 'rgba(140, 165, 190, 0.35)';
    ctx.beginPath();
    ctx.ellipse(3, 6, 12, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#6b4a2f';
    ctx.fillRect(-2, 0, 4, 7);
    const layers = [
      { w: 15, h: 15, dy: -2, c: '#1c6b3a' },
      { w: 12, h: 13, dy: -9, c: '#228047' },
      { w: 8.5, h: 11, dy: -16, c: '#2b9553' },
    ];
    for (const l of layers) {
      ctx.fillStyle = l.c;
      ctx.beginPath();
      ctx.moveTo(0, l.dy - l.h);
      ctx.lineTo(l.w, l.dy);
      ctx.lineTo(-l.w, l.dy);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      ctx.moveTo(0, l.dy - l.h);
      ctx.lineTo(l.w * 0.5, l.dy - l.h * 0.25);
      ctx.lineTo(-l.w * 0.15, l.dy - l.h * 0.35);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawRock(x, y, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size, size);
    ctx.fillStyle = 'rgba(140, 165, 190, 0.35)';
    ctx.beginPath();
    ctx.ellipse(2, 5, 10, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8d939b';
    ctx.beginPath();
    ctx.moveTo(-9, 4);
    ctx.lineTo(-6, -5);
    ctx.lineTo(1, -8);
    ctx.lineTo(8, -3);
    ctx.lineTo(9, 4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#b8bec6';
    ctx.beginPath();
    ctx.moveTo(-6, -5);
    ctx.lineTo(1, -8);
    ctx.lineTo(4, -4);
    ctx.lineTo(-3, -2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.moveTo(-6, -6);
    ctx.lineTo(1, -9);
    ctx.lineTo(5, -4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawStump(x, y, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size, size);
    ctx.fillStyle = '#7a5636';
    ctx.beginPath();
    ctx.ellipse(0, 0, 7, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#a3764c';
    ctx.beginPath();
    ctx.ellipse(0, -2, 5, 3.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#6b4a2f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(0, -2, 2.2, 1.3, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawDog(x, y, t) {
    ctx.save();
    ctx.translate(x, y);
    const wag = Math.sin(t * 12) * 0.5;
    ctx.fillStyle = '#b1703c';
    ctx.beginPath();
    ctx.ellipse(0, 0, 8, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8d5527';
    ctx.beginPath();
    ctx.arc(6, -3, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d8a15f';
    ctx.beginPath();
    ctx.moveTo(8, -5);
    ctx.lineTo(11, -3.5);
    ctx.lineTo(8, -2);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#8d5527';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-7, 0);
    ctx.lineTo(-11, -3 + wag);
    ctx.stroke();
    ctx.fillStyle = '#22262b';
    ctx.fillRect(-4, 3, 2, 3);
    ctx.fillRect(2, 3, 2, 3);
    ctx.restore();
  }

  function drawPad(x, y, pulse) {
    ctx.save();
    ctx.translate(x, y);
    const colors = ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6'];
    const wob = 1 + Math.sin(pulse) * 0.06;
    ctx.scale(wob, 1);
    for (let i = 0; i < colors.length; i++) {
      ctx.fillStyle = colors[i];
      ctx.fillRect(-14, -5 + i * 1.7, 28, 1.8);
    }
    ctx.strokeStyle = 'rgba(16,34,46,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(-14, -5, 28, 10.2);
    ctx.restore();
  }

  function drawGate(x, y, gate, s) {
    const half = gate.gap / 2;
    const passed = s.gatesPassed && s.gatesPassed.has(gate.index);
    // blue flag on the left, red on the right, like the original slalom gates
    for (const side of [-1, 1]) {
      const fx = x + side * half;
      ctx.strokeStyle = 'rgba(16,34,46,0.6)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(fx, y);
      ctx.lineTo(fx, y - 22);
      ctx.stroke();
      ctx.fillStyle = passed ? '#8fa3b4' : (side < 0 ? '#2f6fd0' : '#d23c34');
      ctx.beginPath();
      ctx.moveTo(fx, y - 22);
      ctx.lineTo(fx + side * 11, y - 17);
      ctx.lineTo(fx, y - 12);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(fx - 2, y - 2, 4, 2);
    }
    if (passed) {
      ctx.fillStyle = 'rgba(46, 160, 96, 0.85)';
      ctx.font = 'bold 11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('GATE', x, y - 28);
      ctx.textAlign = 'left';
    }
  }

  function drawFinish(y, vw) {
    const step = 14;
    ctx.save();
    for (let x = -20; x < vw + 20; x += step) {
      const on = Math.floor((x + 20) / step) % 2 === 0;
      ctx.fillStyle = on ? '#111820' : '#ffffff';
      ctx.fillRect(x, y - 4, step, 8);
    }
    ctx.fillStyle = '#111820';
    ctx.font = 'bold 12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('FINISH', vw / 2, y - 12);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  function drawYeti(x, y, t) {
    const bob = Math.sin(t * 9) * 2;
    ctx.save();
    ctx.translate(x, y + bob);
    // shadow
    ctx.fillStyle = 'rgba(150, 175, 200, 0.45)';
    ctx.beginPath();
    ctx.ellipse(4, 20, 16, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    // body
    ctx.fillStyle = '#f3f7fb';
    ctx.strokeStyle = '#20272e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, 16, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // arms
    const swing = Math.sin(t * 11) * 5;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * 15, -2 + swing * side * 0.5, 5, 10, side * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // head
    ctx.beginPath();
    ctx.ellipse(0, -18, 12, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // eyes + mouth
    ctx.fillStyle = '#171c22';
    ctx.beginPath();
    ctx.arc(-4.5, -20, 2.1, 0, Math.PI * 2);
    ctx.arc(4.5, -20, 2.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#171c22';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(0, -13, 5, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    // fangs
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(-3.4, -12.5);
    ctx.lineTo(-1.6, -9.5);
    ctx.lineTo(0, -12.5);
    ctx.closePath();
    ctx.moveTo(0.4, -12.5);
    ctx.lineTo(2.2, -9.5);
    ctx.lineTo(3.6, -12.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawSkier(x, y, s) {
    const crashed = s.crash > 0;
    const air = s.air > 0;
    const angle = s.angle;

    ctx.save();
    ctx.translate(x, y);

    // ground shadow
    const shadowOff = air ? 6 + s.air * 14 : 3;
    ctx.fillStyle = `rgba(140, 168, 196, ${air ? 0.28 : 0.4})`;
    ctx.beginPath();
    ctx.ellipse(2, shadowOff + 4, 8, 3.4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.translate(0, air ? -6 - (s.airTotal - s.air) * 12 : 0);
    ctx.rotate(crashed ? angle + Math.PI * 0.42 : angle);
    ctx.scale(1.5, 1.5);
    if (air) ctx.scale(1, 1 + Math.sin((1 - s.air / s.airTotal) * Math.PI) * 0.12);

    if (crashed) {
      // tumbled skier: snow puff, crossed skis, body and hat
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.ellipse(0, 1, 12, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#e2b53c';
      ctx.lineWidth = 2.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-12, -7);
      ctx.lineTo(10, 7);
      ctx.moveTo(-10, 8);
      ctx.lineTo(12, -6);
      ctx.stroke();
      ctx.fillStyle = '#6b3fa0';
      ctx.strokeStyle = '#2a1b3d';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(0, 0, 8, 5.5, 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f0c9a4';
      ctx.beginPath();
      ctx.arc(7.5, -4.5, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#c0392b';
      ctx.beginPath();
      ctx.arc(8, -6, 3.8, Math.PI, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#39434d';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-6, -4);
      ctx.lineTo(-13, -9);
      ctx.moveTo(-6, 4);
      ctx.lineTo(-13, 9);
      ctx.stroke();
    } else {
      // skis
      ctx.fillStyle = '#e2b53c';
      ctx.strokeStyle = 'rgba(20,30,40,0.55)';
      ctx.lineWidth = 0.8;
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.translate(side * 4.2, 0);
        ctx.beginPath();
        ctx.roundRect(-1.9, -13, 3.8, 26, 1.8);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      // poles
      ctx.strokeStyle = '#39434d';
      ctx.lineWidth = 1.2;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * 6.5, 2);
        ctx.lineTo(side * 9.5, 13);
        ctx.stroke();
      }
      // torso
      ctx.fillStyle = '#6b3fa0';
      ctx.strokeStyle = '#2a1b3d';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(-5, -8, 10, 14, 3);
      ctx.fill();
      ctx.stroke();
      // arms
      ctx.strokeStyle = '#6b3fa0';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(-5, -4);
      ctx.lineTo(-8.5, 4);
      ctx.moveTo(5, -4);
      ctx.lineTo(8.5, 4);
      ctx.stroke();
      // head + cap
      ctx.fillStyle = '#f0c9a4';
      ctx.beginPath();
      ctx.arc(0, -11, 4.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#c0392b';
      ctx.beginPath();
      ctx.arc(0, -12.4, 4.2, Math.PI, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, -16.2, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    if (crashed) {
      ctx.save();
      ctx.font = 'bold 15px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#c0392b';
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 3;
      ctx.strokeText('OUCH!', x, y - 22);
      ctx.fillText('OUCH!', x, y - 22);
      ctx.textAlign = 'left';
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- ui wiring
  function start(mode) {
    resize();
    reset(mode);
    game.state = 'playing';
    last = performance.now();
    el.menu.classList.add('hidden');
    el.over.classList.add('hidden');
    el.paused.classList.add('hidden');
    el.hud.classList.remove('hidden');
    el.pauseBtn.classList.remove('hidden');
    if (view.mobile) el.touch.classList.remove('hidden');
    updateHud();
    sound.ensure();
  }

  el.menu.querySelectorAll('.mode').forEach((b) => {
    b.addEventListener('click', () => start(b.dataset.mode));
  });
  el.again.addEventListener('click', () => start(game.mode));
  el.tomenu.addEventListener('click', () => {
    game.state = 'menu';
    el.over.classList.add('hidden');
    el.menu.classList.remove('hidden');
    el.hud.classList.add('hidden');
    el.pauseBtn.classList.add('hidden');
    el.touch.classList.add('hidden');
  });
  el.resume.addEventListener('click', togglePause);
  el.paused.addEventListener('click', (e) => { if (e.target === el.paused) togglePause(); });
  el.pauseBtn.addEventListener('click', togglePause);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.state === 'playing') togglePause();
  });

  // ---------------------------------------------------------------- boot
  resize();
  // exposed for automated checks and tinkering from the console
  window.__ski = { game, start, reset, MODES };
  requestAnimationFrame(frame);
})();
