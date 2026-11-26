import { moments, phases, PRESETS, samplePoint, validateSettings, waveAt } from './science.js';
import { experiment, parseFiles } from './input.js';
import { line, heat, hoveredIndex, stationMap } from './charts.js';

const $ = id => document.getElementById(id);
const base = new URL('../', import.meta.url);
const storage = 'ndbc-wave-studio:last-experiment/1';
const referenceStorage = 'ndbc-wave-studio:reference/1';
const shade = 'ndbc-wave-studio:theme';
const initialPrefs = () => ({ seed: 41046, point: { x: 0, y: 0 }, assume: false, scenario: 'original', custom: { ...PRESETS.original } });
const state = { data: null, map: null, record: null, result: null, prefs: initialPrefs(), history: [],
  groups: [], modes: [], jobs: new Map(), stats: new Map(), selected: 0, bounds: null, scale: 'shared', curves: { observed: true, ittc: true, jonswap: true },
  lab: null, stage: null, panel: 'wave', view: 'ocean', speed: 1, trace: null, labTime: 0, validationRun: 0, archiveFiles: null, pending: false, reference: null, compareScale: 'absolute' };
const titles = { original: '原方案', updated: '新方案', both: '并排比较', custom: '自定义方案' };
const dateLabel = value => value?.replace('T', ' ').replace(/:00(?:\.000)?Z$/, '') || '未记录';
const rounded = (x, digits = 2) => Number.isFinite(x) ? x.toFixed(digits) : '—';
const select = (root, attr, value) => root.querySelectorAll(`[data-${attr}]`).forEach(item => item.setAttribute('aria-pressed', item.dataset[attr] === value));

function notify(message, type = '') {
  const n = $('notice');
  $('notice-text').textContent = message; n.className = `notice ${type}`; n.hidden = !message;
  clearTimeout(notify.timer);
  if (message && type !== 'error') notify.timer = setTimeout(() => { n.hidden = true; }, 4700);
}

function task(key, payload) {
  cancel(key);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const begin = performance.now();
    const stop = () => { worker.terminate(); if (state.jobs.get(key)?.worker === worker) state.jobs.delete(key); };
    state.jobs.set(key, { worker, stop, resolve });
    worker.onmessage = e => {
      stop();
      performance.measure(`wave:${key}`, { start: begin, end: performance.now() });
      if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.value);
    };
    worker.onerror = e => { stop(); reject(new Error(e.message || '后台计算未能启动。')); };
    worker.postMessage(payload);
  });
}

function cancel(key) {
  const job = state.jobs.get(key);
  if (job) { job.stop(); job.resolve(null); }
}

let importRevision = 0;
function supersedeImport() {
  cancel('import');
  return ++importRevision;
}

function remember() {
  if (!state.record) return;
  pushHistory({ record: state.record, prefs: structuredClone(state.prefs), archive: state.archiveFiles });
}

function pushHistory(entry) {
  state.history.push(entry);
  if (state.history.length > 12) state.history.shift();
  $('undo').hidden = false;
}

function persist() {
  if (!state.record) return;
  try { localStorage.setItem(storage, JSON.stringify(experiment(state.record, state.prefs))); } catch { /* downloads remain available */ }
}

function currentArchive(record) {
  $('import-details').hidden = record.id !== 'imported';
  $('import-name').textContent = record.name;
  const extra = record.missingBins ? ` 排除 ${record.missingBins} 个缺测频带。` : '';
  const clean = (record.skipped || record.duplicates) ? ` 排除 ${record.skipped || 0} 条无效记录，合并 ${record.duplicates || 0} 条重复记录。` : '';
  $('import-copy').textContent = `${record.summary || record.origin || '已导入实验数据'}${extra}${clean}`;
  $('archive-selection').hidden = !record.archiveTimes?.length || !state.archiveFiles;
  if (record.archiveTimes?.length && state.archiveFiles) {
    $('archive-time').value = dateLabel(record.time);
    // Keep the input responsive for large archives while accepting any typed timestamp.
    $('archive-times').replaceChildren(...record.archiveTimes.slice(-180).map(time => {
      const option = document.createElement('option'); option.value = dateLabel(time); return option;
    }));
  }
}

function setCaseButtons() {
  select($('data-cases'), 'case', state.record?.id);
}

function builtInCase(record) {
  if (!record) return;
  const fields = ['f', 's', 'df', 'a1', 'a2', 'r1', 'r2'];
  return state.data?.cases.find(candidate => candidate.name === record.name && candidate.time === record.time
    && candidate.origin === record.origin && candidate.rows.length === record.rows.length
    && candidate.rows.every((row, i) => fields.every(key => (row[key] ?? null) === (record.rows[i][key] ?? null))));
}

function preferencesForNewData() {
  return { ...state.prefs, assume: false };
}

function openPanel(id, { focus = false, hash = true } = {}) {
  const tabs = [...$('workspace-tabs').querySelectorAll('[data-panel]')];
  const active = tabs.find(tab => tab.dataset.panel === id && !tab.hidden)
    || tabs.find(tab => tab.dataset.panel === 'spectra');
  if (state.panel === 'wave' && active.dataset.panel !== 'wave') {
    state.lab?.play(false);
    updatePlayButtons();
  }
  state.panel = active.dataset.panel;
  $('workbench').dataset.panel = state.panel;
  for (const tab of tabs) {
    const current = tab === active;
    tab.setAttribute('aria-selected', current);
    tab.tabIndex = current ? 0 : -1;
    $(tab.dataset.panel).hidden = !current;
  }
  if (hash) history.replaceState(null, '', `#${state.panel}`);
  if (focus) {
    active.focus({ preventScroll: true });
    const viewport = $('workspace-tabs').getBoundingClientRect(), target = active.getBoundingClientRect();
    $('workspace-tabs').scrollLeft += Math.max(0, target.right - viewport.right) - Math.max(0, viewport.left - target.left);
  }
  requestAnimationFrame(() => {
    if (state.panel === 'wave' && !state.lab) void updateScene();
    redraw();
  });
}

