// Builds the sandboxed document a game runs in. The game's own HTML is left
// intact; a small `studio` helper is injected before it so every game gets
// the same assets, sounds, touch controls, saves, and error reporting.

const ZZFX_URL = 'https://esm.sh/zzfx@1.3.2'

const PRELUDE = String.raw`
(() => {
  const DATA = __STUDIO_DATA__;
  const send = (message) => { try { parent.postMessage(message, '*') } catch {} };

  // Leaving a game: the host forwards the shell's "your app is hidden" signal
  // as studio:visibility (the shell keeps a left app loaded, and a hidden
  // frame gets no visibilitychange of its own). While hidden, every sound
  // context is suspended, playing media paused and animation frames held, so
  // the game is silent and frozen; document.hidden reports it too, so games
  // with their own pause-on-hide logic run it. Showing again picks up exactly
  // where it stopped.
  const quiet = { hidden: false, contexts: new Set(), wake: new Set(), media: new Set(), paused: new Set(), frames: new Map(), frameId: 0 };
  (() => {
    const wrapped = new Map();
    for (const name of ['AudioContext', 'webkitAudioContext']) {
      const Native = window[name]; if (!Native) continue;
      if (!wrapped.has(Native)) wrapped.set(Native, class extends Native {
        constructor(...args) { super(...args); quiet.contexts.add(this) }
        resume() { if (quiet.hidden) { quiet.wake.add(this); return Promise.resolve() } return super.resume() }
      });
      window[name] = wrapped.get(Native);
    }
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      quiet.media.add(this);
      if (quiet.hidden) { quiet.paused.add(this); return Promise.resolve() }
      return play.call(this);
    };
    const raf = window.requestAnimationFrame.bind(window); const cancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => { if (!quiet.hidden) return raf(cb); const id = -(++quiet.frameId); quiet.frames.set(id, cb); return id };
    window.cancelAnimationFrame = (id) => { if (id < 0) quiet.frames.delete(id); else cancel(id) };
    const own = (key) => Object.getOwnPropertyDescriptor(Document.prototype, key);
    const hidden = own('hidden'); const state = own('visibilityState');
    if (hidden && state) {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => quiet.hidden || hidden.get.call(document) });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => quiet.hidden ? 'hidden' : state.get.call(document) });
    }
    quiet.set = (visible) => {
      if (quiet.hidden === !visible) return;
      quiet.hidden = !visible;
      if (quiet.hidden) {
        for (const ctx of quiet.contexts) if (ctx.state === 'running') { quiet.wake.add(ctx); ctx.suspend().catch(() => {}) }
        for (const el of [...quiet.media, ...document.querySelectorAll('audio,video')]) if (!el.paused) { quiet.paused.add(el); el.pause() }
      } else {
        for (const ctx of quiet.wake) if (ctx.state !== 'closed') ctx.resume().catch(() => {});
        for (const el of quiet.paused) play.call(el).catch(() => {});
        quiet.wake.clear(); quiet.paused.clear();
        const frames = [...quiet.frames.values()]; quiet.frames.clear();
        for (const cb of frames) raf(cb);
      }
      document.dispatchEvent(new Event('visibilitychange'));
    };
    addEventListener('message', (e) => { if (e.source === parent && e.data && e.data.type === 'studio:visibility') quiet.set(e.data.visible !== false) });
  })();

  // 3D loaders fetch textures from blob: URLs, which the app's security
  // policy blocks; answer those fetches from the blobs themselves.
  (() => {
    if (window.__blobFetch) return; window.__blobFetch = true;
    const blobs = new Map(); const create = URL.createObjectURL.bind(URL); const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (obj) => { const url = create(obj); if (obj instanceof Blob) blobs.set(url, obj); return url };
    URL.revokeObjectURL = (url) => { blobs.delete(url); revoke(url) };
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => { const url = typeof input === 'string' ? input : input && input.url; return url && blobs.has(url) ? Promise.resolve(new Response(blobs.get(url))) : realFetch(input, init) };
  })();
  const report = (message, detail) => send({ type: 'studio:error', message: String(message).slice(0, 500), detail: String(detail || '').slice(0, 500) });
  addEventListener('error', (event) => report(event.message, (event.filename ? 'line ' + event.lineno : '')));
  addEventListener('unhandledrejection', (event) => report(event.reason && event.reason.message || event.reason, 'promise'));

  // Sound: ZzFX loads once; sounds requested before it arrives play when it does.
  let zz = null; const pending = [];
  import('${ZZFX_URL}').then((m) => { zz = m.ZZFX; pending.splice(0).forEach((p) => play(p)) }).catch(() => {});
  const fix = (p) => Array.from(p || [], (v) => v == null ? undefined : v);
  function play(params) {
    if (!zz) { if (pending.length < 8) pending.push(params); return }
    try { zz.audioContext.resume && zz.audioContext.resume(); zz.play(...fix(params)) } catch {}
  }

  // Input: one shared state from keyboard, gamepad, touch controls, and tilt.
  const input = { x: 0, y: 0, a: false, b: false, tilt: null };
  const keys = new Set(); const touch = { x: 0, y: 0, a: false, b: false }; const listeners = { a: new Set(), b: new Set() };
  const KEYS = { left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'], a: ['Space', 'KeyZ', 'Enter'], b: ['KeyX', 'ShiftLeft', 'ShiftRight'] };
  const held = (name) => KEYS[name].some((code) => keys.has(code));
  let pad = { x: 0, y: 0, a: false, b: false };
  function recompute() {
    const prevA = input.a, prevB = input.b;
    let x = (held('right') ? 1 : 0) - (held('left') ? 1 : 0) + touch.x + pad.x;
    let y = (held('down') ? 1 : 0) - (held('up') ? 1 : 0) + touch.y + pad.y;
    input.x = Math.max(-1, Math.min(1, x)); input.y = Math.max(-1, Math.min(1, y));
    input.a = held('a') || touch.a || pad.a; input.b = held('b') || touch.b || pad.b;
    if (input.a && !prevA) listeners.a.forEach((cb) => cb());
    if (input.b && !prevB) listeners.b.forEach((cb) => cb());
  }
  const GAME_KEYS = new Set(Object.values(KEYS).flat());
  addEventListener('keydown', (e) => { if (GAME_KEYS.has(e.code)) e.preventDefault(); keys.add(e.code); recompute() });
  addEventListener('keyup', (e) => { keys.delete(e.code); recompute() });
  addEventListener('blur', () => { keys.clear(); recompute() });
  (function pollPad() {
    const gp = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find(Boolean);
    const dz = (v) => Math.abs(v) < 0.2 ? 0 : v;
    const next = gp ? { x: dz(gp.axes[0] || 0) + (gp.buttons[15]?.pressed ? 1 : 0) - (gp.buttons[14]?.pressed ? 1 : 0), y: dz(gp.axes[1] || 0) + (gp.buttons[13]?.pressed ? 1 : 0) - (gp.buttons[12]?.pressed ? 1 : 0), a: !!gp.buttons[0]?.pressed, b: !!gp.buttons[1]?.pressed } : { x: 0, y: 0, a: false, b: false };
    if (next.x !== pad.x || next.y !== pad.y || next.a !== pad.a || next.b !== pad.b) { pad = next; recompute() }
    requestAnimationFrame(pollPad);
  })();

  function controls(options) {
    const opts = Object.assign({ stick: true, buttons: ['A'], always: false }, options || {});
    const coarse = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (!coarse && !opts.always) return;
    const ready = () => {
      // One set of controls at a time: a restart replaces them instead of stacking more.
      document.querySelectorAll('[data-studio-controls]').forEach((old) => old.remove());
      touch.x = 0; touch.y = 0; touch.a = false; touch.b = false;
      const layer = document.createElement('div');
      layer.setAttribute('data-studio-controls', '');
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;touch-action:none;user-select:none;-webkit-user-select:none';
      const pad = 'max(18px, env(safe-area-inset-bottom))';
      if (opts.stick) {
        const base = document.createElement('div');
        base.style.cssText = 'position:absolute;left:max(18px, env(safe-area-inset-left));bottom:' + pad + ';width:132px;height:132px;border-radius:50%;background:rgba(255,255,255,.10);border:2px solid rgba(255,255,255,.28);pointer-events:auto;touch-action:none';
        const knob = document.createElement('div');
        knob.style.cssText = 'position:absolute;left:41px;top:41px;width:50px;height:50px;border-radius:50%;background:rgba(255,255,255,.55)';
        base.appendChild(knob); layer.appendChild(base);
        let id = null;
        const move = (e) => {
          const r = base.getBoundingClientRect();
          let dx = (e.clientX - (r.left + r.width / 2)) / 50, dy = (e.clientY - (r.top + r.height / 2)) / 50;
          const len = Math.hypot(dx, dy); if (len > 1) { dx /= len; dy /= len }
          touch.x = Math.abs(dx) < 0.15 ? 0 : dx; touch.y = Math.abs(dy) < 0.15 ? 0 : dy;
          knob.style.transform = 'translate(' + dx * 40 + 'px,' + dy * 40 + 'px)'; recompute();
        };
        const end = (e) => { if (e.pointerId !== id) return; id = null; touch.x = 0; touch.y = 0; knob.style.transform = ''; recompute() };
        base.addEventListener('pointerdown', (e) => { id = e.pointerId; base.setPointerCapture(id); move(e); e.preventDefault() });
        base.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e) });
        base.addEventListener('pointerup', end); base.addEventListener('pointercancel', end);
      }
      (opts.buttons || []).slice(0, 2).forEach((label, index) => {
        const key = index === 0 ? 'a' : 'b';
        const btn = document.createElement('div');
        btn.textContent = String(label).slice(0, 6);
        btn.style.cssText = 'position:absolute;right:calc(max(18px, env(safe-area-inset-right)) + ' + (index * 92) + 'px);bottom:calc(' + pad + ' + ' + (index ? 40 : 0) + 'px);width:78px;height:78px;border-radius:50%;display:grid;place-items:center;font:700 18px system-ui,sans-serif;color:#fff;background:rgba(255,255,255,.16);border:2px solid rgba(255,255,255,.34);pointer-events:auto;touch-action:none';
        const set = (value) => (e) => { e.preventDefault(); touch[key] = value; btn.style.background = value ? 'rgba(255,255,255,.4)' : 'rgba(255,255,255,.16)'; recompute() };
        btn.addEventListener('pointerdown', set(true)); btn.addEventListener('pointerup', set(false));
        btn.addEventListener('pointercancel', set(false)); btn.addEventListener('pointerleave', set(false));
        layer.appendChild(btn);
      });
      document.body.appendChild(layer);
    };
    if (document.body) ready(); else addEventListener('DOMContentLoaded', ready, { once: true });
  }

  // Tilt and speech results come back from the studio, which owns the sensors
  // and the voices.
  const spoken = new Map(); let lineId = 0;
  addEventListener('message', (e) => {
    if (e.source !== parent || !e.data) return;
    if (e.data.type === 'studio:tilt') {
      input.tilt = { x: Math.max(-1, Math.min(1, e.data.x)), y: Math.max(-1, Math.min(1, e.data.y)) };
    } else if (e.data.type === 'studio:say-done') {
      const done = spoken.get(e.data.id); spoken.delete(e.data.id); if (done) done();
    }
  });
  // Lines made ahead of time with the studio's Kokoro or VOICEVOX voices (ART.voices,
  // keyed "voice|text") sound the same on every device; others go to the studio.
  let lineSource = null;
  function lineKey(text, voice) { return (voice || 'narrator') + '|' + String(text || '').trim().replace(/\s+/g, ' ').slice(0, 400) }
  function playLine(line, volume) {
    stopLine();
    return new Promise((resolve) => {
      try {
        sampleCtx = sampleCtx || new AudioContext();
        sampleCtx.resume && sampleCtx.resume();
        const bin = atob(line.dataUrl.split(',')[1]); const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        sampleCtx.decodeAudioData(bytes.buffer).then((buffer) => {
          const src = sampleCtx.createBufferSource(); src.buffer = buffer; src.playbackRate.value = line.rate || 1;
          const gain = sampleCtx.createGain(); gain.gain.value = volume == null ? 1 : Math.max(0, Math.min(1, volume));
          src.connect(gain).connect(sampleCtx.destination); src.onended = () => { if (lineSource === src) lineSource = null; resolve() };
          lineSource = src; src.start();
        }).catch(() => resolve());
      } catch { resolve() }
    });
  }
  function stopLine() { if (lineSource) { const s = lineSource; lineSource = null; try { s.stop() } catch {} } }
  function say(text, options) {
    const made = (ART.voices || {})[lineKey(text, (options || {}).voice)];
    if (made) { send({ type: 'studio:say-stop' }); return playLine(made, (options || {}).volume) }
    stopLine();
    // Standalone (the playtest, or a file opened directly): no studio to
    // speak, so finish after roughly how long the line would take.
    if (parent === window) return new Promise((resolve) => setTimeout(resolve, Math.min(6000, String(text || '').length * 55)));
    const id = ++lineId;
    const opts = Object.assign({}, options || {});
    send({ type: 'studio:say', id, text: String(text || '').slice(0, 400), voice: opts.voice, pitch: opts.pitch, rate: opts.rate, lang: opts.lang });
    return new Promise((resolve) => { spoken.set(id, resolve); setTimeout(() => { if (spoken.delete(id)) resolve() }, 30000) });
  }

  const saves = Object.assign({}, DATA.saves || {});
  const ART = Object.assign({ images: {}, sheets: {}, sounds: {}, models: {} }, DATA.art || {});

  // Real sound effects from the art kit play through Web Audio (media
  // elements cannot load data URLs here); decoded once, then reused.
  let sampleCtx = null; const samples = {};
  // Phones only let sound start inside a tap, so the first tap or key press
  // opens the context that voice lines and sound effects play through.
  const unlockSound = () => { try { sampleCtx = sampleCtx || new AudioContext(); sampleCtx.resume && sampleCtx.resume() } catch {} };
  addEventListener('pointerdown', unlockSound, { once: true, capture: true });
  addEventListener('keydown', unlockSound, { once: true, capture: true });
  function playSample(name) {
    try {
      sampleCtx = sampleCtx || new AudioContext();
      sampleCtx.resume && sampleCtx.resume();
      if (!samples[name]) {
        const b64 = ART.sounds[name].split(',')[1]; const bin = atob(b64); const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        samples[name] = sampleCtx.decodeAudioData(bytes.buffer);
      }
      samples[name].then((buffer) => { const src = sampleCtx.createBufferSource(); src.buffer = buffer; src.connect(sampleCtx.destination); src.start() }).catch(() => {});
      return true;
    } catch { return false }
  }

  // The art kit's font comes from Google Fonts (allowed here); games await
  // studio.fontReady before drawing text so it never flashes a fallback.
  let fontReady = Promise.resolve();
  if (ART.font) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(ART.font).replace(/%20/g, '+') + ':wght@400;700&display=swap';
    document.head.appendChild(link);
    fontReady = new Promise((resolve) => { link.onload = resolve; link.onerror = resolve; setTimeout(resolve, 2500) })
      .then(() => Promise.race([document.fonts.load('700 24px "' + ART.font + '"'), new Promise((r) => setTimeout(r, 1500))]))
      .catch(() => {});
    document.documentElement.style.setProperty('--studio-font', '"' + ART.font + '", system-ui, sans-serif');
  }
  const modelBuffers = {};
  function model(name) {
    const b64 = (DATA.models || {})[name] || ART.models[name];
    if (!b64) return null;
    if (!modelBuffers[name]) {
      const bin = atob(b64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      modelBuffers[name] = bytes.buffer;
    }
    return modelBuffers[name].slice(0);
  }
  window.studio = {
    input,
    controls,
    onPress(button, cb) { const set = listeners[button === 'b' ? 'b' : 'a']; set.add(cb); return () => set.delete(cb) },
    image(name) { return (ART.images[name] || DATA.sprites[name] || {}).dataUrl || null },
    images() { return [...new Set([...Object.keys(ART.images), ...Object.keys(DATA.sprites)])] },
    sheet(name) { return ART.sheets[name] || null },
    // The person's 3D characters: [{ name, role, height, body, animations, held }] (load one with studio.model(name)).
    characters() { return (ART.cast || []).map((c) => ({ ...c })) },
    sheets() { return Object.keys(ART.sheets) },
    preloadPhaser(scene) {
      for (const [name, s] of Object.entries(DATA.sprites)) scene.load.image(name, s.dataUrl);
      for (const [name, s] of Object.entries(ART.images)) scene.load.image(name, s.dataUrl);
      for (const [name, s] of Object.entries(ART.sheets)) scene.load.spritesheet(name, s.dataUrl, { frameWidth: s.frameWidth, frameHeight: s.frameHeight, spacing: s.spacing || 0, margin: s.margin || 0 });
    },
    sound(name, fallback) { if (ART.sounds[name] && playSample(name)) return; const p = DATA.sounds[name] || fallback; if (p) play(p) },
    sounds() { return [...new Set([...Object.keys(ART.sounds), ...Object.keys(DATA.sounds)])] },
    style: { title: ART.title || null, look: ART.style || null, font: ART.font || null, palette: ART.palette || {}, credit: ART.credit || null },
    fontReady,
    model,
    models() { return [...new Set([...Object.keys(DATA.models || {}), ...Object.keys(ART.models)])] },
    zzfx(...params) { play(params) },
    enableTilt() { send({ type: 'studio:tilt-start' }) },
    say,
    stopSpeaking() { stopLine(); send({ type: 'studio:say-stop' }) },
    save(key, value) { saves[key] = value; send({ type: 'studio:save', key: String(key).slice(0, 64), value }) },
    load(key) { return saves[key] },
    fullscreen() { const el = document.documentElement; if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {}) },
  };
})();
`

