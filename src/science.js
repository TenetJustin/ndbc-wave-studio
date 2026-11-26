export const TAU = 2 * Math.PI;
export const G = 9.80665;
export const SCIENCE_VERSION = '1.0.0';
export const PRESETS = {
  original: { dt: 0.1, segment: 8192, duration: 14400 },
  updated: { dt: 0.5, segment: 512, duration: 14400 },
};
const SOURCE_FIELDS = ['a1', 'a2', 'r1', 'r2'];

function finite(x) { return typeof x === 'number' && Number.isFinite(x); }
function number(x) { return x === '' || x == null ? null : Number(x); }
function direction(fields) {
  const [a1, a2, r1, r2] = fields;
  return fields.every(finite) && a1 >= 0 && a1 <= 360 && a2 >= 0 && a2 <= 360
    && r1 >= 0 && r1 <= 1 && r2 >= 0 && r2 <= 1;
}

export function cleanRows(input) {
  const rows = [];
  let skipped = 0;
  let duplicates = 0;
  const byFrequency = new Map();
  for (const item of input) {
    const f = number(item.f);
    const s = number(item.s);
    if (!finite(f) || f <= 0 || !finite(s) || s < 0) { skipped++; continue; }
    const row = { f, s };
    const df = number(item.df);
    if (finite(df) && df > 0) row.df = df;
    const angles = SOURCE_FIELDS.map(key => number(item[key]));
    if (direction(angles)) SOURCE_FIELDS.forEach((key, index) => { row[key] = angles[index]; });
    if (byFrequency.has(f)) {
      const previous = byFrequency.get(f);
      if (previous.s !== s || previous.df !== row.df || SOURCE_FIELDS.some(key => previous[key] !== row[key])) {
        throw new Error(`频率 ${f} Hz 有冲突的重复记录。请保留该频带的一条记录。`);
      }
      duplicates++;
      continue;
    }
    byFrequency.set(f, row);
    rows.push(row);
  }
  rows.sort((a, b) => a.f - b.f);
  if (rows.length < 3 || !rows.some(row => row.s > 0)) throw new Error('至少需要三个有效频带，且谱能量应大于零。');
  if (rows.length > 1024) throw new Error('单次最多处理 1024 个频带。请选择一个时次的谱，或在源数据中合并频带。');
  return { rows, skipped, duplicates };
}

export function widths(rows) {
  const f = rows.map(row => row.f);
  return f.map((v, i) => rows[i].df ?? (i === 0 ? f[1] - v : i === f.length - 1 ? v - f[i - 1] : (f[i + 1] - f[i - 1]) / 2));
}

export function moments(rows, df = widths(rows)) {
  let m0 = 0, m1 = 0, peak = 0;
  rows.forEach(({ f, s }, i) => {
    m0 += s * df[i]; m1 += f * s * df[i];
    if (s > rows[peak].s) peak = i;
  });
  if (![m0, m1].every(finite) || m0 <= 0 || m1 <= 0) throw new Error('频谱积分有误，请检查频率和能量的单位。');
  return { m0, m1, hm0: 4 * Math.sqrt(m0), tm01: m0 / m1, tp: 1 / rows[peak].f, peak };
}

export function nrmse(observed, model) {
  if (!observed.length || observed.length !== model.length) return null;
  const span = Math.max(...observed) - Math.min(...observed);
  return span > 0 ? Math.sqrt(observed.reduce((sum, v, i) => sum + (v - model[i]) ** 2, 0) / observed.length) / span : null;
}

function fits(rows, df, stat) {
  const fp = 1 / stat.tp;
  const A = 173 * stat.hm0 ** 2 / stat.tm01 ** 4;
  const B = 691 / stat.tm01 ** 4;
  const ittc = rows.map(({ f }) => {
    const w = TAU * f;
    return TAU * A / w ** 5 * Math.exp(-B / w ** 4);
  });
  const shape = rows.map(({ f }) => {
    const sigma = f <= fp ? .07 : .09;
    const ratio = f / fp;
    const log = -5 * Math.log(ratio) - 1.25 * ratio ** -4
      + Math.log(3.3) * Math.exp(-.5 * ((f - fp) / (sigma * fp)) ** 2);
    return Math.exp(log);
  });
  const energy = shape.reduce((sum, x, i) => sum + x * df[i], 0);
  const jonswap = shape.map(x => x * stat.m0 / energy);
  const observed = rows.map(row => row.s);
  return { ittc, jonswap, ittcError: nrmse(observed, ittc), jonswapError: nrmse(observed, jonswap) };
}

export function comingTo(angle) { return ((270 - angle) % 360 + 360) % 360; }
const multiply = ([ar, ai], [br, bi]) => [ar * br - ai * bi, ar * bi + ai * br];
const conjugate = ([r, i]) => [r, -i];
const subtract = ([ar, ai], [br, bi]) => [ar - br, ai - bi];
const polar = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
const meanVector = (v, cos, sin) => v.reduce(([a, b], x, j) => [a + x * cos[j], b + x * sin[j]], [0, 0]);

