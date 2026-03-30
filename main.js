'use strict';

const layer1 = document.getElementById('layer1');
const layer2 = document.getElementById('layer2');
const stage  = document.getElementById('stage');

// ── Layer 3: silhouette cursor (always sharp) ─────────────────────────────────
const layer3      = document.createElement('div');
const revealInner = document.createElement('div');

Object.assign(layer3.style, {
  position:      'fixed',
  overflow:      'hidden',
  pointerEvents: 'none',
  zIndex:        '3',
  top:           '-9999px',
  left:          '-9999px',
});

Object.assign(revealInner.style, {
  position:   'absolute',
  background: '#f0eeeb',
});

layer3.appendChild(revealInner);
document.body.appendChild(layer3);

// ── Frost canvas ──────────────────────────────────────────────────────────────
// layer1        — sharp images on #f0eeeb
// frostCanvas   — quarter-scale, CSS-upscaled, CSS filter:blur(20px)
//                 Redrawn each frame: imageCache + white tint, destination-out erosion holes
// layer2        — labels (z-index 2)
// layer3        — silhouette cursor, fixed z-index 3, always sharp

const frostCanvas = document.createElement('canvas');
Object.assign(frostCanvas.style, {
  position:        'absolute',
  top:             '0',
  left:            '0',
  zIndex:          '1',
  filter:          'blur(20px)',
  pointerEvents:   'none',
  backgroundColor: '#f0eeeb',  // prevents blur edge bleed showing wrong color on iOS
});
stage.insertBefore(frostCanvas, layer2);

let frostCtx   = null;
let imageCache = null;

// ── Erosion: time-based point list ───────────────────────────────────────────
const erosionPoints = [];
const DECAY_MS      = 2500;
const MEM_SCALE     = 0.25;
const MEM_RADIUS    = 180;
const MEM_STEP      = 10;
const DEPOSIT_ALPHA = 0.10;

let eCtx  = null;
let surfW = 0, surfH = 0;
let lastMemX = -Infinity, lastMemY = -Infinity;
const erosionCanvas = document.createElement('canvas');

const allPlaced = [];

function buildImageCache(eW, eH) {
  const temp    = document.createElement('canvas');
  temp.width    = eW;
  temp.height   = eH;
  const ctx     = temp.getContext('2d');
  ctx.fillStyle = '#f0eeeb';
  ctx.fillRect(0, 0, eW, eH);

  let pending = allPlaced.length;
  if (pending === 0) { imageCache = temp; return; }

  allPlaced.forEach(({ src, x, y, width }) => {
    const img  = new Image();
    const done = () => {
      if (img.naturalWidth > 0) {
        const ih = img.naturalHeight * (width / img.naturalWidth);
        ctx.drawImage(img,
          x * MEM_SCALE, y * MEM_SCALE,
          width * MEM_SCALE, ih * MEM_SCALE);
      }
      if (--pending === 0) imageCache = temp;
    };
    img.onload  = done;
    img.onerror = done;
    img.src     = src;
  });
}

function rebuildErosion(now) {
  if (!eCtx) return;
  const eW = erosionCanvas.width, eH = erosionCanvas.height;
  eCtx.clearRect(0, 0, eW, eH);

  for (const pt of erosionPoints) {
    const age      = now - pt.addedAt;
    const strength = 1 - age / DECAY_MS;

    const g = eCtx.createRadialGradient(pt.ex, pt.ey, 0, pt.ex, pt.ey, pt.r);
    g.addColorStop(0,   `rgba(0,0,0,${DEPOSIT_ALPHA * strength})`);
    g.addColorStop(0.5, `rgba(0,0,0,${DEPOSIT_ALPHA * 0.6 * strength})`);
    g.addColorStop(1,   'rgba(0,0,0,0)');

    eCtx.save();
    eCtx.globalCompositeOperation = 'lighter';
    eCtx.fillStyle = g;
    eCtx.beginPath();
    eCtx.arc(pt.ex, pt.ey, pt.r, 0, Math.PI * 2);
    eCtx.fill();
    eCtx.restore();
  }
}

function drawFrost() {
  if (!frostCtx) return;
  const w = frostCanvas.width, h = frostCanvas.height;

  frostCtx.clearRect(0, 0, w, h);
  if (imageCache) {
    frostCtx.drawImage(imageCache, 0, 0);
  } else {
    frostCtx.fillStyle = '#f0eeeb';
    frostCtx.fillRect(0, 0, w, h);
  }
  frostCtx.fillStyle = 'rgba(255,255,255,0.72)';
  frostCtx.fillRect(0, 0, w, h);

  frostCtx.globalCompositeOperation = 'destination-out';
  frostCtx.drawImage(erosionCanvas, 0, 0);
  frostCtx.globalCompositeOperation = 'source-over';
}

