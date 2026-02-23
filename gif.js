/*
 * gif.js — Self-contained animated GIF encoder
 * Minimal, no dependencies, MIT-compatible.
 * API matches jnordberg/gif.js for drop-in use.
 */
(function (root) {
  'use strict';

  // ── LZW Encoder ──────────────────────────────────────────────
  function lzwEncode(indices, colorDepth) {
    const minCode   = Math.max(2, colorDepth);
    const clearCode = 1 << minCode;
    const eofCode   = clearCode + 1;

    let codeSize = minCode + 1;
    let maxCode  = eofCode + 1;

    const bytes = [];
    let bitBuf = 0, bits = 0;

    function emitCode(code) {
      bitBuf |= (code << bits);
      bits   += codeSize;
      while (bits >= 8) {
        bytes.push(bitBuf & 0xff);
        bitBuf >>= 8;
        bits   -= 8;
      }
    }

    function flushBits() {
      if (bits > 0) bytes.push(bitBuf & 0xff);
    }

    // Init table
    let table = new Map();
    function resetTable() {
      table.clear();
      for (let i = 0; i < clearCode; i++) table.set(i + '', i);
      codeSize = minCode + 1;
      maxCode  = eofCode + 1;
    }

    resetTable();
    emitCode(clearCode);

    let str = '' + indices[0];
    for (let i = 1; i < indices.length; i++) {
      const c    = '' + indices[i];
      const strC = str + ',' + c;
      if (table.has(strC)) {
        str = strC;
      } else {
        emitCode(table.get(str));
        if (maxCode < 4096) {
          table.set(strC, maxCode++);
          if (maxCode > (1 << codeSize) && codeSize < 12) codeSize++;
        } else {
          emitCode(clearCode);
          resetTable();
        }
        str = c;
      }
    }
    emitCode(table.get(str));
    emitCode(eofCode);
    flushBits();

    // Pack into sub-blocks
    const out = [minCode];
    for (let i = 0; i < bytes.length; ) {
      const len = Math.min(255, bytes.length - i);
      out.push(len);
      for (let j = 0; j < len; j++) out.push(bytes[i++]);
    }
    out.push(0);
    return out;
  }

  // ── Simple median-cut quantiser (fixed 256 palette) ──────────
  function quantise(rgba, nColors) {
    nColors = nColors || 256;

    // Build a frequency map of 24-bit colours (quantised to 5 bits/channel for speed)
    const freq = new Map();
    const n    = rgba.length >> 2;
    for (let i = 0; i < n; i++) {
      const r = rgba[i*4]   >> 3;
      const g = rgba[i*4+1] >> 3;
      const b = rgba[i*4+2] >> 3;
      const k = (r << 10) | (g << 5) | b;
      freq.set(k, (freq.get(k) || 0) + 1);
    }

    // Collect unique colours, sorted by freq desc
    let colours = [];
    freq.forEach((cnt, k) => {
      colours.push({
        r: ((k >> 10) & 31) << 3,
        g: ((k >>  5) & 31) << 3,
        b: ( k        & 31) << 3,
        cnt,
      });
    });
    colours.sort((a, b) => b.cnt - a.cnt);

    // Take top nColors
    const palette = colours.slice(0, nColors);

    // Pad palette to exactly 256 entries
    while (palette.length < 256) palette.push({ r:0, g:0, b:0, cnt:0 });

    // Build flat Uint8Array palette
    const pal = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      pal[i*3]   = palette[i].r;
      pal[i*3+1] = palette[i].g;
      pal[i*3+2] = palette[i].b;
    }

    // Map each pixel to nearest palette entry (fast: prebuilt lookup)
    const indices = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const pr = rgba[i*4], pg = rgba[i*4+1], pb = rgba[i*4+2];
      let best = 0, bestD = Infinity;
      // Only search through filled entries (up to nColors)
      const lim = Math.min(nColors, colours.length);
      for (let j = 0; j < lim; j++) {
        const dr = pr - pal[j*3], dg = pg - pal[j*3+1], db = pb - pal[j*3+2];
        const d  = dr*dr + dg*dg + db*db;
        if (d < bestD) { bestD = d; best = j; if (d === 0) break; }
      }
      indices[i] = best;
    }

    return { palette: pal, indices };
  }

  // ── GIF byte builder ─────────────────────────────────────────
  function buildGIF(frames, width, height) {
    const out = [];
    const b   = v  => out.push(v & 0xff);
    const b2  = v  => { b(v); b(v >> 8); };
    const str = s  => { for (let i = 0; i < s.length; i++) b(s.charCodeAt(i)); };

    // Header
    str('GIF89a');
    b2(width); b2(height);
    b(0xf7);   // GCT flag=1, colorRes=7, sort=0, GCT size=7 → 256 colours
    b(0);      // bg colour index
    b(0);      // pixel aspect ratio

    // Global colour table — use first frame's palette
    const gct = frames[0].palette;
    for (let i = 0; i < 256; i++) out.push(gct[i*3], gct[i*3+1], gct[i*3+2]);

    // Netscape loop extension (loop forever)
    out.push(0x21, 0xff, 0x0b);
    str('NETSCAPE2.0');
    out.push(3, 1, 0, 0, 0); // loop count = 0 = infinite

    for (const frame of frames) {
      // Graphic Control Extension
      out.push(0x21, 0xf9, 4);
      b(0);             // packed: no disposal, no user input, no transparency
      b2(frame.delay);  // delay in 1/100 s
      b(0); b(0);       // transparent colour index + block terminator

      // Image descriptor
      b(0x2c);
      b2(0); b2(0);          // left, top
      b2(width); b2(height); // width, height
      b(0x87);               // local colour table, size=7 (256 colours)

      // Local colour table
      const lct = frame.palette;
      for (let i = 0; i < 256; i++) out.push(lct[i*3], lct[i*3+1], lct[i*3+2]);

      // LZW compressed indices
      const lzw = lzwEncode(frame.indices, 8);
      for (const byte of lzw) b(byte);
    }

    b(0x3b); // GIF trailer
    return new Uint8Array(out);
  }

  // ── Public GIF class ─────────────────────────────────────────
  function GIF(opts) {
    this._opts    = opts || {};
    this._frames  = [];
    this._on      = {};
  }

  GIF.prototype.on = function (ev, fn) { this._on[ev] = fn; return this; };
  GIF.prototype._emit = function (ev, d) { if (this._on[ev]) this._on[ev](d); };

  GIF.prototype.addFrame = function (ctx, opts) {
    opts = opts || {};
    const w = this._opts.width  || ctx.canvas.width;
    const h = this._opts.height || ctx.canvas.height;
    const d = ctx.getImageData(0, 0, w, h).data;
    // delay in centiseconds (GIF unit); opts.delay is in ms
    this._frames.push({ rgba: d, delay: Math.max(2, Math.round((opts.delay || 100) / 10)), w, h });
  };

  GIF.prototype.render = function () {
    const self   = this;
    const total  = this._frames.length;
    const w      = this._opts.width  || this._frames[0].w;
    const h      = this._opts.height || this._frames[0].h;
    const encoded = [];

    function next(i) {
      if (i >= total) {
        self._emit('progress', 1);
        try {
          const bytes = buildGIF(encoded, w, h);
          self._emit('finished', new Blob([bytes], { type: 'image/gif' }));
        } catch (e) {
          self._emit('error', e);
        }
        return;
      }
      // Yield to the browser between frames so progress events fire
      setTimeout(() => {
        try {
          const f = self._frames[i];
          const { palette, indices } = quantise(f.rgba, 256);
          encoded.push({ palette, indices, delay: f.delay });
          self._emit('progress', (i + 1) / total);
          next(i + 1);
        } catch (e) {
          self._emit('error', e);
        }
      }, 0);
    }

    next(0);
  };

  root.GIF = GIF;

})(typeof window !== 'undefined' ? window : this);