async function selectRecord(record, prefs = initialPrefs(), { save = true, archive = null, confirm = '', keepTime = false } = {}) {
  if (!record) return;
  const old = state.record;
  try {
    state.pending = true;
    $('active-name').setAttribute('aria-busy', 'true');
    const result = await task('analysis', { kind: 'analysis', record, assume: prefs.assume });
    if (!result) return;
    if (save) remember();
    state.record = record;
    state.result = result;
    state.prefs = prefs;
    state.archiveFiles = archive;
    state.selected = result.stat.peak;
    state.bounds = null;
    state.labTime = keepTime ? state.labTime : 0;
    if (state.lab) { state.lab.play(false); state.lab.seek(state.labTime); }
    state.groups = result.direction ? phases(result, prefs.seed) : [];
    state.modes = state.groups.flatMap(group => group.values);
    $('frequency').max = String(result.rows.length - 1);
    $('frequency').value = String(state.selected);
    $('seed').value = String(prefs.seed);
    $('custom-dt').value = String(prefs.custom.dt);
    $('custom-segment').value = String(prefs.custom.segment);
    $('custom-duration').value = String(prefs.custom.duration);
    currentArchive(record);
    updateReading(); redraw(); updateScene(); refreshTrace();
    state.stats.clear();
    runChecks();
    persist();
    if (confirm) notify(confirm);
    return true;
  } catch (error) {
    notify(error.message, 'error');
    if (!old) $('active-name').textContent = '等待可用的观测频谱';
  } finally {
    state.pending = state.jobs.has('analysis');
    $('active-name').setAttribute('aria-busy', String(state.pending));
  }
}

function updateReading() {
  const { record, result } = state;
  const { stat, fits, direction } = result;
  $('metric-hm0').innerHTML = `${rounded(stat.hm0)}<em> m</em>`;
  $('metric-tp').innerHTML = `${rounded(stat.tp, 1)}<em> s</em>`;
  $('metric-bins').textContent = result.rows.length;
  $('metric-fp').innerHTML = `${rounded(1 / stat.tp, 4)}<em> Hz</em>`;
  $('active-name').textContent = record.name;
  $('active-time').textContent = record.time ? `${dateLabel(record.time)} UTC` : '';
  $('source-readiness').textContent = direction?.assumed ? '固定方向假设' : direction ? '含方向参数' : '一维频谱';
  $('spectrum-name').textContent = record.name;
  $('spectrum-info').textContent = `${record.origin || 'NOAA NDBC 实测谱'} · ${result.rows.length} 频带 · Tₘ₀₁ ${rounded(stat.tm01, 1)} s`;
  $('ittc-value').textContent = rounded(fits.ittcError, 3);
  $('jonswap-value').textContent = rounded(fits.jonswapError, 3);
  $('compact-ittc').textContent = $('ittc-value').textContent;
  $('compact-jonswap').textContent = $('jonswap-value').textContent;
  $('fp-value').textContent = `${(1 / stat.tp).toFixed(4)} Hz`;
  for (const [id, empty] of [['direction-output', 'no-direction'], ['wave-output', 'no-wave'], ['check-output', 'no-checks']]) {
    $(id).hidden = !direction;
    $(empty).hidden = !!direction;
  }
  $('remove-assumption').hidden = !direction?.assumed;
  $('mem-name').textContent = direction?.assumed ? '固定方向假设' : 'MEM 方向重建';
  $('original-reference').hidden = record.id !== 'storm';
  $('scales').hidden = !direction;
  $('stage-name').textContent = direction?.assumed ? '模拟海面 · 固定方向假设' : '模拟海面 · MEM 方向谱';
  $('trace-panel').hidden = !direction;
  for (const id of ['tab-wave', 'tab-checks']) $(id).hidden = !direction;
  if (!direction && ['wave', 'checks'].includes(state.panel)) openPanel('spectra');
  updatePlayButtons();
  for (const id of ['open-export', 'export-json', 'export-csv', 'export-image']) $(id).disabled = false;
  setCaseButtons();
  changeFrequency(state.selected);
  updateComparison();
}

function drawSpectrum(canvas = $('spectrum')) {
  if (!state.result) return;
  const { rows, fits } = state.result;
  const x = rows.map(r => r.f);
  line(canvas, { xLabel: '频率 · Hz', yLabel: '谱能量密度 · m²/Hz', cursor: x[state.selected], bounds: state.bounds, series: [
    { x, y: rows.map(r => r.s), color: 'chart-observed', area: true, visible: state.curves.observed, weight: 2.4 },
    { x, y: fits.ittc, color: 'chart-ittc', dash: [7, 4], visible: state.curves.ittc },
    { x, y: fits.jonswap, color: 'chart-jonswap', visible: state.curves.jonswap },
  ] });
}

function drawDirection() {
  const direction = state.result?.direction;
  if (!direction) return;
  const frequencies = state.result.rows.map(r => r.f);
  const max = matrix => matrix.reduce((v, row) => Math.max(v, ...row), 0);
  const left = max(direction.fixed), right = max(direction.modeled);
  const shared = state.scale === 'shared';
  const a = shared ? Math.max(left, right) : left, b = shared ? Math.max(left, right) : right;
  heat($('fixed'), frequencies, direction.fixed, state.selected, a);
  heat($('mem'), frequencies, direction.modeled, state.selected, b);
  $('fixed-scale').textContent = `色标 0–${rounded(a, 1)} m²/(Hz·rad)`;
  $('mem-scale').textContent = `色标 0–${rounded(b, 1)} m²/(Hz·rad)`;
  const x = direction.angles.map(value => value * 180 / Math.PI).concat(360);
  const m = direction.modeled[state.selected], f = direction.fixed[state.selected];
  line($('slice'), { xLabel: '传播去向 · °', yLabel: 'm²/(Hz·rad)', series: [
    { x, y: [...m, m[0]], color: 'chart-observed', area: true, weight: 2.2 }, { x, y: [...f, f[0]], color: 'chart-ittc', dash: [6, 4] },
  ] });
  $('slice-title').textContent = `${frequencies[state.selected].toFixed(4)} Hz 的方向剖面`;
  $('direction-summary').textContent = direction.assumed ? '绿色与虚线重合。两者使用同一固定 cos² 方向假设，参考去向 0°（东）。'
    : `实线 MEM · 虚线固定 cos²。能量加权平均去向 ${rounded(direction.mean, 1)}°。${direction.unavailableBins ? `${direction.unavailableBins} 个有能量频带采用均匀补齐，占谱能量 ${rounded(100 * direction.unavailableShare, 2)}%。` : '所有有能量频带均使用可用方向参数。'}`;
}

