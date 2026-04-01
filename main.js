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
  background: 'rgba(255,255,255,0.75)',
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
  position:      'absolute',
  top:           '0',
  left:          '0',
  zIndex:        '1',
  filter:        'blur(20px)',
  pointerEvents: 'none',
});
stage.insertBefore(frostCanvas, layer2);

let frostCtx   = null;
let imageCache = null;

// ── Erosion: time-based point list ───────────────────────────────────────────
const erosionPoints = [];
const DECAY_MS      = 3000;
const MEM_SCALE     = 0.25;
const MEM_RADIUS    = 180;
const MEM_STEP      = 10;
const DEPOSIT_ALPHA = 0.10;

let eCtx  = null;
let surfW = 0, surfH = 0;
let lastMemX = -Infinity, lastMemY = -Infinity;
const erosionCanvas = document.createElement('canvas');

const allPlaced = [];  // { src, x, y, width, itemId, l1El, riEl }
const allLabels = [];  // { el, itemId }

function buildImageCache(eW, eH) {
  const temp    = document.createElement('canvas');
  temp.width    = eW;
  temp.height   = eH;
  const ctx     = temp.getContext('2d');
  ctx.fillStyle = '#f0eeeb';
  ctx.fillRect(0, 0, eW, eH);

  // Helper: draw text elements from layer1 into the cache so they appear blurred.
  function drawTextsIntoCache() {
    layer1.querySelectorAll('.surface-text').forEach(el => {
      const x    = parseFloat(el.style.left)     * MEM_SCALE;
      const y    = parseFloat(el.style.top)      * MEM_SCALE;
      const size = parseFloat(el.style.fontSize) * MEM_SCALE;
      const maxW = parseFloat(el.style.maxWidth) * MEM_SCALE;
      ctx.save();
      ctx.fillStyle = '#333';
      ctx.font      = `${size}px "Lucida Grande", Arial, sans-serif`;
      // Word-wrap manually to match the CSS maxWidth
      const words   = el.textContent.split(' ');
      let line = '', lineY = y + size;
      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (ctx.measureText(test).width > maxW && line) {
          ctx.fillText(line, x, lineY);
          line  = word;
          lineY += size * 1.5;
        } else {
          line = test;
        }
      }
      if (line) ctx.fillText(line, x, lineY);
      ctx.restore();
    });
  }

  let pending = allPlaced.length;
  if (pending === 0) { drawTextsIntoCache(); imageCache = temp; return; }

  // Read positions from DOM so cache always matches post-resolution layout
  allPlaced.forEach(({ src, width, l1El }) => {
    const x       = parseFloat(l1El.style.left);
    const y       = parseFloat(l1El.style.top);
    const isVideo = /\.(mp4|mov|webm|ogg)$/i.test(src);

    if (isVideo) {
      // Draw current video frame; video is already playing so a frame is ready.
      const drawH = (l1El.videoHeight > 0)
        ? l1El.videoHeight * (width / l1El.videoWidth)
        : width * 0.75;
      ctx.drawImage(l1El,
        x * MEM_SCALE, y * MEM_SCALE,
        width * MEM_SCALE, drawH * MEM_SCALE);
      if (--pending === 0) { drawTextsIntoCache(); imageCache = temp; }
    } else {
      const img  = new Image();
      const done = () => {
        if (img.naturalWidth > 0) {
          const ih = img.naturalHeight * (width / img.naturalWidth);
          ctx.drawImage(img,
            x * MEM_SCALE, y * MEM_SCALE,
            width * MEM_SCALE, ih * MEM_SCALE);
        }
        if (--pending === 0) { drawTextsIntoCache(); imageCache = temp; }
      };
      img.onload  = done;
      img.onerror = done;
      img.src     = src;
      if (img.complete) { img.onload = null; img.onerror = null; done(); }
    }
  });
}

// ── Project collision resolution ──────────────────────────────────────────────
// Per-image collision resolver. Minimum gap between any two images: 30px.
// Between images from different projects: 200px gap, UNLESS either image's
// item type is 'loose' or 'found' (those use 30px regardless).
// Called after all layer1 images load so real heights are available.
// buildImageCache is called afterwards so the frost layer matches.

