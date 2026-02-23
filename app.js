/* ═══════════════════════════════════════════════════════════════
   Bitcoin Pulse — app.js
   ═══════════════════════════════════════════════════════════════ */
'use strict';

// ─── Constants ────────────────────────────────────────────────
const POLL_MS  = 20_000;
const STALE_MS = 5 * 60_000;
const LS_KEY   = 'btc_pulse_v6';
const LS_MAX   = 90;

// ─── Utility ──────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t)    { return a + (b - a) * t; }
function isStale(ts)       { return !ts || (Date.now() - ts) > STALE_MS; }

// ─── API state ────────────────────────────────────────────────
const api = {
  fastestFee: null, fg: null, volatility: null,
  lastFeeTs: null,  lastFgTs: null, lastVolTs: null,
};
const manual = { fee: null, vol: null, fg: null };

// ─── Pulse engine ─────────────────────────────────────────────
const pulseMemory = createPulseCalculator();
let _lastPulse    = null;

// ─── Colour tables ────────────────────────────────────────────
const GLOW_RGB = {
  DEEP_SLEEP:[140,55,0], DROWSY:[180,68,0], RELAXED:[210,82,0],
  BALANCED:[230,92,0], ALERT:[245,105,0], ENERGIZED:[255,118,0],
  TENSE:[255,122,0], UNDER_PRESSURE:[255,130,0], AT_THE_LIMIT:[255,150,0],
  PANIC:[255,28,28], EUPHORIC:[255,160,0],
};
const TEXT_ALPHA = {
  DEEP_SLEEP:0.38, DROWSY:0.48, RELAXED:0.58, BALANCED:0.65,
  ALERT:0.72, ENERGIZED:0.82, TENSE:0.90, UNDER_PRESSURE:1.0, AT_THE_LIMIT:1.0,
};
function getMoodColors(stateKey, fg) {
  const k = stateKey === 'EXTREME' ? (fg < 50 ? 'PANIC' : 'EUPHORIC') : stateKey;
  const glow = GLOW_RGB[k] || [255,122,0];
  const [r,g,b] = glow;
  const a = TEXT_ALPHA[stateKey] !== undefined ? TEXT_ALPHA[stateKey] : 1.0;
  const text = k === 'PANIC'
    ? 'rgba(255,40,40,' + a + ')'
    : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  return { glow, text };
}

// ─── State CSS map ────────────────────────────────────────────
const STATE_CSS_MAP = {
  DEEP_SLEEP:'state-deep-sleep', DROWSY:'state-drowsy',
  RELAXED:'state-relaxed', BALANCED:'state-balanced',
  ALERT:'state-alert', ENERGIZED:'state-energized',
  TENSE:'state-tense', UNDER_PRESSURE:'state-under-pressure',
  AT_THE_LIMIT:'state-at-the-limit', PANIC:'state-panic', EUPHORIC:'state-euphoric',
};
let _currentStateClass = null;

function applyStateClass(stateKey, subState) {
  const key = stateKey === 'EXTREME' ? (subState || 'PANIC') : stateKey;
  const cls = STATE_CSS_MAP[key];
  if (!cls || cls === _currentStateClass) return;
  if (_currentStateClass) {
    clearParticles();
    heartWrap.classList.remove(_currentStateClass);
  }
  heartWrap.classList.add(cls);
  _currentStateClass = cls;
  setupEffect(cls);
}

// ─── DOM refs ─────────────────────────────────────────────────
const heartEl       = document.getElementById('heart');
const heartWrap     = document.getElementById('heart-wrap');
const statusEl      = document.getElementById('status');
const bpmDisplay    = document.getElementById('bpm-display');
const auraEl        = document.getElementById('aura');
const inpFees       = document.getElementById('inp-fees');
const inpVol        = document.getElementById('inp-vol');
const inpFg         = document.getElementById('inp-fg');
const fxOverlay     = document.getElementById('fx-overlay');
const shareBtn      = document.getElementById('share-btn');
const refreshBtn    = document.getElementById('refresh-btn');
const modalBackdrop = document.getElementById('modal-backdrop');
const modalLabel    = document.getElementById('modal-label');
const modalBar      = document.getElementById('modal-bar');
const modalPreview  = document.getElementById('modal-preview');
const modalActions  = document.getElementById('modal-actions');
const modalClose    = document.getElementById('modal-close');
const modalDl       = document.getElementById('modal-dl');
const modalLink     = document.getElementById('modal-link');