function changeFrequency(index) {
  if (!state.result) return;
  const next = Math.max(0, Math.min(state.result.rows.length - 1, index));
  state.selected = next;
  const row = state.result.rows[next];
  $('frequency').value = String(next);
  $('frequency-readout').textContent = `${row.f.toFixed(4)} Hz · ${rounded(row.s, 3)} m²/Hz`;
  cancelAnimationFrame(changeFrequency.frame);
  changeFrequency.frame = requestAnimationFrame(() => { drawSpectrum(); drawDirection(); });
}

function drawTimeline() {
  if (!state.data) return;
  const byDay = new Map();
  for (const row of state.data.timeline) {
    const key = row.time.slice(0, 10);
    if (!byDay.has(key) || row.hm0 > byDay.get(key).hm0) byDay.set(key, row);
  }
  const days = [...byDay.values()];
  const x = days.map(row => dateValue(row.time));
  const y = days.map(row => row.hm0);
  const markers = state.data.cases.map(item => {
    return { x: dateValue(item.time), y: moments(item.rows).hm0, active: state.record?.id === item.id };
  });
  line($('timeline'), { yLabel: '每日最大 Hₘ₀ · m', xFormat: v => new Date(v).toISOString().slice(5, 10),
    bounds: [Math.min(x[0], ...markers.map(m => m.x)), x.at(-1)], markers, series: [{ x, y, area: true, color: 'chart-observed', weight: 1.5 }] });
  state.displayDays = days;
}

function dateValue(value) { return new Date(value).getTime(); }

function redraw() {
  drawTimeline(); drawSpectrum(); drawDirection(); drawTrace(); drawCheckCharts(); drawComparison();
  if (state.data) stationMap($('map'), state.map, state.data.station);
}

function timeReading(value, force = false) {
  state.labTime = value;
  const ds = `${value.toFixed(state.lab?.playing() ? 1 : 2)} s`;
  if (force || $('time-readout').textContent !== ds) {
    $('time-slider').value = String(value); $('time-readout').textContent = ds;
    $('trace-time').textContent = ds;
    $('point-value').textContent = `${rounded(waveAt(state.modes, state.prefs.point.x, state.prefs.point.y, value))} m`;
    if (force || (state.lastTraceTime ?? -1) + .16 < value || state.lastTraceTime > value) {
      state.lastTraceTime = value;
      drawTrace();
    }
  }
}

function attachScene(fallback = false) {
  const host = $('lab-media');
  state.lab?.dispose();
  state.lab = (fallback ? state.stage.create2d : state.stage.oceanStage)(host, {
    onTime: timeReading, pick: setPoint, onCamera: updateViewReading,
    onOutside: () => notify('请在模型的 320 × 320 m 区域内选点，也可在实验面板直接输入坐标。'),
    onLost: () => { attachScene(true); setupLab(); },
  });
  host.dataset.render = state.lab.kind;
}

function updatePlayButtons() {
  $('lab-play').textContent = state.lab?.playing() ? '暂停' : '播放';
}

async function updateScene() {
  if (!state.result?.direction) {
    state.lab?.play(false);
    return;
  }
  if (!state.lab && state.panel !== 'wave') return;
  try {
    state.stage ||= await import('./ocean.js');
    setupLab();
  } catch (error) {
    console.error(error);
    $('stage-loading').textContent = '波面加载失败，请刷新后重试';
  }
}

function setupLab() {
  if (!state.stage || !state.result?.direction) return;
  if (!state.lab) {
    if (state.panel !== 'wave') return;
    attachScene();
  }
  const share = state.lab.setData(state.modes, state.result.stat.hm0);
  if (state.lab.kind === '2d') state.view = 'science';
  state.lab.setView(state.view); state.lab.setPoint(state.prefs.point); state.lab.seek(state.labTime);
  state.lab.setRate(state.speed);
  $('stage-loading').hidden = true;
  $('wave-title').textContent = state.lab.kind === '2d' ? '二维高程' : '三维波面';
  $('stage-note').textContent = `320 × 320 m · 渲染 ${rounded(share * 100, 1)}% 谱能量 · 统计用完整谱`;
  const range = Math.max(.02, state.result.stat.hm0 * .59);
  $('range-top').textContent = `+${rounded(range, 1)} m`;
  $('range-bottom').textContent = `−${rounded(range, 1)} m`;
  $('top-view').hidden = state.lab.kind !== 'three'; $('reset-view').hidden = state.lab.kind !== 'three';
  $('views').querySelector('[data-mode=ocean]').hidden = state.lab.kind !== 'three';
  $('wave-instructions').textContent = state.lab.kind === '2d' ? '点按高程图改变测点。方向键也可移动测点。'
    : matchMedia('(pointer: coarse)').matches ? '点选测点后可拖动旋转。点到图外可继续滚动。' : '拖动旋转，点选波面改变测点。';
  updateViewReading();
  updatePlayButtons();
}

function setPoint(point) {
  if (!state.result?.direction) return;
  const next = { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 };
  if (state.prefs.point.x === next.x && state.prefs.point.y === next.y) return;
  remember();
  state.prefs.point = next;
  state.lab?.setPoint(next);
  refreshTrace(); state.stats.clear(); runChecks(); persist(); updateComparison();
}

function refreshTrace() {
  if (!state.groups.length) return;
  const pt = state.prefs.point, step = .25;
  $('probe-x').value = pt.x;
  $('probe-y').value = pt.y;
  $('point-name').textContent = `东 ${pt.x.toFixed(1)} m · 北 ${pt.y.toFixed(1)} m`;
  $('point-value').textContent = `${rounded(waveAt(state.modes, pt.x, pt.y, state.labTime))} m`;
  state.trace = { x: Array.from({ length: 321 }, (_, i) => i * step), y: samplePoint(state.groups, pt, step, 321) };
  drawTrace();
}