export function memDensity(row, theta) {
  if (!direction(SOURCE_FIELDS.map(key => row[key]))) return null;
  const c1 = polar(row.r1, comingTo(row.a1) * Math.PI / 180);
  const c2 = polar(row.r2, comingTo(row.a2) * Math.PI / 90);
  const denom = 1 - row.r1 ** 2;
  if (denom < 1e-8) return null;
  const p1 = subtract(c1, multiply(c2, conjugate(c1))).map(x => x / denom);
  const p2 = subtract(c2, multiply(c1, p1));
  const noise = 1 - multiply(p1, conjugate(c1))[0] - multiply(p2, conjugate(c2))[0];
  if (noise <= 1e-8 || Math.hypot(...p2) >= 1) return null;
  const density = theta.map(t => {
    const a = multiply(p1, polar(1, -t));
    const b = multiply(p2, polar(1, -2 * t));
    return noise / Math.max(1e-16, (1 - a[0] - b[0]) ** 2 + (a[1] + b[1]) ** 2);
  });
  const dtheta = TAU / theta.length;
  const scale = dtheta * density.reduce((sum, v) => sum + v, 0);
  return density.map(v => v / scale);
}

function directions(rows, df, stat, useAssumption) {
  const angles = Array.from({ length: 48 }, (_, j) => j * TAU / 48);
  const delta = TAU / angles.length;
  const cos = angles.map(Math.cos);
  const sin = angles.map(Math.sin);
  let x = 0, y = 0, valid = 0, unavailableEnergy = 0, unavailableBins = 0;
  const densities = rows.map((row, i) => {
    if (row.s === 0) return null;
    const curve = memDensity(row, angles);
    const energy = row.s * df[i];
    if (!curve) { unavailableBins++; unavailableEnergy += energy; return null; }
    const [a, b] = meanVector(curve, cos, sin);
    x += a * energy * delta; y += b * energy * delta; valid++;
    return curve;
  });
  if (!valid && !useAssumption) return null;
  const assumed = !valid;
  const mean = assumed ? 0 : Math.atan2(y, x);
  const reference = angles.map(t => Math.max(0, Math.cos(t - mean)) ** 2);
  const total = delta * reference.reduce((sum, v) => sum + v, 0);
  const fixed = reference.map(v => v / total);
  const modeled = rows.map((row, i) => (assumed ? fixed : densities[i] || angles.map(() => 1 / TAU)).map(v => row.s * v));
  return { angles, delta, modeled, fixed: rows.map(row => fixed.map(v => row.s * v)), mean: (mean * 180 / Math.PI + 360) % 360,
    unavailableBins, unavailableShare: Math.min(1, unavailableEnergy / stat.m0), assumed };
}

export function analysis(record, useAssumption = false) {
  const { rows, skipped, duplicates } = cleanRows(record.rows);
  const df = widths(rows);
  const stat = moments(rows, df);
  return { rows, df, stat, fits: fits(rows, df, stat), direction: directions(rows, df, stat, useAssumption), skipped, duplicates };
}

export function phases(result, seed) {
  let state = Number(seed) >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const { angles, delta, modeled } = result.direction;
  return result.rows.map(({ f }, i) => {
    const w = TAU * f;
    const k = w ** 2 / G;
    const values = angles.map((theta, j) => ({
      a: Math.sqrt(2 * modeled[i][j] * result.df[i] * delta),
      kx: k * Math.cos(theta), ky: k * Math.sin(theta), w, phase: TAU * random(),
    }));
    return { w, values: values.filter(mode => mode.a > 0) };
  });
}

export function waveAt(modes, x, y, t) {
  return modes.reduce((sum, m) => sum + m.a * Math.cos(m.kx * x + m.ky * y - m.w * t + m.phase), 0);
}

export function samplePoint(groups, point, dt, count) {
  const samples = new Float64Array(count);
  for (const group of groups) {
    if (!group.values.length) continue;
    let re = 0, im = 0;
    for (const m of group.values) {
      const phase = m.kx * point.x + m.ky * point.y + m.phase;
      re += m.a * Math.cos(phase);
      im += m.a * Math.sin(phase);
    }
    const step = group.w * dt;
    const cos = Math.cos(step), sin = Math.sin(step);
    let c = 1, s = 0;
    for (let i = 0; i < count; i++) {
      if (i % 8192 === 0) { c = Math.cos(step * i); s = Math.sin(step * i); }
      samples[i] += re * c + im * s;
      [c, s] = [c * cos - s * sin, s * cos + c * sin];
    }
  }
  return samples;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let len = 2; len <= n; len *= 2) {
    const step = -TAU / len;
    const cos = Math.cos(step), sin = Math.sin(step);
    for (let left = 0; left < n; left += len) {
      let c = 1, s = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = left + j, b = a + len / 2;
        const r = re[b] * c - im[b] * s, t = re[b] * s + im[b] * c;
        re[b] = re[a] - r; im[b] = im[a] - t; re[a] += r; im[a] += t;
        [c, s] = [c * cos - s * sin, s * cos + c * sin];
      }
    }
  }
}

