// Minimal dependency-free control panel helpers shared by the 2D and 3D apps.

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

export class Panel {
  constructor(root) { this.root = root; this.cur = root; this.controls = {}; }

  section(title, { open = true, collapsible = false } = {}) {
    if (collapsible) {
      const d = el('details', { class: 'sec', open });
      d.append(el('summary', { text: title }));
      const body = el('div', { class: 'sec-body' });
      d.append(body);
      this.root.append(d);
      this.cur = body;
    } else {
      const s = el('section', { class: 'sec' }, el('h2', { text: title }));
      const body = el('div', { class: 'sec-body' });
      s.append(body);
      this.root.append(s);
      this.cur = body;
    }
    return this.cur;
  }

  note(text, cls = 'note') { const n = el('p', { class: cls, text }); this.cur.append(n); return n; }

  select(id, label, options, value, onChange) {
    const s = el('select', { id: 'c-' + id });
    for (const [v, t] of options) s.append(el('option', { value: v, text: t, selected: String(v) === String(value) }));
    s.addEventListener('change', () => onChange(s.value));
    this.cur.append(el('label', { class: 'row' }, el('span', { text: label }), s));
    this.controls[id] = s;
    return s;
  }

  slider(id, label, { min, max, step, value, fmt = (v) => String(v) }, onChange) {
    const out = el('output', { text: fmt(value) });
    const r = el('input', { type: 'range', min, max, step, value, id: 'c-' + id });
    r.addEventListener('input', () => { const v = Number(r.value); out.textContent = fmt(v); onChange(v); });
    this.cur.append(el('label', { class: 'row slider' }, el('span', { text: label }), r, out));
    this.controls[id] = r;
    return r;
  }

  checkbox(id, label, value, onChange, hint) {
    const c = el('input', { type: 'checkbox', id: 'c-' + id, checked: value });
    c.addEventListener('change', () => onChange(c.checked));
    this.cur.append(el('label', { class: 'row check', title: hint || null }, c, el('span', { text: label })));
    this.controls[id] = c;
    return c;
  }

  buttons(items) {
    const row = el('div', { class: 'btns' });
    for (const it of items) {
      const b = el('button', { type: 'button', text: it.label, title: it.title || null, id: it.id ? 'c-' + it.id : null, class: it.primary ? 'primary' : '' });
      b.addEventListener('click', () => it.onClick(b));
      row.append(b);
      if (it.id) this.controls[it.id] = b;
    }
    this.cur.append(row);
    return row;
  }

  /** Exclusive choice rendered as a segmented control. */
  segmented(id, items, value, onChange) {
    const row = el('div', { class: 'seg', role: 'radiogroup' });
    const set = (v) => {
      for (const b of row.children) b.setAttribute('aria-checked', String(b.dataset.v === v));
    };
    for (const [v, label, title] of items) {
      const b = el('button', { type: 'button', role: 'radio', text: label, title: title || null });
      b.dataset.v = v;
      b.addEventListener('click', () => { set(v); onChange(v); });
      row.append(b);
    }
    set(value);
    this.cur.append(row);
    this.controls[id] = { set };
    return row;
  }

  stats(items) {
    const dl = el('dl', { class: 'stats' });
    const out = {};
    for (const [key, label, title] of items) {
      const dd = el('dd', { text: '–' });
      dl.append(el('dt', { text: label, title: title || null }), dd);
      out[key] = dd;
    }
    this.cur.append(dl);
    return out;
  }
}

/** Rolling line plot of mass and iso-contour volume relative to their initial values (cf. Fig. 10). */
export class ConservationPlot {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = [];
    this.span = 12;   // seconds shown
  }
  clear() { this.data = []; this.draw(); }
  push(t, mass, volume) {
    this.data.push([t, mass, volume]);
    while (this.data.length && this.data[0][0] < t - this.span) this.data.shift();
    this.draw();
  }
  draw() {
    const { canvas, ctx } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const lo = 0, hi = 1.3;
    const Y = (v) => h - 4 - ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * (h - 8);
    ctx.lineWidth = 1;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    for (const v of [0.5, 1.0]) {
      ctx.strokeStyle = v === 1 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.10)';
      ctx.beginPath(); ctx.moveTo(0, Y(v) + 0.5); ctx.lineTo(w, Y(v) + 0.5); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(`${v * 100}%`, 3, Y(v) - 3);
    }
    if (this.data.length < 2) return;
    const t1 = this.data[this.data.length - 1][0];
    const t0 = Math.max(this.data[0][0], t1 - this.span);
    const X = (t) => ((t - t0) / Math.max(t1 - t0, this.span * 0.25)) * w;
    const line = (idx, color, width) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round';
      ctx.beginPath();
      this.data.forEach((d, i) => { const x = X(d[0]), y = Y(d[idx]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
    };
    line(2, '#39c5cf', 1.6);
    line(1, '#f2b84b', 1.6);
  }
}
