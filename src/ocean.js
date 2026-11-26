import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { waveAt } from './science.js';

const MAX_MODES = 112;
const DOMAIN = 320;
const motion = matchMedia('(prefers-reduced-motion: reduce)');

const vertex = `
uniform sampler2D uModes;
uniform int uCount;
uniform float uTime;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec2 vUv;
void main(){
  vec3 p=position;
  float height=0.0;
  vec2 slope=vec2(0.0);
  for(int i=0;i<${MAX_MODES};i++){
    if(i>=uCount)break;
    float u=(float(i)+0.5)/float(${MAX_MODES});
    vec4 a=texture2D(uModes,vec2(u,0.25));
    float phase=texture2D(uModes,vec2(u,0.75)).r;
    float theta=dot(a.yz,vec2(p.x,-p.z))-a.w*uTime+phase;
    height+=a.x*cos(theta);
    slope-=a.x*sin(theta)*vec2(a.y,-a.z);
  }
  p.y=height;
  vPosition=p;
  vNormal=normalize(vec3(-slope.x,1.0,-slope.y));
  vUv=uv;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
}`;

const fragment = `
uniform float uRange;
uniform float uOcean;
uniform float uHero;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec2 vUv;
void main(){
  vec3 n=normalize(vNormal);
  vec3 l=normalize(vec3(-0.55,0.82,-0.37));
  vec3 eye=normalize(cameraPosition-vPosition);
  float elevation=clamp(0.5+0.5*vPosition.y/uRange,0.0,1.0);
  float diffuse=max(dot(n,l),0.0);
  float reflectance=pow(1.0-max(dot(n,eye),0.0),3.4);
  float spec=pow(max(dot(n,normalize(eye+l)),0.0),45.0);
  vec3 deep=vec3(0.017,0.07,0.14);
  vec3 mid=vec3(0.04,0.39,0.42);
  vec3 pale=vec3(0.69,0.95,0.71);
  vec3 color=mix(deep,mid,smoothstep(0.13,0.63,elevation));
  color=mix(color,pale,smoothstep(0.59,0.97,elevation));
  vec3 water=mix(vec3(0.015,0.093,0.14),vec3(0.043,0.43,0.43),smoothstep(0.24,0.85,elevation));
  water*=0.61+0.58*diffuse;
  water+=vec3(0.22,0.38,0.39)*reflectance+vec3(0.81,0.95,0.82)*spec*0.56;
  water+=vec3(0.56,0.79,0.62)*smoothstep(0.76,0.99,elevation)*0.35*diffuse;
  color=mix(color,water,uOcean);
  if(uHero>0.5){
    float level=vPosition.y*0.74;
    float contour=1.0-smoothstep(0.017,0.11,abs(fract(level+0.5)-0.5));
    color=mix(color,vec3(0.57,0.91,0.76),contour*0.35*(0.3+elevation*0.7));
  }
  vec2 edges=min(vUv,1.0-vUv);
  float alpha=smoothstep(0.0,mix(0.045,0.15,uHero),min(edges.x,edges.y));
  gl_FragColor=vec4(color,alpha);
  #include <colorspace_fragment>
}`;

export function visibleModes(modes, max = MAX_MODES) {
  const all = modes.slice().sort((a, b) => b.a - a.a);
  const values = all.slice(0, max);
  const energy = all.reduce((s, m) => s + m.a ** 2, 0);
  const shown = values.reduce((s, m) => s + m.a ** 2, 0);
  return { values, share: energy ? shown / energy : 0 };
}