function resolveProjectOverlaps() {
  const SAME_GAP  = 30;   // minimum gap between images in the same project
  const CROSS_GAP = 200;  // minimum gap between images from different projects
  const EXEMPT_TYPES = new Set(['loose', 'found']);

  // Build a lookup of itemId → item type from allPlaced (type stored on element)
  // We tag each placed element with its type during placeItem via data-item-type.
  function getPad(pA, pB) {
    if (pA.itemId === pB.itemId) return SAME_GAP;
    if (EXEMPT_TYPES.has(pA.itemType) || EXEMPT_TYPES.has(pB.itemType)) return SAME_GAP;
    return CROSS_GAP;
  }

  function getRect(p) {
    const x = parseFloat(p.l1El.style.left);
    const y = parseFloat(p.l1El.style.top);
    const w = p.l1El.offsetWidth  || p.width;
    const h = p.l1El.offsetHeight || Math.round(p.width * 1.3);
    return { x, y, w, h };
  }

  function moveImage(p, dx, dy) {
    const nx = Math.round(parseFloat(p.l1El.style.left) + dx);
    const ny = Math.round(parseFloat(p.l1El.style.top)  + dy);
    p.l1El.style.left = nx + 'px';  p.l1El.style.top = ny + 'px';
    p.riEl.style.left = nx + 'px';  p.riEl.style.top = ny + 'px';
  }

  // Also move labels that belong to the same project as a shifted image.
  // Labels are shifted proportionally when their entire project group moves.
  // For per-image resolution we track net displacement per itemId.
  const netDisp = {};  // itemId → { dx, dy }

  for (const p of allPlaced) {
    if (!netDisp[p.itemId]) netDisp[p.itemId] = { dx: 0, dy: 0 };
  }

  for (let pass = 0; pass < 60; pass++) {
    let anyOverlap = false;
    for (let i = 0; i < allPlaced.length; i++) {
      for (let j = i + 1; j < allPlaced.length; j++) {
        const pA = allPlaced[i];
        const pB = allPlaced[j];
        const pad = getPad(pA, pB);
        const a = getRect(pA);
        const b = getRect(pB);

        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + pad;
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + pad;
        if (ox <= 0 || oy <= 0) continue;

        anyOverlap = true;
        // Push along the axis with the smaller overlap
        if (ox <= oy) {
          const push = ox / 2;
          const dir  = (a.x + a.w / 2 <= b.x + b.w / 2) ? 1 : -1;
          moveImage(pA, -push * dir, 0);
          moveImage(pB,  push * dir, 0);
          netDisp[pA.itemId].dx -= push * dir;
          netDisp[pB.itemId].dx += push * dir;
        } else {
          const push = oy / 2;
          const dir  = (a.y + a.h / 2 <= b.y + b.h / 2) ? 1 : -1;
          moveImage(pA, 0, -push * dir);
          moveImage(pB, 0,  push * dir);
          netDisp[pA.itemId].dy -= push * dir;
          netDisp[pB.itemId].dy += push * dir;
        }
      }
    }
    if (!anyOverlap) break;
  }

  // Shift labels by the net displacement accumulated for their project.
  for (const lb of allLabels) {
    const d = netDisp[lb.itemId];
    if (!d || (d.dx === 0 && d.dy === 0)) continue;
    lb.el.style.left = Math.round(parseFloat(lb.el.style.left) + d.dx) + 'px';
    lb.el.style.top  = Math.round(parseFloat(lb.el.style.top)  + d.dy) + 'px';
  }

  // Clamp: ensure no image is above 80px from surface top or left of 80px.
  const TOP_PAD  = 80;
  const LEFT_PAD = 80;
  let minY = Infinity, minX = Infinity;
  for (const p of allPlaced) {
    minY = Math.min(minY, parseFloat(p.l1El.style.top));
    minX = Math.min(minX, parseFloat(p.l1El.style.left));
  }
  const clampDY = minY < TOP_PAD  ? TOP_PAD  - minY : 0;
  const clampDX = minX < LEFT_PAD ? LEFT_PAD - minX : 0;
  if (clampDY !== 0 || clampDX !== 0) {
    for (const p of allPlaced) {
      moveImage(p, clampDX, clampDY);
    }
    for (const lb of allLabels) {
      lb.el.style.left = Math.round(parseFloat(lb.el.style.left) + clampDX) + 'px';
      lb.el.style.top  = Math.round(parseFloat(lb.el.style.top)  + clampDY) + 'px';
    }
  }
}