function restoreLoop(now) {
  while (erosionPoints.length > 0 && now - erosionPoints[0].addedAt >= DECAY_MS) {
    erosionPoints.shift();
  }
  rebuildErosion(now);
  drawFrost();
  requestAnimationFrame(restoreLoop);
}

function applyMemory(sx, sy) {
  const dx = sx - lastMemX, dy = sy - lastMemY;
  if (dx * dx + dy * dy < MEM_STEP * MEM_STEP) return;
  lastMemX = sx; lastMemY = sy;

  erosionPoints.push({
    ex:      sx * MEM_SCALE,
    ey:      sy * MEM_SCALE,
    r:       MEM_RADIUS * MEM_SCALE,
    addedAt: performance.now(),
  });
}

// ── Seeded RNG (xorshift32) ───────────────────────────────────────────────────
function makeRand(seed) {
  let s = (seed >>> 0) || 1;
  return (min, max) => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s = s >>> 0;
    return min + (s / 0x100000000) * (max - min);
  };
}

function strToSeed(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return h;
}

// ── Place one item ────────────────────────────────────────────────────────────
function placeItem(item) {
  const rand = makeRand(strToSeed(item.id));
  const { x: ax, y: ay } = item.anchor;

  const placed = [];
  let cursorX = ax;

  item.images.forEach((img, i) => {
    const x = i === 0
      ? ax + rand(-25, 25)
      : cursorX + rand(10, 65);
    const y = ay + rand(-90, 90);
    placed.push({ src: img.src, width: img.width, x: Math.round(x), y: Math.round(y) });
    cursorX = placed[i].x + img.width;
  });

  placed.forEach(({ src, x, y, width }) => {
    function makeImg() {
      const img          = document.createElement('img');
      img.src            = src;
      img.style.position = 'absolute';
      img.style.left     = x + 'px';
      img.style.top      = y + 'px';
      img.style.width    = width + 'px';
      img.style.height   = 'auto';
      return img;
    }
    layer1.appendChild(makeImg());
    revealInner.appendChild(makeImg());
    allPlaced.push({ src, x, y, width });
  });

  if (item.text) {
    const minX   = Math.min(...placed.map(p => p.x));
    const maxX   = Math.max(...placed.map(p => p.x + p.width));
    const minY   = Math.min(...placed.map(p => p.y));
    const labelX = Math.round(minX + rand(0, 0.65) * (maxX - minX));
    const labelY = Math.round(minY + rand(15, 140));

    const el       = document.createElement('div');
    el.className   = 'surface-label';
    el.textContent = item.text;
    el.style.left  = labelX + 'px';
    el.style.top   = labelY + 'px';
    layer2.appendChild(el);
  }
}

// ── Fetch content ─────────────────────────────────────────────────────────────
fetch('content.json')
  .then(r => {
    if (!r.ok) throw new Error('Could not load content.json');
    return r.json();
  })
  .then(data => {
    const w = data.surface_width  + 'px';
    const h = data.surface_height + 'px';
    surfW = data.surface_width;
    surfH = data.surface_height;

    for (const el of [stage, layer1, layer2]) {
      el.style.width  = w;
      el.style.height = h;
    }
    revealInner.style.width  = w;
    revealInner.style.height = h;

    const eW = Math.round(surfW * MEM_SCALE);
    const eH = Math.round(surfH * MEM_SCALE);

    erosionCanvas.width  = eW;
    erosionCanvas.height = eH;
    eCtx = erosionCanvas.getContext('2d');

    frostCanvas.width        = eW;
    frostCanvas.height       = eH;
    frostCanvas.style.width  = w;
    frostCanvas.style.height = h;
    frostCtx = frostCanvas.getContext('2d');

    data.items.forEach(placeItem);
    buildImageCache(eW, eH);
    drawFrost();
  })
  .catch(err => console.error('content.json error:', err.message));

// ── Cursor mechanic ───────────────────────────────────────────────────────────
const FIG_H   = 250;
const FIG_SRC = 'Assets/Human.png';
let figW = 0;