// ─── LocalStorage ─────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function saveHistory(h) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(h)); } catch {}
}
function appendHistory(key, entry) {
  const h = loadHistory();
  if (!h[key]) h[key] = [];
  h[key].push(entry);
  if (h[key].length > LS_MAX) h[key] = h[key].slice(-LS_MAX);
  saveHistory(h);
}

// ─── Effective inputs ─────────────────────────────────────────
function effInputs() {
  return {
    FEES:  manual.fee !== null ? manual.fee : clamp(api.fastestFee  !== null ? api.fastestFee  : 1,  1, 100),
    VOL24: manual.vol !== null ? manual.vol : clamp(api.volatility   !== null ? api.volatility   : 0,  0,  20),
    FG:    manual.fg  !== null ? manual.fg  : clamp(api.fg           !== null ? api.fg           : 50, 0, 100),
  };
}

// ─── Heart colour ─────────────────────────────────────────────
const moodStyle = document.createElement('style');
document.head.appendChild(moodStyle);
function applyHeartColor(hex) {
  moodStyle.textContent = '.heart::before,.heart::after{background:' + hex + '!important}';
}

// ─── Glow renderer ────────────────────────────────────────────
function renderGlow(intensity, glow) {
  const [r,g,b] = glow;
  const rgb = r + ',' + g + ',' + b;
  const r1 = Math.round(12 + intensity*200), o1 = Math.min(0.60+intensity*4.0,0.98).toFixed(2);
  const r2 = Math.round(30 + intensity*380), o2 = Math.min(0.28+intensity*2.5,0.70).toFixed(2);
  const r3 = Math.round(60 + intensity*560), o3 = Math.min(0.08+intensity*1.2,0.36).toFixed(2);
  heartWrap.style.filter =
    'drop-shadow(0 0 '+r1+'px rgba('+rgb+','+o1+')) '+
    'drop-shadow(0 0 '+r2+'px rgba('+rgb+','+o2+')) '+
    'drop-shadow(0 0 '+r3+'px rgba('+rgb+','+o3+'))';
  const a1 = Math.min(0.08+intensity*1.4,0.36).toFixed(3);
  const a2 = Math.min(0.03+intensity*0.7,0.16).toFixed(3);
  auraEl.style.background =
    'radial-gradient(ellipse 64% 58% at 50% 44%,'+
    'rgba('+rgb+','+a1+') 0%,rgba('+rgb+','+a2+') 42%,transparent 70%)';
}

// ─── Overlay positioning ──────────────────────────────────────
function positionOverlay() {
  const r  = heartWrap.getBoundingClientRect();
  const sr = (heartWrap.closest('.stage') || document.body).getBoundingClientRect();
  fxOverlay.style.cssText = [
    'position:absolute',
    'left:'  + (r.left - sr.left) + 'px',
    'top:'   + (r.top  - sr.top)  + 'px',
    'width:' + r.width  + 'px',
    'height:'+ r.height + 'px',
    'pointer-events:none',
    'overflow:visible',
    'z-index:10',
  ].join(';');
}
window.addEventListener('resize', positionOverlay);

// ─── Heartbeat + shockwave ────────────────────────────────────
let lastBeat       = 0;
let currentAnimBpm = 68;
let _lastBpmText   = '';
let _beatCount     = 0;

function scheduleBeat(bpm) {
  const now = performance.now();
  if (now - lastBeat >= 60000 / bpm) {
    lastBeat = now;
    heartEl.style.animation = 'none';
    void heartEl.offsetWidth;
    heartEl.style.animation =
      'heartbeat ' + ((60000 / bpm) * 0.72).toFixed(0) + 'ms cubic-bezier(0.42,0,0.58,1) 1';

    if (_lastPulse) {
      const intensity = _lastPulse.intensity;
      _beatCount++;
      if (intensity >= 0.90) {
        emitShockwave(intensity);
      } else if (intensity >= 0.70 && _beatCount % 3 === 0) {
        emitShockwave(intensity);
      } else if (intensity >= 0.60 && _beatCount % 5 === 0) {
        emitShockwave(intensity);
      }
    }
  }
}

