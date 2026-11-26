import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { waveAt } from './science.js';

const MAX_MODES = 112;
const DOMAIN = 320;
const HORIZON = 9800;
const motion = matchMedia('(prefers-reduced-motion: reduce)');

const atmosphere = `
const vec3 sun = normalize(vec3(-0.37, 0.105, -0.93));
vec3 clearSky(vec3 ray) {
  float height = max(0.0, ray.y);
  float towardsSun = max(dot(ray, sun), 0.0);
  vec3 horizon = mix(vec3(0.32, 0.41, 0.53), vec3(0.78, 0.53, 0.34), pow(towardsSun, 9.0));
  vec3 zenith = vec3(0.072, 0.178, 0.34);
  vec3 color = mix(horizon, zenith, smoothstep(0.0, 0.6, height));
  return color + vec3(0.42, 0.24, 0.11) * pow(towardsSun, 76.0);
}
`;

const skyVertex = `
varying vec3 vRay;
void main() {
  vRay = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const skyFragment = `
varying vec3 vRay;
${atmosphere}
float hash2(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.54);
}
float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i+vec2(1,0)), f.x),
             mix(hash2(i+vec2(0,1)), hash2(i+vec2(1,1)), f.x), f.y);
}
void main() {
  vec3 ray = normalize(vRay);
  vec3 color = clearSky(ray);
  float horizon = max(ray.y, 0.0);
  vec2 p = ray.xz / (0.23 + horizon) * vec2(4.8, 10.0);
  float cloud = noise2(p)*0.57 + noise2(p*2.1+12.0)*0.28 + noise2(p*4.7-7.0)*0.15;
  float cloudBand = smoothstep(0.02, 0.095, horizon) * (1.0-smoothstep(0.38, 0.85, horizon));
  float sunAngle = max(dot(ray, sun), 0.0);
  vec3 warmCloud = mix(vec3(0.24, 0.32, 0.42), vec3(0.70, 0.47, 0.35), pow(sunAngle, 11.0));
  color = mix(color, warmCloud, smoothstep(0.44, 0.75, cloud)*cloudBand*0.66);
  color += vec3(1.0,0.78,0.50) * (0.21*pow(sunAngle,330.0) + 1.6*smoothstep(0.99977,0.99994,sunAngle));
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

const vertex = `
uniform sampler2D uModes;
uniform int uCount;
uniform float uTime;
uniform float uOcean;
varying vec3 vPosition;
varying vec3 vNormal;
void main() {
  vec3 p = position;
  float height = 0.0;
  vec2 slope = vec2(0.0);
  float radius = max(abs(p.x), abs(p.z));
  float blend = uOcean > 0.5 ? 1.0 - smoothstep(161.0, 365.0, radius) : 1.0;
  if (blend > 0.0) {
    for (int i = 0; i < ${MAX_MODES}; i++) {
      if (i >= uCount) break;
      float u = (float(i) + 0.5) / float(${MAX_MODES});
      vec4 a = texture2D(uModes, vec2(u, 0.25));
      float phase = texture2D(uModes, vec2(u, 0.75)).r;
      float theta = dot(a.yz, vec2(p.x, -p.z)) - a.w * uTime + phase;
      height += a.x * cos(theta);
      slope -= a.x * sin(theta) * vec2(a.y, -a.z);
    }
  }
  p.y = height * blend;
  vPosition = p;
  vNormal = normalize(vec3(-slope.x * blend, 1.0, -slope.y * blend));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const fragment = `
uniform float uRange;
uniform float uOcean;
uniform float uTime;
varying vec3 vPosition;
varying vec3 vNormal;
${atmosphere}
void main() {
  vec3 n = normalize(vNormal);
  vec3 eye = normalize(cameraPosition-vPosition);
  float height = clamp(0.5+0.5*vPosition.y/uRange, 0.0, 1.0);
  vec3 color;
  if (uOcean > 0.5) {
    vec2 p = vPosition.xz;
    float distanceToEye = length(cameraPosition - vPosition);
    float footprint = max(length(dFdx(p)),length(dFdy(p)));
    float ripple = (1.0 - smoothstep(110.0, 445.0, distanceToEye)) * (1.0-smoothstep(0.35,2.7,footprint));
    vec2 q = p + vec2(sin(dot(p,vec2(.17,.21))),cos(dot(p,vec2(.22,-.13))))*2.9;
    float detail = cos(dot(q,vec2(1.19,-0.72))-uTime*1.6);
    float crossing = cos(dot(q,vec2(-0.63,1.67))-uTime*1.9);
    float capillary = sin(dot(q,vec2(2.5,2.1))-uTime*2.5);
    n = normalize(n + vec3(detail*.053-crossing*.017+capillary*.018, 0.0, crossing*.048-detail*.034+capillary*.012)*ripple);
    vec3 reflectRay = reflect(-eye, n);
    float fresnel = 0.03 + 0.86 * pow(1.0-max(dot(n,eye),0.0), 4.4);
    vec3 water = mix(vec3(0.008,0.019,0.035), vec3(0.025,0.085,0.117), height);
    vec3 skyReflected = clearSky(reflectRay) * vec3(0.40,0.56,0.72);
    float glare = pow(max(dot(n,normalize(sun+eye)),0.0), 105.0);
    float glow = pow(max(dot(reflectRay,sun),0.0), 16.0);
    color = mix(water, skyReflected, fresnel);
    color += vec3(0.74,0.47,0.27) * (glare * 0.85 + glow * 0.12);
    float haze = 1.0 - exp(-distanceToEye * 0.00039);
    color = mix(color, clearSky(-eye), haze);
  } else {
    color = mix(vec3(0.012,0.031,0.09),vec3(0.09,0.31,0.43), smoothstep(0.04,0.62,height));
    color = mix(color,vec3(0.88,0.83,0.60), smoothstep(0.59,0.97,height));
    vec2 cell = vPosition.xz / 40.0;
    vec2 line = abs(fract(cell - 0.5) - 0.5) / max(fwidth(cell), vec2(0.0001));
    float grid = 1.0 - min(min(line.x,line.y),1.0);
    color = mix(color, vec3(0.47,0.64,0.69), grid * 0.23);
    float edge = max(abs(vPosition.x), abs(vPosition.z));
    color = mix(color, vec3(0.46,0.67,0.78), smoothstep(159.2,160.0,edge)*0.44);
  }
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

export function visibleModes(modes, max = MAX_MODES) {
  const all = modes.slice().sort((a, b) => b.a - a.a);
  const values = all.slice(0, max);
  const energy = all.reduce((s, m) => s + m.a ** 2, 0);
  const shown = values.reduce((s, m) => s + m.a ** 2, 0);
  return { values, share: energy ? shown / energy : 0 };
}

function simulationLoop(host, render, options) {
  let time = 0, rate = 1, playing = false, visible = false, valid = true, frameId = 0, last = 0;
  function tick(now) {
    frameId = 0;
    if (!valid || !visible || document.hidden) return;
    if (playing && last) time = (time + Math.min(.08, (now - last) / 1000) * rate) % 80;
    last = now;
    const shouldContinue = render(time, now);
    options.onTime?.(time);
    if (playing || shouldContinue) request();
  }
  function request() { if (!frameId && valid && visible && !document.hidden) frameId = requestAnimationFrame(tick); }
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    last = 0;
    if (visible) request();
  });
  observer.observe(host);
  const onVisibility = () => { last = 0; request(); };
  document.addEventListener('visibilitychange', onVisibility);
  const resize = new ResizeObserver(() => request());
  resize.observe(host);
  return { request, setRate(value) { rate = value; }, seek(t) { time = t; last = 0; request(); },
    play(on) { playing = Boolean(on); last = 0; request(); }, playing() { return playing; },
    dispose() { valid = false; observer.disconnect(); resize.disconnect(); document.removeEventListener('visibilitychange', onVisibility); cancelAnimationFrame(frameId); } };
}

