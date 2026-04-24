'use strict';

document.documentElement.style.visibility = 'hidden';

// ── Landing position offset from centre (px) ──────────────────────────────────
const LANDING_OFFSET_X = -300;   // positive = scroll right
const LANDING_OFFSET_Y = -180;   // positive = scroll down

// Declared early so _mirrorLoop IIFE can read it before the zoom block below.
let _currentScale = 1;

const layer1 = document.getElementById('layer1');
const layer2 = document.getElementById('layer2');
const stage  = document.getElementById('stage');

// ── Scroll wrapper ────────────────────────────────────────────────────────────
// scrollWrap is a fixed viewport-filling div with overflow:scroll.
// stage sits inside it. spacer grows with scale to define the scrollable area.
const scrollWrap = document.createElement('div');
scrollWrap.id = 'scroll-wrap';
document.body.insertBefore(scrollWrap, stage);
scrollWrap.appendChild(stage);

const spacer = document.createElement('div');
spacer.id = 'scroll-spacer';
Object.assign(spacer.style, {
  position:      'absolute',
  top:           '0',
  left:          '0',
  pointerEvents: 'none',
  flexShrink:    '0',
});
scrollWrap.appendChild(spacer);

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

// ── Button label overlay ──────────────────────────────────────────────────────
// Mirrors play/pause/view/unmute/read label text at z-index 4 (above layer3:3)
// so it remains readable even when the silhouette hovers over a button.
// Position is synced every frame via rAF using scrollWrap scroll + stage zoom.
const _btnOverlay = document.createElement('div');
Object.assign(_btnOverlay.style, {
  position:      'fixed',
  top:           '0',
  left:          '0',
  width:         '100vw',
  height:        '100vh',
  pointerEvents: 'none',
  zIndex:        '4',
  overflow:      'hidden',
});
document.body.appendChild(_btnOverlay);

const _btnMirrors = [];  // { srcEl, el, absX, absY }

function _addBtnMirror(srcEl, absX, absY) {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position:   'absolute',
    fontFamily: '"Lucida Grande", Verdana, Geneva, sans-serif',
    fontSize:   '10px',
    color:      '#333',
    whiteSpace: 'nowrap',
  });
  _btnOverlay.appendChild(el);
  _btnMirrors.push({ srcEl, el, absX, absY });
}

(function _mirrorLoop() {
  const sl = scrollWrap.scrollLeft;
  const st = scrollWrap.scrollTop;
  const z  = _currentScale;
  for (const m of _btnMirrors) {
    const ax = parseFloat(m.srcEl.style.left)  || m.absX;
    const ay = parseFloat(m.srcEl.style.top)   || m.absY;
    m.el.style.left        = Math.round(ax * z - sl) + 'px';
    m.el.style.top         = Math.round(ay * z - st) + 'px';
    m.el.style.fontSize    = Math.round(10 * z) + 'px';
    m.el.textContent       = m.srcEl.textContent;
  }
  requestAnimationFrame(_mirrorLoop);
})();

// ── Frost canvas ──────────────────────────────────────────────────────────────
// layer1        — sharp images on #f0eeeb
// frostCanvas   — quarter-scale, CSS-upscaled, CSS filter:blur(20px)
//                 Redrawn each frame: imageCache + white tint, destination-out erosion holes
// layer2        — labels (z-index 2)
// layer3        — silhouette cursor, fixed z-index 3, always sharp

const frostCanvas = document.createElement('canvas');
frostCanvas.id = 'frost-canvas';
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
const MEM_RADIUS    = 182;
const MEM_STEP      = 10;
const DEPOSIT_ALPHA = 0.15;

let eCtx  = null;
let surfW = 0, surfH = 0;
let maxSurfW = 0, maxSurfH = 0;  // declared size from content.json — zoom floor reference
let lastMemX = -Infinity, lastMemY = -Infinity;
const erosionCanvas = document.createElement('canvas');

const allPlaced = [];  // { src, x, y, width, itemId, l1El, riEl }
const allLabels = [];  // { el, itemId }
const allTexts  = [];  // { el, textId }
const viewRects = new Set();  // active video view regions { x, y, w, h }