// ─── Animation loop ───────────────────────────────────────────
function animLoop() {
  if (_lastPulse) {
    currentAnimBpm = lerp(currentAnimBpm, _lastPulse.bpm, 0.06);
    scheduleBeat(currentAnimBpm);
    const t = Math.round(currentAnimBpm) + ' BPM';
    if (t !== _lastBpmText) { bpmDisplay.textContent = t; _lastBpmText = t; }
    const { glow } = getMoodColors(_lastPulse.stateKey, effInputs().FG);
    renderGlow(_lastPulse.intensity, glow);
  }
  requestAnimationFrame(animLoop);
}

// ─── HUD field refresh ────────────────────────────────────────
let _focusedKey = null;

function refreshHUDField(inp, val, ts) {
  inp.value = (val !== null && val !== undefined) ? val : '';
  inp.classList.toggle('stale', val === null || val === undefined || isStale(ts));
  inp.classList.remove('manual');
}

// ─── Main UI update ───────────────────────────────────────────
function updateUI() {
  const inputs = effInputs();

  // Snap intensity + BPM immediately
  const raw = (inputs.FG/100 + inputs.VOL24/20 + (inputs.FEES-1)/99) / 3;
  pulseMemory.intensity = pulseMemory.intensity + (raw - pulseMemory.intensity) * 0.85;
  const tBpm = 58 + pulseMemory.intensity * 82;
  pulseMemory.bpm = pulseMemory.bpm + (tBpm - pulseMemory.bpm) * 0.85;

  const pulse  = updatePulse(pulseMemory, inputs);
  _lastPulse   = pulse;
  currentAnimBpm = pulse.bpm;

  const { stateKey, stateText } = pulse;
  const subState = stateKey === 'EXTREME' ? (inputs.FG < 50 ? 'PANIC' : 'EUPHORIC') : null;
  const { text } = getMoodColors(stateKey, inputs.FG);

  statusEl.textContent = stateText;
  statusEl.style.color = text;
  statusEl.className   = 'status';
  applyHeartColor('#ff7a00');
  applyStateClass(stateKey, subState);

  if (manual.fee === null && _focusedKey !== 'fee') {
    refreshHUDField(inpFees, api.fastestFee, api.lastFeeTs);
  }
  if (manual.vol === null && _focusedKey !== 'vol') {
    const v = api.volatility !== null ? Number(api.volatility).toFixed(1) : null;
    refreshHUDField(inpVol, v, api.lastVolTs);
  }
  if (manual.fg === null && _focusedKey !== 'fg') {
    refreshHUDField(inpFg, api.fg, api.lastFgTs);
  }
}

// ─── Editable HUD ─────────────────────────────────────────────
function initEditableHUD() {
  function wire(inp, key, parse, lo, hi, fmt) {
    inp.addEventListener('focus', function() { _focusedKey = key; this.select(); });
    inp.addEventListener('blur', function() {
      _focusedKey = null;
      const raw = this.value.trim();
      if (raw === '') {
        manual[key] = null;
        this.classList.remove('manual');
      } else {
        const n = parse(raw);
        if (!isNaN(n) && isFinite(n) && n >= lo && n <= hi) {
          manual[key] = n;
          this.value  = fmt ? fmt(n) : String(n);
          this.classList.add('manual');
          this.classList.remove('stale');
        } else {
          manual[key] = null;
          this.classList.remove('manual');
        }
      }
      updateUI();
    });
    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter')  { e.preventDefault(); this.blur(); }
      if (e.key === 'Escape') { manual[key] = null; this.classList.remove('manual'); this.blur(); }
    });
  }
  wire(inpFees, 'fee', parseFloat,              1,  100, v => Math.round(v));
  wire(inpVol,  'vol', parseFloat,              0,   20, v => Number(v).toFixed(1));
  wire(inpFg,   'fg',  v => parseInt(v, 10),   0,  100, v => Math.round(v));

  refreshBtn.addEventListener('click', function() {
    manual.fee = manual.vol = manual.fg = null;
    inpFees.classList.remove('manual');
    inpVol.classList.remove('manual');
    inpFg.classList.remove('manual');
    refreshBtn.classList.add('spinning');
    refreshBtn.disabled = true;
    setTimeout(function() { refreshBtn.classList.remove('spinning'); refreshBtn.disabled = false; }, 650);
    poll();
  });
}

// ══════════════════════════════════════════════════════════════
// PARTICLE + EFFECT SYSTEM
// ══════════════════════════════════════════════════════════════