async function initCursor() {
  const img = await new Promise((res, rej) => {
    const i  = new Image();
    i.onload  = () => res(i);
    i.onerror = () => rej(new Error('Cannot load ' + FIG_SRC));
    i.src = FIG_SRC;
  }).catch(e => { console.warn(e.message); return null; });

  if (!img) return;
  figW = Math.round(img.naturalWidth * FIG_H / img.naturalHeight);

  layer3.style.width  = figW + 'px';
  layer3.style.height = FIG_H + 'px';

  const maskUrl = `url("${FIG_SRC}")`;
  layer3.style.webkitMaskImage    = maskUrl;
  layer3.style.webkitMaskSize     = `${figW}px ${FIG_H}px`;
  layer3.style.webkitMaskRepeat   = 'no-repeat';
  layer3.style.webkitMaskPosition = '0 0';
  layer3.style.maskImage          = maskUrl;
  layer3.style.maskMode           = 'alpha';
  layer3.style.maskSize           = `${figW}px ${FIG_H}px`;
  layer3.style.maskRepeat         = 'no-repeat';
  layer3.style.maskPosition       = '0 0';

  document.addEventListener('mousemove',  e => moveReveal(e.clientX, e.clientY));
  document.addEventListener('mouseleave', hideReveal);
  // Touch listeners are added by MOBILE TOUCH FEATURE below
}

function moveReveal(clientX, clientY) {
  layer3.style.left = (clientX - figW / 2) + 'px';
  layer3.style.top  = (clientY - FIG_H / 2) + 'px';

  const rect     = layer1.getBoundingClientRect();
  const surfaceX = clientX - rect.left;
  const surfaceY = clientY - rect.top;
  revealInner.style.left = (-(surfaceX - figW / 2)) + 'px';
  revealInner.style.top  = (-(surfaceY - FIG_H / 2)) + 'px';

  applyMemory(surfaceX, surfaceY);
}

function hideReveal() {
  layer3.style.left = '-9999px';
  layer3.style.top  = '-9999px';
}

initCursor();
requestAnimationFrame(restoreLoop);

// ── MOBILE TOUCH FEATURE ──────────────────────────────────────────────────────
// State machine:
//   IDLE       — no touches
//   PENDING    — 1 finger down, 150 ms window to see if a 2nd finger arrives
//   DRAGGING   — confirmed single-finger drag; figure follows finger, no scroll
//   TWO_FINGER — 2+ fingers active; figure frozen, browser handles scroll/zoom
//   COOLING    — all fingers lifted after TWO_FINGER; 200 ms lockout before
//                single-finger drag can activate again
//
// Zoom compensation: figure stays the same visual size regardless of pinch zoom.
//   visualViewport.scale > 1 → zoomed in → divide CSS dimensions by scale.
//
// Hint shown once per session via sessionStorage.

const MOB = { IDLE: 0, PENDING: 1, DRAGGING: 2, TWO_FINGER: 3, COOLING: 4 };
let mob_state        = MOB.IDLE;
let mob_pendingTimer = null;
let mob_coolingTimer = null;
const mob_pos        = { x: 0, y: 0 };  // viewport coords of figure centre
let mob_vpScale      = 1.0;              // current visual viewport zoom

// Effective figure size: shrinks when zoomed in so it stays the same on screen
function mob_effectiveSize() {
  return { w: figW / mob_vpScale, h: FIG_H / mob_vpScale };
}

// Like moveReveal but uses zoom-corrected dimensions. Always syncs size too.
function mob_moveReveal(clientX, clientY) {
  const { w, h } = mob_effectiveSize();
  const maskSize  = `${w}px ${h}px`;
  layer3.style.width          = w + 'px';
  layer3.style.height         = h + 'px';
  layer3.style.webkitMaskSize = maskSize;
  layer3.style.maskSize       = maskSize;
  layer3.style.left = (clientX - w / 2) + 'px';
  layer3.style.top  = (clientY - h / 2) + 'px';

  const rect     = layer1.getBoundingClientRect();
  const surfaceX = clientX - rect.left;
  const surfaceY = clientY - rect.top;
  revealInner.style.left = (-(surfaceX - w / 2)) + 'px';
  revealInner.style.top  = (-(surfaceY - h / 2)) + 'px';

  applyMemory(surfaceX, surfaceY);
}

function mob_initPosition() {
  mob_pos.x = window.innerWidth  / 2;
  mob_pos.y = window.innerHeight / 2;
  mob_moveReveal(mob_pos.x, mob_pos.y);
}

// ── State transitions ──────────────────────────────────────────────────────

function mob_enterTwoFinger() {
  clearTimeout(mob_pendingTimer);
  clearTimeout(mob_coolingTimer);
  mob_pendingTimer = null;
  mob_coolingTimer = null;
  mob_state = MOB.TWO_FINGER;
}

function mob_enterCooling() {
  mob_state = MOB.COOLING;
  mob_coolingTimer = setTimeout(() => {
    mob_state        = MOB.IDLE;
    mob_coolingTimer = null;
  }, 200);
}

// ── Touch handlers ─────────────────────────────────────────────────────────