function buildImageCache(eW, eH) {
  console.log('[DBG] buildImageCache called — eW:', eW, 'eH:', eH, '| caller:', new Error().stack.split('\n')[2]);
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
    // Move buttons and timeline with the video.
    if (p.btns) {
      for (const btn of p.btns) {
        btn.style.left = Math.round(parseFloat(btn.style.left) + dx) + 'px';
        btn.style.top  = Math.round(parseFloat(btn.style.top)  + dy) + 'px';
      }
    }
    if (p.timelineEl) {
      p.timelineEl.style.left = Math.round(parseFloat(p.timelineEl.style.left) + dx) + 'px';
      p.timelineEl.style.top  = Math.round(parseFloat(p.timelineEl.style.top)  + dy) + 'px';
    }
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
    if (!IS_MOBILE) resolveProjectOverlaps();

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

    // Clamp current scale to new minimum now that surfW/surfH are finalised.
    const minAfterResize = getMinScale();
    if (_currentScale < minAfterResize) {
      applyScale(minAfterResize, surfW / 2, surfH / 2);
    }

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

    updateSpacer();
    scrollWrap.scrollLeft = surfW / 2 - scrollWrap.clientWidth  / 2 + LANDING_OFFSET_X;
    scrollWrap.scrollTop  = surfH / 2 - scrollWrap.clientHeight / 2 + LANDING_OFFSET_Y;

    // ── Mobile scroll bounds ─────────────────────────────────────────────────
    // Layers, canvas, and image cache keep their full computed dimensions.
    // Only the stage dimensions and the spacer (which drives scrollWrap's
    // scroll range) are clamped so the user cannot scroll to blank space.
    if (IS_MOBILE) {
      const narrowW = Math.round(bx1 + 80);
      stage.style.width     = narrowW + 'px';
      stage.style.height    = surfH   + 'px';
      stage.style.overflowX = 'hidden';
      stage.style.overflowY = 'hidden';
      // Override the spacer so scrollWrap's scrollable area matches exactly.
      spacer.style.width  = narrowW + 'px';
      spacer.style.height = surfH   + 'px';

      // Reposition GuestWeb (created by the module in index.html) to fit
      // within the narrowed canvas.
      const _posGW = () => {
        const gwEl = document.getElementById('guestweb-area');
        if (!gwEl) return;
        gwEl.style.left = Math.round(4000 * MOB_X_SCALE) + 'px';
        gwEl.style.top  = Math.round(2000 * MOB_Y_SCALE) + 'px';
      };
      setTimeout(_posGW, 0);
      setTimeout(_posGW, 600);  // retry after Firebase entries may have shifted layout

    }
    document.documentElement.style.visibility = 'visible';
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

  // Clear video view rects completely — same effect as silhouette cursor reveal.
  for (const r of viewRects) {
    frostCtx.clearRect(r.x * MEM_SCALE, r.y * MEM_SCALE, r.w * MEM_SCALE, r.h * MEM_SCALE);
  }
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

// Seeded ragged wrap — splits text into at most maxLines lines with random
// word counts per line, giving an uneven right edge.
function raggedWrap(content, textId, maxLines) {
  const rand  = makeRand(strToSeed(textId));
  const words = content.split(' ');
  const lines = [];
  let rem = words.slice();
  for (let i = 0; i < maxLines - 1 && rem.length > 0; i++) {
    const linesLeft = maxLines - i;
    const avg  = rem.length / linesLeft;
    const minW = Math.max(1, Math.floor(avg * 0.65));
    const maxW = Math.ceil(avg * 1.35);
    const count = Math.min(Math.round(rand(minW, maxW)), rem.length - (linesLeft - 1));
    lines.push(rem.splice(0, count).join(' '));
  }
  if (rem.length > 0) lines.push(rem.join(' '));
  return lines.join('<br>');
}

// ── Mobile layout detection ───────────────────────────────────────────────────
// Add ?mob=1 to the URL on desktop to preview the mobile layout and use
// the P-key drag editor to manually set mobile positions.
const IS_MOBILE = window.innerWidth < 768 ||
  new URLSearchParams(window.location.search).has('mob');
// Mobile surface dimensions.
const MOB_SURF_W = 2600;
const MOB_SURF_H = 5200;

// Scale factors — set in the fetch handler once data.surface_width/height are known.
// mobilizeImage() uses these to remap desktop coordinates to mobile space.
let MOB_X_SCALE = 1;
let MOB_Y_SCALE = 1;

// ── Mobile image size ─────────────────────────────────────────────────────────
// Controls how large mobile images are relative to their desktop size.
// 1.0 = same pixel width as the position-scaled desktop image (~37% of desktop).
// 1.5 = 50% bigger than position-scaled  (~55% of desktop).
// 2.0 = same physical size as desktop images (100% relative to desktop would be ~2.7).
// Positions are NOT affected — only rendered width changes. The collision resolver
// will automatically push overlapping images apart after scaling.
const MOB_IMG_SCALE = 0.5;

function mobilizeImage(img) {
  if (!IS_MOBILE) return img;
  // Use manually placed mobile coordinates when present (mx/my/mw in content.json).
  if (img.mx !== undefined) {
    return { src: img.src, width: img.mw, x: img.mx, y: img.my };
  }
  return {
    src:   img.src,
    width: Math.max(60, Math.round(img.width * MOB_X_SCALE * MOB_IMG_SCALE)),
    x:     Math.round(img.x * MOB_X_SCALE),
    y:     Math.round(img.y * MOB_Y_SCALE),
  };
}

// ── Place one item ────────────────────────────────────────────────────────────
function placeItem(item) {
  const rand = makeRand(strToSeed(item.id));
  // Positions come directly from x,y on each image entry in the JSON.
  // On mobile, positions and widths are remapped to the narrower surface.
  const placed = item.images.map(img => mobilizeImage(img));

  placed.forEach(({ src, x, y, width }) => {
    const isVideo = /\.(mp4|mov|webm|ogg)$/i.test(src);

    function makeEl() {
      let el;
      if (isVideo) {
        el = document.createElement('video');
        el.dataset.src = src;  // real src stored here; loaded lazily by observer
        el.autoplay    = IS_MOBILE ? item.id === '015' : true;
        el.loop        = true;
        el.muted       = true;
        el.playsInline = true;
        el.preload     = 'none';
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
    _pendingL1.appendChild(l1El);
    _pendingRI.appendChild(riEl);
    // For video: call play() explicitly after insertion — needed in some browsers
    // when autoplay attribute alone is not honoured for .mov files.
    if (isVideo) {
      riEl.muted = true;  // frost copy is always muted — visual only, never produces sound

      // Lazy-load: observe l1El; when it enters viewport load both copies then play.
      const videoObserver = new IntersectionObserver((entries, obs) => {
        if (!entries[0].isIntersecting) return;
        obs.disconnect();
        const lazySrc = l1El.dataset.src;
        if (lazySrc) {
          l1El.src    = lazySrc;
          riEl.src    = lazySrc;
          l1El.preload = 'auto';
          riEl.preload = 'auto';
        }
        if (!IS_MOBILE || item.id === '015') {
          l1El.play().catch(() => {});
          riEl.play().catch(() => {});
        }
      }, { root: scrollWrap, rootMargin: '200px' });
      videoObserver.observe(l1El);
    }
    const placedEntry = { src, x, y, width, itemId: item.id, itemType: item.type || '', l1El, riEl, btns: [], timelineEl: null };
    allPlaced.push(placedEntry);

    // For videos: always-visible text buttons at random position + timeline at bottom.
    if (isVideo) {
      function fmtTime(s) {
        if (!isFinite(s) || isNaN(s)) return '0:00';
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return m + ':' + (sec < 10 ? '0' : '') + sec;
      }

      const btnY = Math.round(y + rand(10, 40));
      const btnX = Math.round(x + rand(10, width * 0.4));
      let btnOffX = 0;

      function makeBtn(label) {
        const el = document.createElement('div');
        el.textContent = label;
        Object.assign(el.style, {
          position:      'absolute',
          left:          (btnX + btnOffX) + 'px',
          top:           btnY + 'px',
          fontFamily:    '"Lucida Grande", Verdana, Geneva, sans-serif',
          fontSize:      '10px',
          color:         'transparent',  // invisible — mirror at z-index 4 handles display
          cursor:        'pointer',
          userSelect:    'none',
          pointerEvents: 'auto',
          padding:       '10px 14px',
          margin:        '-10px -14px',
        });
        layer2.appendChild(el);
        btnOffX += 70;
        return el;
      }

      // Play / pause
      const playBtn = makeBtn('pause');
      playBtn.addEventListener('click', () => {
        const v1 = /** @type {HTMLVideoElement} */ (l1El);
        const v2 = /** @type {HTMLVideoElement} */ (riEl);
        if (v1.paused) {
          v1.play().catch(() => {});
          v2.play().catch(() => {});
          playBtn.textContent = 'pause';
        } else {
          v1.pause();
          v2.pause();
          playBtn.textContent = 'play';
        }
      });

      // View
      const viewBtn = makeBtn('view');
      let _viewTimeout = null;
      let _viewRect    = null;

      function stopView() {
        clearTimeout(_viewTimeout);
        _viewTimeout = null;
        if (_viewRect) { viewRects.delete(_viewRect); _viewRect = null; }
        viewBtn.textContent = 'view';
      }

      viewBtn.addEventListener('click', () => {
        if (_viewRect) { stopView(); return; }
        viewBtn.textContent = 'hide';
        const liveX = parseFloat(l1El.style.left);
        const liveY = parseFloat(l1El.style.top);
        const vidH = l1El.videoHeight > 0
          ? Math.round(l1El.videoHeight * (width / l1El.videoWidth))
          : Math.round(width * 0.75);
        _viewRect = { x: liveX, y: liveY, w: width, h: vidH };
        viewRects.add(_viewRect);
        const dur = (l1El.duration && isFinite(l1El.duration))
          ? l1El.duration * 1000 : 5000;
        _viewTimeout = setTimeout(stopView, dur);
      });

      // Mute / unmute
      const muteBtn = makeBtn('unmute');
      muteBtn.className = 'mute-btn';
      muteBtn.addEventListener('click', () => {
        if (l1El.muted) {
          layer1.querySelectorAll('video').forEach(v => { v.muted = true; });
          stage.querySelectorAll('.mute-btn').forEach(b => { b.textContent = 'unmute'; });
          l1El.muted = false;
          muteBtn.textContent = 'mute';
        } else {
          l1El.muted = true;
          muteBtn.textContent = 'unmute';
        }
      });


      _addBtnMirror(playBtn, parseFloat(playBtn.style.left), parseFloat(playBtn.style.top));
      _addBtnMirror(viewBtn, parseFloat(viewBtn.style.left), parseFloat(viewBtn.style.top));
      _addBtnMirror(muteBtn, parseFloat(muteBtn.style.left), parseFloat(muteBtn.style.top));
      placedEntry.btns.push(playBtn, viewBtn, muteBtn);

      // ── Timeline: always visible, fixed at bottom of video ───────────────────
      const timelineRow = document.createElement('div');
      Object.assign(timelineRow.style, {
        position:    'absolute',
        left:        x + 'px',
        top:         (y + Math.round(width * 0.75)) + 'px',  // updated on loadedmetadata
        width:       width + 'px',
        display:     'flex',
        alignItems:  'center',
        gap:         '5px',
        boxSizing:   'border-box',
        fontFamily:  '"Lucida Grande", Verdana, Geneva, sans-serif',
        fontSize:    '10px',
        color:       '#333',
        userSelect:  'none',
        pointerEvents: 'auto',
      });
      layer2.appendChild(timelineRow);
      placedEntry.timelineEl = timelineRow;

      const currentTimeEl = document.createElement('div');
      currentTimeEl.textContent = '0:00';
      Object.assign(currentTimeEl.style, { flexShrink: '0', minWidth: '26px' });
      timelineRow.appendChild(currentTimeEl);

      const timelineTrack = document.createElement('div');
      Object.assign(timelineTrack.style, {
        flex:         '1',
        height:       '5px',
        background:   'rgba(0,0,0,0.12)',
        cursor:       'pointer',
        position:     'relative',
        borderRadius: '3px',
      });
      const timelineFill = document.createElement('div');
      Object.assign(timelineFill.style, {
        position:      'absolute',
        left:          '0',
        top:           '0',
        height:        '100%',
        width:         '0%',
        background:    '#555',
        borderRadius:  '3px',
        pointerEvents: 'none',
      });
      timelineTrack.appendChild(timelineFill);
      timelineRow.appendChild(timelineTrack);

      const totalTimeEl = document.createElement('div');
      totalTimeEl.textContent = '0:00';
      Object.assign(totalTimeEl.style, { flexShrink: '0', minWidth: '26px' });
      timelineRow.appendChild(totalTimeEl);

      // Fix timeline position once actual video height is known
      function updateTimelinePos() {
        if (l1El.videoHeight > 0 && l1El.videoWidth > 0) {
          const vidH = Math.round(l1El.videoHeight * (width / l1El.videoWidth));
          timelineRow.style.top = (y + vidH + 4) + 'px';
        }
      }
      l1El.addEventListener('loadedmetadata', () => {
        updateTimelinePos();
        totalTimeEl.textContent = fmtTime(l1El.duration);
      });
      if (l1El.readyState >= 1) updateTimelinePos();

      // Scrub — keep _scrubbing true briefly after mouseup to absorb stray timeupdate
      let _scrubbing = false;
      let _scrubEndTimer = null;
      function seekFromEvent(e) {
        const rect = timelineTrack.getBoundingClientRect();
        const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (l1El.duration) {
          const t = pct * l1El.duration;
          l1El.currentTime = t;
          riEl.currentTime = t;
          timelineFill.style.width = (pct * 100) + '%';
          currentTimeEl.textContent = fmtTime(t);
        }
      }
      timelineTrack.addEventListener('mousedown', e => {
        clearTimeout(_scrubEndTimer);
        _scrubbing = true;
        seekFromEvent(e);
        const onMove = e2 => { if (_scrubbing) seekFromEvent(e2); };
        const onUp   = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup',   onUp);
          _scrubEndTimer = setTimeout(() => { _scrubbing = false; }, 150);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup',   onUp);
      });

      l1El.addEventListener('timeupdate', () => {
        if (_scrubbing || !l1El.duration) return;
        timelineFill.style.width = ((l1El.currentTime / l1El.duration) * 100) + '%';
        currentTimeEl.textContent = fmtTime(l1El.currentTime);
      });
    }
  });

  if (item.text) {
    // If the item has a video, always attach the label to it. Otherwise pick randomly.
    const videoEntry = placed.find(p => /\.(mp4|mov|webm|ogg)$/i.test(p.src));
    const target = videoEntry || placed[Math.floor(rand(0, placed.length))];
    const labelX = Math.round(target.x + rand(0, target.width * 0.5));
    const labelY = videoEntry
      ? Math.round(target.y + rand(70, 110))
      : Math.round(target.y + rand(10, 50));

    const el       = document.createElement('div');
    el.className   = 'surface-label';
    el.textContent = item.text;
    el.style.left  = labelX + 'px';
    el.style.top   = labelY + 'px';
    layer2.appendChild(el);
    allLabels.push({ el, itemId: item.id });

    if (item.link) {
      const lx = IS_MOBILE ? Math.round(item.link.x * MOB_X_SCALE) : item.link.x;
      const ly = IS_MOBILE ? Math.round(item.link.y * MOB_Y_SCALE) : item.link.y;
      const linkEl = document.createElement('a');
      linkEl.href        = item.link.href;
      linkEl.target      = '_blank';
      linkEl.rel         = 'noopener noreferrer';
      linkEl.textContent = item.link.href.replace(/^https?:\/\//, '').replace(/\/$/, '');
      Object.assign(linkEl.style, {
        position:       'absolute',
        left:           lx + 'px',
        top:            ly + 'px',
        fontFamily:     '"Lucida Grande", Verdana, Geneva, sans-serif',
        fontSize:       '11px',
        color:          '#333',
        textDecoration: 'underline',
        pointerEvents:  'auto',
        cursor:         'pointer',
      });
      layer2.appendChild(linkEl);
      allLabels.push({ el: linkEl, itemId: item.id });
    }
  }

  // ── "read" button for ScreenShotThis (id 012) — reveals t001 text region ──
  if (item.id === '012') {
    const target = placed[0];
    const readBtnX = Math.round(target.x + rand(0, target.width * 0.4));
    const readBtnY = Math.round(target.y + rand(70, 110));

    const readBtn = document.createElement('div');
    readBtn.textContent = 'read';
    Object.assign(readBtn.style, {
      position:      'absolute',
      left:          readBtnX + 'px',
      top:           readBtnY + 'px',
      fontFamily:    '"Lucida Grande", Verdana, Geneva, sans-serif',
      fontSize:      '10px',
      color:         'transparent',  // invisible — mirror at z-index 4 handles display
      cursor:        'pointer',
      userSelect:    'none',
      pointerEvents: 'auto',
      padding:       '10px 14px',
      margin:        '-10px -14px',
    });

    let _readRect    = null;
    let _readTimeout = null;

    readBtn.addEventListener('click', () => {
      if (_readRect) {
        clearTimeout(_readTimeout);
        _readTimeout = null;
        viewRects.delete(_readRect);
        _readRect = null;
        readBtn.textContent = 'read';
        return;
      }

      // Get t001's current position and size from the DOM at click time
      const t001 = allTexts.find(t => t.textId === 't001');
      if (!t001) return;
      const tx = parseFloat(t001.el.style.left);
      const ty = parseFloat(t001.el.style.top);
      const tw = t001.el.offsetWidth  || 420;
      const th = t001.el.offsetHeight || 120;

      _readRect = { x: tx, y: ty, w: tw, h: th };
      viewRects.add(_readRect);
      readBtn.textContent = 'close';

      _readTimeout = setTimeout(() => {
        viewRects.delete(_readRect);
        _readRect = null;
        _readTimeout = null;
        readBtn.textContent = 'read';
      }, 12000);
    });

    layer2.appendChild(readBtn);
    _addBtnMirror(readBtn, parseFloat(readBtn.style.left), parseFloat(readBtn.style.top));
  }
}

// ── UpdateLog scatter layer ───────────────────────────────────────────────────
// Zone centre where update entries are scattered (desktop surface coords).
const UL_ZONE_X = 3600;
const UL_ZONE_Y = 2700;

function placeUpdateLog(entries) {
  if (!entries || entries.length === 0) return;
  entries.forEach((entry, i) => {
    const rand     = makeRand(strToSeed('ul_' + i + '_' + entry.date));
    const isLatest = i === 0;
    let x = isLatest ? UL_ZONE_X : Math.round(UL_ZONE_X + rand(-220, 220));
    let y = isLatest ? UL_ZONE_Y : Math.round(UL_ZONE_Y + rand(-160, 160));
    if (IS_MOBILE) { x = Math.round(x * MOB_X_SCALE); y = Math.round(y * MOB_Y_SCALE); }
    const rotation = rand(-5, 5);
    const text = (isLatest ? 'last updated ' : '') + entry.date + (entry.note ? ' \u2014 ' + entry.note : '');
    const el = document.createElement('div');
    el.className      = 'surface-text';
    el.dataset.textId = 'ul_' + i;
    el.textContent    = text;
    Object.assign(el.style, {
      position:        'absolute',
      left:            x + 'px',
      top:             y + 'px',
      fontFamily:      '"Lucida Grande", Arial, sans-serif',
      fontSize:        isLatest ? '12px' : '10px',
      color:           '#333',
      opacity:         isLatest ? '0.65' : String(rand(0.25, 0.42).toFixed(2)),
      whiteSpace:      'nowrap',
      pointerEvents:   'none',
      transform:       'rotate(' + rotation.toFixed(2) + 'deg)',
      transformOrigin: 'left top',
    });
    _pendingL1.appendChild(el);
    allTexts.push({ el, textId: 'ul_' + i });
  });
}

// Fragments that collect all layer1/revealInner elements before they're shown.
// Everything is appended to these until the final flush in waitResolveAndCache,
// so the browser never paints a partial or pre-layout state.
const _pendingL1 = document.createDocumentFragment();
const _pendingRI = document.createDocumentFragment();

// ── Fetch content ─────────────────────────────────────────────────────────────
fetch('content.json')
  .then(r => {
    if (!r.ok) throw new Error('Could not load content.json');
    return r.json();
  })
  .then(data => {
    if (IS_MOBILE) {
      MOB_X_SCALE = MOB_SURF_W / data.surface_width;
      MOB_Y_SCALE = MOB_SURF_H / data.surface_height;
    }
    surfW = IS_MOBILE ? MOB_SURF_W : data.surface_width;
    surfH = IS_MOBILE ? MOB_SURF_H : data.surface_height;
    maxSurfW = surfW;
    maxSurfH = surfH;
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
      el.className      = 'surface-text';
      el.dataset.textId = t.id;
      if (Array.isArray(t.lines)) {
        el.innerHTML = t.lines.map(l => l.replace(/&/g,'&amp;').replace(/</g,'&lt;')).join('<br>');
      } else {
        el.textContent = t.content || '';
      }
      const tx = IS_MOBILE ? (t.mx !== undefined ? t.mx : Math.round(t.x * MOB_X_SCALE)) : t.x;
      const ty = IS_MOBILE ? (t.my !== undefined ? t.my : Math.round(t.y * MOB_Y_SCALE)) : t.y;
      Object.assign(el.style, {
        position:      'absolute',
        left:          tx + 'px',
        top:           ty + 'px',
        fontFamily:    '"Lucida Grande", Arial, sans-serif',
        fontSize:      fontSizes[t.style] || '11px',
        color:         '#333',
        lineHeight:    t.lineHeight !== undefined ? String(t.lineHeight) : '1.5',
        maxWidth:      (t.maxWidth ? t.maxWidth + 'px' : '160px'),
        wordSpacing:   '3px',
        textAlign:     t.align || 'left',
        pointerEvents: 'none',
      });
      _pendingL1.appendChild(el);
      allTexts.push({ el, textId: t.id });
    });

    // ── DUMPimages loader ─────────────────────────────────────────────────────
    // Fetch DUMPimages/manifest.json, scatter images and .txt files across the
    // stage alongside portfolio items. Positions are seeded by filename so they
    // stay stable across reloads. Call waitResolveAndCache after all are placed.
    fetch('DUMPimages/manifest.json')
      .then(r => r.ok ? r.json() : [])
      .catch(() => [])
      .then(files => {
        const imgExts = /\.(jpe?g|png|gif|webp|svg)$/i;
        const txtExts = /\.txt$/i;
        const imgFiles = files.filter(f => imgExts.test(f));
        const txtFiles = files.filter(f => txtExts.test(f));

        // Place images — grid-cell distribution so right/bottom are evenly covered.
        // Divide the surface into a grid with one cell per image, then randomise
        // position within each cell so images stay stable but spread evenly.
        const surfaceW = IS_MOBILE ? MOB_SURF_W : data.surface_width;
        const surfaceH = IS_MOBILE ? MOB_SURF_H : data.surface_height;
        const cols = Math.ceil(Math.sqrt(imgFiles.length));
        const rows = Math.ceil(imgFiles.length / cols);
        const cellW = Math.floor(surfaceW / cols);
        const cellH = Math.floor(surfaceH / rows);

        imgFiles.forEach((filename, i) => {
          const col   = i % cols;
          const row   = Math.floor(i / cols);
          const seed  = strToSeed('dump_' + filename);
          const rand  = makeRand(seed);
          const w     = Math.round(rand(120, 240));
          const pad   = 60;
          const x     = Math.round(col * cellW + rand(pad, Math.max(pad + 1, cellW - w - pad)));
          const y     = Math.round(row * cellH + rand(pad, Math.max(pad + 1, cellH - 240 - pad)));
          const src   = 'DUMPimages/' + filename;

          function makeDumpEl() {
            const el = document.createElement('img');
            el.src            = src;
            el.style.position = 'absolute';
            el.style.left     = x + 'px';
            el.style.top      = y + 'px';
            el.style.width    = w + 'px';
            el.style.height   = 'auto';
            return el;
          }
          const l1El = makeDumpEl();
          const riEl = makeDumpEl();
          _pendingL1.appendChild(l1El);
          _pendingRI.appendChild(riEl);
          allPlaced.push({ src, x, y, width: w, itemId: 'dump_' + filename, itemType: 'loose', l1El, riEl });
        });

        // Place text files — fetch content, render as surface-text at random pos.
        const txtPromises = txtFiles.map(filename => {
          const seed = strToSeed('dump_' + filename);
          const rand = makeRand(seed);
          const x    = Math.round(rand(80, (IS_MOBILE ? MOB_SURF_W : data.surface_width)  - 300));
          const y    = Math.round(rand(80, (IS_MOBILE ? MOB_SURF_H : data.surface_height) - 200));
          return fetch('DUMPimages/' + filename)
            .then(r => r.ok ? r.text() : '')
            .then(text => {
              if (!text.trim()) return;
              const el = document.createElement('div');
              el.className      = 'surface-text';
              el.dataset.textId = 'dump_' + filename;
              el.textContent    = text.trim();
              Object.assign(el.style, {
                position:      'absolute',
                left:          x + 'px',
                top:           y + 'px',
                fontFamily:    '"Lucida Grande", Arial, sans-serif',
                fontSize:      '11px',
                color:         '#333',
                lineHeight:    '1.5',
                maxWidth:      '280px',
                pointerEvents: 'none',
              });
              _pendingL1.appendChild(el);
              allTexts.push({ el, textId: 'dump_' + filename });
            })
            .catch(() => {});
        });

        const ulPromise = fetch('updatelog.json')
          .then(r => r.ok ? r.json() : [])
          .catch(() => [])
          .then(entries => placeUpdateLog(entries));

        Promise.all([...txtPromises, ulPromise]).then(() => {
          // Pre-position scroll before elements appear so there's no visible jump.
          scrollWrap.scrollLeft = surfW / 2 - scrollWrap.clientWidth  / 2 + LANDING_OFFSET_X;
          scrollWrap.scrollTop  = surfH / 2 - scrollWrap.clientHeight / 2 + LANDING_OFFSET_Y;
          // Flush all layer1/revealInner elements at once — final positions already set.
          layer1.appendChild(_pendingL1);
          revealInner.appendChild(_pendingRI);
          waitResolveAndCache();
          drawFrost();
        });
      });
    // ── END DUMPimages loader ─────────────────────────────────────────────────
  })
  .catch(err => console.error('content.json error:', err.message));

// ── Cursor mechanic ───────────────────────────────────────────────────────────
const FIG_H   = 250;
const FIG_SRC = 'Assets/BOB.png';
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

  // Skip on touch devices — taps fire synthetic mousemove that would teleport the figure.
  if (!IS_MOBILE) {
    document.addEventListener('mousemove',  e => { _lastMouseX = e.clientX; _lastMouseY = e.clientY; moveReveal(e.clientX, e.clientY); });
    document.addEventListener('mouseleave', hideReveal);
  }
  // Touch listeners are added by MOBILE TOUCH FEATURE below
}

function moveReveal(clientX, clientY) {
  // layer3 is position:fixed on body — position directly from viewport coords.
  layer3.style.left = (clientX - figW / 2) + 'px';
  layer3.style.top  = (clientY - FIG_H / 2) + 'px';

  const z = _currentScale;

  // Scale layer3 to match stage scale so silhouette matches content scale.
  layer3.style.transform       = z !== 1 ? `scale(${z})` : '';
  layer3.style.transformOrigin = 'center';

  // getBoundingClientRect reflects the visual position after CSS transform.
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
    if (!v.src) return;  // not yet lazy-loaded — skip
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

if (!IS_MOBILE) registerVideoPlayListeners();

// ── Contact overlay ───────────────────────────────────────────────────────────
const contactDiv = document.createElement('div');
Object.assign(contactDiv.style, {
  position:   'fixed',
  top:        '10px',
  left:       '10px',
  zIndex:     '10',
  fontFamily: '"Lucida Grande", Arial, sans-serif',
  fontSize:   '12px',
  color:      '#333',
  lineHeight: '1.6',
  pointerEvents: 'auto',
});
const gwLink = document.createElement('span');
gwLink.textContent = 'Guest';
Object.assign(gwLink.style, {
  textDecoration: 'underline',
  cursor:         'pointer',
});
gwLink.addEventListener('click', () => {
  const gwEl = document.getElementById('guestweb-area');
  if (!gwEl) return;

  const gwX = parseFloat(gwEl.style.left) || 0;
  const gwY = parseFloat(gwEl.style.top)  || 0;
  const gwW = gwEl.offsetWidth  || 190;
  const gwH = gwEl.offsetHeight || 120;

  // Target: scale 1, centred on guestweb-area.
  const targetScale      = Math.max(1, _currentScale);
  const targetScrollLeft = gwX * targetScale + (gwW * targetScale) / 2 - scrollWrap.clientWidth  / 2;
  const targetScrollTop  = gwY * targetScale + (gwH * targetScale) / 2 - scrollWrap.clientHeight / 2;

  if (_currentScale >= 1) {
    // Already at or above scale 1 — just scroll smoothly, no zoom change.
    scrollWrap.scrollTo({ left: targetScrollLeft, top: targetScrollTop, behavior: 'smooth' });
    return;
  }

  // Zoomed out — animate zoom + scroll simultaneously over ~1.5 s.
  const DURATION        = 1500;
  const startScale      = _currentScale;
  const startScrollLeft = scrollWrap.scrollLeft;
  const startScrollTop  = scrollWrap.scrollTop;
  const startTime       = performance.now();

  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  function animFrame(now) {
    const raw = Math.min(1, (now - startTime) / DURATION);
    const t   = easeInOut(raw);

    const scale = startScale + (targetScale - startScale) * t;
    const sl    = startScrollLeft + (targetScrollLeft - startScrollLeft) * t;
    const st    = startScrollTop  + (targetScrollTop  - startScrollTop)  * t;

    _currentScale = scale;
    stage.style.transformOrigin = '0 0';
    stage.style.transform       = 'scale(' + scale + ')';
    updateSpacer();
    scrollWrap.scrollLeft = sl;
    scrollWrap.scrollTop  = st;
    if (typeof _updateScaleBar === 'function') _updateScaleBar();

    if (raw < 1) requestAnimationFrame(animFrame);
  }

  requestAnimationFrame(animFrame);
});

contactDiv.innerHTML = 'helenyzh, heleniyzh@gmail.com, London, ';
contactDiv.appendChild(gwLink);
document.body.appendChild(contactDiv);

// ── Bookmark icon ─────────────────────────────────────────────────────────────
(function () {
  const bookmarkEl = document.createElement('div');
  Object.assign(bookmarkEl.style, {
    position:   'fixed',
    top:        '10px',
    right:      '10px',
    zIndex:     '10',
    fontFamily: '"Lucida Grande", Arial, sans-serif',
    fontSize:   '18px',
    color:      '#ccc',
    cursor:     'pointer',
    lineHeight: '1',
    userSelect: 'none',
    pointerEvents: 'auto',
  });

  function render(filled) {
    bookmarkEl.innerHTML = filled
      ? '<svg width="14" height="18" viewBox="0 0 14 18" fill="#333" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h14v18l-7-5-7 5V0z"/></svg>'
      : '<svg width="14" height="18" viewBox="0 0 14 18" fill="none" stroke="#333" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><path d="M1 1h12v15.5l-6-4.3-6 4.3V1z"/></svg>';
  }

  // Detect bookmark state: use standalone display mode as a proxy for "added to home screen".
  // There's no reliable cross-browser API to detect bookmarks; we store a flag in localStorage.
  let isBookmarked = localStorage.getItem('hy_bookmarked') === '1';
  render(isBookmarked);

  bookmarkEl.title = isBookmarked ? 'Bookmarked' : 'Bookmark this site';

  bookmarkEl.addEventListener('click', function () {
    if (IS_MOBILE && navigator.share) {
      navigator.share({ title: document.title, url: window.location.href }).catch(() => {});
      return;
    }
    // Try legacy browser bookmark APIs
    if (window.sidebar && window.sidebar.addPanel) {
      window.sidebar.addPanel(document.title, location.href, '');
      isBookmarked = true;
    } else {
      // Modern browsers don't allow programmatic bookmarking — show instructions
      const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
      const shortcut = isMac ? '⌘+D' : 'Ctrl+D';
      alert('Press ' + shortcut + ' to bookmark this page.');
    }
    if (isBookmarked) {
      localStorage.setItem('hy_bookmarked', '1');
      render(true);
      bookmarkEl.title = 'Bookmarked';
    }
  });

  document.body.appendChild(bookmarkEl);
})();

// ── Zoom button overlay ───────────────────────────────────────────────────────
const ZOOM_BTN_SIZE   = 18;   // font size in px — adjust here
const ZOOM_BTN_GAP    = 10;   // gap between + and − in px — adjust here
const ZOOM_STEP       = 0.5; // scale change per click
const ZOOM_BTN_LEFT   = 14;   // px from left edge — adjust here

const zoomWrap = document.createElement('div');
Object.assign(zoomWrap.style, {
  position:      'fixed',
  left:          ZOOM_BTN_LEFT + 'px',
  top:           '50%',
  transform:     'translateY(-50%)',
  zIndex:        '10',
  display:       'flex',
  flexDirection: 'column',
  alignItems:    'center',
  gap:           ZOOM_BTN_GAP + 'px',
  pointerEvents: 'auto',
  fontFamily:    '"Lucida Grande", Arial, sans-serif',
  fontSize:      ZOOM_BTN_SIZE + 'px',
  color:         '#333',
  userSelect:    'none',
});

// Smooth zoom — lerps _currentScale toward _targetScale each rAF frame.
let _targetScale  = 1;
let _zoomAnchorX  = 0;
let _zoomAnchorY  = 0;
let _zoomRafId    = null;

function _zoomStep() {
  try {
    _zoomRafId = null;
    const diff = _targetScale - _currentScale;
    if (Math.abs(diff) < 0.0015) {
      applyScale(_targetScale, _zoomAnchorX, _zoomAnchorY);
      if (!IS_MOBILE) moveReveal(_lastMouseX, _lastMouseY);
      return;
    }
    applyScale(_currentScale + diff * 0.1, _zoomAnchorX, _zoomAnchorY);
    if (!IS_MOBILE) moveReveal(_lastMouseX, _lastMouseY);
    _zoomRafId = requestAnimationFrame(_zoomStep);
  } catch (err) {
    console.error('[DBG] _zoomStep CRASHED:', err);
  }
}

function _zoomFromCentre(newScale) {
  const cx = scrollWrap.clientWidth  / 2;
  const cy = scrollWrap.clientHeight / 2;
  _zoomAnchorX = (scrollWrap.scrollLeft + cx) / _currentScale;
  _zoomAnchorY = (scrollWrap.scrollTop  + cy) / _currentScale;
  _targetScale = Math.max(getMinScale(), Math.min(IS_MOBILE ? 2 : 3, newScale));
  if (_zoomRafId === null) _zoomRafId = requestAnimationFrame(_zoomStep);
}

const zoomInBtn = document.createElement('div');
zoomInBtn.textContent = '+';
Object.assign(zoomInBtn.style, { cursor: 'pointer', lineHeight: '1' });
zoomInBtn.addEventListener('click', () => _zoomFromCentre(_currentScale + (IS_MOBILE ? 0.25 : ZOOM_STEP)));

// Scale bar
const scaleBarWrap = document.createElement('div');
Object.assign(scaleBarWrap.style, {
  width:      '2px',
  height:     '60px',
  background: 'rgba(0,0,0,0.12)',
  position:   'relative',
});
const scaleBarFill = document.createElement('div');
Object.assign(scaleBarFill.style, {
  position:   'absolute',
  bottom:     '0',
  left:       '0',
  width:      '100%',
  background: '#555',
  transition: 'height 0.15s ease',
});
scaleBarWrap.appendChild(scaleBarFill);

function _updateScaleBar() {
  const min = IS_MOBILE ? 1.0 : getMinScale();
  const max = IS_MOBILE ? 2 : 3;
  const pct = Math.max(0, Math.min(1, (_currentScale - min) / (max - min)));
  scaleBarFill.style.height = Math.round(pct * 100) + '%';
}

const zoomOutBtn = document.createElement('div');
zoomOutBtn.textContent = '−';
Object.assign(zoomOutBtn.style, { cursor: 'pointer', lineHeight: '1' });
zoomOutBtn.addEventListener('click', () => {
  console.log('[DBG] zoom-out button clicked | _currentScale before:', _currentScale);
  if (IS_MOBILE && _currentScale <= 1.0) return;
  try {
    _zoomFromCentre(_currentScale - (IS_MOBILE ? 0.25 : ZOOM_STEP));
  } catch (err) {
    console.error('[DBG] zoom-out CRASHED:', err);
  }
});

zoomWrap.appendChild(zoomInBtn);
zoomWrap.appendChild(scaleBarWrap);
zoomWrap.appendChild(zoomOutBtn);
document.body.appendChild(zoomWrap);

setTimeout(_updateScaleBar, 800);

// ── MOBILE ZOOM SCALE INDICATOR ───────────────────────────────────────────────
// Small "×1.5" label to the right of zoom buttons, visible on mobile only.
// Shown immediately on button click, fades out 1.5 s after last click.
if (IS_MOBILE) {
  const _zoomLabel = document.createElement('div');
  Object.assign(_zoomLabel.style, {
    position:   'fixed',
    left:       (ZOOM_BTN_LEFT + 20) + 'px',
    top:        '50%',
    transform:  'translateY(-50%)',
    zIndex:     '10',
    fontFamily: '"Lucida Grande", Verdana, Geneva, sans-serif',
    fontSize:   '11px',
    color:      '#aaa',
    opacity:    '0',
    transition: 'opacity 0.3s ease',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
  });
  document.body.appendChild(_zoomLabel);

  let _zoomLabelTimer = null;

  function _showZoomLabel() {
    const mult = Math.round(_currentScale / 1.0 * 4) / 4;
    _zoomLabel.textContent = '×' + (Number.isInteger(mult) ? mult : mult.toFixed(2));
    _zoomLabel.style.opacity = '1';
    clearTimeout(_zoomLabelTimer);
    _zoomLabelTimer = setTimeout(() => { _zoomLabel.style.opacity = '0'; }, 1500);
  }

  zoomInBtn.addEventListener('click',  _showZoomLabel);
  zoomOutBtn.addEventListener('click', _showZoomLabel);
}
// ── END MOBILE ZOOM SCALE INDICATOR ──────────────────────────────────────────

// ── MOBILE SCROLL INDICATORS ──────────────────────────────────────────────────
// Horizontal bar: top-centre — shows left/right progress.
// Vertical bar:   right-centre — shows up/down progress.
// Both match the scale bar visual: 2px track, rgba fill, #555 fill, 0.15s ease.
if (IS_MOBILE) {
  const hScrollTrack = document.createElement('div');
  Object.assign(hScrollTrack.style, {
    position:      'fixed',
    top:           '36px',
    left:          '50%',
    transform:     'translateX(-50%)',
    width:         '60px',
    height:        '2px',
    background:    'rgba(0,0,0,0.12)',
    zIndex:        '10',
    pointerEvents: 'none',
  });
  const hScrollFill = document.createElement('div');
  Object.assign(hScrollFill.style, {
    position:   'absolute',
    top:        '0',
    left:       '0',
    height:     '100%',
    width:      '0%',
    background: '#555',
    transition: 'width 0.15s ease',
  });
  hScrollTrack.appendChild(hScrollFill);
  document.body.appendChild(hScrollTrack);

  const vScrollTrack = document.createElement('div');
  Object.assign(vScrollTrack.style, {
    position:      'fixed',
    right:         '14px',
    top:           '50%',
    transform:     'translateY(-50%)',
    width:         '2px',
    height:        '60px',
    background:    'rgba(0,0,0,0.12)',
    zIndex:        '10',
    pointerEvents: 'none',
  });
  const vScrollFill = document.createElement('div');
  Object.assign(vScrollFill.style, {
    position:   'absolute',
    top:        '0',
    left:       '0',
    width:      '100%',
    height:     '0%',
    background: '#555',
    transition: 'height 0.15s ease',
  });
  vScrollTrack.appendChild(vScrollFill);
  document.body.appendChild(vScrollTrack);

  function _updateScrollBars() {
    const maxLeft = scrollWrap.scrollWidth  - scrollWrap.clientWidth;
    const maxTop  = scrollWrap.scrollHeight - scrollWrap.clientHeight;
    const hPct = maxLeft > 0 ? Math.max(0, Math.min(1, scrollWrap.scrollLeft / maxLeft)) : 0;
    const vPct = maxTop  > 0 ? Math.max(0, Math.min(1, scrollWrap.scrollTop  / maxTop))  : 0;
    hScrollFill.style.width  = Math.round(hPct * 100) + '%';
    vScrollFill.style.height = Math.round(vPct * 100) + '%';
  }

  scrollWrap.addEventListener('scroll', _updateScrollBars, { passive: true });
  setTimeout(_updateScrollBars, 800);
}
// ── END MOBILE SCROLL INDICATORS ─────────────────────────────────────────────

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
  const hint = document.createElement('div');
  hint.innerHTML = 'drag figure to look<br>scroll to navigate<br><span id="mob-hint-pc"></span>';
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
    textAlign:     'center',
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

  function _overGuestWeb(clientX, clientY) {
    const gwEl = document.getElementById('guestweb-area');
    if (!gwEl) return false;
    const r = gwEl.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  let _mobDragOffX    = 0;
  let _mobDragOffY    = 0;
  let _figDragActive  = false;
  let _velX = 0, _velY = 0;
  let _prevT = 0, _prevX = 0, _prevY = 0;
  let _currT = 0, _currX = 0, _currY = 0;
  let _momentumRaf    = null;

  function _stopMomentum() {
    if (_momentumRaf !== null) { cancelAnimationFrame(_momentumRaf); _momentumRaf = null; }
  }

  function _startMomentum() {
    _stopMomentum();
    const FRICTION = 0.90;
    const MIN_VEL  = 0.4;
    function step() {
      _velX *= FRICTION;
      _velY *= FRICTION;
      if (Math.abs(_velX) < MIN_VEL && Math.abs(_velY) < MIN_VEL) { _momentumRaf = null; return; }
      mob_pos.x += _velX;
      mob_pos.y += _velY;
      mob_pos.x = Math.max(figW / 2, Math.min(window.innerWidth  - figW / 2, mob_pos.x));
      mob_pos.y = Math.max(FIG_H / 2, Math.min(window.innerHeight - FIG_H / 2, mob_pos.y));
      moveReveal(mob_pos.x, mob_pos.y);
      _momentumRaf = requestAnimationFrame(step);
    }
    _momentumRaf = requestAnimationFrame(step);
  }

  // Drag only starts when touchstart lands on the figure (layer3).
  layer3.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (_overGuestWeb(t.clientX, t.clientY)) {
      layer3.style.pointerEvents = 'none';
      return;
    }
    e.preventDefault();
    _stopMomentum();
    _figDragActive = true;
    _velX = 0; _velY = 0;
    _mobDragOffX = mob_pos.x - t.clientX;
    _mobDragOffY = mob_pos.y - t.clientY;
    _prevT = _currT = performance.now();
    _prevX = _currX = t.clientX;
    _prevY = _currY = t.clientY;
  }, { passive: false });

  layer3.addEventListener('touchmove', e => {
    if (e.touches.length !== 1 || !_figDragActive) return;
    const t = e.touches[0];
    if (_overGuestWeb(t.clientX, t.clientY)) return;
    e.preventDefault();
    _prevT = _currT; _prevX = _currX; _prevY = _currY;
    _currT = performance.now(); _currX = t.clientX; _currY = t.clientY;
    mob_pos.x = t.clientX + _mobDragOffX;
    mob_pos.y = t.clientY + _mobDragOffY;
    mob_pos.x = Math.max(figW / 2, Math.min(window.innerWidth  - figW / 2, mob_pos.x));
    mob_pos.y = Math.max(FIG_H / 2, Math.min(window.innerHeight - FIG_H / 2, mob_pos.y));
    moveReveal(mob_pos.x, mob_pos.y);
  }, { passive: false });

  // Restore layer3 pointer-events when a touch begins outside guestweb-area.
  document.addEventListener('touchstart', e => {
    if (layer3.style.pointerEvents === 'none') {
      const t = e.touches[0];
      if (!_overGuestWeb(t.clientX, t.clientY)) {
        layer3.style.pointerEvents = 'auto';
      }
    }
  }, { passive: true, capture: true });

  // On release: compute velocity from last two tracked points and start momentum.
  layer3.addEventListener('touchend', () => {
    if (!_figDragActive) return;
    _figDragActive = false;
    const dt = _currT - _prevT;
    if (dt > 0 && dt < 120) {
      _velX = (_currX - _prevX) / dt * 16;  // scale to ~60fps frame delta
      _velY = (_currY - _prevY) / dt * 16;
      const speed = Math.hypot(_velX, _velY);
      const MAX   = 35;
      if (speed > MAX) { _velX *= MAX / speed; _velY *= MAX / speed; }
      _startMomentum();
    }
  }, { passive: true });

  scrollWrap.addEventListener('scroll', mob_onScroll, { passive: true });

  // Place figure at centre once figW is available (initCursor is async).
  const mob_waitForFigW = setInterval(() => {
    if (figW > 0) {
      clearInterval(mob_waitForFigW);
      mob_initPosition();
    }
  }, 50);

  // Show hint immediately (it has its own 2 s internal delay).
  // Decoupled from figW so it fires even if the figure image is slow to load.
  mob_showHint();
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

  // Make GuestWeb draggable
  const gwEl = document.getElementById('guestweb-area');
  if (gwEl) {
    const gwLbl = document.createElement('div');
    Object.assign(gwLbl.style, {
      position:      'absolute',
      left:          gwEl.style.left,
      top:           (parseFloat(gwEl.style.top) - 18) + 'px',
      fontFamily:    '"Lucida Grande", Arial, sans-serif',
      fontSize:      '10px',
      color:         '#a0a',
      background:    'rgba(255,255,255,0.75)',
      padding:       '1px 3px',
      pointerEvents: 'none',
      zIndex:        '20',
      whiteSpace:    'nowrap',
    });
    gwLbl.textContent = `GuestWeb: ${Math.round(parseFloat(gwEl.style.left))}, ${Math.round(parseFloat(gwEl.style.top))}`;
    stage.appendChild(gwLbl);
    previewLabels.push({ el: gwLbl, gw: gwEl });
    gwEl.style.cursor = 'grab';
    gwEl.addEventListener('mousedown', previewGwDragStart);
  }

  // Make surface texts draggable
  for (const t of allTexts) {
    const lbl = document.createElement('div');
    Object.assign(lbl.style, {
      position:      'absolute',
      left:          t.el.style.left,
      top:           (parseFloat(t.el.style.top) - 18) + 'px',
      fontFamily:    '"Lucida Grande", Arial, sans-serif',
      fontSize:      '10px',
      color:         '#00a',
      background:    'rgba(255,255,255,0.75)',
      padding:       '1px 3px',
      pointerEvents: 'none',
      zIndex:        '20',
      whiteSpace:    'nowrap',
    });
    lbl.textContent = `${t.textId}: ${Math.round(parseFloat(t.el.style.left))}, ${Math.round(parseFloat(t.el.style.top))}`;
    stage.appendChild(lbl);
    previewLabels.push({ el: lbl, t });
    t.el.style.cursor        = 'grab';
    t.el.style.pointerEvents = 'auto';
    t.el.addEventListener('mousedown', previewTextDragStart);
  }
}