let _particleTimers = [];

function clearParticles() {
  _particleTimers.forEach(function(id) { clearTimeout(id); clearInterval(id); });
  _particleTimers = [];
  fxOverlay.innerHTML = '';
}

function mkEl(tag, cssText) {
  const el = document.createElement(tag);
  el.style.cssText = cssText;
  el.classList.add('fx-particle');
  fxOverlay.appendChild(el);
  el.addEventListener('animationend', function() { el.remove(); }, { once: true });
  return el;
}

// ─── zZZ ──────────────────────────────────────────────────────
function spawnZ(opts) {
  function emit() {
    var seq = opts.big
      ? [{ch:'z',sc:0.50,d:0},{ch:'Z',sc:0.75,d:280},{ch:'Z',sc:1.0,d:560}]
      : [{ch:'z',sc:0.65,d:0},{ch:'Z',sc:1.0, d:340}];
    seq.forEach(function(s) {
      var tid = setTimeout(function() {
        var sz   = Math.round(opts.size * s.sc);
        var xPct = 28 + Math.random() * 44;
        var yPct = 2  + Math.random() * 18;
        var el = mkEl('span', [
          'position:absolute',
          'left:'+xPct+'%','top:'+yPct+'%',
          'font-size:'+sz+'px',
          'font-family:"Courier New",monospace',
          'font-weight:bold',
          'color:rgba(255,170,0,'+opts.opacity+')',
          'text-shadow:0 0 16px rgba(255,140,0,0.90),0 0 32px rgba(255,100,0,0.50)',
          'pointer-events:none','user-select:none',
          '--fx-drift:'+((Math.random()-0.5)*opts.drift)+'px',
          'animation:fx-float-up '+opts.duration+'ms ease-out forwards',
        ].join(';'));
        el.textContent = s.ch;
      }, s.d);
      _particleTimers.push(tid);
    });
  }
  emit();
  // Simple setInterval — no recursion, no stack overflow
  _particleTimers.push(setInterval(emit, opts.intervalMs));
}

// ─── Sparks ───────────────────────────────────────────────────
function spawnSparks() {
  function emit() {
    var n = 1 + Math.floor(Math.random()*2);
    for (var i=0;i<n;i++) {
      var angle = Math.random()*Math.PI*2;
      var r     = 32 + Math.random()*24;
      mkEl('span',[
        'position:absolute','width:4px','height:4px','border-radius:50%',
        'background:rgba(255,200,0,1)',
        'box-shadow:0 0 6px rgba(255,160,0,0.9)',
        'pointer-events:none',
        'left:calc(50% + '+Math.round(Math.cos(angle)*18)+'%)',
        'top:calc(50% + '+Math.round(Math.sin(angle)*16)+'%)',
        '--fx-dx:'+(Math.cos(angle)*r).toFixed(1)+'px',
        '--fx-dy:'+(Math.sin(angle)*r).toFixed(1)+'px',
        'animation:fx-spark-out '+(260+Math.random()*200)+'ms ease-out forwards',
      ].join(';'));
    }
  }
  emit();
  _particleTimers.push(setInterval(emit, 190));
}

// ─── Sweat drops ──────────────────────────────────────────────
function spawnSweat(opts) {
  function emitBatch() {
    for (var i=0;i<opts.count;i++) {
      (function() {
        var t = setTimeout(function() {
          var leftPct = 16 + Math.random()*68;
          var topPct  = 12 + Math.random()*16;
          mkEl('span',[
            'position:absolute',
            'width:'+opts.size+'px',
            'height:'+Math.round(opts.size*2.2)+'px',
            'border-radius:50% 50% 50% 50% / 30% 30% 70% 70%',
            'background:linear-gradient(to bottom,'+
              'rgba(180,230,255,'+opts.opacity+'),'+
              'rgba(80,150,255,'+(opts.opacity*0.55).toFixed(2)+'))',
            'box-shadow:0 0 '+(opts.size*2)+'px rgba(120,190,255,0.50)',
            'pointer-events:none',
            'left:'+leftPct+'%','top:'+topPct+'%',
            'animation:fx-sweat-drop '+(opts.speedMs+Math.random()*400)+'ms ease-in forwards',
          ].join(';'));
        }, Math.random()*500);
        _particleTimers.push(t);
      }());
    }
  }
  emitBatch();
  _particleTimers.push(setInterval(emitBatch, opts.intervalMs));
}