function mob_onTouchStart(e) {
  if (e.touches.length >= 2) {
    // Second finger arrived — enter two-finger mode, allow browser scroll/zoom
    mob_enterTwoFinger();
    return;
  }

  // Single finger
  if (mob_state === MOB.TWO_FINGER || mob_state === MOB.COOLING) {
    // Lockout: single finger ignored during and just after two-finger gesture.
    // preventDefault so a stray finger doesn't trigger a browser scroll.
    e.preventDefault();
    return;
  }

  if (mob_state === MOB.IDLE) {
    e.preventDefault();
    mob_state = MOB.PENDING;
    mob_pendingTimer = setTimeout(() => {
      if (mob_state === MOB.PENDING) mob_state = MOB.DRAGGING;
    }, 150);
  }
}

function mob_onTouchMove(e) {
  if (e.touches.length >= 2) {
    // Multi-finger move: enter two-finger, let browser handle scroll/zoom
    if (mob_state !== MOB.TWO_FINGER) mob_enterTwoFinger();
    return;
  }

  if (mob_state === MOB.DRAGGING) {
    e.preventDefault();
    mob_pos.x = e.touches[0].clientX;
    mob_pos.y = e.touches[0].clientY;
    mob_moveReveal(mob_pos.x, mob_pos.y);
  } else if (mob_state === MOB.PENDING) {
    // Hold scroll while 150 ms decision window is open
    e.preventDefault();
  }
  // TWO_FINGER / COOLING / IDLE: don't preventDefault, don't move
}

function mob_onTouchEnd(e) {
  if (mob_state === MOB.TWO_FINGER) {
    if (e.touches.length === 0) mob_enterCooling();
    // If 1 finger remains after 2-finger gesture: stay in TWO_FINGER until
    // all fingers lift, then enter COOLING.
    return;
  }

  if (mob_state === MOB.COOLING) {
    // All fingers lifted; cooldown already running — nothing to do
    return;
  }

  if (e.touches.length === 0) {
    clearTimeout(mob_pendingTimer);
    mob_pendingTimer = null;
    mob_state = MOB.IDLE;
    // Figure stays at mob_pos — no hideReveal
  }
}

// Re-sync reveal when page scrolls under the stationary figure
function mob_onScroll() {
  mob_moveReveal(mob_pos.x, mob_pos.y);
}

// Zoom compensation via visualViewport API
function mob_onViewportChange() {
  if (!window.visualViewport) return;
  const s = window.visualViewport.scale;
  if (Math.abs(s - mob_vpScale) > 0.005) {
    mob_vpScale = s;
    mob_moveReveal(mob_pos.x, mob_pos.y);
  }
}

// ── First-visit hint ───────────────────────────────────────────────────────

function mob_showHint() {
  if (sessionStorage.getItem('mob_hint_shown')) return;
  sessionStorage.setItem('mob_hint_shown', '1');

  const hint = document.createElement('div');
  hint.textContent = 'drag to look, two fingers to scroll';
  Object.assign(hint.style, {
    position:      'fixed',
    bottom:        '32px',
    left:          '50%',
    transform:     'translateX(-50%)',
    fontFamily:    '"Lucida Grande", Verdana, Geneva, sans-serif',
    fontSize:      '11px',
    color:         '#aaa',
    opacity:       '0',
    transition:    'opacity 1s ease',
    zIndex:        '100',
    pointerEvents: 'none',
    whiteSpace:    'nowrap',
  });
  document.body.appendChild(hint);

  setTimeout(() => {
    hint.style.opacity = '1';
    setTimeout(() => {
      hint.style.opacity = '0';
      hint.addEventListener('transitionend', () => hint.remove(), { once: true });
    }, 1000 + 3000);
  }, 2000);
}

// ── Boot ───────────────────────────────────────────────────────────────────

if ('ontouchstart' in window) {
  // touchstart + touchmove non-passive so we can call preventDefault selectively
  document.addEventListener('touchstart',  mob_onTouchStart, { passive: false });
  document.addEventListener('touchmove',   mob_onTouchMove,  { passive: false });
  document.addEventListener('touchend',    mob_onTouchEnd,   { passive: true });
  document.addEventListener('touchcancel', mob_onTouchEnd,   { passive: true });
  document.addEventListener('scroll',      mob_onScroll,     { passive: true });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', mob_onViewportChange);
    window.visualViewport.addEventListener('scroll', mob_onViewportChange);
  }

  // Wait for figW to be set by initCursor (async image load)
  const mob_waitForFigW = setInterval(() => {
    if (figW > 0) {
      clearInterval(mob_waitForFigW);
      mob_initPosition();
      mob_showHint();
    }
  }, 50);
}
// ── END MOBILE TOUCH FEATURE ─────────────────────────────────────────────────
