const layouts = new WeakMap();
const heatmaps = new WeakMap();
const styles = () => {
  const css = getComputedStyle(document.documentElement);
  return Object.fromEntries(['muted', 'grid', 'accent', 'text', 'surface', 'surface-deep', 'chart-observed', 'chart-ittc', 'chart-jonswap'].map(name => [name, css.getPropertyValue(`--${name}`).trim()]));
};

function setup(canvas) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
  if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '12px system-ui, sans-serif';
  return { ctx, w, h, colors: styles() };
}

function plotFrame(ctx, w, h, colors, xLabel, yLabel, xFmt, yFmt, xMin, xMax, yMin, yMax) {
  const left = w < 420 ? 49 : 76;
  const right = w - 22;
  const top = 26;
  const bottom = h - 38;
  const x = v => left + (right - left) * (v - xMin) / (xMax - xMin);
  const y = v => bottom - (bottom - top) * (v - yMin) / (yMax - yMin);
  ctx.strokeStyle = colors.grid; ctx.fillStyle = colors.muted; ctx.lineWidth = 1;
  ctx.textBaseline = 'middle';
  const divisions = w < 420 ? 4 : 6;
  for (let i = 0; i <= divisions; i++) {
    const v = xMin + (xMax - xMin) * i / divisions;
    const p = x(v);
    ctx.beginPath(); ctx.moveTo(p, top); ctx.lineTo(p, bottom); ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillText(xFmt(v), p, bottom + 14);
  }
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (yMax - yMin) * i / 4;
    const p = y(v);
    ctx.beginPath(); ctx.moveTo(left, p); ctx.lineTo(right, p); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(yFmt(v), left - 8, p);
  }
  ctx.textAlign = 'left'; ctx.fillText(yLabel || '', left, 11);
  ctx.textAlign = 'right'; ctx.fillText(xLabel || '', right, h - 7);
  return { left, right, top, bottom, x, y, xMin, xMax, yMin, yMax };
}

function axisValue(v) {
  const x = Math.abs(v);
  if (x >= 1000 || (x > 0 && x < 0.01)) return v.toExponential(1);
  return Number(v.toFixed(x < 10 ? 2 : 0)).toString();
}