function create2d(host, options) {
  const canvas = document.createElement('canvas');
  canvas.className = 'ocean-canvas';
  canvas.setAttribute('aria-label', '二维波面高程。点击选择固定点');
  canvas.tabIndex = 0;
  host.append(canvas);
  const ctx = canvas.getContext('2d');
  const grid = document.createElement('canvas'); grid.width = 57; grid.height = 46;
  const gc = grid.getContext('2d'); const data = gc.createImageData(grid.width, grid.height);
  let modes = [], range = 4, point = { x: 0, y: 0 }, lastDraw = -100, changed = true;
  const loop = simulationLoop(host, (t, now) => {
    if (!changed && loop.playing() && now - lastDraw < 48) return false;
    lastDraw = now; changed = false;
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    for (let j = 0; j < grid.height; j++) for (let i = 0; i < grid.width; i++) {
      const fraction = Math.max(0, Math.min(1, .5 + .5 * waveAt(modes, DOMAIN * (i / (grid.width - 1) - .5), DOMAIN * (.5 - j / (grid.height - 1)), t) / range));
      const ink = [150, 186, 155];
      const at = (j * grid.width + i) * 4;
      data.data[at] = 14 + ink[0] * fraction ** 2;
      data.data[at + 1] = 35 + ink[1] * fraction;
      data.data[at + 2] = 62 + ink[2] * fraction * .75;
      data.data[at + 3] = 255;
    }
    gc.putImageData(data, 0, 0); ctx.drawImage(grid, 0, 0, w, h);
    const x = (point.x / DOMAIN + .5) * w, y = (.5 - point.y / DOMAIN) * h;
    ctx.strokeStyle = '#ffdbb8'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
    return false;
  }, options);
  canvas.addEventListener('click', e => {
    const r = canvas.getBoundingClientRect();
    options.pick?.({ x: DOMAIN * ((e.clientX - r.left) / r.width - .5), y: DOMAIN * (.5 - (e.clientY - r.top) / r.height) });
  });
  canvas.addEventListener('keydown', e => {
    const step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 10], ArrowDown: [0, -10] }[e.key];
    if (!step) return;
    e.preventDefault();
    options.pick?.({ x: Math.max(-160, Math.min(160, point.x + step[0])), y: Math.max(-160, Math.min(160, point.y + step[1])) });
  });
  return { ...loop, kind: '2d', setData(value, hm0) { const kept = visibleModes(value, 84); modes = kept.values; range = Math.max(.02, hm0 * .59); changed = true; loop.request(); return kept.share; },
    setView() {}, setPoint(p) { point = p; changed = true; loop.request(); },
    top() {}, reset() {}, dispose() { loop.dispose(); canvas.remove(); } };
}