// Wait for all layer1 images to load, resolve collisions, resize the surface to
// fit all content, then build the frost cache and scroll to the new centre.
function waitResolveAndCache() {
  const imgs = Array.from(layer1.querySelectorAll('img'));
  let pending = imgs.length;

  function finish() {
    resolveProjectOverlaps();

    // ── Compute bounding box of all placed images ────────────────────────────
    const SURFACE_PAD = 400;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const p of allPlaced) {
      const x = parseFloat(p.l1El.style.left);
      const y = parseFloat(p.l1El.style.top);
      const w = p.l1El.offsetWidth  || p.width;
      const h = p.l1El.offsetHeight || Math.round(p.width * 1.3);
      bx0 = Math.min(bx0, x);       by0 = Math.min(by0, y);
      bx1 = Math.max(bx1, x + w);   by1 = Math.max(by1, y + h);
    }
    if (!isFinite(bx0)) { bx0 = 0; by0 = 0; bx1 = 800; by1 = 600; }

    surfW = Math.round(bx1 - bx0 + SURFACE_PAD * 2);
    surfH = Math.round(by1 - by0 + SURFACE_PAD * 2);

    const w = surfW + 'px';
    const h = surfH + 'px';

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

    buildImageCache(eW, eH);

    window.scrollTo(
      surfW / 2 - window.innerWidth  / 2,
      surfH / 2 - window.innerHeight / 2
    );
  }

  if (pending === 0) { finish(); return; }

  const done = () => { if (--pending === 0) finish(); };
  imgs.forEach(img => {
    if (img.complete) { done(); return; }
    img.addEventListener('load',  done, { once: true });
    img.addEventListener('error', done, { once: true });
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

  // Draw current video frames on top of imageCache each frame.
  // Images are baked into imageCache once; videos need live redraw.
  for (const p of allPlaced) {
    if (!(p.l1El instanceof HTMLVideoElement)) continue;
    if (p.l1El.readyState < 2) continue;  // no frame available yet
    const x = parseFloat(p.l1El.style.left);
    const y = parseFloat(p.l1El.style.top);
    const drawW = p.width * MEM_SCALE;
    const drawH = p.l1El.videoHeight > 0
      ? p.l1El.videoHeight * (p.width / p.l1El.videoWidth) * MEM_SCALE
      : drawW * 0.75;
    frostCtx.drawImage(p.l1El, x * MEM_SCALE, y * MEM_SCALE, drawW, drawH);
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

// ── Mobile layout detection ───────────────────────────────────────────────────
const IS_MOBILE = window.innerWidth < 768;
// Desktop surface: 8000×6000. Mobile surface: 2000×4000.
// Remap positions proportionally and scale widths down by 30%.
const MOB_SURF_W = 2000;
const MOB_SURF_H = 4000;
const DESK_SURF_W = 8000;
const DESK_SURF_H = 6000;

function mobilizeImage(img) {
  if (!IS_MOBILE) return img;
  return {
    src:   img.src,
    width: Math.round(img.width * 0.7),
    x:     Math.round(img.x * (MOB_SURF_W / DESK_SURF_W)),
    y:     Math.round(img.y * (MOB_SURF_H / DESK_SURF_H)),
  };
}

// ── Place one item ────────────────────────────────────────────────────────────
function placeItem(item) {
  const rand = makeRand(strToSeed(item.id));
  // Positions come directly from x,y on each image entry in the JSON.
  // On mobile, positions and widths are remapped to the narrower surface.
  const placed = item.images.map(img => mobilizeImage({
    src: img.src, width: img.width, x: img.x, y: img.y
  }));

  placed.forEach(({ src, x, y, width }) => {
    const isVideo = /\.(mp4|mov|webm|ogg)$/i.test(src);

    function makeEl() {
      let el;
      if (isVideo) {
        el = document.createElement('video');
        el.src         = src;
        el.autoplay    = true;
        el.loop        = true;
        el.muted       = true;
        el.playsInline = true;
        el.setAttribute('playsinline', '');
        el.setAttribute('webkit-playsinline', '');  // older Safari
        el.controls    = false;
      } else {
        el = document.createElement('img');
        el.src = src;
      }
      el.style.position = 'absolute';
      el.style.left     = x + 'px';
      el.style.top      = y + 'px';
      el.style.width    = width + 'px';
      el.style.height   = 'auto';
      return el;
    }
    const l1El = makeEl();
    const riEl = makeEl();
    layer1.appendChild(l1El);
    revealInner.appendChild(riEl);
    // For video: call play() explicitly after insertion — needed in some browsers
    // when autoplay attribute alone is not honoured for .mov files.
    if (isVideo) {
      riEl.muted = true;  // frost copy is always muted — visual only, never produces sound
      l1El.play().catch(() => {});
      riEl.play().catch(() => {});
    }
    allPlaced.push({ src, x, y, width, itemId: item.id, itemType: item.type || '', l1El, riEl });

    // For videos: add a mute/unmute label above all layers including the silhouette.
    if (isVideo) {
      const muteBtn = document.createElement('div');
      muteBtn.textContent = 'unmute';
      Object.assign(muteBtn.style, {
        position:      'absolute',
        left:          x + 'px',
        top:           (y + 20) + 'px',
        fontFamily:    '"Lucida Grande", Verdana, Geneva, sans-serif',
        fontSize:      '11px',
        color:         '#333',
        cursor:        'pointer',
        pointerEvents: 'auto',
        userSelect:    'none',
        zIndex:        '10',
      });
      muteBtn.addEventListener('click', () => {
        const isNowMuted = l1El.muted;
        if (isNowMuted) {
          // Unmuting this video — mute all layer1 videos first.
          layer1.querySelectorAll('video').forEach(v => {
            v.muted = true;
          });
          stage.querySelectorAll('.mute-btn').forEach(b => {
            b.textContent = 'unmute';
          });
          l1El.muted = false;
          muteBtn.textContent = 'mute';
        } else {
          l1El.muted = true;
          muteBtn.textContent = 'unmute';
        }
      });
      muteBtn.className = 'mute-btn';
      stage.appendChild(muteBtn);
    }
  });

  if (item.text) {
    // Attach label to a randomly chosen image — either overlapping it or just below.
    const target = placed[Math.floor(rand(0, placed.length))];
    const labelX = Math.round(target.x + rand(0, target.width * 0.5));
    const labelY = Math.round(target.y + rand(10, 50));

    const el       = document.createElement('div');
    el.className   = 'surface-label';
    el.textContent = item.text;
    el.style.left  = labelX + 'px';
    el.style.top   = labelY + 'px';
    layer2.appendChild(el);
    allLabels.push({ el, itemId: item.id });
  }
}

// ── Fetch content ─────────────────────────────────────────────────────────────
fetch('content.json')
  .then(r => {
    if (!r.ok) throw new Error('Could not load content.json');
    return r.json();
  })
  .then(data => {
    surfW = IS_MOBILE ? MOB_SURF_W : data.surface_width;
    surfH = IS_MOBILE ? MOB_SURF_H : data.surface_height;
    const w = surfW + 'px';
    const h = surfH + 'px';

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

    // ── Text layer ────────────────────────────────────────────────────────────
    // Text elements sit on layer1 (the sharp layer) at absolute positions.
    // The frost covers them like images — the erosion cursor reveals them.
    const fontSizes = { small: '11px', medium: '14px', large: '20px' };
    (data.texts || []).forEach(t => {
      const el = document.createElement('div');
      el.className   = 'surface-text';
      el.textContent = t.content;
      const tx = IS_MOBILE ? Math.round(t.x * (MOB_SURF_W / DESK_SURF_W)) : t.x;
      const ty = IS_MOBILE ? Math.round(t.y * (MOB_SURF_H / DESK_SURF_H)) : t.y;
      Object.assign(el.style, {
        position:   'absolute',
        left:       tx + 'px',
        top:        ty + 'px',
        fontFamily: '"Lucida Grande", Arial, sans-serif',
        fontSize:   fontSizes[t.style] || '11px',
        color:       '#333',
        lineHeight:  '1.5',
        maxWidth:    '160px',
        wordSpacing: '3px',
        textAlign:   'left',
        pointerEvents: 'none',
      });
      layer1.appendChild(el);
    });

    waitResolveAndCache();
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
  // layer3 is position:fixed on body — position directly from viewport coords.
  layer3.style.left = (clientX - figW / 2) + 'px';
  layer3.style.top  = (clientY - FIG_H / 2) + 'px';

  const z = parseFloat(stage.style.zoom) || 1;

  // Scale layer3 to match stage zoom so silhouette matches content scale.
  layer3.style.transform       = z !== 1 ? `scale(${z})` : '';
  layer3.style.transformOrigin = 'center';

  // getBoundingClientRect already accounts for CSS zoom and scroll.
  const rect    = layer1.getBoundingClientRect();
  const visOffX = clientX - rect.left;
  const visOffY = clientY - rect.top;

  revealInner.style.left = (figW  / 2 - visOffX / z) + 'px';
  revealInner.style.top  = (FIG_H / 2 - visOffY / z) + 'px';

  applyMemory(visOffX / z, visOffY / z);
}

function hideReveal() {
  layer3.style.left = '-9999px';
  layer3.style.top  = '-9999px';
}

initCursor();
requestAnimationFrame(restoreLoop);

// ── Video autoplay fallback ───────────────────────────────────────────────────
// Safari blocks autoplay until a user gesture. On each interaction, attempt
// play() on every video. If a play() fails, the next interaction retries it.
// Listeners are re-registered after each firing until all videos are playing.
function tryPlayAllVideos() {
  let anyPaused = false;
  document.querySelectorAll('video').forEach(v => {
    if (v.paused) {
      anyPaused = true;
      v.play().catch(() => {});
    }
  });
  // Re-register if any video is still paused after this attempt
  if (anyPaused) registerVideoPlayListeners();
}

function registerVideoPlayListeners() {
  document.addEventListener('mousemove', tryPlayAllVideos, { once: true });
  document.addEventListener('click',     tryPlayAllVideos, { once: true });
  document.addEventListener('touchstart',tryPlayAllVideos, { once: true, passive: true });
}

registerVideoPlayListeners();

// ── Contact overlay ───────────────────────────────────────────────────────────
const contactDiv = document.createElement('div');
Object.assign(contactDiv.style, {
  position:   'fixed',
  top:        '10px',
  left:       '10px',
  zIndex:     '10',
  fontFamily: '"Lucida Grande", Arial, sans-serif',
  fontSize:   '11px',
  color:      '#333',
  lineHeight: '1.6',
  pointerEvents: 'auto',
});
contactDiv.innerHTML =
  'helenyzh, heleniyzh@gmail.com, London<br>';
document.body.appendChild(contactDiv);

// ── MOBILE TOUCH FEATURE ──────────────────────────────────────────────────────
// 1-finger touch: drags the figure. Page does not scroll. Erosion trail active.
//   Figure stays at release position when finger lifts.
// 2-finger touch: scrolls the page normally (browser default).
//   Figure stays fixed at its last position; revealInner re-syncs on scroll.
//
// Hint: on first mobile visit this session, show "drag to look, two fingers to
//   scroll" at bottom-centre after 2 s. Fade in 1 s, hold 3 s, fade out 1 s.
//   Stored in sessionStorage so it only shows once per session.

const mob_pos = { x: 0, y: 0 };  // current viewport position of figure centre

function mob_initPosition() {
  mob_pos.x = window.innerWidth  / 2;
  mob_pos.y = window.innerHeight / 2;
  moveReveal(mob_pos.x, mob_pos.y);
}

// Re-sync reveal offset when the page scrolls under the stationary figure.
function mob_onScroll() {
  moveReveal(mob_pos.x, mob_pos.y);
}

function mob_showHint() {
  if (sessionStorage.getItem('mob_hint_shown')) return;
  sessionStorage.setItem('mob_hint_shown', '1');

  const hint = document.createElement('div');
  hint.textContent = 'drag figure to look, scroll to navigate';
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

if ('ontouchstart' in window) {
  // Enable pointer events on layer3 so it can receive touch.
  layer3.style.pointerEvents = 'auto';

  // Touchstart on layer3 only — drag the figure. Scrolling is unaffected elsewhere.
  layer3.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    e.preventDefault();  // block scroll only while dragging the figure
    const t = e.touches[0];
    mob_pos.x = t.clientX;
    mob_pos.y = t.clientY;
    moveReveal(mob_pos.x, mob_pos.y);
  }, { passive: false });

  layer3.addEventListener('touchmove', e => {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    mob_pos.x = t.clientX;
    mob_pos.y = t.clientY;
    moveReveal(mob_pos.x, mob_pos.y);
  }, { passive: false });

  // touchend: figure stays where released — no action needed.

  document.addEventListener('scroll', mob_onScroll, { passive: true });

  // Place figure at centre once figW is available (initCursor is async).
  const mob_waitForFigW = setInterval(() => {
    if (figW > 0) {
      clearInterval(mob_waitForFigW);
      mob_initPosition();
      mob_showHint();
    }
  }, 50);
}
// ── END MOBILE TOUCH FEATURE ─────────────────────────────────────────────────

// ── PREVIEW / DRAG MODE (press P to toggle) ───────────────────────────────────
// P on  — shows x,y labels on every image, enables click-drag to reposition.
//         Frost and cursor are hidden so you can see exact positions.
// P off — logs updated JSON coordinates to console, restores normal view.

let previewMode = false;
const previewLabels = [];  // { el } coordinate label divs

function previewEnter() {
  previewMode = true;
  frostCanvas.style.display      = 'none';
  layer3.style.display           = 'none';
  layer2.style.pointerEvents     = 'none';
  document.body.style.cursor     = 'default';

  for (const p of allPlaced) {
    // Coordinate label
    const lbl = document.createElement('div');
    Object.assign(lbl.style, {
      position:      'absolute',
      left:          p.l1El.style.left,
      top:           (parseFloat(p.l1El.style.top) - 18) + 'px',
      fontFamily:    '"Lucida Grande", Arial, sans-serif',
      fontSize:      '10px',
      color:         '#e00',
      background:    'rgba(255,255,255,0.75)',
      padding:       '1px 3px',
      pointerEvents: 'none',
      zIndex:        '20',
      whiteSpace:    'nowrap',
    });
    lbl.textContent = `${Math.round(parseFloat(p.l1El.style.left))}, ${Math.round(parseFloat(p.l1El.style.top))}`;
    stage.appendChild(lbl);
    previewLabels.push({ el: lbl, p });

    // Make image draggable
    p.l1El.style.cursor = 'grab';
    p.l1El.addEventListener('mousedown', previewDragStart);
  }
}

function previewExit() {
  previewMode = false;
  frostCanvas.style.display      = '';
  layer3.style.display           = '';
  layer2.style.pointerEvents     = '';
  document.body.style.cursor = '';

  // Remove labels and unbind drag
  for (const { el, p } of previewLabels) {
    el.remove();
    p.l1El.style.cursor = '';
    p.l1El.removeEventListener('mousedown', previewDragStart);
  }
  previewLabels.length = 0;

  // Log updated positions as JSON to console
  const out = {};
  for (const p of allPlaced) {
    if (!out[p.itemId]) out[p.itemId] = [];
    out[p.itemId].push({
      src:   p.src,
      width: p.width,
      x:     Math.round(parseFloat(p.l1El.style.left)),
      y:     Math.round(parseFloat(p.l1El.style.top)),
    });
  }
  console.log('── Updated image positions ──');
  for (const [id, imgs] of Object.entries(out)) {
    console.log(`Item ${id}:`);
    imgs.forEach(img => console.log(`  { "src": "${img.src}", "width": ${img.width}, "x": ${img.x}, "y": ${img.y} }`));
  }
  console.log('────────────────────────────');
}

// Drag logic — uses pageX/pageY so scroll offset is included,
// matching the surface coordinate space of style.left/top.
let _drag = null;

function previewDragStart(e) {
  e.preventDefault();
  e.stopPropagation();
  const p = allPlaced.find(q => q.l1El === e.currentTarget);
  if (!p) return;
  _drag = {
    p,
    startMouseX: e.pageX,
    startMouseY: e.pageY,
    startElX:    parseFloat(p.l1El.style.left),
    startElY:    parseFloat(p.l1El.style.top),
  };
  p.l1El.style.cursor        = 'grabbing';
  document.body.style.userSelect = 'none';
  window.addEventListener('mousemove', previewDragMove);
  window.addEventListener('mouseup',   previewDragEnd);
}

function previewDragMove(e) {
  if (!_drag) return;
  const nx = Math.round(_drag.startElX + e.pageX - _drag.startMouseX);
  const ny = Math.round(_drag.startElY + e.pageY - _drag.startMouseY);
  _drag.p.l1El.style.left = nx + 'px';
  _drag.p.l1El.style.top  = ny + 'px';
  _drag.p.riEl.style.left = nx + 'px';
  _drag.p.riEl.style.top  = ny + 'px';

  // Update coordinate label
  const lbl = previewLabels.find(l => l.p === _drag.p);
  if (lbl) {
    lbl.el.style.left  = nx + 'px';
    lbl.el.style.top   = (ny - 18) + 'px';
    lbl.el.textContent = `${nx}, ${ny}`;
  }
}

function previewDragEnd() {
  if (_drag) _drag.p.l1El.style.cursor = 'grab';
  _drag = null;
  document.body.style.userSelect = '';
  window.removeEventListener('mousemove', previewDragMove);
  window.removeEventListener('mouseup',   previewDragEnd);
}

document.addEventListener('keydown', e => {
  if (e.key === 'p' || e.key === 'P') {
    previewMode ? previewExit() : previewEnter();
  }
});
// ── END PREVIEW / DRAG MODE ───────────────────────────────────────────────────

// ── ZOOM (non-Safari only) ────────────────────────────────────────────────────
const _isSafari = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);

function getMinZoom() {
  const minW = window.innerWidth  / surfW;
  const minH = window.innerHeight / surfH;
  return Math.max(minW, minH);
}

if (!_isSafari) {
  document.addEventListener('wheel', function(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();

    const oldZoom = parseFloat(stage.style.zoom) || 1;
    const delta   = e.deltaY > 0 ? -0.05 : 0.05;
    const newZoom = Math.min(3, Math.max(getMinZoom(), oldZoom + delta));

    const rect     = stage.getBoundingClientRect();
    const surfaceX = (e.clientX - rect.left) / oldZoom;
    const surfaceY = (e.clientY - rect.top)  / oldZoom;

    stage.style.zoom             = newZoom;
    layer3.style.transform       = newZoom !== 1 ? `scale(${newZoom})` : '';
    layer3.style.transformOrigin = 'center';

    window.scrollTo(
      surfaceX * newZoom - e.clientX,
      surfaceY * newZoom - e.clientY
    );
  }, { passive: false });

  window.addEventListener('resize', function() {
    const min = getMinZoom();
    const cur = parseFloat(stage.style.zoom) || 1;
    if (cur < min) stage.style.zoom = min;
  });
}
// ── END ZOOM ──────────────────────────────────────────────────────────────────