function seekTime(seconds) {
  const value = Math.min(80, Math.max(0, seconds));
  state.lab?.play(false);
  state.lab?.seek(value);
  timeReading(value, true);
  updatePlayButtons();
}

function updateViewReading() {
  $('wave-frame').dataset.view = state.view;
  $('elevation-key').hidden = state.view === 'ocean';
  select($('views'), 'mode', state.view);
  $('top-view').setAttribute('aria-pressed', String(Boolean(state.lab?.isTop?.())));
}

function drawTrace() {
  if (!state.trace || !state.result?.direction) return;
  const index = Math.min(320, Math.round(state.labTime * 4));
  line($('trace'), { xLabel: '模拟秒', yLabel: '高程 · m', cursor: state.trace.x[index], series: [{ x: state.trace.x, y: state.trace.y, color: 'chart-observed', weight: 1.6 }] });
}

const comparisonMetrics = [
  ['谱有效波高 Hₘ₀', 'm', 2, stat => stat.hm0],
  ['谱峰周期 Tₚ', 's', 2, stat => stat.tp],
  ['平均周期 Tₘ₀₁', 's', 2, stat => stat.tm01],
  ['峰值频率', 'Hz', 4, stat => 1 / stat.tp],
];

function experimentMeta({ record, prefs, result }) {
  const parts = [record.time ? `${dateLabel(record.time)} UTC` : record.origin];
  if (result.direction) {
    parts.push(result.direction.assumed ? '固定方向假设' : 'MEM', `种子 ${prefs.seed}`,
      `东 ${prefs.point.x} · 北 ${prefs.point.y} m`, titles[prefs.scenario]);
  }
  return parts.filter(Boolean).join(' · ');
}

function comparisonRows() {
  return comparisonMetrics.map(([name, unit, digits, read]) => {
    const baseline = read(state.reference.result.stat), current = read(state.result.stat);
    return { name, unit, digits, baseline, current, delta: current - baseline };
  });
}

function drawComparison() {
  if (state.panel !== 'compare' || !state.reference || !state.result) return;
  const normalized = state.compareScale === 'normalized';
  const series = [
    { result: state.reference.result, color: 'chart-ittc', dash: [7, 4] },
    { result: state.result, color: 'chart-observed', area: true },
  ].map(({ result, ...style }) => ({
    x: result.rows.map(row => row.f), y: result.rows.map(row => row.s / (normalized ? result.stat.m0 : 1)), ...style,
  }));
  const range = [Math.min(...series.map(({ x }) => x[0])), Math.max(...series.map(({ x }) => x.at(-1)))];
  $('compare-scale-caption').textContent = normalized ? '每条谱除以自身 m₀，可以比较峰值位置与谱形。' : '各谱保留原始频率网格与谱值单位。';
  line($('compare-spectrum'), { xLabel: '频率 · Hz', yLabel: normalized ? 'S(f) / m₀ · 1/Hz' : '实测谱 · m²/Hz', bounds: range, series });
}