function oceanGrid(segments) {
  const grid = new THREE.PlaneGeometry(2, 2, segments, segments);
  grid.rotateX(-Math.PI / 2);
  const custom = grid.attributes.position;
  const edge = 0.74;
  const coordinate = value => {
    const radius = Math.abs(value);
    if (radius <= edge) return value * DOMAIN / (2 * edge);
    return Math.sign(value) * (DOMAIN / 2 + (HORIZON - DOMAIN / 2) * ((radius - edge) / (1 - edge)) ** 3.7);
  };
  for (let i = 0; i < custom.count; i++) custom.setXYZ(i, coordinate(custom.getX(i)), 0, coordinate(custom.getZ(i)));
  return grid;
}

function pickSurface(ray, modes, time) {
  // Clip the ray to the square observation domain, then find the front crossing
  // of the same height function that deforms the rendered surface.
  const half = DOMAIN / 2;
  let near = 0, far = Infinity;
  for (const axis of ['x', 'z']) {
    const origin = ray.origin[axis], slope = ray.direction[axis];
    if (Math.abs(slope) < 1e-8) {
      if (Math.abs(origin) > half) return null;
      continue;
    }
    const low = (-half - origin) / slope, high = (half - origin) / slope;
    near = Math.max(near, Math.min(low, high));
    far = Math.min(far, Math.max(low, high));
  }
  if (near > far) return null;
  const heightBound = modes.reduce((sum, mode) => sum + mode.a, 0);
  if (Math.abs(ray.direction.y) < 1e-8) {
    if (Math.abs(ray.origin.y) > heightBound) return null;
  } else {
    const low = (-heightBound - ray.origin.y) / ray.direction.y;
    const high = (heightBound - ray.origin.y) / ray.direction.y;
    near = Math.max(near, Math.min(low, high));
    far = Math.min(far, Math.max(low, high));
  }
  if (near > far || !Number.isFinite(far)) return null;
  const at = t => {
    const x = ray.origin.x + t * ray.direction.x, y = -ray.origin.z - t * ray.direction.z;
    return ray.origin.y + t * ray.direction.y - waveAt(modes, x, y, time);
  };
  let t0 = near, h0 = at(t0);
  while (t0 <= far) {
    const t1 = Math.min(far, t0 + 2.4), h1 = at(t1);
    if (h0 * h1 <= 0) {
      let lo = t0, hi = t1;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if (h0 * at(mid) > 0) lo = mid;
        else hi = mid;
      }
      const timeAlongRay = (lo + hi) / 2;
      return { x: ray.origin.x + timeAlongRay * ray.direction.x, y: -ray.origin.z - timeAlongRay * ray.direction.z };
    }
    if (t1 === far) break;
    t0 = t1; h0 = h1;
  }
  return null;
}