function previewExit() {
  previewMode = false;
  frostCanvas.style.display      = '';
  layer3.style.display           = '';
  layer2.style.pointerEvents     = '';
  document.body.style.cursor = '';

  // Remove labels and unbind drag
  for (const { el, p, t, gw } of previewLabels) {
    el.remove();
    if (p) {
      p.l1El.style.cursor = '';
      p.l1El.removeEventListener('mousedown', previewDragStart);
    }
    if (t) {
      t.el.style.cursor        = '';
      t.el.style.pointerEvents = 'none';
      t.el.removeEventListener('mousedown', previewTextDragStart);
    }
    if (gw) {
      gw.style.cursor = '';
      gw.removeEventListener('mousedown', previewGwDragStart);
    }
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
  console.log('── Updated text positions ──');
  for (const t of allTexts) {
    console.log(`  { "id": "${t.textId}", "x": ${Math.round(parseFloat(t.el.style.left))}, "y": ${Math.round(parseFloat(t.el.style.top))} }`);
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
  const nx = Math.round(_drag.startElX + (e.pageX - _drag.startMouseX) / _currentScale);
  const ny = Math.round(_drag.startElY + (e.pageY - _drag.startMouseY) / _currentScale);
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

let _textDrag = null;

function previewTextDragStart(e) {
  e.preventDefault();
  e.stopPropagation();
  const t = allTexts.find(q => q.el === e.currentTarget);
  if (!t) return;
  _textDrag = {
    t,
    startMouseX: e.pageX,
    startMouseY: e.pageY,
    startElX:    parseFloat(t.el.style.left),
    startElY:    parseFloat(t.el.style.top),
  };
  t.el.style.cursor = 'grabbing';
  document.body.style.userSelect = 'none';
  window.addEventListener('mousemove', previewTextDragMove);
  window.addEventListener('mouseup',   previewTextDragEnd);
}

function previewTextDragMove(e) {
  if (!_textDrag) return;
  const nx = Math.round(_textDrag.startElX + (e.pageX - _textDrag.startMouseX) / _currentScale);
  const ny = Math.round(_textDrag.startElY + (e.pageY - _textDrag.startMouseY) / _currentScale);
  _textDrag.t.el.style.left = nx + 'px';
  _textDrag.t.el.style.top  = ny + 'px';
  const lbl = previewLabels.find(l => l.t === _textDrag.t);
  if (lbl) {
    lbl.el.style.left  = nx + 'px';
    lbl.el.style.top   = (ny - 18) + 'px';
    lbl.el.textContent = `${_textDrag.t.textId}: ${nx}, ${ny}`;
  }
}

function previewTextDragEnd() {
  if (_textDrag) _textDrag.t.el.style.cursor = 'grab';
  _textDrag = null;
  document.body.style.userSelect = '';
  window.removeEventListener('mousemove', previewTextDragMove);
  window.removeEventListener('mouseup',   previewTextDragEnd);
}

// ── GuestWeb drag ─────────────────────────────────────────────────────────────
let _gwDrag = null;

function previewGwDragStart(e) {
  e.preventDefault();
  e.stopPropagation();
  const gwEl = document.getElementById('guestweb-area');
  if (!gwEl) return;
  _gwDrag = {
    gwEl,
    startMouseX: e.pageX,
    startMouseY: e.pageY,
    startElX:    parseFloat(gwEl.style.left),
    startElY:    parseFloat(gwEl.style.top),
    // Capture all entry divs (siblings of gwEl in layer2 that are not the form)
    entries: Array.from(layer2.children).filter(c => c !== gwEl && c.style.position === 'absolute').map(c => ({
      el: c,
      startX: parseFloat(c.style.left),
      startY: parseFloat(c.style.top),
    })),
  };
  gwEl.style.cursor = 'grabbing';
  document.body.style.userSelect = 'none';
  window.addEventListener('mousemove', previewGwDragMove);
  window.addEventListener('mouseup',   previewGwDragEnd);
}

function previewGwDragMove(e) {
  if (!_gwDrag) return;
  const dx = (e.pageX - _gwDrag.startMouseX) / _currentScale;
  const dy = (e.pageY - _gwDrag.startMouseY) / _currentScale;
  const nx = Math.round(_gwDrag.startElX + dx);
  const ny = Math.round(_gwDrag.startElY + dy);
  _gwDrag.gwEl.style.left = nx + 'px';
  _gwDrag.gwEl.style.top  = ny + 'px';
  // Move entries by same delta
  for (const entry of _gwDrag.entries) {
    entry.el.style.left = Math.round(entry.startX + dx) + 'px';
    entry.el.style.top  = Math.round(entry.startY + dy) + 'px';
  }
  // Update label
  const lbl = previewLabels.find(l => l.gw === _gwDrag.gwEl);
  if (lbl) {
    lbl.el.style.left  = nx + 'px';
    lbl.el.style.top   = (ny - 18) + 'px';
    lbl.el.textContent = `GuestWeb: ${nx}, ${ny}`;
  }
}

function previewGwDragEnd() {
  if (_gwDrag) {
    _gwDrag.gwEl.style.cursor = 'grab';
    const nx = Math.round(parseFloat(_gwDrag.gwEl.style.left));
    const ny = Math.round(parseFloat(_gwDrag.gwEl.style.top));
    console.log(`GuestWeb new position — GW_X: ${nx}, GW_Y: ${ny}`);
  }
  _gwDrag = null;
  document.body.style.userSelect = '';
  window.removeEventListener('mousemove', previewGwDragMove);
  window.removeEventListener('mouseup',   previewGwDragEnd);
}

document.addEventListener('keydown', e => {
  if (e.key === 'p' || e.key === 'P') {
    previewMode ? previewExit() : previewEnter();
  }
});
// ── END PREVIEW / DRAG MODE ───────────────────────────────────────────────────

// ── ZOOM (non-Safari only) ────────────────────────────────────────────────────
// ── ZOOM (transform scale, all browsers) ─────────────────────────────────────
// _currentScale declared at top of file so _mirrorLoop IIFE can access it.
let _lastMouseX = window.innerWidth / 2;
let _lastMouseY = window.innerHeight / 2;

function getMinScale() {
  const refW = surfW || maxSurfW || 5400;
  const refH = surfH || maxSurfH || 3900;
  return Math.max(scrollWrap.clientWidth / refW, scrollWrap.clientHeight / refH) + 0.01;
}

function updateSpacer() {
  spacer.style.width  = Math.round(Math.max(surfW * _currentScale, scrollWrap.clientWidth))  + 'px';
  spacer.style.height = Math.round(Math.max(surfH * _currentScale, scrollWrap.clientHeight)) + 'px';
}

function applyScale(newScale, stageX, stageY) {
  // stageX/stageY are unscaled stage coordinates — anchor point stays fixed.
  // Round scroll values to integers to avoid sub-pixel jiggle between layers.
  const newScrollLeft = Math.round(stageX * (newScale - _currentScale) + scrollWrap.scrollLeft);
  const newScrollTop  = Math.round(stageY * (newScale - _currentScale) + scrollWrap.scrollTop);

  _currentScale = newScale;
  stage.style.transformOrigin = '0 0';
  stage.style.transform       = newScale !== 1 ? 'scale(' + newScale + ')' : '';
  updateSpacer();

  scrollWrap.scrollLeft = newScrollLeft;
  scrollWrap.scrollTop  = newScrollTop;
  if (typeof _updateScaleBar === 'function') _updateScaleBar();
}

// Block native browser pinch/ctrl-scroll zoom on all browsers.
document.addEventListener('wheel', function(e) {
  if (e.ctrlKey) e.preventDefault();
}, { passive: false });
// Gesture events (Safari desktop) — disabled on mobile to avoid double-handling with touch pinch.
let _gestureScale0 = 1;
if (!IS_MOBILE) {
  document.addEventListener('gesturestart', function(e) {
    e.preventDefault();
    _gestureScale0 = _currentScale;
  }, { passive: false });

  document.addEventListener('gesturechange', function(e) {
    e.preventDefault();
    try {
      const min      = getMinScale();
      const newScale = Math.min(3, Math.max(min, _gestureScale0 * e.scale));
      if (!isFinite(newScale) || newScale < min) return;
      const originX  = (scrollWrap.scrollLeft + e.clientX) / _currentScale;
      const originY  = (scrollWrap.scrollTop  + e.clientY) / _currentScale;
      applyScale(newScale, originX, originY);
      moveReveal(_lastMouseX, _lastMouseY);
    } catch (err) {
      // swallow
    }
  }, { passive: false });

  document.addEventListener('gestureend', function(e) {
    e.preventDefault();
  }, { passive: false });
}

// Ctrl+scroll zoom.
document.addEventListener('wheel', function(e) {
  if (!e.ctrlKey) return;
  e.preventDefault();

  const delta    = e.deltaY > 0 ? -0.05 : 0.05;
  const newScale = Math.min(3, Math.max(getMinScale(), _currentScale + delta));
  // Cursor in unscaled stage coordinates.
  const originX  = (scrollWrap.scrollLeft + e.clientX) / _currentScale;
  const originY  = (scrollWrap.scrollTop  + e.clientY) / _currentScale;

  applyScale(newScale, originX, originY);
  moveReveal(_lastMouseX, _lastMouseY);
}, { passive: false });

// Touch pinch zoom — desktop only. On mobile, two-finger touch falls through to native scroll.
if (!IS_MOBILE) {
  let _pinchDist0 = null;
  let _pinchScale0 = 1;
  let _pinchMidX = 0;
  let _pinchMidY = 0;
  let _pinchRafPending = false;

  document.addEventListener('touchstart', function(e) {
    if (e.touches.length === 2) {
      const t0 = e.touches[0], t1 = e.touches[1];
      _pinchDist0  = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      if (_pinchDist0 < 10) { _pinchDist0 = null; return; }
      _pinchScale0 = _currentScale;
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;
      _pinchMidX = (scrollWrap.scrollLeft + midX) / _currentScale;
      _pinchMidY = (scrollWrap.scrollTop  + midY) / _currentScale;
    }
  }, { passive: true });

  document.addEventListener('touchmove', function(e) {
    if (e.touches.length !== 2 || _pinchDist0 === null) return;
    e.preventDefault();
    if (_pinchRafPending) return;
    const t0 = e.touches[0], t1 = e.touches[1];
    const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    if (!dist || dist < 10) return;
    const snapMidX = _pinchMidX, snapMidY = _pinchMidY;
    const snapDist = dist;
    _pinchRafPending = true;
    requestAnimationFrame(() => {
      _pinchRafPending = false;
      try {
        const min      = getMinScale();
        const raw      = _pinchScale0 * (snapDist / _pinchDist0);
        const newScale = Math.min(3, Math.max(min, raw));
        if (!isFinite(newScale) || newScale <= 0 || newScale < min) return;
        applyScale(newScale, snapMidX, snapMidY);
      } catch (err) {
        // swallow — never let a zoom calc crash the page
      }
    });
  }, { passive: false });

  document.addEventListener('touchend', function(e) {
    if (e.touches.length < 2) {
      _pinchDist0 = null;
      _pinchRafPending = false;
    }
  }, { passive: true });
}
// Clamp scale when window is resized — desktop only.
// On mobile, min scale is fixed after layout and must not be recalculated.
if (!IS_MOBILE) {
  window.addEventListener('resize', function() {
    updateSpacer();
    const min = getMinScale();
    if (_currentScale < min && min !== _currentScale) {
      applyScale(min, surfW / 2, surfH / 2);
    }
  });
}
// ── END ZOOM ──────────────────────────────────────────────────────────────────