// The shell keeps an app you leave loaded but hidden, and tells it with
// moebius:frame-visibility. Hosts pass that on to their game frame (see
// "Leaving a game" in the prelude) and call sync() whenever a new game frame
// loads; onChange lets the host quiet its own sounds (voices) too.
let shellVisible = true
export function relayVisibility(getFrame, onChange) {
  const sync = () => getFrame()?.contentWindow?.postMessage({ type: 'studio:visibility', visible: shellVisible }, '*')
  const onMessage = (event) => {
    if (event.source !== window.parent || event.data?.type !== 'moebius:frame-visibility') return
    shellVisible = event.data.visible !== false
    sync()
    onChange?.(shellVisible)
  }
  window.addEventListener('message', onMessage)
  return { sync, stop: () => window.removeEventListener('message', onMessage) }
}

function scriptSafeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

// A game's art is its kit (shared by every game in that style) plus the
// pictures added to that one game; the game's own entries win on a name clash.
export function mergeArt(kit, own) {
  const base = kit || {}
  const extra = own || {}
  const pick = (key) => ({ ...(base[key] || {}), ...(extra[key] || {}) })
  return {
    title: base.title, style: base.style, font: extra.font || base.font, palette: { ...(base.palette || {}), ...(extra.palette || {}) },
    credit: base.credit, images: pick('images'), sheets: pick('sheets'), sounds: pick('sounds'), models: pick('models'), voices: pick('voices'),
  }
}

