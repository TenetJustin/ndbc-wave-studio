import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { analysis, comingTo, memDensity, moments, phases, PRESETS, samplePoint, validateSimulation, waveAt, welch } from '../src/science.js';
import { experiment, parseFiles } from '../src/input.js';

const data = JSON.parse(await readFile(new URL('../public/data/buoy.json', import.meta.url), 'utf8'));
const near = (x, y, tolerance) => assert.ok(Math.abs(x - y) <= tolerance, `${x} differs from ${y} by more than ${tolerance}`);

test('NOAA cases reproduce gradient bandwidth moments and independent fit errors', () => {
  const references = {
    calibration: [2.886000693, 9.090909091, .095814825, .057383486],
    storm: [9.300881679, 12.903225806, .107069589, .053764404],
    multipeak: [2.093943648, 9.090909091, .083716771, .246093129],
  };
  assert.equal(data.station.records, 12109);
  for (const item of data.cases) {
    const result = analysis(item), expected = references[item.id];
    near(result.stat.hm0, expected[0], 1e-7);
    near(result.stat.tp, expected[1], 1e-7);
    near(result.fits.ittcError, expected[2], 1e-7);
    near(result.fits.jonswapError, expected[3], 1e-7);
    assert.equal(result.direction.assumed, false);
    assert.equal(result.direction.unavailableBins, 0);
  }
});

test('MEM normalizes and orients a wrapped Cauchy distribution', () => {
  const angles = Array.from({ length: 48 }, (_, i) => 2 * Math.PI * i / 48);
  const d = memDensity({ a1: 0, a2: 0, r1: .5, r2: .25 }, angles);
  assert.equal(comingTo(0), 270);
  assert.equal(comingTo(90), 180);
  assert.equal(d.indexOf(Math.max(...d)), 36);
  near(d[36] / d[12], 9, 1e-9);
  near(d.reduce((sum, v) => sum + v, 0) * 2 * Math.PI / 48, 1, 1e-12);
});

test('component energy equals input m0 and fixed-point recurrence equals spatial summation', () => {
  const result = analysis(data.cases.find(c => c.id === 'storm'));
  const groups = phases(result, 41046), modes = groups.flatMap(v => v.values);
  near(modes.reduce((sum, m) => sum + m.a ** 2 / 2, 0), result.stat.m0, 1e-10);
  assert.deepEqual(phases(result, 41046), groups);
  const point = { x: 12, y: -30 }, dt = .14, series = samplePoint(groups, point, dt, 790);
  for (const i of [0, 81, 789]) near(series[i], waveAt(modes, point.x, point.y, i * dt), 1e-9);
  const w = 1.2, k = .3, t = 1;
  near(waveAt([{ a: 1, kx: k, ky: 0, w, phase: 0 }], w * t / k, 0, t), 1, 1e-12);
});

test('Welch density is one-sided and conserved on a sinusoid', () => {
  const dt = .125, f = .125, amplitude = 2;
  const values = Float64Array.from({ length: 4096 }, (_, i) => amplitude * Math.cos(2 * Math.PI * f * i * dt));
  const output = welch(values, dt, 512);
  assert.equal(output.frequency[output.power.indexOf(Math.max(...output.power))], f);
  // The symmetric Hann window leaves a small finite-window deviation from A²/2.
  near(output.power.reduce((total, value) => total + value, 0) * output.interval, 2, 1e-6);
  assert.equal(output.segments, 15);
});

test('default Welch presets share a seeded realization and use the expected number of segments', () => {
  const result = analysis(data.cases.find(c => c.id === 'storm'));
  const groups = phases(result, 41046), point = { x: 0, y: 0 };
  const original = validateSimulation(result.rows, groups, point, PRESETS.original);
  const updated = validateSimulation(result.rows, groups, point, PRESETS.updated);
  assert.equal(original.spectral.segments, 34);
  assert.equal(updated.spectral.segments, 111);
  near(original.spectral.interval, .001220703125, 1e-12);
  near(updated.spectral.interval, .00390625, 1e-12);
  original.samples.filter((_, i) => i % 5 === 0).forEach((value, i) => near(value, updated.samples[i], 1e-9));
  assert.throws(() => validateSimulation(result.rows, groups, point, { dt: 2, segment: 64, duration: 300 }), /奈奎斯特/);
});

test('missing archive bins preserve original band widths, not the new gaps', () => {
  const f = { name: '41046w2025.txt', text: '#YY MM DD hh mm .0200 .0325 .0375 .0425 .0475 .0525\n2025 04 22 00 10 0 1 1 999 1 1\n' };
  const { record } = parseFiles([f]);
  assert.equal(record.missingBins, 1);
  near(moments(record.rows).m0, .02, 1e-12);
  assert.equal(analysis(record).direction, null);
  assert.equal(analysis(record, true).direction.assumed, true);
});

test('CSV and JSON round trip, including comparison state and fixed point', async () => {
  const csv = await readFile(new URL('../public/data/example-spectrum.csv', import.meta.url), 'utf8');
  const data = parseFiles([{ name: 'example.csv', text: csv }]).record;
  const prefs = { seed: 37, point: { x: -12, y: 4 }, assume: false, scenario: 'both', custom: { ...PRESETS.updated } };
  const json = JSON.stringify(experiment(data, prefs));
  const revived = parseFiles([{ name: 'experiment.json', text: json }]);
  assert.deepEqual(revived.record.rows, data.rows);
  assert.deepEqual(revived.prefs, prefs);
  assert.throws(() => parseFiles([{ name: 'conflict.csv', text: 'frequency_hz,spectrum_m2_per_hz\n.05,1\n.05,2\n.1,3\n.2,4' }]), /冲突的重复/);
});
