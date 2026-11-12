// Thin WebGL2 helper layer: programs with reflected uniforms, float textures,
// cached framebuffers, fullscreen passes, point-scatter passes and async readback.

const FORMATS = {
  r16f: { internal: 'R16F', format: 'RED', channels: 1, half: true },   // filters linearly without an extension
  r32f: { internal: 'R32F', format: 'RED', channels: 1 },
  rg32f: { internal: 'RG32F', format: 'RG', channels: 2 },
  rgba32f: { internal: 'RGBA32F', format: 'RGBA', channels: 4 },
};

const VS_FULLSCREEN = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Vertex shader of a pass that only covers some tiles of its target: one instanced quad per
// tile, the tile's index in aSlot (see GLContext.drawTiles).
export const VS_TILES = `#version 300 es
layout(location = 0) in float aSlot;
uniform vec2 uTileSize;     // texels
uniform int uTilesPerRow;
uniform vec2 uTargetInv;    // 1 / target size
void main() {
  int s = int(aSlot);
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 p = (vec2(float(s % uTilesPerRow), float(s / uTilesPerRow)) + corner) * uTileSize * uTargetInv;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export class GLContext {
  constructor(canvas, opts = {}) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      premultipliedAlpha: false, powerPreference: 'high-performance',
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('EXT_color_buffer_float is required (rendering to float textures).');
    }
    this.floatBlend = !!gl.getExtension('EXT_float_blend');
    if (!this.floatBlend) throw new Error('EXT_float_blend is required (additive scatter into float textures).');
    this.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');

    // points per draw call in scatter passes (a multiple of every stencil size, below every
    // browser's per-draw limit)
    this.maxPointsPerDraw = opts.maxPointsPerDraw || 1 << 24;

    this._fboCache = new Map();
    this._texId = 0;
    this.passCount = 0;
    this._emptyVao = gl.createVertexArray();
    gl.bindVertexArray(this._emptyVao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.readback = this._testReadback();
  }

  /**
   * Reads a known float texture back and reports what arrived: 'exact', 'noisy' or 'scrambled'.
   * Browsers with fingerprinting protection alter canvas data on its way to the page. LibreWolf
   * always flips the last bits of some values (a few units in the last place: harmless here);
   * with privacy.resistFingerprinting on, Firefox and LibreWolf return random numbers instead,
   * and nothing that depends on read-back (statistics, forces on bodies, picking) can work.
   */
  _testReadback() {
    const n = 16;
    const src = new Float32Array(n * n * 4);
    for (let i = 0; i < src.length; i++) src[i] = 1 + ((i * 7919) % 1024) / 8;
    const t = this.texture(n, n, 'rgba32f', { data: src });
    const out = this.read(t);
    this.deleteTexture(t);
    let worst = 0;
    for (let i = 0; i < src.length; i++) {
      const d = Math.abs(out[i] - src[i]) / src[i];
      if (!(d <= worst)) worst = d;   // also catches NaN
    }
    return worst === 0 ? 'exact' : worst < 1e-5 ? 'noisy' : 'scrambled';
  }

  // ---- programs -----------------------------------------------------------
  _compile(type, src, label) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
      throw new Error(`Shader compile error in "${label}":\n${log}\n${numbered}`);
    }
    return sh;
  }

  /** Create a program. `vs` may be null to use the fullscreen-triangle vertex shader. */
  program(label, fs, vs = null) {
    const gl = this.gl;
    const prog = gl.createProgram();
    const v = this._compile(gl.VERTEX_SHADER, vs || VS_FULLSCREEN, label + ' (vertex)');
    const f = this._compile(gl.FRAGMENT_SHADER, fs, label + ' (fragment)');
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Program link error in "${label}": ${gl.getProgramInfoLog(prog)}`);
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    const uniforms = new Map();
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      const name = info.name.replace(/\[0\]$/, '');
      uniforms.set(name, { loc: gl.getUniformLocation(prog, info.name), type: info.type, size: info.size });
    }
    return { label, prog, uniforms };
  }

  _setUniforms(p, values) {
    const gl = this.gl;
    let unit = 0;
    for (const [name, u] of p.uniforms) {
      let v = values[name];
      if (v === undefined) {
        // struct field "G.n" -> values.G.n
        const dot = name.indexOf('.');
        if (dot > 0) {
          const base = values[name.slice(0, dot)];
          if (base !== undefined) v = base[name.slice(dot + 1)];
        }
      }
      if (v === undefined) throw new Error(`Program "${p.label}": uniform "${name}" not provided`);
      switch (u.type) {
        case gl.FLOAT: if (u.size > 1) gl.uniform1fv(u.loc, v); else gl.uniform1f(u.loc, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
        case gl.INT: case gl.BOOL: if (u.size > 1) gl.uniform1iv(u.loc, v); else gl.uniform1i(u.loc, v); break;
        case gl.INT_VEC2: gl.uniform2iv(u.loc, v); break;
        case gl.INT_VEC3: gl.uniform3iv(u.loc, v); break;
        case gl.INT_VEC4: gl.uniform4iv(u.loc, v); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, v); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, v); break;
        case gl.SAMPLER_2D:
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, v.tex);
          gl.uniform1i(u.loc, unit);
          unit++;
          break;
        default: throw new Error(`Program "${p.label}": unsupported uniform type for "${name}"`);
      }
    }
  }

  // ---- textures & framebuffers --------------------------------------------
  texture(w, h, fmt = 'rgba32f', { linear = false, data = null } = {}) {
    const gl = this.gl;
    const F = FORMATS[fmt];
    if (!F) throw new Error('unknown texture format ' + fmt);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl[F.internal], w, h, 0, gl[F.format], gl.FLOAT, data);
    const filt = linear && (this.floatLinear || F.half) ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, w, h, fmt, channels: F.channels, id: ++this._texId };
  }

  deleteTexture(t) {
    if (!t) return;
    for (const [key, fbo] of this._fboCache) {
      if (key.split(',').includes(String(t.id))) { this.gl.deleteFramebuffer(fbo); this._fboCache.delete(key); }
    }
    this.gl.deleteTexture(t.tex);
  }

  _fbo(targets) {
    const gl = this.gl;
    const key = targets.map((t) => t.id).join(',');
    let fbo = this._fboCache.get(key);
    if (!fbo) {
      fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      targets.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t.tex, 0));
      gl.drawBuffers(targets.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete: 0x' + status.toString(16));
      this._fboCache.set(key, fbo);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    }
    return fbo;
  }

  _bindTarget(target) {
    const gl = this.gl;
    if (target === null) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    } else {
      const targets = Array.isArray(target) ? target : [target];
      this._fbo(targets);
      gl.viewport(0, 0, targets[0].w, targets[0].h);
    }
  }

  // ---- passes -------------------------------------------------------------
  /** Fullscreen fragment pass into `target` (texture, array of textures for MRT, or null for canvas). */
  draw(p, target, uniforms, opts = {}) {
    const gl = this.gl;
    this._bindTarget(target);
    gl.useProgram(p.prog);
    this._setUniforms(p, uniforms);
    if (opts.blend) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); } else gl.disable(gl.BLEND);
    if (opts.viewport) gl.viewport(...opts.viewport);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.passCount++;
  }

  /** A list of tile indices for drawTiles(). `set(indices)` replaces its contents. */
  tileList() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.bindVertexArray(this._emptyVao);
    const list = {
      vao, buf, count: 0,
      set: (indices) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, indices instanceof Float32Array ? indices : new Float32Array(indices), gl.DYNAMIC_DRAW);
        list.count = indices.length;
      },
      dispose: () => { gl.deleteBuffer(buf); gl.deleteVertexArray(vao); },
    };
    return list;
  }

  /**
   * Fragment pass over the tiles in `list` only (program built with VS_TILES); the rest of the
   * target keeps its contents. `tile` = { size: [w, h] texels, perRow }.
   */
  drawTiles(p, target, uniforms, list, tile) {
    const gl = this.gl;
    if (!list.count) return;
    this._bindTarget(target);
    const t0 = Array.isArray(target) ? target[0] : target;
    gl.useProgram(p.prog);
    this._setUniforms(p, { ...uniforms, uTileSize: tile.size, uTilesPerRow: tile.perRow, uTargetInv: [1 / t0.w, 1 / t0.h] });
    gl.disable(gl.BLEND);
    gl.bindVertexArray(list.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, list.count);
    gl.bindVertexArray(this._emptyVao);
    this.passCount++;
  }

  /**
   * Additive point-scatter pass: `count` attribute-less points. The vertex shader takes the
   * point's index from `gl_VertexID + uBase`: browsers cap the number of vertices in one draw
   * call (Firefox at 30 million, and a larger draw is dropped with nothing but a console
   * warning), so a large pass is drawn in pieces. `ranges` ([[first, count], ...]) draws those
   * points instead of all `count`.
   */
  scatter(p, target, uniforms, count, { clear = false, ranges = null } = {}) {
    const gl = this.gl;
    this._bindTarget(target);
    if (clear) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.useProgram(p.prog);
    this._setUniforms(p, { ...uniforms, uBase: 0 });
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    const base = p.uniforms.get('uBase');
    if (!base) throw new Error(`Program "${p.label}": a scatter pass needs "uniform int uBase"`);
    for (const [start, n] of ranges || [[0, count]]) {
      for (let first = 0; first < n; first += this.maxPointsPerDraw) {
        if (start + first > 0) gl.uniform1i(base.loc, start + first);
        gl.drawArrays(gl.POINTS, 0, Math.min(this.maxPointsPerDraw, n - first));
      }
    }
    gl.disable(gl.BLEND);
    this.passCount++;
  }

  /**
   * Throws if the context has recorded an error. WebGL drops a call it rejects and carries on,
   * so a pass that the browser refuses would otherwise only show up as wrong physics. This is
   * a synchronous round trip to the GPU process: call it once per set-up, not per frame.
   */
  checkErrors(where) {
    const gl = this.gl;
    const names = [];
    for (let e = gl.getError(); e !== gl.NO_ERROR && names.length < 8; e = gl.getError()) {
      if (e === gl.CONTEXT_LOST_WEBGL) { names.push('CONTEXT_LOST_WEBGL'); break; }
      names.push(['INVALID_ENUM', 'INVALID_VALUE', 'INVALID_OPERATION', 'INVALID_FRAMEBUFFER_OPERATION', 'OUT_OF_MEMORY']
        .find((n) => gl[n] === e) || '0x' + e.toString(16));
    }
    if (names.length) throw new Error(`WebGL reported ${[...new Set(names)].join(', ')} during ${where}; the browser console has the details.`);
  }

  clear(target, r = 0, g = 0, b = 0, a = 0) {
    const gl = this.gl;
    this._bindTarget(target);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Clear a rectangle of `target` (all of its attachments) to one value. */
  clearRect(target, x, y, w, h, r = 0, g = 0, b = 0, a = 0) {
    const gl = this.gl;
    this._bindTarget(target);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, w, h);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }

  /** Replace a rectangle of a texture with `data` (Float32Array, `channels` values per texel). */
  upload(t, data, x = 0, y = 0, w = t.w, h = t.h) {
    const gl = this.gl;
    const F = FORMATS[t.fmt];
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl[F.format], gl.FLOAT, data);
  }

  // ---- readback -----------------------------------------------------------
  /** Synchronous readback of a float texture (use sparingly). Returns Float32Array with `channels` per texel. */
  read(t, x = 0, y = 0, w = t.w, h = t.h) {
    const gl = this.gl;
    this._fbo([t]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    // RGBA/FLOAT is always a valid read format for float color buffers.
    const out = new Float32Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, out);
    if (t.channels === 4) return out;
    const packed = new Float32Array(w * h * t.channels);
    for (let i = 0, n = w * h; i < n; i++) for (let c = 0; c < t.channels; c++) packed[i * t.channels + c] = out[i * 4 + c];
    return packed;
  }

  /** Asynchronous readback through a pixel-pack buffer + fence. Resolves to RGBA Float32Array. */
  readAsync(t) {
    const gl = this.gl;
    this._fbo([t]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const buf = gl.createBuffer();
    const bytes = t.w * t.h * 16;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return new Promise((resolve, reject) => {
      const poll = () => {
        const st = gl.clientWaitSync(sync, 0, 0);
        if (st === gl.WAIT_FAILED) { gl.deleteSync(sync); gl.deleteBuffer(buf); reject(new Error('readAsync: wait failed')); return; }
        if (st === gl.TIMEOUT_EXPIRED) { setTimeout(poll, 1); return; }
        gl.deleteSync(sync);
        const out = new Float32Array(t.w * t.h * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteBuffer(buf);
        resolve(out);
      };
      poll();
    });
  }

  /** Block until the GPU has finished all submitted work (for timing). */
  finish() { this.gl.finish(); }

  /**
   * Measure the GPU time of fn() with a timer query when the extension is available.
   * Returns a promise for milliseconds (or null if it cannot be measured this time).
   */
  timeGpu(fn) {
    const gl = this.gl;
    const ext = this.timerExt;
    if (!ext || this._timing) { fn(); return Promise.resolve(null); }
    this._timing = true;
    const query = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    try { fn(); } finally { gl.endQuery(ext.TIME_ELAPSED_EXT); }
    return new Promise((resolve) => {
      let tries = 0;
      const poll = () => {
        const ready = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
        if (ready || disjoint || ++tries > 600) {
          const ns = ready && !disjoint ? gl.getQueryParameter(query, gl.QUERY_RESULT) : null;
          gl.deleteQuery(query);
          this._timing = false;
          resolve(ns === null ? null : ns / 1e6);
        } else {
          requestAnimationFrame(poll);
        }
      };
      requestAnimationFrame(poll);
    });
  }
}