// ─── Flames ───────────────────────────────────────────────────
function spawnFlames() {
  function emit() {
    var xOff = (Math.random()-0.5)*65;
    var w    = 10 + Math.random()*14;
    var h    = 35 + Math.random()*45;
    mkEl('span',[
      'position:absolute',
      'width:'+w+'px','height:'+h+'px',
      'border-radius:60% 60% 30% 30% / 60% 60% 40% 40%',
      'background:linear-gradient(to top,rgba(255,50,0,0.98),rgba(255,180,0,0.70),rgba(255,240,100,0))',
      'box-shadow:0 0 18px rgba(255,80,0,0.80),0 0 40px rgba(255,60,0,0.35)',
      'pointer-events:none',
      'left:calc(50% + '+xOff.toFixed(1)+'px - '+Math.round(w/2)+'px)',
      'top:62%',
      '--fx-drift:'+((Math.random()-0.5)*24).toFixed(1)+'px',
      'animation:fx-flame-rise '+(500+Math.random()*400)+'ms ease-out forwards',
    ].join(';'));
  }
  emit();emit();emit();emit();
  _particleTimers.push(setInterval(function() {
    var n = 2+Math.floor(Math.random()*3);
    for (var i=0;i<n;i++) {
      var t = setTimeout(emit, Math.random()*140);
      _particleTimers.push(t);
    }
  }, 150));
}

// ─── Shockwave ────────────────────────────────────────────────
function emitShockwave(intensity) {
  var dur   = Math.round(420+(1-intensity)*380);
  var a     = (0.40+intensity*0.50).toFixed(2);
  var color = intensity > 0.90
    ? 'rgba(255,30,30,'+a+')'
    : 'rgba(255,'+Math.round(90+intensity*90)+',0,'+a+')';
  var s = 88;
  var el = document.createElement('div');
  el.style.cssText = [
    'position:absolute',
    'width:'+s+'%','height:'+s+'%',
    'left:'+((100-s)/2)+'%','top:'+((100-s)/2)+'%',
    'border-radius:50%',
    'border:3px solid '+color,
    'box-shadow:0 0 14px '+color+',inset 0 0 10px '+color,
    'pointer-events:none',
    'animation:fx-shockwave '+dur+'ms ease-out forwards',
  ].join(';');
  fxOverlay.appendChild(el);
  el.addEventListener('animationend', function() { el.remove(); }, { once: true });
}

// ─── Setup per state ──────────────────────────────────────────
function setupEffect(cls) {
  _beatCount = 0;
  switch(cls) {
    case 'state-deep-sleep':
      spawnZ({big:true,  intervalMs:1800,drift:44,duration:4200,size:42,opacity:0.90});break;
    case 'state-drowsy':
      spawnZ({big:false, intervalMs:2600,drift:26,duration:3400,size:28,opacity:0.70});break;
    case 'state-energized':
      spawnSparks();break;
    case 'state-tense':
      spawnSweat({count:1,size:6, opacity:0.70,speedMs:850, intervalMs:1300});break;
    case 'state-under-pressure':
      spawnSweat({count:2,size:9, opacity:0.85,speedMs:680, intervalMs:950});break;
    case 'state-at-the-limit':
      spawnSweat({count:3,size:12,opacity:1.00,speedMs:520, intervalMs:700});break;
    case 'state-euphoric':
      spawnFlames();break;
    default:break;
  }
}

// ─── API fetches ──────────────────────────────────────────────
async function fetchFees() {
  try {
    const r = await fetch('https://mempool.space/api/v1/fees/recommended',{cache:'no-store'});
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    if (d.fastestFee != null) {
      api.fastestFee = d.fastestFee; api.lastFeeTs = Date.now();
      appendHistory('fees',{t:api.lastFeeTs,v:api.fastestFee});
    }
  } catch(e) { console.warn('[fees]',e.message); if(isStale(api.lastFeeTs)) api.fastestFee=null; }
}

async function fetchFG() {
  try {
    const r = await fetch('https://api.alternative.me/fng/',{cache:'no-store'});
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    const v = parseInt(d&&d.data&&d.data[0]&&d.data[0].value,10);
    if (!isNaN(v)) { api.fg=v; api.lastFgTs=Date.now(); appendHistory('fg',{t:api.lastFgTs,v}); }
  } catch(e) { console.warn('[fng]',e.message); if(isStale(api.lastFgTs)) api.fg=null; }
}

