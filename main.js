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
const allTexts  = [];  // { el, textId }
const viewRects = new Set();  // active video view regions { x, y, w, h }

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

    // ── Mobile width clamp ───────────────────────────────────────────────────
    // Only the stage (the scroll container) is narrowed — layers, canvas, and
    // the image cache keep their full computed dimensions so rendering is
    // unaffected. overflow-x:hidden on stage prevents scrolling past bx1.
    if (IS_MOBILE) {
      const narrowW = Math.round(bx1 + 80);
      stage.style.width     = narrowW + 'px';
      stage.style.overflowX = 'hidden';

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
const MOB_SURF_W = 2000;
const MOB_SURF_H = 4000;

// Scale factors — set in the fetch handler once data.surface_width/height are known.
// mobilizeImage() uses these to remap desktop coordinates to mobile space.
let MOB_X_SCALE = 1;
let MOB_Y_SCALE = 1;

function mobilizeImage(img) {
  if (!IS_MOBILE) return img;
  return {
    src:   img.src,
    width: Math.max(60, Math.round(img.width * MOB_X_SCALE)),
    x:     Math.round(img.x * MOB_X_SCALE),
    y:     Math.round(img.y * MOB_Y_SCALE),
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

    // For videos: always-visible text buttons at random position + timeline at bottom.
    if (isVideo) {
      function fmtTime(s) {
        if (!isFinite(s) || isNaN(s)) return '0:00';
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return m + ':' + (sec < 10 ? '0' : '') + sec;
      }

      const btnStyle = {
        position:      'absolute',
        fontFamily:    '"Lucida Grande", Verdana, Geneva, sans-serif',
        fontSize:      '10px',
        color:         '#333',
        cursor:        'pointer',
        userSelect:    'none',
        zIndex:        '11',
        pointerEvents: 'auto',
        padding:       '10px 14px',
        margin:        '-10px -14px',
      };

      const btnY = Math.round(y + rand(10, 40));
      const btnX = Math.round(x + rand(10, width * 0.4));
      let btnOffX = 0;

      function makeBtn(label) {
        const el = document.createElement('div');
        el.textContent = label;
        Object.assign(el.style, btnStyle);
        el.style.left = (btnX + btnOffX) + 'px';
        el.style.top  = btnY + 'px';
        btnOffX += 70;
        stage.appendChild(el);
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
        const vidH = l1El.videoHeight > 0
          ? Math.round(l1El.videoHeight * (width / l1El.videoWidth))
          : Math.round(width * 0.75);
        _viewRect = { x, y, w: width, h: vidH };
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
        zIndex:      '11',
        pointerEvents: 'auto',
      });
      stage.appendChild(timelineRow);

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
      color:         '#333',
      cursor:        'pointer',
      userSelect:    'none',
      zIndex:        '11',
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

    stage.appendChild(readBtn);
  }
}

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
      const useRagged   = t.id === 't001' && t.content;
      if (useRagged) {
        el.innerHTML = raggedWrap(t.content, t.id, 6);
      } else {
        el.textContent = t.content;
      }
      const tx = IS_MOBILE ? Math.round(t.x * MOB_X_SCALE) : t.x;
      const ty = IS_MOBILE ? Math.round(t.y * MOB_Y_SCALE) : t.y;
      Object.assign(el.style, {
        position:      'absolute',
        left:          tx + 'px',
        top:           ty + 'px',
        fontFamily:    '"Lucida Grande", Arial, sans-serif',
        fontSize:      fontSizes[t.style] || '11px',
        color:         '#333',
        lineHeight:    '1.5',
        maxWidth:      useRagged ? '420px' : '160px',
        wordSpacing:   '3px',
        textAlign:     'left',
        pointerEvents: 'none',
      });
      layer1.appendChild(el);
      allTexts.push({ el, textId: t.id });
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
const gwLink = document.createElement('span');
gwLink.textContent = 'GuestWeb';
Object.assign(gwLink.style, {
  textDecoration: 'underline',
  cursor:         'pointer',
});
gwLink.addEventListener('click', () => {
  const curZoom = parseFloat(stage.style.zoom) || 1;
  if (!_isSafari && curZoom < 0.8) {
    stage.style.zoom             = 0.8;
    layer3.style.transform       = 'scale(0.8)';
    layer3.style.transformOrigin = 'center';
    setTimeout(() => {
      document.getElementById('guestweb-area').scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }, 300);
  } else {
    document.getElementById('guestweb-area').scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }
});

contactDiv.innerHTML = 'helenyzh, heleniyzh@gmail.com, London, ';
contactDiv.appendChild(gwLink);
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

  const hint = document.createElement('div');
  hint.innerHTML = 'drag figure to look, scroll to navigate<br><span id="mob-hint-pc">or experience differently on PC...</span>';
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
    sessionStorage.setItem('mob_hint_shown', '1');
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

  // Touchstart on layer3 only — drag the figure. Scrolling is unaffected elsewhere.
  layer3.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (_overGuestWeb(t.clientX, t.clientY)) {
      // Touch is on the GuestWeb form — let the browser handle it normally.
      // Set pointer-events:none so the tap falls through to the inputs/links below.
      layer3.style.pointerEvents = 'none';
      return;
    }
    e.preventDefault();  // block scroll only while dragging the figure
    mob_pos.x = t.clientX;
    mob_pos.y = t.clientY;
    moveReveal(mob_pos.x, mob_pos.y);
  }, { passive: false });

  layer3.addEventListener('touchmove', e => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (_overGuestWeb(t.clientX, t.clientY)) return;
    e.preventDefault();
    mob_pos.x = t.clientX;
    mob_pos.y = t.clientY;
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

  // touchend: figure stays where released — no action needed.

  document.addEventListener('scroll', mob_onScroll, { passive: true });

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
  for (const { el, p, t } of previewLabels) {
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
  const nx = Math.round(_textDrag.startElX + e.pageX - _textDrag.startMouseX);
  const ny = Math.round(_textDrag.startElY + e.pageY - _textDrag.startMouseY);
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

if (_isSafari) {
  // Block all pinch-zoom and ctrl+scroll zoom on Safari.
  document.addEventListener('wheel', function(e) {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart',  function(e) { e.preventDefault(); }, { passive: false });
  document.addEventListener('gesturechange', function(e) { e.preventDefault(); }, { passive: false });
  document.addEventListener('gestureend',    function(e) { e.preventDefault(); }, { passive: false });
} else {
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
}
// ── END ZOOM ──────────────────────────────────────────────────────────────────