// The person's Characters and Assets tabs feed every game: characters become
// sprite sheets (studio.sheet(name); first frame as studio.image(name)) and
// assets become images. The game's own and kit art still win on a name clash
// for images already in it; library names otherwise override kit names.
export function withLibrary(art, assets) {
  const base = art || {}
  const sheets = {}
  const images = {}
  for (const [name, c] of Object.entries(assets?.characters || {})) {
    sheets[name] = { dataUrl: c.dataUrl, frameWidth: c.frameWidth, frameHeight: c.frameHeight, frameCount: c.frameCount, animations: c.animations }
    if (c.thumb) images[name] = { dataUrl: c.thumb }
  }
  for (const [name, sprite] of Object.entries(assets?.sprites || {})) images[name] = { dataUrl: sprite.dataUrl, w: sprite.width, h: sprite.height }
  // What each 3D character is, so games can cast them: role, size, body and moves.
  const cast = Object.entries(assets?.characters || {}).filter(([, c]) => c.kind === '3d').map(([name, c]) => ({
    name, role: c.role || null, height: c.height || null, body: c.body || 'humanoid', animations: c.animations || [], held: c.held || [],
  }))
  return { ...base, images: { ...(base.images || {}), ...images }, sheets: { ...(base.sheets || {}), ...sheets }, cast }
}

export function buildGameDocument(html, { sprites = {}, sounds = {}, saves = {}, models = {}, art = null } = {}) {
  const data = scriptSafeJson({ sprites, sounds, saves, models, art })
  const prelude = `<script>${PRELUDE.replace('__STUDIO_DATA__', () => data)}</script>`
  const base = '<style>html,body{margin:0;height:100%;overflow:hidden;background:#0b1020;overscroll-behavior:none}</style>'
  const source = String(html || '')
  const head = source.match(/<head[^>]*>/i)
  if (head) return source.replace(head[0], () => `${head[0]}${base}${prelude}`)
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${base}${prelude}</head><body>${source}</body></html>`
}
