'use strict';

// ── Config ───────────────────────────────────────────────────────────────────

const FIGURES_CONFIG = {
  delay:      2,            // seconds after page load before the figure appears

  sprites: [                // sprite sheet paths
    'assets/sprites/Walking_L2RSide_Lady_1.png'
  ],

  fills: [                  // fill image paths — shown through the silhouette mask
    'WORKimages/2024_Female_Photographer.jpg'
  ],

  speedRange: [15, 20],     // [min, max] seconds to walk across the content area

  sizeRange:  [0.45, 0.5]   // [min, max] figure height as a fraction of viewport height
};

// ── Sprite sheet constants ────────────────────────────────────────────────────

const SPRITE = {
  frames:        4,
  frameW:        737,
  frameH:        1250,
  frameDuration: 250    // ms per frame
};

// ── Spawn ─────────────────────────────────────────────────────────────────────

function spawnFigure() {
  const main = document.getElementById('main');
  if (!main) return;

  const mainRect = main.getBoundingClientRect();
  const mainW    = mainRect.width;

  const sprite = FIGURES_CONFIG.sprites[
    Math.floor(Math.random() * FIGURES_CONFIG.sprites.length)
  ];
  const fill = FIGURES_CONFIG.fills[
    Math.floor(Math.random() * FIGURES_CONFIG.fills.length)
  ];

  // ── Size ──────────────────────────────────────────────────────────────────
  const [sMin, sMax] = FIGURES_CONFIG.sizeRange;
  const sizeFrac     = sMin + Math.random() * (sMax - sMin);
  const figH         = window.innerHeight * sizeFrac;
  const figW         = figH * (SPRITE.frameW / SPRITE.frameH);
  const sheetW       = figW * SPRITE.frames;

  // ── Speed ─────────────────────────────────────────────────────────────────
  const [dMin, dMax] = FIGURES_CONFIG.speedRange;
  const duration     = (dMin + Math.random() * (dMax - dMin)) * 1000;

  // ── Vertical: centre in the visible band below #main's top edge ──────────
  const visibleMainH = window.innerHeight - mainRect.top;
  const topOffset    = mainRect.top + Math.max(0, (visibleMainH - figH) / 2);

  // ── Build element ─────────────────────────────────────────────────────────
  const el = document.createElement('div');
  el.className = 'figure-walker';

  Object.assign(el.style, {
    position:             'fixed',
    top:                  topOffset + 'px',
    left:                 '0',
    width:                figW + 'px',
    height:               figH + 'px',
    zIndex:               '10',
    pointerEvents:        'none',

    // Fill image — visible only through the silhouette
    backgroundImage:      `url('${fill}')`,
    backgroundSize:       'cover',
    backgroundPosition:   'center top',

    // CSS mask — webkit prefix requires lowercase 'w' in JS property names
    webkitMaskImage:      `url('${sprite}')`,
    maskImage:            `url('${sprite}')`,
    webkitMaskSize:       `${sheetW}px ${figH}px`,
    maskSize:             `${sheetW}px ${figH}px`,
    webkitMaskRepeat:     'no-repeat',
    maskRepeat:           'no-repeat',
    webkitMaskPosition:   '0 0',
    maskPosition:         '0 0',

    transform:            `translateX(${-figW}px)`
  });

  document.body.appendChild(el);

  // ── Frame cycling ─────────────────────────────────────────────────────────
  let frame = 0;

  const frameInterval = setInterval(() => {
    frame = (frame + 1) % SPRITE.frames;
    const offsetX = -(frame * figW);
    // lowercase 'w' here too — same property, set via direct assignment
    el.style.webkitMaskPosition = `${offsetX}px 0`;
    el.style.maskPosition       = `${offsetX}px 0`;
  }, SPRITE.frameDuration);

  // ── Walk: viewport-space coords aligned to #main's horizontal span ────────
  const startX    = mainRect.left - figW;
  const endX      = mainRect.left + mainW;
  const startTime = performance.now();

  function walk(now) {
    const t = Math.min((now - startTime) / duration, 1);
    el.style.transform = `translateX(${startX + (endX - startX) * t}px)`;

    if (t < 1) {
      requestAnimationFrame(walk);
    } else {
      clearInterval(frameInterval);
      el.remove();
    }
  }

  requestAnimationFrame(walk);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

setTimeout(spawnFigure, FIGURES_CONFIG.delay * 1000);