function simulationLoop(host, render, options) {
  let time = 0, playing = false, visible = false, valid = true, frameId = 0, last = 0;
  function tick(now) {
    frameId = 0;
    if (!valid || !visible || document.hidden) return;
    if (playing && last) time = (time + Math.min(.08, (now - last) / 1000) * (options.hero ? 1.1 : 1)) % 80;
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
  return { request, time() { return time; }, seek(t) { time = t; last = 0; request(); },
    play(on) { playing = Boolean(on); last = 0; request(); }, playing() { return playing; },
    dispose() { valid = false; observer.disconnect(); resize.disconnect(); document.removeEventListener('visibilitychange', onVisibility); cancelAnimationFrame(frameId); } };
}

function create2d(host, options) {
  const canvas = document.createElement('canvas');
  canvas.className = 'ocean-canvas';
  canvas.setAttribute('aria-label', '二维波面高程。点击选择固定点');
  canvas.tabIndex = options.hero ? -1 : 0;
  host.append(canvas);
  const ctx = canvas.getContext('2d');
  const grid = document.createElement('canvas'); grid.width = 57; grid.height = 46;
  const gc = grid.getContext('2d'); const data = gc.createImageData(grid.width, grid.height);
  let modes = [], range = 4, point = { x: 0, y: 0 }, lastDraw = -100, changed = true, view = options.hero ? 'ocean' : 'science';
  const loop = simulationLoop(host, (t, now) => {
    if (!changed && loop.playing() && now - lastDraw < 48) return false;
    lastDraw = now; changed = false;
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    for (let j = 0; j < grid.height; j++) for (let i = 0; i < grid.width; i++) {
      const fraction = Math.max(0, Math.min(1, .5 + .5 * waveAt(modes, DOMAIN * (i / (grid.width - 1) - .5), DOMAIN * (.5 - j / (grid.height - 1)), t) / range));
      const ink = view === 'science' ? [150, 215, 146] : [103, 178, 146];
      const at = (j * grid.width + i) * 4;
      data.data[at] = 14 + ink[0] * fraction ** 2;
      data.data[at + 1] = 35 + ink[1] * fraction;
      data.data[at + 2] = 62 + ink[2] * fraction * .75;
      data.data[at + 3] = 255;
    }
    gc.putImageData(data, 0, 0); ctx.drawImage(grid, 0, 0, w, h);
    if (!options.hero) {
      const x = (point.x / DOMAIN + .5) * w, y = (.5 - point.y / DOMAIN) * h;
      ctx.strokeStyle = '#fff5b4'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
    }
    return false;
  }, options);
  if (!options.hero) canvas.addEventListener('click', e => {
    const r = canvas.getBoundingClientRect();
    options.pick?.({ x: DOMAIN * ((e.clientX - r.left) / r.width - .5), y: DOMAIN * (.5 - (e.clientY - r.top) / r.height) });
  });
  if (!options.hero) canvas.addEventListener('keydown', e => {
    const step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 10], ArrowDown: [0, -10] }[e.key];
    if (!step) return;
    e.preventDefault();
    options.pick?.({ x: Math.max(-160, Math.min(160, point.x + step[0])), y: Math.max(-160, Math.min(160, point.y + step[1])) });
  });
  return { ...loop, kind: '2d', setData(value, hm0) { const kept = visibleModes(value, 84); modes = kept.values; range = Math.max(.02, hm0 * .59); changed = true; loop.request(); return kept.share; },
    setView(next) { view = next; changed = true; loop.request(); }, setPoint(p) { point = p; changed = true; loop.request(); },
    top() {}, reset() {}, dispose() { loop.dispose(); canvas.remove(); } };
}