async function fetchVol() {
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
      {cache:'no-store'});
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    const pct = d&&d.bitcoin&&d.bitcoin.usd_24h_change;
    if (pct!=null&&!isNaN(pct)) {
      api.volatility=Math.abs(pct); api.lastVolTs=Date.now();
      appendHistory('vol',{t:api.lastVolTs,v:api.volatility});
    }
  } catch(e) { console.warn('[vol]',e.message); if(isStale(api.lastVolTs)) api.volatility=null; }
}

// ─── GIF generator ────────────────────────────────────────────
function heartPath(ctx,cx,cy,w,h) {
  const ox=cx,oy=cy-h*0.06;
  ctx.beginPath();
  ctx.moveTo(ox,oy+h*.15);
  ctx.bezierCurveTo(ox-w*.04,oy-h*.06,ox-w*.5,oy-h*.15,ox-w*.5,oy+h*.12);
  ctx.bezierCurveTo(ox-w*.5, oy+h*.42,ox,     oy+h*.62,ox,     oy+h*.72);
  ctx.bezierCurveTo(ox,      oy+h*.62,ox+w*.5,oy+h*.42,ox+w*.5,oy+h*.12);
  ctx.bezierCurveTo(ox+w*.5, oy-h*.15,ox+w*.04,oy-h*.06,ox,    oy+h*.15);
  ctx.closePath();
}
function drawGlowHalo(ctx,cx,cy,hSize,glow,intensity) {
  const [r,g,b]=glow,rgb=r+','+g+','+b;
  for(var i=8;i>=1;i--){
    const expand=1+(i/8)*(0.5+intensity*2.5);
    const alpha=((8-i+1)/8)*Math.min(0.18+intensity*0.9,0.65);
    ctx.save();ctx.translate(cx,cy);ctx.scale(expand*0.72,expand*0.65);ctx.translate(-cx,-cy);
    heartPath(ctx,cx,cy,hSize*0.72,hSize*0.65);
    ctx.fillStyle='rgba('+rgb+','+alpha.toFixed(3)+')';ctx.fill();ctx.restore();
  }
}
function scaleAtT(t) {
  if(t<0.14) return 1+(t/0.14)*0.13;
  if(t<0.28) return 1.13-((t-0.14)/0.14)*0.13;
  if(t<0.42) return 1+((t-0.28)/0.14)*0.07;
  if(t<0.60) return 1.07-((t-0.42)/0.18)*0.07;
  return 1;
}
async function generateGIF() {
  if(typeof GIF==='undefined') throw new Error('gif.js not loaded');
  if(!_lastPulse) throw new Error('no pulse data yet');
  const {stateKey,stateText,intensity,bpm}=_lastPulse;
  const fg=effInputs().FG;
  const {glow,text}=getMoodColors(stateKey,fg);
  const glowStr=glow[0]+','+glow[1]+','+glow[2];
  const bpmInt=Math.round(bpm);
  const SIZE=400,CX=200,CY=182,HSIZE=124,FRAMES=30;
  const delay=Math.max(2,Math.round(Math.min(60000/bpmInt,2800)/FRAMES/10));
  const canvas=document.createElement('canvas');
  canvas.width=canvas.height=SIZE;
  const ctx=canvas.getContext('2d');
  const gif=new GIF({quality:8,width:SIZE,height:SIZE});
  for(var f=0;f<FRAMES;f++){
    const sc=scaleAtT(f/FRAMES);
    ctx.fillStyle='#050608';ctx.fillRect(0,0,SIZE,SIZE);
    const aAmp=Math.min(0.14+intensity*1.2,0.42);
    const aGrad=ctx.createRadialGradient(CX,CY,0,CX,CY,SIZE*0.52);
    aGrad.addColorStop(0,'rgba('+glowStr+','+aAmp.toFixed(3)+')');
    aGrad.addColorStop(0.45,'rgba('+glowStr+','+(aAmp*0.28).toFixed(3)+')');
    aGrad.addColorStop(1,'rgba('+glowStr+',0)');
    ctx.fillStyle=aGrad;ctx.fillRect(0,0,SIZE,SIZE);
    ctx.save();ctx.translate(CX,CY);ctx.scale(sc,sc);ctx.translate(-CX,-CY);
    drawGlowHalo(ctx,CX,CY,HSIZE,glow,intensity);
    heartPath(ctx,CX,CY,HSIZE*0.72,HSIZE*0.65);
    ctx.shadowColor='#ff7a00';ctx.shadowBlur=18+intensity*60;
    ctx.fillStyle='#ff7a00';ctx.fill();ctx.shadowBlur=0;ctx.restore();
    ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.font='bold 14px "Courier New",monospace';
    ctx.fillStyle=text;ctx.shadowColor=text;ctx.shadowBlur=12;
    ctx.fillText(stateText,CX,CY+HSIZE*0.76);ctx.restore();
    ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.font='10px "Courier New",monospace';
    ctx.fillStyle='rgba('+glowStr+',0.40)';
    ctx.fillText(bpmInt+' BPM',CX,CY+HSIZE*0.76+20);ctx.restore();
    ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.font='9px "Courier New",monospace';
    ctx.fillStyle='rgba('+glowStr+',0.18)';
    ctx.fillText('bitcoin-pulse',CX,SIZE-15);ctx.restore();
    gif.addFrame(ctx,{copy:true,delay});
  }
  return new Promise(function(resolve,reject){
    gif.on('progress',p=>{modalBar.style.width=Math.round(p*100)+'%';});
    gif.on('finished',resolve);gif.on('error',reject);gif.render();
  });
}