export function line(canvas, options) {
  const a = setup(canvas);
  if (!a) return;
  const { ctx, w, h, colors } = a;
  const { series, xLabel = '', yLabel = '', cursor, bounds, yBounds, markers = [], xFormat } = options;
  const primary = series[0]?.x || [];
  if (!primary.length) return;
  const all = series.filter(s => s.visible !== false);
  const xMin = bounds?.[0] ?? primary[0], xMax = bounds?.[1] ?? primary.at(-1);
  if (!(xMax > xMin)) return;
  let yMin = 0, yMax = 0;
  for (const s of all) s.y.forEach((v, i) => {
    if (Number.isFinite(v) && s.x[i] >= xMin && s.x[i] <= xMax) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v); }
  });
  const layout = plotFrame(ctx, w, h, colors, xLabel, yLabel, xFormat || axisValue, axisValue, xMin, xMax,
    yBounds?.[0] ?? yMin * 1.06, yBounds?.[1] ?? (yMax > 0 ? yMax * 1.07 : 1));
  layouts.set(canvas, { ...layout, points: primary });
  const { left, right, top, bottom, x, y } = layout;
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
  for (const s of all) {
    if (!s.x.length) continue;
    const color = colors[s.color] || s.color || colors.accent;
    const path = new Path2D();
    let active = false;
    s.x.forEach((f, i) => {
      if (!Number.isFinite(s.y[i])) { active = false; return; }
      if (active) path.lineTo(x(f), y(s.y[i]));
      else { path.moveTo(x(f), y(s.y[i])); active = true; }
    });
    if (s.area) {
      const area = new Path2D(path);
      area.lineTo(x(s.x.at(-1)), bottom); area.lineTo(x(s.x[0]), bottom); area.closePath();
      const gradient = ctx.createLinearGradient(0, top, 0, bottom);
      gradient.addColorStop(0, `${color}44`); gradient.addColorStop(1, `${color}05`);
      ctx.fillStyle = gradient; ctx.fill(area);
    }
    ctx.lineWidth = s.weight || 2;
    ctx.strokeStyle = color;
    ctx.setLineDash(s.dash || []); ctx.stroke(path); ctx.setLineDash([]);
  }
  for (const m of markers) {
    ctx.fillStyle = m.active ? colors.accent : colors['chart-ittc'];
    ctx.beginPath(); ctx.arc(x(m.x), y(m.y), m.active ? 5 : 4, 0, Math.PI * 2); ctx.fill();
  }
  if (Number.isFinite(cursor) && cursor >= xMin && cursor <= xMax) {
    ctx.strokeStyle = colors.accent; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x(cursor), top); ctx.lineTo(x(cursor), bottom); ctx.stroke(); ctx.setLineDash([]);
    for (const s of all) {
      const i = s.x.indexOf(cursor);
      if (i < 0 || !Number.isFinite(s.y[i])) continue;
      ctx.fillStyle = colors[s.color] || s.color || colors.accent;
      ctx.beginPath(); ctx.arc(x(cursor), y(s.y[i]), 3.8, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

export function hoveredIndex(canvas, clientX, clientY) {
  const p = layouts.get(canvas);
  if (!p) return null;
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left, y = clientY - rect.top;
  if (x < p.left || x > p.right || y < p.top || y > p.bottom) return null;
  const value = p.xMin + (p.xMax - p.xMin) * (x - p.left) / (p.right - p.left);
  return p.points.reduce((best, next, i) => Math.abs(next - value) < Math.abs(p.points[best] - value) ? i : best, 0);
}

const ramp = [[11, 27, 53], [20, 66, 102], [19, 106, 139], [39, 157, 150], [125, 207, 172], [248, 236, 173]];
function intensity(v) {
  const p = Math.max(0, Math.min(1, v)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(p));
  const a = p - i;
  return `rgb(${ramp[i].map((x, j) => Math.round(x * (1 - a) + ramp[i + 1][j] * a)).join(',')})`;
}

export function heat(canvas, frequencies, matrix, selected, maximum) {
  const a = setup(canvas);
  if (!a) return;
  const { ctx, w, h, colors } = a;
  const iMin = frequencies[0], iMax = frequencies.at(-1), bins = matrix[0].length;
  const p = plotFrame(ctx, w, h, colors, 'Hz', '传播去向 °', v => v.toFixed(2), v => v.toFixed(0), iMin, iMax, 0, 360);
  layouts.set(canvas, { ...p, points: frequencies });
  let cached = heatmaps.get(canvas);
  const key = `${canvas.width}x${canvas.height}/${w}x${h}/${maximum}`;
  if (cached?.matrix !== matrix || cached.key !== key) {
    const tile = document.createElement('canvas');
    tile.width = canvas.width; tile.height = canvas.height;
    const ink = tile.getContext('2d'); ink.scale(canvas.width / w, canvas.height / h);
    const span = 360 / bins;
    for (let i = 0; i < frequencies.length; i++) {
      const center = frequencies[i];
      const from = i === 0 ? iMin : (center + frequencies[i - 1]) / 2;
      const to = i === frequencies.length - 1 ? iMax : (center + frequencies[i + 1]) / 2;
      for (let j = 0; j < bins; j++) {
        ink.fillStyle = intensity(maximum > 0 ? matrix[i][j] / maximum : 0);
        const angle = j * span;
        const top = p.y(Math.min(360, angle + span / 2));
        const bottom = p.y(Math.max(0, angle - span / 2));
        ink.fillRect(p.x(from), top, p.x(to) - p.x(from) + .3, bottom - top + .3);
        if (!j) ink.fillRect(p.x(from), p.y(360), p.x(to) - p.x(from) + .3, p.y(360 - span / 2) - p.y(360) + .3);
      }
    }
    cached = { key, matrix, tile }; heatmaps.set(canvas, cached);
  }
  ctx.drawImage(cached.tile, 0, 0, w, h);
  const x = p.x(frequencies[selected]);
  ctx.strokeStyle = '#f6ffee'; ctx.lineWidth = 1.4; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(x, p.top); ctx.lineTo(x, p.bottom); ctx.stroke(); ctx.setLineDash([]);
}

export function stationMap(canvas, map, station) {
  const a = setup(canvas);
  if (!a) return;
  const { ctx, w, h } = a;
  const lonRange = w < 450 ? [-91, -48] : [-98, -45], latRange = [11, 4 + 37];
  const x = lon => (lon - lonRange[0]) * w / (lonRange[1] - lonRange[0]);
  const y = lat => h - (lat - latRange[0]) * h / (latRange[1] - latRange[0]);
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, '#122b38'); gradient.addColorStop(1, '#0c1e2c');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#244653'; ctx.lineWidth = 1;
  for (let lon = -90; lon <= -50; lon += 10) { ctx.beginPath(); ctx.moveTo(x(lon), 0); ctx.lineTo(x(lon), h); ctx.stroke(); }
  for (let lat = 20; lat < 50; lat += 10) { ctx.beginPath(); ctx.moveTo(0, y(lat)); ctx.lineTo(w, y(lat)); ctx.stroke(); }
  for (const feature of (map?.features || [])) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
    ctx.fillStyle = '#365451'; ctx.strokeStyle = '#718982'; ctx.lineWidth = .9;
    for (const polygon of polygons) {
      if (!polygon[0].some(([lon, lat]) => lon >= -130 && lon <= -25 && lat >= -10 && lat <= 65)) continue;
      ctx.beginPath();
      for (const ring of polygon) {
        ring.forEach(([lon, lat], i) => i ? ctx.lineTo(x(lon), y(lat)) : ctx.moveTo(x(lon), y(lat)));
        ctx.closePath();
      }
      ctx.fill('evenodd'); ctx.stroke();
    }
  }
  const px = x(station.longitude), py = y(station.latitude);
  ctx.fillStyle = '#9be8d03d'; ctx.beginPath(); ctx.arc(px, py, 15, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#a2e9d1'; ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
  ctx.font = '700 14px system-ui'; ctx.fillStyle = '#dcfff2'; ctx.textAlign = 'left'; ctx.fillText('41046', px + 13, py + 4);
  ctx.font = '12px system-ui'; ctx.fillStyle = '#a0babc'; ctx.fillText('北大西洋', Math.min(w - 77, px + 45), py - 43);
}
