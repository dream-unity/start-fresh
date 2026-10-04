import * as THREE from '../vendor/three/three.module.min.js';

// The same space stays mounted throughout a conversation. Regions are positions,
// never pages; the application supplies intent, this module supplies movement.
const REGIONS = {
  unity: { color: 0x9dcfff, position: [0, 0.4, 0] },
  machine: { color: 0x4fc8ff, position: [-6.3, 1.4, -3.6] },
  maker: { color: 0x70e8b5, position: [6.1, 0.9, -3.2] },
  world: { color: 0xb39bff, position: [0.4, 4.2, -6.2] },
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const normalizeRegion = value => {
  const name = String(value || '').toLowerCase().replace(/^dream[\s_-]*/, '');
  return Object.hasOwn(REGIONS, name) ? name : 'unity';
};
const hash = value => [...String(value)].reduce((n, c) => ((n * 31) + c.charCodeAt(0)) >>> 0, 2166136261);

function randomSequence(seed = 76392) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

function crystalGeometry(radius, height, sides = 4) {
  // Individually colored faces preserve a cut-glass silhouette without a heavy
  // postprocessing pipeline, external textures, or screen-space reflections.
  const vertices = [];
  const colors = [];
  const face = (a, b, c, shade) => {
    vertices.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) colors.push(shade, shade, shade);
  };
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2 + Math.PI / 4;
    const next = ((i + 1) / sides) * Math.PI * 2 + Math.PI / 4;
    const a = [Math.cos(angle) * radius, height * 0.09, Math.sin(angle) * radius];
    const b = [Math.cos(next) * radius, height * 0.09, Math.sin(next) * radius];
    face([0, height * 0.64, 0], b, a, 0.65 + (i % 3) * 0.16);
    face([0, -height * 0.53, 0], a, b, 0.46 + (i % 3) * 0.17);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function emptyScene(canvas, onReady, error) {
  canvas.dataset.renderer = 'fallback';
  onReady?.({ webgl: false, error });
  return {
    setRegion() {}, setListening() {}, setSpeaking() {}, setEnergy() {},
    setMemory() {}, setMotion() {}, dispose() {},
  };
}

/**
 * A bounded, disposable visual layer. No microphone, model, or persistence APIs
 * are owned here. WebGL loss cannot change the conversation's application state.
 */
export function createScene(canvas, { onReady, onRegion } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch (error) {
    return emptyScene(canvas, onReady, error);
  }

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x030810, 0.014);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobile = window.matchMedia('(max-width: 680px)');
  let motion = !reducedMotion.matches;
  let requestedMotion = true;
  let disposed = false;
  let contextLost = false;
  let frame = 0;
  let previousTime = 0;
  let elapsed = 0;
  let energy = 0;
  let displayedEnergy = 0;
  let listening = false;
  let speaking = false;
  let region = 'unity';
  let cameraFocus = true;
  const resources = new Set();
  const tracked = item => { resources.add(item); return item; };
  const targetCamera = new THREE.Vector3();
  const cameraLook = new THREE.Vector3(0, 0, 0);
  const targetLook = new THREE.Vector3(0, 0, 0);
  const group = new THREE.Group();
  scene.add(group);

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile.matches ? 1.5 : 1.8));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.setClearColor(0x030810, 0);

  scene.add(new THREE.AmbientLight(0xadc7ec, 1.6));
  const key = new THREE.DirectionalLight(0xe9f4ff, 4.2);
  key.position.set(-4, 8, 9);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x536dff, 3.2);
  rim.position.set(5, 1, -8);
  scene.add(rim);
  const warm = new THREE.DirectionalLight(0xffe4ad, 1.1);
  warm.position.set(7, -3, 4);
  scene.add(warm);

  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = glowCanvas.height = 64;
  const glowContext = glowCanvas.getContext('2d');
  if (glowContext) {
    const gradient = glowContext.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.08, 'rgba(255,255,255,.8)');
    gradient.addColorStop(0.28, 'rgba(255,255,255,.2)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    glowContext.fillStyle = gradient;
    glowContext.fillRect(0, 0, 64, 64);
  }
  const glowTexture = tracked(new THREE.CanvasTexture(glowCanvas));
  const makeGlow = (color, size, opacity, parent) => {
    const material = tracked(new THREE.SpriteMaterial({
      map: glowTexture, color, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(size, size, 1);
    parent.add(sprite);
    return sprite;
  };

  const makeCrystal = (radius, height, color, parent, sides = 4, edgeOpacity = 0.25) => {
    const geometry = tracked(crystalGeometry(radius, height, sides));
    const material = tracked(new THREE.MeshStandardMaterial({
      color, vertexColors: true, emissive: color, emissiveIntensity: 0.09,
      metalness: 0.55, roughness: 0.18, flatShading: true,
      transparent: true, opacity: 0.86,
    }));
    const mesh = new THREE.Mesh(geometry, material);
    const edges = new THREE.LineSegments(
      tracked(new THREE.EdgesGeometry(geometry)),
      tracked(new THREE.LineBasicMaterial({ color, transparent: true, opacity: edgeOpacity })),
    );
    mesh.add(edges);
    parent.add(mesh);
    return mesh;
  };

  const makeLine = (points, color, opacity, parent = group) => {
    const line = new THREE.Line(
      tracked(new THREE.BufferGeometry().setFromPoints(points)),
      tracked(new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })),
    );
    parent.add(line);
    return line;
  };

  const nexus = new THREE.Group();
  nexus.position.fromArray(REGIONS.unity.position);
  group.add(nexus);
  const centralCrystal = makeCrystal(0.83, 2.66, 0x789edb, nexus, 4, 0.75);
  centralCrystal.rotation.set(0.03, Math.PI / 9, 0.07);
  const innerCrystal = makeCrystal(0.25, 1.46, 0xb9e2ff, nexus, 4, 0.25);
  innerCrystal.rotation.y = Math.PI / 4;
  const coreGlow = makeGlow(0x79baff, 3.8, 0.46, nexus);
  coreGlow.position.z = -0.2;
  const coreLight = new THREE.PointLight(0x86caff, 5, 13, 2);
  nexus.add(coreLight);

  // Two intersecting geometric halos give Unity a precise architectural form.
  const halos = [];
  for (let i = 0; i < 3; i++) {
    const points = [];
    for (let j = 0; j <= 160; j++) {
      const a = (j / 160) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * (2.35 + i * 0.31), 0, Math.sin(a) * (2.35 + i * 0.31)));
    }
    const halo = makeLine(points, i === 2 ? 0xc7dcf8 : 0x769ed4, i === 2 ? 0.1 : 0.26, nexus);
    halo.rotation.set(i === 0 ? 0.18 : 0.6, 0, i === 1 ? 0.37 : -0.28);
    halos.push(halo);
  }

  const assemblies = {};
  const flowPaths = [];
  const rnd = randomSequence();
  for (const name of ['machine', 'maker', 'world']) {
    const spec = REGIONS[name];
    const assembly = new THREE.Group();
    assembly.position.fromArray(spec.position);
    group.add(assembly);
    const crystals = [];
    const geometry = new THREE.Group();
    assembly.add(geometry);
    const glow = makeGlow(spec.color, 4.8, 0.29, assembly);
    glow.position.z = -0.5;
    const base = new THREE.Vector3(...spec.position);
    const path = new THREE.CubicBezierCurve3(
      new THREE.Vector3(0, 0.25, 0),
      new THREE.Vector3(base.x * 0.3, base.y + 1.8, 1.4),
      new THREE.Vector3(base.x * 0.8, base.y - 1.4, base.z + 1.6),
      base,
    );
    const thread = makeLine(path.getPoints(80), spec.color, 0.15);
    const pulse = makeGlow(spec.color, 0.18, 0, group);
    flowPaths.push({ name, path, thread, pulse });

    if (name === 'machine') {
      // Possibility branches: each tiny crystal is an unrealised direction.
      crystals.push(makeCrystal(0.53, 1.9, spec.color, geometry, 4, 0.55));
      for (let i = 0; i < 9; i++) {
        const a = i * 2.39996;
        const r = 0.82 + (i % 3) * 0.26;
        const end = new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r * 0.8, -0.18 - rnd() * 0.45);
        const shard = makeCrystal(0.10 + rnd() * 0.05, 0.39 + rnd() * 0.36, spec.color, geometry);
        shard.position.copy(end);
        shard.rotation.set(rnd() * 0.2, a, -Math.cos(a) * 0.48);
        crystals.push(shard);
        const branch = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, -0.25), end.clone().multiplyScalar(0.55).add(new THREE.Vector3(0, 0.35, 0)), end);
        makeLine(branch.getPoints(18), spec.color, 0.32, geometry);
      }
    } else if (name === 'maker') {
      // Agency: upright, gathered geometry; a gold axis holds emerald facets.
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const shard = makeCrystal(i === 0 ? 0.36 : 0.22, i === 0 ? 2.25 : 1.1, i === 0 ? 0xbddc9c : spec.color, geometry, 4, 0.42);
        shard.position.set(i === 0 ? 0 : Math.cos(a) * 0.52, i === 0 ? 0.15 : -0.24, i === 0 ? 0 : Math.sin(a) * 0.52);
        shard.rotation.z = i === 0 ? -0.06 : -Math.cos(a) * 0.16;
        crystals.push(shard);
      }
      const circle = [];
      for (let i = 0; i <= 80; i++) { const a = i / 80 * Math.PI * 2; circle.push(new THREE.Vector3(Math.cos(a), -0.7, Math.sin(a))); }
      makeLine(circle, 0xd7c995, 0.45, geometry);
    } else {
      // Consequence: grounded interlocking structures with many shared edges.
      for (let i = 0; i < 11; i++) {
        const a = i * 2.39996;
        const r = Math.sqrt(i / 11) * 1.1;
        const shard = makeCrystal(0.24 + rnd() * 0.12, 0.7 + rnd() * 0.95, spec.color, geometry, 6, 0.29);
        shard.position.set(Math.cos(a) * r, -0.25 + rnd() * 0.35, Math.sin(a) * r * 0.55);
        shard.rotation.set(rnd() * 0.22, a, (rnd() - 0.5) * 0.32);
        crystals.push(shard);
      }
    }
    assemblies[name] = { assembly, geometry, crystals, glow, intensity: 0 };
  }

  // Orbital architecture is shared by the three regions. Its ellipses read as
  // luminous paths rather than a collection of disconnected destination cards.
  const orbitGroup = new THREE.Group();
  orbitGroup.rotation.set(0.42, -0.12, -0.08);
  group.add(orbitGroup);
  for (let k = 0; k < 5; k++) {
    const points = [];
    for (let i = 0; i <= 180; i++) {
      const a = i / 180 * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * (7.1 + k * 0.6), Math.sin(a) * (3.8 + k * 0.38), -4.2));
    }
    makeLine(points, k % 2 ? 0x96a9cd : 0x38536f, k === 0 ? 0.29 : 0.12, orbitGroup);
  }

  const starPositions = [];
  const starColors = [];
  for (let i = 0; i < (mobile.matches ? 290 : 580); i++) {
    starPositions.push((rnd() - 0.5) * 62, (rnd() - 0.5) * 36, -6 - rnd() * 44);
    const luminosity = 0.35 + rnd() * 0.65;
    starColors.push(luminosity * 0.66, luminosity * 0.78, luminosity);
  }
  const starsGeometry = tracked(new THREE.BufferGeometry());
  starsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
  starsGeometry.setAttribute('color', new THREE.Float32BufferAttribute(starColors, 3));
  const stars = new THREE.Points(starsGeometry, tracked(new THREE.PointsMaterial({
    size: 0.075, map: glowTexture, vertexColors: true, transparent: true,
    opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false,
  })));
  scene.add(stars);

  const memoryGroup = new THREE.Group();
  group.add(memoryGroup);
  let memoryResources = [];

  function setMemory(nodes = []) {
    memoryGroup.clear();
    memoryResources.forEach(item => item.dispose());
    memoryResources = [];
    const nodesById = new Map();
    const positions = [];
    const colors = [];
    const entries = Array.isArray(nodes) ? nodes.filter(node => node && node.id).slice(0, 120) : [];
    for (const node of entries) {
      const seed = hash(node.id);
      const a = ((seed % 6283) / 1000);
      const ring = 4 + ((seed >>> 8) % 250) / 100;
      const position = new THREE.Vector3(Math.cos(a) * ring, Math.sin(a) * ring * 0.58, -1.4 - ((seed >>> 16) % 200) / 100);
      const key = normalizeRegion(node.region || node.world);
      const color = new THREE.Color(REGIONS[key].color);
      if (node.archived || node.status === 'archived') color.multiplyScalar(0.25);
      positions.push(...position.toArray());
      colors.push(color.r, color.g, color.b);
      nodesById.set(String(node.id), position);
    }
    if (!positions.length) { start(); return; }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({ size: 0.26, map: glowTexture, vertexColors: true, transparent: true, opacity: 0.96, blending: THREE.AdditiveBlending, depthWrite: false });
    memoryResources.push(geometry, material);
    memoryGroup.add(new THREE.Points(geometry, material));
    const edgePositions = [];
    const seen = new Set();
    for (const node of entries) {
      const links = node.connections || node.relatedIds || node.links || [];
      if (!Array.isArray(links)) continue;
      for (const link of links.slice(0, 12)) {
        const target = String(typeof link === 'object' ? link?.id || link?.target : link);
        const key = [String(node.id), target].sort().join('|');
        if (seen.has(key) || !nodesById.has(target) || target === String(node.id)) continue;
        seen.add(key);
        edgePositions.push(...nodesById.get(String(node.id)).toArray(), ...nodesById.get(target).toArray());
      }
    }
    if (edgePositions.length) {
      const edges = new THREE.BufferGeometry();
      edges.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
      const lineMaterial = new THREE.LineBasicMaterial({ color: 0x9cacd8, transparent: true, opacity: 0.28 });
      memoryResources.push(edges, lineMaterial);
      memoryGroup.add(new THREE.LineSegments(edges, lineMaterial));
    }
    start();
  }

  function updateCamera() {
    const narrow = canvas.clientWidth / Math.max(canvas.clientHeight, 1) < 0.8;
    const position = REGIONS[region].position;
    const focus = region !== 'unity' && cameraFocus;
    const distance = narrow ? 25 : 18.4;
    targetCamera.set(focus ? position[0] * 0.69 : 0, focus ? position[1] * 0.61 + 1.3 : 1.25, distance + (focus ? -3.7 : 0));
    targetLook.set(focus ? position[0] * 0.82 : 0, focus ? position[1] * 0.7 : -0.15, focus ? position[2] * 0.4 : -1.6);
    if (!motion) { camera.position.copy(targetCamera); cameraLook.copy(targetLook); camera.lookAt(cameraLook); }
  }

  function resize() {
    if (disposed) return;
    const width = Math.max(1, canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, canvas.clientHeight || window.innerHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    updateCamera();
    start();
  }

  function setRegion(value, { focus = true } = {}) {
    region = normalizeRegion(value);
    cameraFocus = focus;
    updateCamera();
    onRegion?.(region);
    start();
  }

  function tick(time) {
    frame = 0;
    if (disposed || contextLost || document.hidden) return;
    const delta = Math.min((time - (previousTime || time)) / 1000, 0.05);
    previousTime = time;
    if (motion) elapsed += delta;
    const smooth = 1 - Math.exp(-delta * 3.6);
    displayedEnergy += (energy - displayedEnergy) * (1 - Math.exp(-delta * 12));
    const activity = listening ? 0.23 + displayedEnergy * 0.65 : speaking ? 0.26 + (motion ? Math.sin(elapsed * 4) * 0.08 : 0) : 0;
    const breath = motion ? Math.sin(elapsed * 0.75) * 0.06 : 0;
    centralCrystal.rotation.y = Math.PI / 9 + (motion ? elapsed * 0.055 : 0);
    centralCrystal.position.y = breath;
    innerCrystal.rotation.y = Math.PI / 4 - (motion ? elapsed * 0.07 : 0);
    centralCrystal.material.emissiveIntensity = 0.09 + activity * 0.4;
    coreGlow.material.opacity = 0.4 + activity * 0.3 + breath;
    coreLight.intensity = 3.4 + activity * 4;
    coreGlow.scale.setScalar(3.8 + activity * 0.7);
    halos[1].rotation.y = motion ? elapsed * 0.018 : 0;
    halos[2].rotation.z = -0.28 + (motion ? Math.sin(elapsed * 0.15) * 0.09 : 0);
    stars.rotation.z = motion ? Math.sin(elapsed * 0.03) * 0.006 : 0;
    for (const [name, item] of Object.entries(assemblies)) {
      const target = name === region ? 1 : region === 'unity' ? 0.23 : 0.04;
      item.intensity = motion ? item.intensity + (target - item.intensity) * smooth : target;
      item.glow.material.opacity = 0.15 + item.intensity * 0.45 + activity * 0.07;
      item.geometry.position.y = motion ? Math.sin(elapsed * 0.52 + REGIONS[name].position[0]) * 0.085 : 0;
      item.geometry.rotation.y = motion ? Math.sin(elapsed * 0.09) * 0.15 : 0;
      item.crystals.forEach(crystal => { crystal.material.emissiveIntensity = 0.045 + item.intensity * 0.28 + activity * 0.07; });
    }
    for (let i = 0; i < flowPaths.length; i++) {
      const { name, path, thread, pulse } = flowPaths[i];
      const active = name === region || region === 'unity';
      thread.material.opacity = 0.08 + (active ? 0.14 : 0.02) + activity * 0.17;
      pulse.position.copy(path.getPoint(motion ? (elapsed * 0.15 + i * 0.31) % 1 : 0.5));
      pulse.material.opacity = activity > 0 ? (active ? 0.8 : 0.25) : 0.16;
      pulse.scale.setScalar(0.13 + activity * 0.24);
    }
    if (motion) { camera.position.lerp(targetCamera, smooth * 0.64); cameraLook.lerp(targetLook, smooth * 0.64); }
    camera.lookAt(cameraLook);
    renderer.render(scene, camera);
    if (motion || listening || speaking || displayedEnergy > 0.001) frame = requestAnimationFrame(tick);
  }

  function start() {
    if (!frame && !disposed && !contextLost && !document.hidden) { previousTime = 0; frame = requestAnimationFrame(tick); }
  }
  function visibilityChange() {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; previousTime = 0; }
    else start();
  }
  function motionPreference() { motion = requestedMotion && !reducedMotion.matches; updateCamera(); start(); }
  function loseContext(event) {
    event.preventDefault();
    contextLost = true;
    canvas.dataset.renderer = 'fallback';
    cancelAnimationFrame(frame);
    frame = 0;
    onReady?.({ webgl: false, error: new Error('WebGL context lost') });
  }
  function restoreContext() {
    contextLost = false;
    canvas.dataset.renderer = 'webgl';
    resize();
    onReady?.({ webgl: true });
    start();
  }
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', visibilityChange);
  reducedMotion.addEventListener?.('change', motionPreference);
  canvas.addEventListener('webglcontextlost', loseContext);
  canvas.addEventListener('webglcontextrestored', restoreContext);
  resize();
  camera.position.copy(targetCamera);
  cameraLook.copy(targetLook);
  canvas.dataset.renderer = 'webgl';
  onReady?.({ webgl: true });
  start();

  return {
    setRegion,
    setListening(value) { listening = Boolean(value); start(); },
    setSpeaking(value) { speaking = Boolean(value); start(); },
    setEnergy(value) { energy = Number.isFinite(value) ? clamp(value, 0, 1) : 0; start(); },
    setMemory,
    setMotion(value) { requestedMotion = Boolean(value); motion = requestedMotion && !reducedMotion.matches; updateCamera(); start(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visibilityChange);
      reducedMotion.removeEventListener?.('change', motionPreference);
      canvas.removeEventListener('webglcontextlost', loseContext);
      canvas.removeEventListener('webglcontextrestored', restoreContext);
      memoryResources.forEach(item => item.dispose());
      resources.forEach(item => item.dispose());
      renderer.dispose();
      scene.clear();
    },
  };
}
