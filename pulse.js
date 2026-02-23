/**
 * pulse.js — Bitcoin Pulse calculation engine
 * Wrapped in IIFE — exposes only createPulseCalculator() and updatePulse() globally.
 */
(function () {
  'use strict';

  var BPM_MIN = 58;
  var BPM_MAX = 140;
  var GLOW_MIN_PX = 12;
  var GLOW_MAX_PX = 45;

  // Smoothing: fast enough to respond within 2-3 poll ticks
  var INTENSITY_SMOOTH  = 0.35;   // was 0.10 — much faster convergence
  var BPM_SMOOTH        = 0.20;   // was 0.08

  // Anti-flicker: only 6s hold, ±0.03 hysteresis band (was 20s / ±0.05)
  var STATE_MIN_HOLD_MS = 6000;
  var ANTI_FLICKER_BAND = 0.03;

  var STATE_BANDS = [
    { key: 'DEEP_SLEEP',     label: 'IN DEEP SLEEP',  lo: 0.00, hi: 0.10 },
    { key: 'DROWSY',         label: 'DROWSY',          lo: 0.10, hi: 0.20 },
    { key: 'RELAXED',        label: 'RELAXED',         lo: 0.20, hi: 0.30 },
    { key: 'BALANCED',       label: 'BALANCED',        lo: 0.30, hi: 0.40 },
    { key: 'ALERT',          label: 'ALERT',           lo: 0.40, hi: 0.50 },
    { key: 'ENERGIZED',      label: 'ENERGIZED',       lo: 0.50, hi: 0.60 },
    { key: 'TENSE',          label: 'TENSE',           lo: 0.60, hi: 0.70 },
    { key: 'UNDER_PRESSURE', label: 'UNDER PRESSURE',  lo: 0.70, hi: 0.80 },
    { key: 'AT_THE_LIMIT',   label: 'AT THE LIMIT',    lo: 0.80, hi: 0.90 },
    { key: 'EXTREME',        label: null,              lo: 0.90, hi: 1.00 },
  ];

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function _lerp(a, b, t)    { return a + (b - a) * t; }

  function normaliseFG(fg)     { return _clamp(fg / 100, 0, 1); }
  function normaliseVol(vol24) { return _clamp(vol24 / 20, 0, 1); }
  function normaliseFees(fees) { return _clamp((fees - 1) / 99, 0, 1); }

  function resolveStateBand(intensity) {
    for (var i = STATE_BANDS.length - 1; i >= 0; i--) {
      if (intensity >= STATE_BANDS[i].lo) return STATE_BANDS[i];
    }
    return STATE_BANDS[0];
  }

  function buildStateText(key, fg) {
    if (key === 'EXTREME') return fg < 50 ? 'BITCOIN IS IN PANIC' : 'BITCOIN IS EUPHORIC';
    var band = null;
    for (var i = 0; i < STATE_BANDS.length; i++) {
      if (STATE_BANDS[i].key === key) { band = STATE_BANDS[i]; break; }
    }
    return 'BITCOIN IS ' + (band ? band.label : key);
  }

  function getStateBand(key) {
    for (var i = 0; i < STATE_BANDS.length; i++) {
      if (STATE_BANDS[i].key === key) return STATE_BANDS[i];
    }
    return STATE_BANDS[0];
  }

  function shouldTransition(memory, candidate, intensity, now) {
    // EXTREME always immediate
    if (candidate.key === 'EXTREME') return true;
    // On first boot (stateSince === 0) always allow
    if (memory.stateSince === 0) return true;

    var held = (now - memory.stateSince) >= STATE_MIN_HOLD_MS;
    // Use the CURRENT STATE's band (not the new intensity's band)
    var currentBand = getStateBand(memory.stateKey);
    var exited = intensity < currentBand.lo - ANTI_FLICKER_BAND ||
                 intensity > currentBand.hi + ANTI_FLICKER_BAND;
    return held && exited;
  }

  function tickMicroVariation(memory, now) {
    if (now >= memory.jitterNextAt) {
      var sign = Math.random() < 0.5 ? 1 : -1;
      memory.jitter      = sign * (1 + Math.random());
      memory.jitterNextAt = now + 1000 + Math.random() * 2000;
    }
    return memory.jitter;
  }

  window.createPulseCalculator = function () {
    return {
      intensity:    0,
      bpm:          BPM_MIN,
      stateKey:     'DEEP_SLEEP',
      stateSince:   0,       // 0 = never set, first transition is always immediate
      jitter:       0,
      jitterNextAt: 0,
    };
  };

  window.updatePulse = function (memory, inputs) {
    var FG    = inputs.FG;
    var VOL24 = inputs.VOL24;
    var FEES  = inputs.FEES;
    var now   = Date.now();

    var fgScore  = normaliseFG(FG);
    var volScore = normaliseVol(VOL24);
    var feeScore = normaliseFees(FEES);
    var rawIntensity = (fgScore + volScore + feeScore) / 3;

    memory.intensity = _lerp(memory.intensity, rawIntensity, INTENSITY_SMOOTH);
    var intensity    = _clamp(memory.intensity, 0, 1);

    var candidate = resolveStateBand(intensity);
    if (candidate.key !== memory.stateKey) {
      if (shouldTransition(memory, candidate, intensity, now)) {
        memory.stateKey   = candidate.key;
        memory.stateSince = now;
      }
    }

    var targetBpm = _clamp(BPM_MIN + intensity * (BPM_MAX - BPM_MIN), BPM_MIN, BPM_MAX);
    memory.bpm    = _lerp(memory.bpm, targetBpm, BPM_SMOOTH);
    var jitter    = tickMicroVariation(memory, now);
    var bpm       = _clamp(memory.bpm + jitter, BPM_MIN, BPM_MAX);

    var glowPx = GLOW_MIN_PX + intensity * (GLOW_MAX_PX - GLOW_MIN_PX);
    var scale  = 1.02 + intensity * 0.10;

    return {
      bpm:        Math.round(bpm * 10) / 10,
      intensity:  Math.round(intensity * 1000) / 1000,
      glowPx:     Math.round(glowPx * 10) / 10,
      scale:      Math.round(scale * 1000) / 1000,
      stateKey:   memory.stateKey,
      stateText:  buildStateText(memory.stateKey, FG),
      components: { fgScore: fgScore, volScore: volScore, feeScore: feeScore },
    };
  };

}());