function updateComparison() {
  const ref = state.reference;
  const ready = Boolean(ref && state.result);
  $('compare-empty').hidden = ready;
  $('compare-output').hidden = !ready;
  $('view-reference').hidden = !ready;
  document.querySelectorAll('[data-pin-reference]').forEach(button => {
    button.disabled = !state.result;
    button.textContent = ref ? '更新基准' : '设为基准';
  });
  if (!ready) return;
  $('ref-name').textContent = ref.record.name;
  $('ref-meta').textContent = experimentMeta(ref);
  $('compare-name').textContent = state.record.name;
  $('compare-meta').textContent = experimentMeta(state);
  $('compare-values').replaceChildren(...comparisonRows().map(({ name, unit, digits, baseline, current, delta }) => {
    const row = document.createElement('tr');
    const title = document.createElement('th');
    title.scope = 'row';
    title.textContent = `${name} / ${unit}`;
    row.append(title);
    for (const value of [rounded(baseline, digits), rounded(current, digits), `${delta > 0 ? '+' : ''}${rounded(delta, digits)}`]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
  drawComparison();
}

function pinReference() {
  if (!state.record || !state.result) return;
  const snapshot = { record: state.record, prefs: structuredClone(state.prefs), result: state.result, archive: state.archiveFiles };
  pushHistory({ reference: state.reference });
  state.reference = snapshot;
  updateComparison();
  try {
    persistReference();
    notify(`已保存基准：${snapshot.record.name}。`);
  } catch { notify('已设为基准。此浏览器无法将基准保留到下次打开。'); }
}

function persistReference() {
  const ref = state.reference;
  if (ref) localStorage.setItem(referenceStorage, JSON.stringify(experiment(ref.record, ref.prefs)));
  else localStorage.removeItem(referenceStorage);
}

async function loadReference() {
  try {
    const text = localStorage.getItem(referenceStorage);
    if (!text) return;
    const { record, prefs } = parseFiles([{ name: 'reference.json', text }]);
    const result = await task('reference', { kind: 'analysis', record, assume: prefs.assume });
    if (result && !state.reference) {
      state.reference = { record: builtInCase(record) ?? record, prefs, result };
      updateComparison();
    }
  } catch { /* An unreadable local baseline can be replaced from the current experiment. */ }
}

function exportComparison() {
  if (!state.reference || !state.result) return;
  const cell = text => `"${String(text).replaceAll('"', '""')}"`;
  const label = text => cell(/^[=+@\-\t\r]/.test(text) ? "'" + text : text);
  const rows = [
    ['dataset', '', label(state.reference.record.name), label(state.record.name), ''],
    ['observation_utc', '', cell(state.reference.record.time || ''), cell(state.record.time || ''), ''],
    ...comparisonRows().map(({ name, unit, digits, baseline, current, delta }) =>
      [cell(name), unit, rounded(baseline, digits), rounded(current, digits), rounded(delta, digits)]),
  ];
  exportFile(new Blob(['\uFEFFmetric,unit,baseline,current,delta\n' + rows.map(row => row.join(',')).join('\n') + '\n'], { type: 'text/csv;charset=utf-8' }), 'wave-comparison.csv');
  notify('对照表已导出。');
}

function scenarios() { return state.prefs.scenario === 'both' ? ['original', 'updated'] : [state.prefs.scenario]; }
function scenarioParams(id) { return PRESETS[id] || state.prefs.custom; }

async function runChecks() {
  const token = ++state.validationRun;
  const targets = scenarios();
  for (const key of [...state.jobs.keys()].filter(name => name.startsWith('checks-'))) cancel(key);
  select($('check-presets'), 'scenario', state.prefs.scenario);
  $('cancel-check').hidden = true;
  if (!state.result?.direction) return;
  const missing = targets.filter(id => !state.stats.has(id) || state.stats.get(id).cancelled);
  for (const id of missing) if (state.stats.get(id)?.cancelled) state.stats.delete(id);
  $('check-status').textContent = missing.length ? '正在后台计算 · 可以继续浏览图表' : '计算完成 · 可对照参数与原始结果';
  $('cancel-check').hidden = !missing.length;
  fillCheckCards();
  if (!missing.length) return;
  const payload = { kind: 'validate', record: state.record, seed: state.prefs.seed, point: state.prefs.point, assume: state.prefs.assume };
  await Promise.all(missing.map(async id => {
    try {
      const outcome = await task(`checks-${id}`, { ...payload, params: scenarioParams(id) });
      if (outcome && token === state.validationRun) state.stats.set(id, { outcome });
    } catch (error) { if (token === state.validationRun) state.stats.set(id, { error: error.message }); }
  }));
  if (token !== state.validationRun) return;
  $('cancel-check').hidden = true;
  const failed = targets.some(id => state.stats.get(id)?.error);
  $('check-status').textContent = failed ? '部分设置需要调整' : '计算完成 · 可对照参数与原始结果';
  fillCheckCards();
}

function fillCheckCards() {
  const parent = $('check-columns');
  parent.replaceChildren();
  for (const id of scenarios()) {
    const card = document.createElement('article');
    card.className = 'check-card'; card.dataset.check = id;
    const entry = state.stats.get(id), p = scenarioParams(id);
    card.innerHTML = `<div class="panel-head"><div><h4>${titles[id]}</h4><p>Δt ${rounded(p.dt, 2)} s · 分段 ${p.segment} 点 · ${p.duration.toLocaleString('zh-CN')} s</p></div></div>`;
    if (entry?.outcome) {
      const v = entry.outcome;
      const caption = Number.isFinite(v.ks) ? `5% 近似参考值 ${rounded(v.critical, 3)} · 已识别 ${v.waveCount.toLocaleString('zh-CN')} 个完整波` : '未识别足够的完整波';
      card.insertAdjacentHTML('beforeend', `<div class="panel-metrics"><div><span>上跨零有效波高</span><strong>${rounded(v.h13)} m</strong></div><div><span>瑞利 KS 距离</span><strong>${rounded(v.ks, 3)}</strong></div><div><span>Welch NRMSE</span><strong>${rounded(v.error, 4)}</strong></div></div><canvas id="psd-${id}" class="chart" role="img" aria-label="实测谱和 Welch 反演谱对照"></canvas><p class="panel-foot">实线 实测谱 · 虚线 Welch · 间隔 ${v.spectral.interval.toFixed(5)} Hz · ${v.spectral.segments} 段</p><canvas id="cdf-${id}" class="chart small-chart" role="img" aria-label="经验波高累积分布与瑞利理论对照"></canvas><p class="panel-foot">实线 经验分布 · 虚线 瑞利理论 · ${caption}</p>`);
    } else {
      const p = document.createElement('p'); p.className = 'panel-foot'; p.textContent = entry?.error || '等待计算结果…'; card.append(p);
    }
    parent.append(card);
  }
  drawCheckCharts();
}

function drawCheckCharts() {
  if (!state.result?.direction) return;
  for (const id of scenarios()) {
    const v = state.stats.get(id)?.outcome;
    const cv = $(`psd-${id}`), cdf = $(`cdf-${id}`);
    if (!v || !cv || !cdf) continue;
    const x = state.result.rows.map(row => row.f), cap = x.at(-1) * 1.03;
    const n = v.spectral.frequency.findIndex(f => f > cap);
    const fx = v.spectral.frequency.slice(0, n < 0 ? undefined : n), psd = v.spectral.power.slice(0, fx.length);
    line(cv, { xLabel: '频率 · Hz', yLabel: 'm²/Hz', bounds: [x[0], x.at(-1)], series: [
      { x, y: state.result.rows.map(row => row.s), color: 'chart-observed', weight: 2.1 },
      { x: fx, y: psd, color: 'chart-jonswap', dash: [5, 3] },
    ] });
    if (!v.cdf.length) continue;
    const stride = Math.max(1, Math.ceil(v.cdf.length / 900));
    const small = v.cdf.filter((row, i) => i % stride === 0 || i === v.cdf.length - 1);
    const heights = [0, ...small.map(row => row[0])];
    if (heights.at(-1) <= 0) continue;
    line(cdf, { xLabel: '单波波高 · m', yLabel: '累计概率', yBounds: [0, 1], series: [
      { x: heights, y: [0, ...small.map(row => row[1])], color: 'chart-observed' },
      { x: heights, y: [0, ...small.map(row => row[2])], color: 'chart-ittc', dash: [5, 3] },
    ] });
  }
}

async function readFiles(files) {
  const list = Array.from(files);
  if (!list.length) return [];
  if (list.length > 5 || list.reduce((sum, f) => sum + f.size, 0) > 45_000_000) throw new Error('每次导入最多五个文件，合计不超过 45 MB。');
  return Promise.all(list.map(async file => {
    if (/\.gz$/i.test(file.name)) {
      if (!globalThis.DecompressionStream) throw new Error('当前浏览器无法解压 GZIP。请解压后导入 TXT。');
      const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const decoder = new TextDecoder();
      let size = 0, text = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 32_000_000) { await reader.cancel(); throw new Error('解压后的单个文件超过 32 MB，请按年份拆分后导入。'); }
        text += decoder.decode(value, { stream: true });
      }
      return { name: file.name, text: text + decoder.decode() };
    }
    return { name: file.name, text: await file.text() };
  }));
}

async function importFiles(files) {
  const generation = supersedeImport();
  try {
    notify('正在读取与校验文件。');
    const source = await readFiles(files);
    if (!source.length || generation !== importRevision) return;
    const imported = await task('import', { kind: 'import', files: source });
    if (!imported || generation !== importRevision) return;
    const message = imported.prefs ? '实验已恢复。' : `已导入 ${imported.record.rows.length} 个有效频带。`;
    const record = (imported.prefs ? builtInCase(imported.record) : null) ?? imported.record;
    const saved = await selectRecord(record, imported.prefs || preferencesForNewData(), { archive: record.archiveTimes ? source : null, confirm: message });
    if (saved && generation === importRevision) {
      if (state.archiveFiles) $('source-menu').open = true;
      else closeSourceMenu();
    }
    if (generation === importRevision && imported.version && imported.version !== '1.0.0') notify(`已用当前算法复算。原记录版本 ${String(imported.version).slice(0, 20)}。`);
  } catch (error) { if (generation === importRevision) notify(error.message, 'error'); }
}

function exportFile(blob, filename) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportJson() {
  if (!state.record || !state.result) return;
  const pack = experiment(state.record, state.prefs);
  pack.summary = state.result.stat;
  pack.fitNRMSE = { ittc: state.result.fits.ittcError, jonswap: state.result.fits.jonswapError };
  if (state.result.direction) pack.directionSummary = Object.fromEntries(Object.entries(state.result.direction).filter(([key]) => !['angles', 'modeled', 'fixed'].includes(key)));
  pack.validation = Object.fromEntries([...state.stats].filter(([, entry]) => entry.outcome).map(([name, { outcome }]) => [name, outcome]));
  exportFile(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }), 'wave-experiment.json');
  notify('实验记录已导出，可以再次导入恢复。');
}