export function welch(samples, dt, segment) {
  const frequency = Array.from({ length: segment / 2 + 1 }, (_, i) => i / (dt * segment));
  const window = Float64Array.from({ length: segment }, (_, i) => .5 - .5 * Math.cos(TAU * i / (segment - 1)));
  const norm = window.reduce((sum, v) => sum + v ** 2, 0) / dt;
  const power = new Float64Array(frequency.length);
  const re = new Float64Array(segment), im = new Float64Array(segment);
  const step = segment / 2;
  let segments = 0;
  for (let start = 0; start + segment <= samples.length; start += step) {
    let mean = 0;
    for (let i = 0; i < segment; i++) mean += samples[start + i] / segment;
    for (let i = 0; i < segment; i++) { re[i] = (samples[start + i] - mean) * window[i]; im[i] = 0; }
    fft(re, im);
    for (let i = 0; i < power.length; i++) power[i] += (re[i] ** 2 + im[i] ** 2) * (i === 0 || i === segment / 2 ? 1 : 2) / norm;
    segments++;
  }
  return { frequency, power: Array.from(power, value => value / segments), segments, interval: 1 / (dt * segment) };
}

function crossingHeights(series) {
  const mean = series.reduce((s, v) => s + v, 0) / series.length;
  let active = false, low = 0, high = 0;
  const heights = [];
  for (let i = 1; i < series.length; i++) {
    const x = series[i] - mean, previous = series[i - 1] - mean;
    if (previous < 0 && x >= 0) {
      if (active) heights.push(high - low);
      active = true; low = 0; high = x;
    } else if (active) { low = Math.min(x, low); high = Math.max(x, high); }
  }
  const variance = series.reduce((sum, v) => sum + (v - mean) ** 2, 0) / series.length;
  const sorted = heights.sort((a, b) => a - b);
  const top = sorted.slice(sorted.length - Math.floor(sorted.length / 3));
  let ks = 0;
  const cdf = sorted.map((h, i) => {
    const theory = 1 - Math.exp(-h * h / (8 * variance));
    const empirical = (i + 1) / sorted.length;
    ks = Math.max(ks, Math.abs(theory - empirical), Math.abs(theory - i / sorted.length));
    return [h, empirical, theory];
  });
  return { waveCount: sorted.length, h13: top.length ? top.reduce((sum, v) => sum + v, 0) / top.length : null,
    ks: sorted.length && variance > 0 ? ks : null, critical: sorted.length ? 1.36 / Math.sqrt(sorted.length) : null, cdf, variance };
}

export function validateSettings({ dt, segment, duration }, maxFrequency) {
  if (!finite(dt) || dt < .02 || dt > 5 || .5 / dt <= maxFrequency) {
    throw new Error(`采样步长需满足最高频率 ${maxFrequency.toFixed(4)} Hz 的奈奎斯特条件。请调小 Δt。`);
  }
  if (!Number.isInteger(segment) || segment < 64 || segment > 16384 || (segment & (segment - 1))) {
    throw new Error('Welch 分段点数请选择 64–16,384 之间的 2 的整数次幂。');
  }
  if (!finite(duration) || duration < 60 || duration > 14400) throw new Error('模拟时长应在 60–14,400 秒以内。');
  const n = Math.floor(duration / dt);
  if (n < segment || n > 800000) throw new Error('采样点数应不少于一个分段，且不超过 800,000 点。');
  return n;
}

export function validateSimulation(rows, groups, point, params) {
  const { dt, segment } = params;
  const maxFrequency = Math.max(...rows.filter(row => row.s > 0).map(row => row.f));
  const count = validateSettings(params, maxFrequency);
  const samples = samplePoint(groups, point, dt, count);
  const spectral = welch(samples, dt, segment);
  const estimate = rows.map(({ f }) => {
    const t = f / spectral.interval;
    if (t > spectral.power.length - 1) return null;
    const i = Math.floor(t), p = t - i;
    return spectral.power[i] * (1 - p) + (spectral.power[i + 1] ?? spectral.power[i]) * p;
  });
  const valid = rows.map((row, i) => [row.s, estimate[i]]).filter(([, s]) => s !== null);
  return { ...crossingHeights(samples), spectral, estimate, error: nrmse(valid.map(v => v[0]), valid.map(v => v[1])),
    params, samples: Array.from(samples.slice(0, Math.min(samples.length, Math.floor(180 / dt) + 1))) };
}