// ─── Share modal ──────────────────────────────────────────────
function initShare() {
  var blobUrl=null;
  function open(){modalLabel.textContent='Generating…';modalBar.style.width='0%';modalActions.hidden=true;modalPreview.innerHTML='';modalBackdrop.hidden=false;}
  function close(){modalBackdrop.hidden=true;if(blobUrl){URL.revokeObjectURL(blobUrl);blobUrl=null;}}
  shareBtn.addEventListener('click',async function(){
    open();shareBtn.classList.add('busy');
    try{
      const blob=await generateGIF();
      blobUrl=URL.createObjectURL(blob);
      const img=new Image();img.src=blobUrl;
      img.alt=(_lastPulse&&_lastPulse.stateText)||'Bitcoin Pulse';
      modalPreview.appendChild(img);
      modalLabel.textContent='Ready to share';modalBar.style.width='100%';modalActions.hidden=false;
      modalDl.onclick=function(){const a=document.createElement('a');a.href=blobUrl;a.download='bitcoin-pulse-'+((_lastPulse&&_lastPulse.stateKey)||'state').toLowerCase()+'.gif';a.click();};
      modalLink.onclick=async function(){
        const url=location.origin+location.pathname;
        try{if(navigator.share){await navigator.share({title:'Bitcoin Pulse',url});}
        else{await navigator.clipboard.writeText(url);modalLink.textContent='✓ Copied!';setTimeout(function(){modalLink.textContent='⧉ Copy link';},2200);}}catch(e){}
      };
    }catch(err){console.error('[gif]',err);modalLabel.textContent='⚠ Failed — see console';}
    shareBtn.classList.remove('busy');
  });
  modalClose.addEventListener('click',close);
  modalBackdrop.addEventListener('click',function(e){if(e.target===modalBackdrop)close();});
}

// ─── Cache restore ────────────────────────────────────────────
function restoreCache() {
  const h=loadHistory();
  function last(k){const a=h[k];return(a&&a.length)?a[a.length-1]:null;}
  const lf=last('fees');if(lf&&!isStale(lf.t)){api.fastestFee=lf.v;api.lastFeeTs=lf.t;}
  const lv=last('vol'); if(lv&&!isStale(lv.t)){api.volatility=lv.v;api.lastVolTs=lv.t;}
  const lg=last('fg');  if(lg&&!isStale(lg.t)){api.fg=lg.v;api.lastFgTs=lg.t;}
}

// ─── Poll ─────────────────────────────────────────────────────
async function poll() {
  await Promise.all([fetchFees(), fetchFG(), fetchVol()]);
  updateUI();
}

// ─── Boot ─────────────────────────────────────────────────────
(function init() {
  restoreCache();
  updateUI();
  initEditableHUD();
  initShare();
  positionOverlay();
  requestAnimationFrame(animLoop);
  poll();
  setInterval(poll, POLL_MS);
}());