function exportCsv() {
  if (!state.result) return;
  const { rows, fits } = state.result;
  const checks = [...state.stats].filter(([, value]) => value.outcome);
  const header = ['frequency_hz', 'spectrum_m2_per_hz', 'bandwidth_hz', 'alpha1_deg', 'alpha2_deg', 'r1', 'r2', 'ittc_m2_per_hz', 'jonswap_m2_per_hz', ...checks.map(([name]) => `welch_${name}_m2_per_hz`)];
  const grid = rows.map(({ f, s, a1, a2, r1, r2 }, i) => [f, s, state.result.df[i], a1, a2, r1, r2, fits.ittc[i], fits.jonswap[i], ...checks.map(([, e]) => e.outcome.estimate[i])].join(','));
  exportFile(new Blob([[header.join(','), ...grid].join('\n') + '\n'], { type: 'text/csv;charset=utf-8' }), 'wave-spectrum-results.csv');
  notify('频谱数值已导出。');
}

function exportPng() {
  if (!state.result) return;
  const plot = $('spectrum'), canvas = document.createElement('canvas');
  const source = plot.clientWidth ? plot : document.createElement('canvas');
  if (source !== plot) {
    source.className = 'export-chart';
    document.body.append(source);
  }
  drawSpectrum(source);
  const css = getComputedStyle(document.documentElement);
  canvas.width = source.width; canvas.height = source.height + 98;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = css.getPropertyValue('--surface').trim(); ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = css.getPropertyValue('--text').trim(); ctx.font = 'bold 21px sans-serif';
  ctx.fillText(`${state.record.name} · 一维频谱`, 23, 30, canvas.width - 46);
  ctx.font = '14px sans-serif'; ctx.fillText(`${dateLabel(state.record.time)} · ${state.record.origin || 'NOAA NDBC'} · 本站复算`, 23, 57, canvas.width - 46);
  ctx.drawImage(source, 0, 66);
  if (source !== plot) source.remove();
  const names = [['observed', '实测谱'], ['ittc', 'ITTC'], ['jonswap', 'JONSWAP']].filter(([key]) => state.curves[key]);
  let x = 23;
  for (const [key, name] of names) { ctx.fillStyle = css.getPropertyValue(`--chart-${key}`).trim(); ctx.fillText(name, x, canvas.height - 10, 120); x += 94; }
  canvas.toBlob(blob => { if (blob) exportFile(blob, 'wave-spectrum.png'); else notify('图表导出失败，请重试。', 'error'); });
}

function makeCaseButtons() {
  $('data-cases').replaceChildren(...state.data.cases.map(record => {
    const button = document.createElement('button'), name = document.createElement('span'), height = document.createElement('span');
    button.type = 'button';
    button.dataset.case = record.id;
    name.textContent = record.name;
    height.className = 'case-height';
    height.textContent = `${rounded(moments(record.rows).hm0)} m`;
    button.append(name, height);
    button.setAttribute('aria-pressed', String(state.record?.id === record.id));
    button.addEventListener('click', () => selectCase(record));
    return button;
  }));
}

function selectCase(record) {
  closeSourceMenu();
  supersedeImport();
  if (state.record?.id === record.id && !state.pending) { notify(''); return; }
  void selectRecord(record, preferencesForNewData(), { confirm: `已切换至${record.name}。` });
}

function closeSourceMenu() {
  const menu = $('source-menu');
  if (!menu.open) return;
  const focused = menu.contains(document.activeElement);
  menu.open = false;
  if (focused) menu.querySelector('summary').focus({ preventScroll: true });
}

function changeTheme(light) {
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('theme').textContent = light ? '☾' : '☼';
  $('theme').setAttribute('aria-label', light ? '切换深色模式' : '切换浅色模式');
  $('theme').title = $('theme').getAttribute('aria-label');
  try { localStorage.setItem(shade, light ? 'light' : 'dark'); } catch { /* visual mode still works */ }
  redraw();
}

function bindFrequency(canvas) {
  const point = e => {
    const index = hoveredIndex(canvas, e.clientX, e.clientY);
    if (index !== null && index !== state.selected) changeFrequency(index);
  };
  canvas.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') point(e); });
  canvas.addEventListener('click', point);
  canvas.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault(); changeFrequency(state.selected + (e.key === 'ArrowLeft' ? -1 : 1));
  });
}