export function oceanStage(host, options = {}) {
  if (new URLSearchParams(location.search).get('renderer') === '2d') return create2d(host, options);
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'high-performance' });
  if (!gl) return create2d(host, options);

  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: true }); }
  catch { return create2d(host, options); }
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  canvas.className = 'ocean-canvas';
  canvas.setAttribute('aria-label', 'Three.js 三维波面。拖动选择视角，点按或用方向键选择固定点。');
  canvas.tabIndex = 0;
  host.append(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(43, 1, 0.7, 14200);
  const texture = new THREE.DataTexture(new Float32Array(MAX_MODES * 8), MAX_MODES, 2, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  const mobile = innerWidth <= 760;
  const heightGrid = new THREE.PlaneGeometry(DOMAIN, DOMAIN, mobile ? 52 : 84, mobile ? 52 : 84);
  heightGrid.rotateX(-Math.PI / 2);
  const seaGrid = oceanGrid(mobile ? 74 : 102);
  const surface = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, side: THREE.DoubleSide,
    uniforms: { uModes: { value: texture }, uCount: { value: 0 }, uRange: { value: 4 }, uTime: { value: 0 }, uOcean: { value: 1 } } });
  const sea = new THREE.Mesh(seaGrid, surface);
  scene.add(sea);
  const skyShape = new THREE.SphereGeometry(11000, 40, 22);
  const skyMaterial = new THREE.ShaderMaterial({ vertexShader: skyVertex, fragmentShader: skyFragment, side: THREE.BackSide, depthWrite: false });
  const sky = new THREE.Mesh(skyShape, skyMaterial);
  sky.renderOrder = -1;
  scene.add(sky);

  const stem = new THREE.CylinderGeometry(.44, .62, 5.3, 10);
  const head = new THREE.SphereGeometry(1.0, 14, 10);
  const ring = new THREE.RingGeometry(1.7, 2.05, 32);
  ring.rotateX(-Math.PI / 2);
  const markerInk = new THREE.MeshBasicMaterial({ color: 0xffb67b, side: THREE.DoubleSide });
  const capInk = new THREE.MeshBasicMaterial({ color: 0xffe6cb });
  const marker = new THREE.Group();
  const markerStem = new THREE.Mesh(stem, markerInk), markerHead = new THREE.Mesh(head, capInk);
  markerStem.position.y = 2.1;
  markerHead.position.y = 5.0;
  marker.add(markerStem, markerHead, new THREE.Mesh(ring, markerInk));
  scene.add(marker);

  const controls = new OrbitControls(camera, canvas);
  const coarse = matchMedia('(pointer: coarse)');
  controls.enableDamping = !motion.matches;
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.minDistance = 30;
  controls.maxDistance = 900;
  controls.maxPolarAngle = Math.PI * .496;
  if (coarse.matches) { controls.enabled = false; canvas.style.touchAction = 'pan-y'; }
  canvas.addEventListener('focus', () => { controls.enableZoom = true; });
  canvas.addEventListener('blur', () => {
    controls.enableZoom = false;
    if (coarse.matches) { controls.enabled = false; canvas.style.touchAction = 'pan-y'; }
  });

  let modes = [], point = { x: 0, y: 0 }, view = 'ocean', size = '', toTop = false, renderedTime = 0, cameraMove = null;
  const lastCamera = new THREE.Vector3();
  const dpr = Math.min(mobile ? 1.14 : 1.38, devicePixelRatio || 1);
  function cameraPreset(top = false, animate = false) {
    toTop = top;
    const aspect = host.clientWidth / Math.max(host.clientHeight, 1);
    const scale = Math.max(1, .95 / Math.max(.5, aspect));
    const position = new THREE.Vector3(), target = new THREE.Vector3(0, top || view === 'science' ? 0 : 7, 0);
    const fov = top || view === 'science' ? 39 : 45;
    if (top) position.set(0, 540 * scale, .18);
    else if (view === 'ocean') position.set(86 * Math.min(scale, 1.22), 19, 132 * Math.min(scale, 1.22));
    else position.set(288 * scale, 224 * scale, 307 * scale);
    if (animate && !motion.matches && size) {
      cameraMove = { position, target, fov, from: camera.position.clone(), fromTarget: controls.target.clone(), fromFov: camera.fov, start: performance.now() };
      return;
    }
    cameraMove = null;
    camera.position.copy(position);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    controls.target.copy(target);
    controls.update();
  }
  cameraPreset();
  const loop = simulationLoop(host, (t, now) => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return false;
    const key = `${w}/${h}`;
    if (size !== key) {
      const oldAspect = camera.aspect;
      size = key;
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if ((oldAspect < .9) !== (camera.aspect < .9)) cameraPreset(toTop);
    }
    surface.uniforms.uTime.value = t;
    renderedTime = t;
    if (cameraMove) {
      const progress = Math.max(0, Math.min(1, (now - cameraMove.start) / 320));
      const easing = 1 - (1 - progress) ** 3;
      camera.position.lerpVectors(cameraMove.from, cameraMove.position, easing);
      controls.target.lerpVectors(cameraMove.fromTarget, cameraMove.target, easing);
      camera.fov = THREE.MathUtils.lerp(cameraMove.fromFov, cameraMove.fov, easing);
      camera.updateProjectionMatrix();
      if (progress === 1) cameraMove = null;
    }
    controls.update();
    if (!cameraMove && toTop && Math.hypot(camera.position.x, camera.position.z) > 15) {
      toTop = false;
      options.onCamera?.();
    }
    marker.position.set(point.x, waveAt(modes, point.x, point.y, t) + .75, -point.y);
    if (sky.visible) sky.position.copy(camera.position);
    renderer.render(scene, camera);
    const moving = lastCamera.distanceToSquared(camera.position) > .000005;
    lastCamera.copy(camera.position);
    return moving || cameraMove !== null;
  }, options);

  const watchMotion = () => {
    controls.enableDamping = !motion.matches;
    if (motion.matches && cameraMove) { cameraPreset(toTop); loop.request(); }
  };
  motion.addEventListener('change', watchMotion);
  controls.addEventListener('change', loop.request);
  controls.addEventListener('start', () => { cameraMove = null; });
  const raycaster = new THREE.Raycaster();
  let start;
  canvas.addEventListener('pointerdown', e => { start = e.isPrimary && e.button === 0 ? [e.clientX, e.clientY] : null; });
  canvas.addEventListener('pointercancel', () => { start = null; });
  canvas.addEventListener('pointerup', e => {
    const beganAt = start;
    start = null;
    if (!e.isPrimary || e.button !== 0 || !beganAt || Math.hypot(e.clientX - beganAt[0], e.clientY - beganAt[1]) > 6) return;
    if (e.pointerType === 'touch' && !controls.enabled) {
      controls.enabled = true;
      canvas.style.touchAction = 'none';
      canvas.focus({ preventScroll: true });
    }
    const bounds = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((e.clientX - bounds.left) / bounds.width * 2 - 1, -(e.clientY - bounds.top) / bounds.height * 2 + 1), camera);
    const picked = pickSurface(raycaster.ray, modes, renderedTime);
    if (picked) options.pick?.(picked);
    else options.onOutside?.();
  });
  canvas.addEventListener('keydown', e => {
    const step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 10], ArrowDown: [0, -10] }[e.key];
    if (!step) return;
    e.preventDefault();
    options.pick?.({ x: Math.max(-160, Math.min(160, point.x + step[0])), y: Math.max(-160, Math.min(160, point.y + step[1])) });
  });
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); loop.play(false); options.onLost?.(); });

  return { ...loop, kind: 'three',
    setData(values, hm0) {
      const kept = visibleModes(values, mobile ? 84 : MAX_MODES);
      modes = kept.values;
      texture.image.data.fill(0);
      modes.forEach((mode, i) => {
        texture.image.data.set([mode.a, mode.kx, mode.ky, mode.w], 4 * i);
        texture.image.data[(MAX_MODES + i) * 4] = mode.phase;
      });
      texture.needsUpdate = true;
      surface.uniforms.uCount.value = modes.length;
      surface.uniforms.uRange.value = Math.max(.02, hm0 * .59);
      loop.request();
      return kept.share;
    },
    setView(next) {
      if (view === next) return;
      view = next;
      const ocean = view === 'ocean';
      surface.uniforms.uOcean.value = ocean ? 1 : 0;
      sea.geometry = ocean ? seaGrid : heightGrid;
      sky.visible = ocean;
      cameraPreset(toTop, true);
      loop.request();
    },
    setPoint(next) { point = next; loop.request(); },
    top() { cameraPreset(!toTop, true); loop.request(); },
    isTop() { return toTop; },
    reset() { cameraPreset(false, true); loop.request(); },
    dispose() {
      loop.dispose();
      motion.removeEventListener('change', watchMotion);
      controls.dispose();
      for (const item of [stem, head, ring, markerInk, capInk, skyShape, skyMaterial, heightGrid, seaGrid, surface, texture, renderer]) item.dispose();
      canvas.remove();
    },
  };
}

export { create2d };
