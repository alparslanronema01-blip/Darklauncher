'use strict';

// Animated background engine. 15 built-in themes drawn on a single canvas
// behind the UI, plus user images (background or floating blocks).
// Performance: one requestAnimationFrame loop, paused when hidden, capped
// at ~40fps. Zero dependencies.

(function () {
  const canvas = document.getElementById('bg-canvas');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0;
  let currentTheme = 'off';
  let themeState = null;
  let rafId = 0;
  let lastFrame = 0;
  const FRAME_MIN_MS = 25; // ~40fps cap

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
    if (currentTheme !== 'off') startTheme(currentTheme, true);
  }
  window.addEventListener('resize', resize);

  const rand = (min, max) => min + Math.random() * (max - min);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // Built-in texture painters (small offscreen canvases used as tiles).
  function makeTexture(draw) {
    const t = document.createElement('canvas');
    t.width = t.height = 16;
    draw(t.getContext('2d'));
    return t;
  }
  const TEX = {
    grass: makeTexture((c) => {
      c.fillStyle = '#79553d'; c.fillRect(0, 0, 16, 16);
      c.fillStyle = '#5d9143'; c.fillRect(0, 0, 16, 4);
      c.fillStyle = 'rgba(0,0,0,0.15)';
      for (let i = 0; i < 12; i++) c.fillRect(Math.floor(Math.random() * 16), 4 + Math.floor(Math.random() * 12), 1, 1);
    }),
    dirt: makeTexture((c) => {
      c.fillStyle = '#79553d'; c.fillRect(0, 0, 16, 16);
      c.fillStyle = 'rgba(0,0,0,0.18)';
      for (let i = 0; i < 16; i++) c.fillRect(Math.floor(Math.random() * 16), Math.floor(Math.random() * 16), 1, 1);
    }),
    stone: makeTexture((c) => {
      c.fillStyle = '#8a8a8a'; c.fillRect(0, 0, 16, 16);
      c.fillStyle = 'rgba(0,0,0,0.22)';
      for (let i = 0; i < 14; i++) c.fillRect(Math.floor(Math.random() * 16), Math.floor(Math.random() * 16), 2, 1);
    }),
    diamond: makeTexture((c) => {
      c.fillStyle = '#7ec8c8'; c.fillRect(0, 0, 16, 16);
      c.fillStyle = '#4aedd9';
      [[3, 3], [10, 6], [6, 11]].forEach(([x, y]) => c.fillRect(x, y, 3, 3));
      c.fillStyle = 'rgba(255,255,255,0.5)'; c.fillRect(3, 3, 1, 1); c.fillRect(10, 6, 1, 1);
    }),
    gold: makeTexture((c) => {
      c.fillStyle = '#9c8342'; c.fillRect(0, 0, 16, 16);
      c.fillStyle = '#f5d93f';
      [[2, 2], [9, 4], [5, 9], [12, 11]].forEach(([x, y]) => c.fillRect(x, y, 3, 2));
    }),
    redstone: makeTexture((c) => {
      c.fillStyle = '#8a8a8a'; c.fillRect(0, 0, 16, 16);
      c.fillStyle = '#d63b2f';
      [[3, 2], [8, 5], [12, 9], [4, 11]].forEach(([x, y]) => c.fillRect(x, y, 2, 2));
    }),
    tnt: makeTexture((c) => {
      c.fillStyle = '#d63b2f'; c.fillRect(0, 0, 16, 16);
      c.fillStyle = '#f2f2f2'; c.fillRect(0, 5, 16, 6);
      c.fillStyle = '#111'; c.font = '6px monospace'; c.fillText('TNT', 2, 10);
    }),
    obsidian: makeTexture((c) => {
      c.fillStyle = '#1b1123'; c.fillRect(0, 0, 16, 16);
      c.fillStyle = '#3c2a56';
      for (let i = 0; i < 8; i++) c.fillRect(Math.floor(Math.random() * 14), Math.floor(Math.random() * 14), 2, 2);
    }),
    emerald: makeTexture((c) => {
      c.fillStyle = '#5c8a50'; c.fillRect(0, 0, 16, 16);
      c.fillStyle = '#41f384';
      [[4, 3], [10, 7], [6, 11]].forEach(([x, y]) => c.fillRect(x, y, 3, 3));
    })
  };
  const BLOCKS = ['grass', 'dirt', 'stone', 'diamond', 'gold', 'redstone', 'tnt', 'obsidian', 'emerald'];

  // ---------------------------------------------------------------- themes
  const themes = {};

  // 1. Floating Minecraft blocks drifting upward (the classic request).
  themes.blocks = {
    init: (s) => {
      s.items = Array.from({ length: 22 }, () => ({
        tex: pick(BLOCKS), x: rand(0, W), y: rand(0, H),
        size: rand(22, 52), vy: rand(-0.6, -0.15), rot: rand(0, Math.PI * 2), vr: rand(-0.01, 0.01), wobble: rand(0, 6.28)
      }));
    },
    draw: (s, t) => {
      for (const b of s.items) {
        b.y += b.vy; b.rot += b.vr; b.wobble += 0.02;
        const x = b.x + Math.sin(b.wobble) * 14;
        if (b.y < -60) { b.y = H + 40; b.x = rand(0, W); b.tex = pick(BLOCKS); }
        ctx.save();
        ctx.translate(x, b.y); ctx.rotate(b.rot);
        ctx.globalAlpha = 0.85;
        ctx.drawImage(TEX[b.tex], -b.size / 2, -b.size / 2, b.size, b.size);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  };

  // 2. Red moon (Akatsuki vibe) with drifting embers.
  themes.redmoon = {
    init: (s) => {
      s.embers = Array.from({ length: 60 }, () => ({ x: rand(0, W), y: rand(0, H), r: rand(1, 3.2), vx: rand(-0.3, 0.3), vy: rand(-0.7, -0.2), a: rand(0.3, 0.9) }));
    },
    draw: (s, t) => {
      const g = ctx.createRadialGradient(W * 0.5, H * 0.42, 10, W * 0.5, H * 0.42, Math.min(W, H) * 0.36);
      g.addColorStop(0, '#e02424'); g.addColorStop(0.7, '#7a0f0f'); g.addColorStop(1, 'rgba(20,4,4,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(W * 0.5, H * 0.42, Math.min(W, H) * 0.32, 0, 7); ctx.fill();
      // silhouette figure
      ctx.fillStyle = 'rgba(5,2,2,0.9)';
      ctx.beginPath();
      ctx.ellipse(W * 0.5, H * 0.52, Math.min(W, H) * 0.045, Math.min(W, H) * 0.2, 0, 0, 7);
      ctx.fill();
      for (const e of s.embers) {
        e.x += e.vx; e.y += e.vy;
        if (e.y < -10) { e.y = H + 10; e.x = rand(0, W); }
        ctx.globalAlpha = e.a; ctx.fillStyle = '#ff5544';
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  };

  // 3. Starfield warp.
  themes.warp = {
    init: (s) => { s.stars = Array.from({ length: 140 }, () => ({ x: rand(-1, 1), y: rand(-1, 1), z: rand(0.1, 1) })); },
    draw: (s) => {
      ctx.fillStyle = '#04060c'; ctx.fillRect(0, 0, W, H);
      for (const st of s.stars) {
        st.z -= 0.008;
        if (st.z <= 0.05) { st.x = rand(-1, 1); st.y = rand(-1, 1); st.z = 1; }
        const px = (st.x / st.z) * W * 0.5 + W / 2;
        const py = (st.y / st.z) * H * 0.5 + H / 2;
        const r = Math.max(0.4, (1 - st.z) * 2.2);
        ctx.globalAlpha = 1 - st.z + 0.2;
        ctx.fillStyle = '#9ecbff';
        ctx.fillRect(px, py, r, r);
      }
      ctx.globalAlpha = 1;
    }
  };

  // 4. Rain of particles (Matrix-lite).
  themes.matrix = {
    init: (s) => { s.cols = Math.floor(W / 18); s.drops = Array.from({ length: s.cols }, () => rand(0, H)); },
    draw: (s) => {
      ctx.fillStyle = 'rgba(4,6,10,0.28)'; ctx.fillRect(0, 0, W, H);
      ctx.font = '13px monospace';
      for (let i = 0; i < s.drops.length; i++) {
        ctx.fillStyle = Math.random() < 0.02 ? '#c4f7ff' : '#22d3ee';
        ctx.fillText(String.fromCharCode(0x30a0 + Math.floor(Math.random() * 90)), i * 18, s.drops[i]);
        s.drops[i] += rand(8, 18);
        if (s.drops[i] > H && Math.random() > 0.97) s.drops[i] = 0;
      }
    }
  };

  // 5. Lava lamp blobs.
  themes.lava = {
    init: (s) => { s.blobs = Array.from({ length: 10 }, () => ({ x: rand(0, W), y: rand(0, H), r: rand(50, 140), vx: rand(-0.4, 0.4), vy: rand(-0.4, 0.4), hue: rand(260, 330) })); },
    draw: (s) => {
      ctx.fillStyle = '#0a0713'; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (const b of s.blobs) {
        b.x += b.vx; b.y += b.vy;
        if (b.x < -b.r || b.x > W + b.r) b.vx *= -1;
        if (b.y < -b.r || b.y > H + b.r) b.vy *= -1;
        const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
        g.addColorStop(0, `hsla(${b.hue},80%,60%,0.5)`);
        g.addColorStop(1, 'hsla(280,80%,50%,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  };

  // 6. Night parallax hills.
  themes.hills = {
    init: (s) => { s.t = 0; },
    draw: (s) => {
      s.t += 0.2;
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#0b0d1a'); sky.addColorStop(1, '#1b1035');
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      for (let i = 0; i < 40; i++) {
        const x = (i * 137 + s.t * 0.3) % W, y = (i * 61) % (H * 0.4);
        ctx.fillRect(x, y, 1.6, 1.6);
      }
      const layers = [[0.35, '#141a33'], [0.55, '#0f1327'], [0.75, '#0a0d1d']];
      layers.forEach(([f, col], li) => {
        ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, H);
        for (let x = 0; x <= W; x += 24) {
          const y = H * f - Math.sin((x + s.t * (li + 1) * 0.4) * 0.006) * 60 - Math.sin(x * 0.013) * 30;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      });
    }
  };

  // 7. Creeper faces floating.
  themes.creeper = {
    init: (s) => {
      s.faces = Array.from({ length: 14 }, () => ({ x: rand(0, W), y: rand(0, H), size: rand(26, 60), vy: rand(-0.5, -0.1), rot: rand(-0.4, 0.4) }));
    },
    draw: (s) => {
      for (const f of s.faces) {
        f.y += f.vy;
        if (f.y < -70) { f.y = H + 50; f.x = rand(0, W); }
        const size = f.size, px = f.x, py = f.y;
        ctx.save(); ctx.translate(px, py); ctx.rotate(f.rot); ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#4faa46'; ctx.fillRect(-size / 2, -size / 2, size, size);
        ctx.fillStyle = '#0c1a0c';
        const u = size / 8;
        [[-3, -3], [1, -3], [-2, -1], [-1, 1], [0, 1], [1, 1], [-3, 2], [1, 2]].forEach(([a, b]) => ctx.fillRect(a * u, b * u, u, u));
        ctx.restore(); ctx.globalAlpha = 1;
      }
    }
  };

  // 8. Grid horizon (synthwave).
  themes.grid = {
    init: (s) => { s.t = 0; },
    draw: (s) => {
      s.t += 0.03;
      ctx.fillStyle = '#07030f'; ctx.fillRect(0, 0, W, H);
      const horizon = H * 0.55;
      ctx.strokeStyle = 'rgba(139,92,246,0.5)'; ctx.lineWidth = 1;
      for (let i = 0; i < 20; i++) {
        const y = horizon + Math.pow(i + s.t % 1, 2.2) * 3;
        if (y > H) break;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      for (let x = -W; x <= W * 2; x += 80) {
        ctx.beginPath();
        ctx.moveTo(W / 2 + (x - W / 2) * 0.2, horizon);
        ctx.lineTo(x + Math.sin(s.t) * 40, H);
        ctx.stroke();
      }
      const sun = ctx.createLinearGradient(0, horizon - 160, 0, horizon);
      sun.addColorStop(0, '#f43f5e'); sun.addColorStop(1, '#8b5cf6');
      ctx.fillStyle = sun;
      ctx.beginPath(); ctx.arc(W / 2, horizon, 90, Math.PI, 0); ctx.fill();
    }
  };

  // 9. Falling snow.
  themes.snow = {
    init: (s) => { s.flakes = Array.from({ length: 120 }, () => ({ x: rand(0, W), y: rand(0, H), r: rand(1, 3), vy: rand(0.4, 1.6), drift: rand(0, 6.28) })); },
    draw: (s) => {
      for (const f of s.flakes) {
        f.y += f.vy; f.drift += 0.02;
        if (f.y > H + 5) { f.y = -5; f.x = rand(0, W); }
        ctx.globalAlpha = 0.5 + (f.r / 3) * 0.5;
        ctx.fillStyle = '#dfe9ff';
        ctx.beginPath(); ctx.arc(f.x + Math.sin(f.drift) * 20, f.y, f.r, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  };

  // 10. Embers/sparks rising.
  themes.embers = {
    init: (s) => { s.parts = Array.from({ length: 80 }, () => ({ x: rand(0, W), y: rand(0, H), vx: rand(-0.2, 0.2), vy: rand(-1.4, -0.3), r: rand(0.8, 2.6), life: rand(0.3, 1) })); },
    draw: (s) => {
      for (const p of s.parts) {
        p.x += p.vx + rand(-0.15, 0.15); p.y += p.vy;
        if (p.y < -5) { p.y = H + 5; p.x = rand(0, W); p.life = rand(0.3, 1); }
        p.life -= 0.002;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.life > 0.6 ? '#ffd166' : '#f43f5e';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  };

  // 11. Underwater bubbles.
  themes.underwater = {
    init: (s) => {
      s.bubbles = Array.from({ length: 50 }, () => ({ x: rand(0, W), y: rand(0, H), r: rand(2, 8), vy: rand(-1.2, -0.3), wob: rand(0, 6.28) }));
    },
    draw: (s) => {
      const sea = ctx.createLinearGradient(0, 0, 0, H);
      sea.addColorStop(0, '#04263a'); sea.addColorStop(1, '#02131f');
      ctx.fillStyle = sea; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(120,220,255,0.25)';
      for (const b of s.bubbles) {
        b.y += b.vy; b.wob += 0.03;
        if (b.y < -10) { b.y = H + 10; b.x = rand(0, W); }
        ctx.beginPath(); ctx.arc(b.x + Math.sin(b.wob) * 8, b.y, b.r, 0, 7); ctx.stroke();
      }
    }
  };

  // 12. Constellation links.
  themes.constellation = {
    init: (s) => { s.pts = Array.from({ length: 46 }, () => ({ x: rand(0, W), y: rand(0, H), vx: rand(-0.25, 0.25), vy: rand(-0.25, 0.25) })); },
    draw: (s) => {
      for (const p of s.pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > W) p.vx *= -1;
        if (p.y < 0 || p.y > H) p.vy *= -1;
      }
      ctx.strokeStyle = 'rgba(139,92,246,0.28)';
      for (let i = 0; i < s.pts.length; i++) {
        for (let j = i + 1; j < s.pts.length; j++) {
          const a = s.pts[i], b = s.pts[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 110) { ctx.globalAlpha = 1 - d / 110; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
        }
      }
      ctx.globalAlpha = 1; ctx.fillStyle = '#c4b5fd';
      for (const p of s.pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 1.8, 0, 7); ctx.fill(); }
    }
  };

  // 13. TNT rain (chaotic fun).
  themes.tntrain = {
    init: (s) => {
      s.items = Array.from({ length: 16 }, () => ({ x: rand(0, W), y: rand(-H, 0), size: rand(18, 40), vy: rand(1.5, 4), rot: rand(0, 6.28), vr: rand(-0.06, 0.06) }));
    },
    draw: (s) => {
      for (const b of s.items) {
        b.y += b.vy; b.rot += b.vr;
        if (b.y > H + 50) { b.y = -50; b.x = rand(0, W); }
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot);
        ctx.globalAlpha = 0.9;
        ctx.drawImage(TEX.tnt, -b.size / 2, -b.size / 2, b.size, b.size);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  };

  // 14. Diamond shimmer (slow sparkles on dark).
  themes.diamond = {
    init: (s) => { s.sparks = Array.from({ length: 70 }, () => ({ x: rand(0, W), y: rand(0, H), r: rand(0.6, 2.4), ph: rand(0, 6.28), sp: rand(0.01, 0.04) })); },
    draw: (s) => {
      for (const p of s.sparks) {
        p.ph += p.sp;
        const a = (Math.sin(p.ph) + 1) / 2;
        ctx.globalAlpha = a * 0.9;
        ctx.fillStyle = '#67e8f9';
        const r = p.r * (0.6 + a);
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.ph * 0.3);
        ctx.fillRect(-r, -r, r * 2, r * 2);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  };

  // 15. Aurora waves.
  themes.aurora = {
    init: (s) => { s.t = 0; },
    draw: (s) => {
      s.t += 0.008;
      ctx.fillStyle = '#050810'; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (let band = 0; band < 3; band++) {
        ctx.beginPath();
        for (let x = 0; x <= W; x += 16) {
          const y = H * 0.3 + band * 40 + Math.sin(x * 0.004 + s.t * (2 + band)) * 60 + Math.sin(x * 0.01 + s.t) * 20;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = band === 1 ? 'rgba(52,211,153,0.30)' : 'rgba(139,92,246,0.30)';
        ctx.lineWidth = 26; ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  };

  // 16. Blocks + user images drifting together ("custom blocks").
  themes.custom = {
    init: (s) => {
      s.items = Array.from({ length: 18 }, () => ({
        tex: pick(BLOCKS), img: null, x: rand(0, W), y: rand(0, H),
        size: rand(28, 60), vy: rand(-0.7, -0.2), rot: rand(0, 6.28), vr: rand(-0.012, 0.012), wob: rand(0, 6.28)
      }));
      // Sprinkle 5 user images among the blocks.
      const imgs = Object.values(userImages).slice(0, 5);
      s.items.slice(0, imgs.length).forEach((item, i) => { item.img = imgs[i]; });
    },
    draw: (s) => {
      for (const b of s.items) {
        b.y += b.vy; b.rot += b.vr; b.wob += 0.02;
        if (b.y < -70) { b.y = H + 40; b.x = rand(0, W); }
        const x = b.x + Math.sin(b.wob) * 12;
        ctx.save(); ctx.translate(x, b.y); ctx.rotate(b.rot); ctx.globalAlpha = 0.9;
        const size = b.size;
        if (b.img && b.img.complete && b.img.naturalWidth) {
          const side = Math.min(b.img.naturalWidth, b.img.naturalHeight);
          ctx.drawImage(b.img, (b.img.naturalWidth - side) / 2, (b.img.naturalHeight - side) / 2, side, side, -size / 2, -size / 2, size, size);
        } else {
          ctx.drawImage(TEX[b.tex], -size / 2, -size / 2, size, size);
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  };

  // ---------------------------------------------------------------- user images
  const userImages = {}; // name -> Image element (decoded, ready to draw)

  function loadUserImages(names) {
    for (const name of names) {
      if (userImages[name]) continue;
      window.darklauncher.bgLoad(name).then((res) => {
        if (!res.ok) return;
        const img = new Image();
        img.onload = () => { userImages[name] = img; };
        img.src = res.dataUrl;
      });
    }
  }

  // Full background image layer (kept as a DOM element behind everything).
  const bgImage = document.createElement('div');
  bgImage.id = 'bg-image';
  document.body.insertBefore(bgImage, canvas);

  function applyBackgroundImage(dataUrl) {
    bgImage.style.backgroundImage = dataUrl ? `url("${dataUrl}")` : '';
    document.body.classList.toggle('has-bg-image', !!dataUrl);
  }

  // ---------------------------------------------------------------- loop
  function startTheme(name, keepState) {
    if (!themes[name]) name = 'off';
    currentTheme = name;
    cancelAnimationFrame(rafId);
    ctx.clearRect(0, 0, W, H);
    themeState = themes[name] ? themes[name].init({}) || {} : null;
    if (name !== 'off') lastFrame = 0, loop(performance.now());
  }

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (document.hidden) return;
    if (now - lastFrame < FRAME_MIN_MS) return;
    lastFrame = now;
    const theme = themes[currentTheme];
    if (!theme) return;
    // Fade-free clear: themes paint their own background when needed.
    if (!/^(matrix|warp|lava|underwater|aurora|grid|hills)$/.test(currentTheme)) ctx.clearRect(0, 0, W, H);
    theme.draw(themeState, now);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentTheme !== 'off') { lastFrame = 0; loop(performance.now()); }
  });

  // ---------------------------------------------------------------- API
  window.DarkBG = {
    setTheme(name) {
      if (!themes[name]) name = 'off';
      startTheme(name);
      if (name === 'custom') window.darklauncher.bgList().then((r) => { if (r.ok) loadUserImages(r.files); });
    },
    getTheme() { return currentTheme; },
    async setBackgroundImage(name) {
      if (!name) { applyBackgroundImage(''); return; }
      const res = await window.darklauncher.bgLoad(name);
      if (res.ok) applyBackgroundImage(res.dataUrl);
    },
    refreshImages() {
      return window.darklauncher.bgList().then((r) => { if (r.ok) loadUserImages(r.files); });
    },
    themeNames: Object.keys(themes)
  };

  resize();
})();
