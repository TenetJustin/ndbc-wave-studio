import { cleanRows, PRESETS, SCIENCE_VERSION, widths } from './science.js';

function splitCsv(line) {
  const cells = [];
  let cell = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { cells.push(cell.trim()); cell = ''; }
    else cell += c;
  }
  if (quoted) throw new Error('CSV 有未闭合的引号。请按模板整理后重试。');
  cells.push(cell.trim());
  return cells;
}

function csvRecord(file) {
  const lines = file.text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  const header = splitCsv(lines.shift() || '').map(v => v.toLowerCase());
  if (!header.includes('frequency_hz') || !header.includes('spectrum_m2_per_hz')) {
    throw new Error('CSV 需要 frequency_hz 与 spectrum_m2_per_hz 两列。可下载示例查看格式。');
  }
  const rows = lines.map(line => {
    const data = splitCsv(line);
    const get = key => data[header.indexOf(key)] || null;
    const scaled = key => {
      if (get(key) != null) return get(key);
      const v = get(`${key}_scaled_100`);
      return v == null ? null : Number(v) / 100;
    };
    return { f: get('frequency_hz'), s: get('spectrum_m2_per_hz'), df: get('bandwidth_hz'), a1: get('alpha1_deg'), a2: get('alpha2_deg'), r1: scaled('r1'), r2: scaled('r2') };
  });
  return { id: 'imported', name: file.name.replace(/\.csv$/i, ''), time: file.time || '', origin: '导入 CSV', rows };
}

function parseNdbc(file) {
  const name = file.name.match(/^(\w{5})([wdijk])(\d{4})\.txt(?:\.gz)?$/i);
  if (!name) throw new Error('NDBC 文件名应保留站号、类型和年份，例如 41046w2025.txt。');
  const lines = file.text.split(/\r?\n/).map(text => text.trim()).filter(Boolean);
  const header = (lines.shift() || '').split(/\s+/);
  const separation = /^sep[_-]?freq$/i.test(header[5] || '');
  const frequencies = header.slice(separation ? 6 : 5).map(Number);
  if (!header[0]?.startsWith('#') || frequencies.length < 3 || frequencies.some(f => !Number.isFinite(f) || f <= 0)) {
    throw new Error(`无法识别 ${file.name} 的频带表头。`);
  }
  const entries = new Map();
  for (const line of lines) {
    const fields = line.split(/\s+/);
    const [yy, mm, dd, hh, min] = fields.slice(0, 5).map(Number);
    const year = yy < 100 && yy >= 0 ? Math.floor(Number(name[3]) / 100) * 100 + yy : yy;
    const date = new Date(Date.UTC(year, mm - 1, dd, hh, min));
    if (!Number.isFinite(+date) || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== mm
      || date.getUTCDate() !== dd || date.getUTCHours() !== hh || date.getUTCMinutes() !== min) continue;
    const stamp = date.toISOString();
    const values = fields.slice(separation ? 6 : 5).map(Number);
    if (entries.has(stamp)) {
      if (values.join(',') !== entries.get(stamp).join(',')) throw new Error(`${file.name} 的 ${stamp} 有冲突的重复时次。`);
      continue;
    }
    entries.set(stamp, values);
  }
  return { station: name[1], kind: name[2].toLowerCase(), year: name[3], frequencies, entries };
}