export function oceanStage(host, options = {}) {
  try {
    if (new URLSearchParams(location.search).get('renderer') === '2d') return create2d(host, options);
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'high-performance' });
    if (!gl) return create2d(host, options);
    const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    canvas.className = 'ocean-canvas';
    canvas.setAttribute('aria-label', options.hero ? 'Three.js 海面预览' : 'Three.js 三维海面，拖动选择视角，点击选择固定点');
    if (!options.hero) canvas.tabIndex = 0;
    host.append(canvas);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(options.hero ? 37 : 36, 1, 2, 1400);
    const texture = new THREE.DataTexture(new Float32Array(MAX_MODES * 8), MAX_MODES, 2, THREE.RGBAFormat, THREE.FloatType);
    texture.needsUpdate = true;
    const geometry = new THREE.PlaneGeometry(DOMAIN, DOMAIN, innerWidth <= 760 ? 55 : 86, innerWidth <= 760 ? 55 : 86);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, transparent: true, side: THREE.DoubleSide,
      uniforms: { uModes: { value: texture }, uCount: { value: 0 }, uRange: { value: 4 }, uTime: { value: 0 }, uOcean: { value: options.hero ? 1 : 0 }, uHero: { value: options.hero ? 1 : 0 } } });
    const mesh = new THREE.Mesh(geometry, material); scene.add(mesh);
    const markerGeometry = new THREE.SphereGeometry(2, 14, 10);
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xfff0aa });
    const marker = new THREE.Mesh(markerGeometry, markerMaterial); if (!options.hero) scene.add(marker);
    const controls = options.hero ? null : new OrbitControls(camera, canvas);
    if (controls) {
      controls.enableDamping = !motion.matches;
      controls.enablePan = false; controls.enableZoom = false;
      controls.minDistance = 126; controls.maxDistance = 850; controls.maxPolarAngle = Math.PI * .494;
      if (matchMedia('(pointer: coarse)').matches) { controls.enabled = false; canvas.style.touchAction = 'pan-y'; }
      canvas.addEventListener('focus', () => { controls.enableZoom = true; });
      canvas.addEventListener('blur', () => { controls.enableZoom = false; });
    }
    let shown = [], worldPoint = { x: 0, y: 0 }, view = options.hero ? 'ocean' : 'science', size = '', zoom = 1.0;
    let toTop = false, lastCamera = new THREE.Vector3(), nextDpr = Math.min(1.45, devicePixelRatio || 1);
    function cameraPreset(top = false) {
      toTop = top;
      const aspect = host.clientWidth / Math.max(host.clientHeight, 1);
      const s = (aspect < .94 ? 1.37 : 1.13) * zoom;
      if (top) camera.position.set(0, 620 * s, .2);
      else if (options.hero) camera.position.set(248 * s, 111 * s, 275 * s);
      else camera.position.set(250 * s, 176 * s, 287 * s);
      camera.lookAt(0, 0, 0);
      if (controls) { controls.target.set(0, 0, 0); controls.update(); }
    }
    cameraPreset();
    const loop = simulationLoop(host, (t, now) => {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return false;
      const key = `${w}/${h}/${nextDpr}`;
      if (size !== key) {
        const oldAspect = camera.aspect;
        size = key; renderer.setPixelRatio(nextDpr); renderer.setSize(w, h, false);
        camera.aspect = w / h; camera.updateProjectionMatrix();
        if (options.hero || (oldAspect < .94) !== (camera.aspect < .94)) cameraPreset(toTop);
      }
      material.uniforms.uTime.value = t;
      controls?.update();
      marker.position.set(worldPoint.x, waveAt(shown, worldPoint.x, worldPoint.y, t) + 2.7, -worldPoint.y);
      renderer.render(scene, camera);
      const moving = lastCamera.distanceToSquared(camera.position) > .000005;
      lastCamera.copy(camera.position);
      return Boolean(controls) && moving;
    }, options);
    const watchMotion = () => { if (controls) controls.enableDamping = !motion.matches; if (motion.matches) loop.play(false); };
    motion.addEventListener('change', watchMotion);
    controls?.addEventListener('change', loop.request);
    let start;
    if (controls) {
      canvas.addEventListener('pointerdown', e => { start = [e.clientX, e.clientY]; });
      canvas.addEventListener('pointerup', e => {
        if (!start || Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 6) return;
        if (e.pointerType === 'touch' && !controls.enabled) {
          controls.enabled = true; canvas.style.touchAction = 'none'; canvas.focus({ preventScroll: true });
        }
        const r = canvas.getBoundingClientRect();
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
        const p = new THREE.Vector3();
        if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) && Math.abs(p.x) <= DOMAIN / 2 && Math.abs(p.z) <= DOMAIN / 2) options.pick?.({ x: p.x, y: -p.z });
      });
      canvas.addEventListener('blur', () => {
        if (matchMedia('(pointer: coarse)').matches) { controls.enabled = false; canvas.style.touchAction = 'pan-y'; }
      });
      canvas.addEventListener('keydown', e => {
        const move = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 10], ArrowDown: [0, -10] }[e.key];
        if (!move) return;
        e.preventDefault(); options.pick?.({ x: Math.max(-160, Math.min(160, worldPoint.x + move[0])), y: Math.max(-160, Math.min(160, worldPoint.y + move[1])) });
      });
    }
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); loop.play(false); options.onLost?.(); });
    return { ...loop, kind: 'three', setData(values, hm0) {
      const kept = visibleModes(values, innerWidth <= 760 ? 92 : MAX_MODES); shown = kept.values;
      texture.image.data.fill(0);
      shown.forEach((m, i) => { texture.image.data.set([m.a, m.kx, m.ky, m.w], 4 * i); texture.image.data[(MAX_MODES + i) * 4] = m.phase; });
      texture.needsUpdate = true; material.uniforms.uCount.value = shown.length;
      material.uniforms.uRange.value = Math.max(.02, hm0 * .59); loop.request(); return kept.share;
    }, setView(next) { view = next; material.uniforms.uOcean.value = view === 'ocean' ? 1 : 0; loop.request(); },
    setPoint(p) { worldPoint = p; loop.request(); }, top() { cameraPreset(true); loop.request(); }, reset() { zoom = 1; cameraPreset(); loop.request(); },
    dispose() { loop.dispose(); motion.removeEventListener('change', watchMotion); controls?.dispose(); markerGeometry.dispose(); markerMaterial.dispose(); geometry.dispose(); material.dispose(); texture.dispose(); renderer.dispose(); canvas.remove(); } };
  } catch { return create2d(host, options); }
}

export { create2d };