function zoomAt(event) {
  if (!state.result || !event.ctrlKey && !event.metaKey && document.activeElement !== $('spectrum')) return;
  event.preventDefault();
  const i = hoveredIndex($('spectrum'), event.clientX, event.clientY) ?? state.selected;
  const rows = state.result.rows, focus = rows[i].f, low = rows[0].f, high = rows.at(-1).f;
  const [a, b] = state.bounds || [low, high];
  const width = Math.min(high - low, Math.max((high - low) / 18, (b - a) * (event.deltaY > 0 ? 1.22 : .82)));
  const position = Math.max(0, Math.min(1, (focus - a) / (b - a)));
  const left = Math.max(low, Math.min(high - width, focus - width * position));
  state.bounds = [left, left + width]; drawSpectrum();
}

function bind() {
  const mast = document.querySelector('.mast');
  const measureMast = () => document.documentElement.style.setProperty('--mast-height', `${Math.ceil(mast.getBoundingClientRect().height)}px`);
  new ResizeObserver(measureMast).observe(mast);
  measureMast();
  const tabs = $('workspace-tabs');
  tabs.addEventListener('click', event => {
    const tab = event.target.closest('[data-panel]');
    if (tab && state.panel !== tab.dataset.panel) openPanel(tab.dataset.panel, { focus: true });
  });
  tabs.addEventListener('keydown', event => {
    const available = [...tabs.querySelectorAll('[data-panel]:not([hidden])')];
    const current = available.indexOf(event.target);
    if (current === -1 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length;
    openPanel(available[next].dataset.panel, { focus: true });
  });
  const route = () => {
    const id = location.hash.slice(1);
    if (tabs.querySelector(`[data-panel="${CSS.escape(id)}"]`)) openPanel(id, { hash: false });
  };
  window.addEventListener('hashchange', route);
  $('workbench').dataset.panel = state.panel;
  route();
  document.querySelector('.brand').addEventListener('click', event => {
    event.preventDefault();
    openPanel('wave');
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  document.querySelectorAll('[data-open-panel]').forEach(button => button.addEventListener('click', () => {
    closeSourceMenu();
    openPanel(button.dataset.openPanel, { focus: true });
    if (tabs.getBoundingClientRect().top < mast.getBoundingClientRect().bottom) {
      tabs.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }));
  document.addEventListener('click', event => { if (!$('source-menu').contains(event.target)) closeSourceMenu(); });
  $('source-menu').addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('source-menu').open) { event.preventDefault(); closeSourceMenu(); }
  });
  $('project-open').addEventListener('click', () => $('project-dialog').showModal());
  $('open-export').addEventListener('click', () => $('export-dialog').showModal());
  document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $(button.dataset.closeDialog).close()));
  $('dismiss-notice').addEventListener('click', () => notify(''));
  document.querySelectorAll('[data-import]').forEach(b => b.addEventListener('click', () => $('files').click()));
  $('files').addEventListener('change', e => { void importFiles(e.target.files); e.target.value = ''; });
  const hasFile = e => Array.from(e.dataTransfer.types).includes('Files');
  let enters = 0;
  window.addEventListener('dragenter', e => { if (hasFile(e)) { e.preventDefault(); enters++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragover', e => { if (hasFile(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('dragleave', () => { if (--enters <= 0) { enters = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('drop', e => { if (hasFile(e)) { e.preventDefault(); enters = 0; document.body.classList.remove('dragging'); importFiles(e.dataTransfer.files); } });
  $('theme').addEventListener('click', () => changeTheme(document.documentElement.dataset.theme !== 'light'));
  $('undo').addEventListener('click', () => {
    supersedeImport();
    const previous = state.history.pop(); $('undo').hidden = !state.history.length;
    if (!previous) return;
    if (Object.hasOwn(previous, 'reference')) {
      state.reference = previous.reference;
      try { persistReference(); } catch { /* Undo still applies for this session. */ }
      updateComparison();
      notify('已撤销基准变更。');
    } else selectRecord(previous.record, previous.prefs, { save: false, archive: previous.archive, confirm: '已恢复上一个实验状态。' });
  });
  $('choose-time').addEventListener('click', async () => {
    const value = $('archive-time').value.trim();
    if (!/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d$/.test(value)) { notify('时次格式为 YYYY-MM-DD HH:mm（UTC）。', 'error'); return; }
    const generation = supersedeImport();
    try {
      const next = new Date(`${value.replace(' ', 'T')}:00Z`).toISOString();
      const files = state.archiveFiles;
      const data = await task('import', { kind: 'import', files, time: next });
      if (data && generation === importRevision) {
        await selectRecord(data.record, preferencesForNewData(), { archive: files, confirm: '已切换 NDBC 观测时次。' });
      }
    } catch (error) { if (generation === importRevision) notify(error.message, 'error'); }
  });
  $('frequency').addEventListener('input', e => changeFrequency(Number(e.target.value)));
  for (const id of ['spectrum', 'fixed', 'mem']) bindFrequency($(id));
  $('spectrum').addEventListener('wheel', zoomAt, { passive: false });
  const zoomReset = () => { state.bounds = null; drawSpectrum(); };
  $('zoom-reset').addEventListener('click', zoomReset);
  $('spectrum').addEventListener('dblclick', zoomReset);
  $('spectrum-toggles').addEventListener('click', e => {
    const b = e.target.closest('button[data-curve]');
    if (!b) return;
    const key = b.dataset.curve;
    if (state.curves[key] && Object.values(state.curves).filter(Boolean).length === 1) { notify('保留至少一条曲线以查看频谱。'); return; }
    state.curves[key] = !state.curves[key]; b.setAttribute('aria-pressed', state.curves[key]); drawSpectrum();
  });
  $('scales').addEventListener('click', e => { const b = e.target.closest('[data-scale]'); if (b) { state.scale = b.dataset.scale; select($('scales'), 'scale', state.scale); drawDirection(); } });
  $('timeline').addEventListener('click', e => {
    const i = hoveredIndex($('timeline'), e.clientX, e.clientY);
    const row = state.displayDays?.[i];
    const record = state.data?.cases.find(item => item.time.slice(0, 10) === row?.time.slice(0, 10));
    if (record) selectCase(record);
    else if (row) notify(`${dateLabel(row.time)} UTC · 谱有效波高 ${rounded(row.hm0)} m`);
  });
  $('assume-direction').addEventListener('click', () => selectRecord(state.record, { ...state.prefs, assume: true }, { archive: state.archiveFiles, confirm: '已应用固定 cos² 方向假设。' }));
  $('remove-assumption').addEventListener('click', () => selectRecord(state.record, { ...state.prefs, assume: false }, { archive: state.archiveFiles, confirm: '已恢复一维分析。' }));
  $('lab-play').addEventListener('click', () => { if (!state.lab) setupLab(); if (state.lab) state.lab.play(!state.lab.playing()); updatePlayButtons(); });
  $('time-slider').addEventListener('input', e => seekTime(+e.target.value));
  $('rewind-time').addEventListener('click', () => seekTime(0));
  $('play-speeds').addEventListener('click', e => {
    const button = e.target.closest('[data-speed]');
    if (!button) return;
    state.speed = Number(button.dataset.speed);
    state.lab?.setRate(state.speed);
    select($('play-speeds'), 'speed', button.dataset.speed);
  });
  $('views').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b) { state.view = b.dataset.mode; state.lab?.setView(state.view); updateViewReading(); }
  });
  $('top-view').addEventListener('click', () => { state.lab?.top(); updateViewReading(); });
  $('reset-view').addEventListener('click', () => { state.lab?.reset(); updateViewReading(); });
  $('reset-point').addEventListener('click', () => setPoint({ x: 0, y: 0 }));
  $('trace').addEventListener('click', e => {
    const index = hoveredIndex($('trace'), e.clientX, e.clientY);
    if (index != null) seekTime(index * .25);
  });
  $('trace').addEventListener('keydown', e => {
    const direction = { ArrowLeft: -.25, ArrowRight: .25 }[e.key];
    if (direction == null) return;
    e.preventDefault();
    seekTime(state.labTime + direction);
  });
  $('probe-form').addEventListener('submit', e => {
    e.preventDefault();
    const point = { x: +$('probe-x').value, y: +$('probe-y').value };
    const seed = +$('seed').value;
    if (seed === state.prefs.seed) { setPoint(point); return; }
    selectRecord(state.record, { ...state.prefs, point, seed }, { archive: state.archiveFiles, keepTime: true, confirm: '已更新测点和随机种子。' });
  });
  document.querySelectorAll('[data-pin-reference]').forEach(button => button.addEventListener('click', pinReference));
  $('restore-reference').addEventListener('click', () => {
    const ref = state.reference;
    if (ref) selectRecord(ref.record, structuredClone(ref.prefs), { archive: ref.archive, confirm: '已恢复基准实验。' });
  });
  $('export-comparison').addEventListener('click', exportComparison);
  $('compare-scales').addEventListener('click', event => {
    const button = event.target.closest('[data-compare-scale]');
    if (!button) return;
    state.compareScale = button.dataset.compareScale;
    select($('compare-scales'), 'compare-scale', state.compareScale);
    drawComparison();
  });
  $('check-presets').addEventListener('click', e => {
    const b = e.target.closest('button[data-scenario]');
    if (!b || !state.result?.direction) return;
    if (state.prefs.scenario === b.dataset.scenario) {
      if (!state.jobs.size && scenarios().some(id => !state.stats.get(id)?.outcome)) {
        for (const id of scenarios()) if (!state.stats.get(id)?.outcome) state.stats.delete(id);
        runChecks();
      }
      return;
    }
    remember(); state.prefs.scenario = b.dataset.scenario; persist(); runChecks(); updateComparison();
  });
  $('cancel-check').addEventListener('click', () => {
    state.validationRun++;
    for (const key of [...state.jobs.keys()].filter(name => name.startsWith('checks-'))) cancel(key);
    $('check-status').textContent = '已取消 · 可以重新选择方案计算'; $('cancel-check').hidden = true;
    for (const id of scenarios()) if (!state.stats.has(id)) state.stats.set(id, { error: '计算已取消。切换方案或重新运行当前方案。', cancelled: true });
    fillCheckCards();
  });
  $('custom-form').addEventListener('submit', e => {
    e.preventDefault(); if (!state.result?.direction) return;
    const custom = { dt: +$('custom-dt').value, segment: +$('custom-segment').value, duration: +$('custom-duration').value };
    try { validateSettings(custom, Math.max(...state.result.rows.filter(row => row.s > 0).map(row => row.f))); }
    catch (error) { notify(error.message, 'error'); return; }
    remember(); state.prefs.custom = custom;
    state.prefs.scenario = 'custom'; state.stats.delete('custom'); persist(); runChecks(); updateComparison();
  });
  for (const [id, action] of [['export-json', exportJson], ['export-csv', exportCsv], ['export-image', exportPng]]) {
    $(id).addEventListener('click', () => { $('export-dialog').close(); action(); });
  }
  const resize = new ResizeObserver(() => { cancelAnimationFrame(redraw.frame); redraw.frame = requestAnimationFrame(redraw); });
  resize.observe(document.querySelector('main'));
}

async function start() {
  bind();
  try { if (localStorage.getItem(shade) === 'light') changeTheme(true); } catch { /* dark default */ }
  const fetchJson = async file => {
    const response = await fetch(new URL(`data/${file}`, base));
    if (!response.ok) throw new Error('无法读取内置数据，请刷新后重试。');
    return response.json();
  };
  fetchJson('ne-land.json').then(map => { state.map = map; if (state.data) stationMap($('map'), map, state.data.station); }).catch(() => {});
  try {
    state.data = await fetchJson('buoy.json');
    state.data.cases.forEach(record => { record.origin ||= 'NOAA NDBC 实测档案'; });
    makeCaseButtons();
    const fallback = state.data.cases.find(record => record.id === 'storm');
    let saved = null;
    try {
      const text = localStorage.getItem(storage);
      if (text) saved = parseFiles([{ name: 'previous.json', text }]);
    } catch { /* continue with the public example */ }
    const found = builtInCase(saved?.record);
    if (!state.record && !state.pending) await selectRecord(found || saved?.record || fallback, saved?.prefs || initialPrefs(), { save: false });
    void loadReference();
  } catch (error) { notify(error.message, 'error'); }
}

void start();