function archiveRecord(files, requestedTime) {
  const archive = new Map();
  for (const file of files.map(parseNdbc)) {
    if (archive.has(file.kind)) throw new Error('同一类型有多份 NDBC 文件。请每次导入一个站点、一个年份的文件。');
    archive.set(file.kind, file);
  }
  const main = archive.get('w');
  if (!main) throw new Error('请同时加入提供一维实测谱的 w 文件，方向文件会自动对齐。');
  if ([...archive.values()].some(file => file.station !== main.station || file.year !== main.year)) throw new Error('NDBC 文件的站号或年份不一致。请保留同站同年的文件。');
  const times = [...main.entries.keys()].sort().filter(time => main.entries.get(time).some(s => s > 0 && s < 999));
  if (!times.length) throw new Error('NDBC 谱文件没有可用的带能量观测。');
  if (requestedTime && !times.includes(requestedTime)) throw new Error('请求观测时次不在所导入的频谱中。');
  const time = requestedTime || times.at(-1);
  const axis = main.frequencies.filter(f => f !== 0.02).map(f => ({ f })).sort((a, b) => a.f - b.f);
  const bands = new Map(widths(axis).map((df, i) => [axis[i].f, df]));
  let missingBins = 0;
  const rows = main.frequencies.map((f, i) => {
    const s = main.entries.get(time)[i];
    if (f === 0.02) return null;
    if (!Number.isFinite(s) || s < 0 || s >= 999) { missingBins++; return null; }
    const row = { f, s, df: bands.get(f) };
    for (const [kind, key, factor] of [['d', 'a1', 1], ['i', 'a2', 1], ['j', 'r1', 100], ['k', 'r2', 100]]) {
      const file = archive.get(kind);
      const j = file?.frequencies.findIndex(value => Math.abs(value - f) < 1e-7) ?? -1;
      const value = file?.entries.get(time)?.[j];
      if (Number.isFinite(value) && value >= 0 && value < 999) row[key] = value / factor;
    }
    return row;
  }).filter(Boolean);
  return { id: 'imported', name: `NDBC ${main.station}`, time, origin: '导入 NDBC 历史档案', rows, archiveTimes: times, missingBins,
    summary: `在 ${times.length.toLocaleString('zh-CN')} 个有效时次中选择${requestedTime ? '指定时次' : '最新时次'}。排除 0.020 Hz 与缺测值，保留原网格带宽。` };
}

export function parseFiles(files, requestedTime) {
  if (!files.length) throw new Error('请选择要导入的文件。');
  if (files.length === 1 && /\.json$/i.test(files[0].name)) {
    let obj;
    try { obj = JSON.parse(files[0].text); } catch { throw new Error('JSON 文件无法读取。请使用工作台导出的实验记录。'); }
    if (obj.schema !== 'ndbc-wave-studio/1' || !Array.isArray(obj.record?.rows)) throw new Error('JSON 格式不符合工作台实验记录。');
    const cleaned = cleanRows(obj.record.rows);
    const record = { id: 'imported', rows: cleaned.rows, name: String(obj.record.name || '恢复的实验').slice(0, 100),
      time: String(obj.record.time || '').slice(0, 40), origin: String(obj.record.origin || '导入实验记录').slice(0, 120), skipped: cleaned.skipped, duplicates: cleaned.duplicates };
    const prefs = obj.preferences || {};
    const seed = Number(prefs.seed);
    const x = Number(prefs.point?.x), y = Number(prefs.point?.y);
    const params = Object.fromEntries(Object.entries(PRESETS.original).map(([key, value]) => [key, Number(prefs.custom?.[key]) || value]));
    return { record, prefs: { seed: Number.isInteger(seed) && seed >= 0 && seed <= 4294967295 ? seed : 41046,
      point: { x: Number.isFinite(x) ? Math.max(-160, Math.min(160, x)) : 0, y: Number.isFinite(y) ? Math.max(-160, Math.min(160, y)) : 0 },
      assume: prefs.assume === true, scenario: ['original', 'updated', 'both', 'custom'].includes(prefs.scenario) ? prefs.scenario : 'original', custom: params }, version: obj.algorithm };
  }
  const isCsv = files.some(file => /\.csv$/i.test(file.name));
  if (isCsv && files.length !== 1) throw new Error('每次导入一份 CSV，或一组同站同年的 NDBC 文件。');
  const record = isCsv ? csvRecord(files[0]) : archiveRecord(files, requestedTime);
  const cleaned = cleanRows(record.rows);
  return { record: { ...record, rows: cleaned.rows, skipped: cleaned.skipped, duplicates: cleaned.duplicates } };
}

export function experiment(record, preferences) {
  const { archiveTimes, ...fields } = record;
  return { schema: 'ndbc-wave-studio/1', algorithm: SCIENCE_VERSION, record: fields, preferences, units: { frequency: 'Hz', density: 'm²/Hz', direction: 'NDBC 来向，度', r: '无量纲 0–1', point: 'm；x 东、y 北' } };
}
