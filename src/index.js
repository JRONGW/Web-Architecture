import "./styles.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { BufferGeometryUtils } from "three/examples/jsm/utils/BufferGeometryUtils";
import * as TWEEN from "@tweenjs/tween.js";
import * as turf from "@turf/turf";

import WORLD_TEXTURE from "../assets/world.jpg";
import TREECOVER_DATA_URL from "../data/forestclipped.asc";
import GDP_ASC_URL from "../data/2000GDPresample.asc";

import COUNTRY_BRAZIL from "../data/Brazil.geojson";
import COUNTRY_POLAND from "../data/Poland.geojson";
import COUNTRY_SOUTHKOREA from "../data/SouthKorea.geojson";
import GLOBAL_BOUNDARIES from "../data/globalboundaries.geojson";

/* ---------------- Tweens ---------------- */
class TweenManger {
  constructor() { this.numTweensRunning = 0; }
  _handleComplete() { --this.numTweensRunning; console.assert(this.numTweensRunning >= 0); }
  createTween(targetObject) {
    const self = this;
    ++this.numTweensRunning;
    let userCompleteFn = () => {};
    const tween = new TWEEN.Tween(targetObject).onComplete(function (...args) {
      self._handleComplete();
      userCompleteFn.call(this, ...args);
    });
    tween.onComplete = (fn) => { userCompleteFn = fn; return tween; };
    return tween;
  }
  update() { TWEEN.update(); return this.numTweensRunning > 0; }
}

/* ---------------- Main ---------------- */
function main() {
  const canvas = document.querySelector("#c");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const tweenManager = new TweenManger();

  const fov = 60, aspect = 2, near = 0.1, far = 10;
  const camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
  camera.position.set(4, 0, 0);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 1.5;
  controls.maxDistance = 3;
  controls.update();

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("black");

  // --- mapping fudge (must match rasters & bars) ---
  const lonFudge = Math.PI * 0.5;
  const latFudge = Math.PI * -0.135;

  // projector helpers at scene root
  const lonHelperLL = new THREE.Object3D(); scene.add(lonHelperLL);
  const latHelperLL = new THREE.Object3D(); lonHelperLL.add(latHelperLL);
  const posHelperLL = new THREE.Object3D(); posHelperLL.position.z = 1.01; // a hair above the globe
  latHelperLL.add(posHelperLL);

  function normLon(lon) {
    let L = lon;
    if (L > 180) L -= 360;
    if (L < -180) L += 360;
    return L;
  }
  function normLon360(lon) {
    return ((lon + 180) % 360 + 360) % 360 - 180; // [-180,180)
  }
  function projectLL(lat, lon) {
    lonHelperLL.rotation.y = THREE.MathUtils.degToRad(normLon(lon)) + lonFudge;
    latHelperLL.rotation.x = THREE.MathUtils.degToRad(lat) + latFudge;
    posHelperLL.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixPosition(posHelperLL.matrixWorld);
  }
  function vector3ToLatLon(v) {
    const r = v.length();
    const phi = Math.acos(v.y / r);
    const theta = Math.atan2(v.z, v.x);
    const lat = 90 - THREE.MathUtils.radToDeg(phi);
    let lon = THREE.MathUtils.radToDeg(theta);
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    return { lat, lon };
  }

  /* ---------- Globe ---------- */
  let earthMesh;
  {
    const loader = new THREE.TextureLoader();
    const texture = loader.load(WORLD_TEXTURE, render);
    const geometry = new THREE.SphereGeometry(1, 64, 32);
    const material = new THREE.MeshBasicMaterial({ map: texture });
    earthMesh = new THREE.Mesh(geometry, material);
    earthMesh.rotation.y = Math.PI * -0.5;
    scene.add(earthMesh);

    const atmosphereShader = {
      uniforms: {},
      vertexShader: `
        varying vec3 vNormal;
        void main(){
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }`,
      fragmentShader: `
        varying vec3 vNormal;
        void main(){
          float intensity = pow(0.8 - dot(vNormal, vec3(0,0,1.0)), 12.0);
          gl_FragColor = vec4(1.0,1.0,1.0,1.0) * intensity;
        }`
    };
    const atmosphereMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(atmosphereShader.uniforms),
      vertexShader: atmosphereShader.vertexShader,
      fragmentShader: atmosphereShader.fragmentShader,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true
    });
    const atmosphereMesh = new THREE.Mesh(new THREE.SphereGeometry(1.07, 40, 30), atmosphereMaterial);
    atmosphereMesh.scale.set(1.1, 1.1, 1.1);
    scene.add(atmosphereMesh);
  }

  /* ---------- Groups & materials ---------- */
  const countryOutlineGroup = new THREE.Group(); countryOutlineGroup.rotation.y = Math.PI * -0.5; scene.add(countryOutlineGroup);
  const globalBoundariesGroup = new THREE.Group(); globalBoundariesGroup.rotation.y = Math.PI * -0.5; scene.add(globalBoundariesGroup);
  const labelGroup = new THREE.Group(); labelGroup.rotation.y = Math.PI * -0.5; scene.add(labelGroup);

  const outlineMaterial = new THREE.LineBasicMaterial({
    color: 0xffffb3, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  const globalBoundariesMaterial = new THREE.LineBasicMaterial({
    color: 0xcbcbcb, transparent: true, opacity: 0.2, depthWrite: false
  });

  const geoJsonLatOffset = 25;

  /* ---------- Labels ---------- */
  const LABEL_NORMAL = { text: "rgba(255,255,255,0.95)", underline: "rgba(255,255,255,0.85)" };
  const LABEL_HOVER  = { text: "#ffd24d", underline: "#ffd24d" };

  function drawLabelTexture(text, hovered = false) {
    const colors = hovered ? LABEL_HOVER : LABEL_NORMAL;
    const font = "600 24px Georgia, serif";
    const underlineThickness = 2;
    const underlineGap = 6;
    const paddingX = 6, paddingY = 4;

    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    ctx.font = font;

    const w = Math.ceil(ctx.measureText(text).width);
    const h = Math.ceil(24 * 1.25);
    const cw = w + paddingX * 2;
    const ch = h + paddingY * 2;

    const pot = (n) => 2 ** Math.ceil(Math.log2(n));
    c.width = pot(cw); c.height = pot(ch);
    ctx.scale(c.width / cw, c.height / ch);
    ctx.clearRect(0, 0, cw, ch);

    ctx.font = font;
    ctx.fillStyle = colors.text;
    ctx.textBaseline = "middle";
    const midY = ch / 2;
    ctx.fillText(text, paddingX, midY);

    const underlineY = midY + Math.floor(24 / 2) - 4 + underlineGap;
    ctx.beginPath();
    ctx.moveTo(paddingX, underlineY);
    ctx.lineTo(paddingX + w, underlineY);
    ctx.lineWidth = underlineThickness;
    ctx.strokeStyle = colors.underline;
    ctx.stroke();

    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return { texture: tex, width: cw, height: ch };
  }

  function makeTextSprite(text) {
    const { texture, width, height } = drawLabelTexture(text, false);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, transparent: true, depthTest: false, depthWrite: false,
    }));
    const spriteWorldHeight = 0.16;
    const aspect = width / height;
    sprite.scale.set(spriteWorldHeight * aspect, spriteWorldHeight, 1);
    sprite.renderOrder = 1000;

    sprite.userData._hovered = false;
    sprite.userData.updateHover = (hovered) => {
      if (sprite.userData._hovered === hovered) return;
      sprite.userData._hovered = hovered;
      const t2 = drawLabelTexture(text, hovered).texture;
      sprite.material.map.dispose();
      sprite.material.map = t2;
      sprite.material.needsUpdate = true;
    };
    return sprite;
  }

  function addCountryLabel({ name, code, lat, lon }) {
    const pos = projectLL(-lat + geoJsonLatOffset, lon);
    const outward = pos.clone().normalize().multiplyScalar(1.02);
    const label = makeTextSprite(name);
    label.position.copy(outward);
    label.userData.countryCode = code;
    label.name = `label:${code}`;
    labelGroup.add(label);
    return label;
  }

  addCountryLabel({ name: "Brazil",      code: "BRA", lat: -10.0, lon: -52.0 });
  addCountryLabel({ name: "Poland",      code: "POL", lat:  52.0, lon:  19.0 });
  addCountryLabel({ name: "South Korea", code: "KOR", lat:  36.0, lon: 128.0 });

  /* ---------- Boundaries & helpers ---------- */
  function ringToLine(ring, material) {
    const pts = [];
    for (const [lon, lat] of ring) pts.push(projectLL(-lat + geoJsonLatOffset, lon));
    const [lon0, lat0] = ring[0], [lonN, latN] = ring[ring.length - 1];
    if (lon0 !== lonN || lat0 !== latN) pts.push(projectLL(-lat0 + geoJsonLatOffset, lon0));
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material.clone());
  }
  function addCountryOutline(feature, parentGroup, material) {
    const g = feature.geometry; if (!g) return;
    const addPoly = (poly) => {
      parentGroup.add(ringToLine(poly[0], material));
      for (let i = 1; i < poly.length; ++i) {
        const hole = ringToLine(poly[i], material);
        hole.material.opacity = material.opacity * 0.4;
        parentGroup.add(hole);
      }
    };
    if (g.type === "Polygon") addPoly(g.coordinates);
    else if (g.type === "MultiPolygon") for (const poly of g.coordinates) addPoly(poly);
  }

  async function loadFile(url) { const req = await fetch(url); return req.text(); }

  // ESRI ASCII parser (normalizes xllcenter/yllcenter to corners)
  function parseData(text) {
    if (text && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const data = [], settings = { data };
    let max, min;

    const lines = text.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2) {
        const k = parts[0], raw = parts[1], v = Number(raw);
        settings[k] = Number.isFinite(v) ? v : raw;
      } else if (parts.length > 2) break;
    }

    const hasXCenter = "xllcenter" in settings;
    const hasYCenter = "yllcenter" in settings;

    settings.ncols = Number(settings.ncols);
    settings.nrows = Number(settings.nrows);
    settings.cellsize = Number(settings.cellsize);
    settings.NODATA_value = Number(settings.NODATA_value);

    let xll = Number(settings.xllcorner);
    let yll = Number(settings.yllcorner);
    if (hasXCenter) xll = Number(settings.xllcenter) - settings.cellsize * 0.5;
    if (hasYCenter) yll = Number(settings.yllcenter) - settings.cellsize * 0.5;
    settings.xllcorner = xll; settings.yllcorner = yll;

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length <= 2) continue;
      const values = parts.map((str) => {
        const v = Number(str);
        if (!Number.isFinite(v)) return undefined;
        if (v === settings.NODATA_value) return undefined;
        max = Math.max(max === undefined ? v : max, v);
        min = Math.min(min === undefined ? v : min, v);
        return v;
      });
      data.push(values);
    }
    return Object.assign(settings, { min, max });
  }

  const COUNTRY_FEATURES = [];

  async function loadGlobalBoundaries() {
    try {
      const res = await fetch(GLOBAL_BOUNDARIES);
      const gj = await res.json();
      const features = gj.type === "FeatureCollection" ? gj.features : gj.type === "Feature" ? [gj] : [];
      const polys = features.filter(f => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"));
      polys.forEach(f => addCountryOutline(f, globalBoundariesGroup, globalBoundariesMaterial));
    } catch (e) { console.error("[global boundaries] Failed to load:", e); }
  }

  async function loadCountries() {
    const infos = [
      { name: "Brazil", code: "BRA", url: COUNTRY_BRAZIL },
      { name: "Poland", code: "POL", url: COUNTRY_POLAND },
      { name: "South Korea", code: "KOR", url: COUNTRY_SOUTHKOREA }
    ];
    for (const info of infos) {
      try {
        const res = await fetch(info.url);
        const gj = await res.json();
        const features = gj.type === "FeatureCollection" ? gj.features : gj.type === "Feature" ? [gj] : [];
        const polys = features.filter(f => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"));
        polys.forEach(f => {
          const transformGeometry = (geom) => {
            const transformCoords = (coords) => {
              if (typeof coords[0] === "number") { const [lon, lat] = coords; return [lon, -lat + geoJsonLatOffset]; }
              return coords.map(transformCoords);
            };
            const newGeom = { type: geom.type };
            if (geom.type === "Polygon") newGeom.coordinates = geom.coordinates.map(r => transformCoords(r));
            else if (geom.type === "MultiPolygon") newGeom.coordinates = geom.coordinates.map(p => p.map(r => transformCoords(r)));
            return newGeom;
          };
          COUNTRY_FEATURES.push({ type: "Feature", properties: { NAME: info.name, CODE: info.code }, geometry: transformGeometry(f.geometry) });
          addCountryOutline(f, countryOutlineGroup, outlineMaterial);
        });
      } catch (e) { console.error(`[countries] Failed to load ${info.name}:`, e); }
    }
  }

  /* ---------- Raster bars (generic) ---------- */
  function makeBoxes(file, hueRange, maxBoxes = 150_000, opts = {}) {
    const { min, max, data, xllcorner, yllcorner, cellsize, nrows, ncols } = file;
    const range = (max - min) || 1;
    const invertLightness = !!opts.invertLightness; // true => high values look darker

    const totalCells = nrows * ncols;
    const stride = Math.max(1, Math.ceil(Math.sqrt(totalCells / maxBoxes)));

    const lonHelper = new THREE.Object3D(); scene.add(lonHelper);
    const latHelper = new THREE.Object3D(); lonHelper.add(latHelper);
    const positionHelper = new THREE.Object3D(); positionHelper.position.z = 1; latHelper.add(positionHelper);
    const originHelper = new THREE.Object3D(); originHelper.position.z = 0.5; positionHelper.add(originHelper);

    const color = new THREE.Color();
    const geometries = [];

    for (let row = 0; row < nrows; row += stride) {
      const lat = yllcorner + (row + 0.5) * cellsize;
      const rowData = data[row]; if (!rowData) continue;

      for (let col = 0; col < ncols; col += stride) {
        if (col === ncols - 1) continue; // avoid duplicated wrap column seam

        const v = rowData[col];
        if (v === undefined || v === 0) continue;

        const lonRaw = xllcorner + (col + 0.5) * cellsize;
        const lon = normLon360(lonRaw);

        const amount = (v - min) / range;

        const geometry = new THREE.BoxGeometry(1, 1, 1);

        lonHelper.rotation.y = THREE.MathUtils.degToRad(lon) + lonFudge;
        latHelper.rotation.x = THREE.MathUtils.degToRad(lat) + latFudge;

        positionHelper.scale.set(0.005, 0.005, THREE.MathUtils.lerp(0.000001, 0.02, amount));
        originHelper.updateWorldMatrix(true, false);
        geometry.applyMatrix4(originHelper.matrixWorld);

        // hue: use provided range (can be constant); lightness: optionally inverted
        const hue = THREE.MathUtils.lerp(...hueRange, amount);
        const lightness = invertLightness
          ? THREE.MathUtils.lerp(0.85, 0.25, amount)  // low->light blue, high->deep blue
          : THREE.MathUtils.lerp(0.4, 1.0, amount);

        color.setHSL(hue, 1, lightness);
        const rgb = color.toArray().map(x => x * 255);

        const numVerts = geometry.getAttribute("position").count;
        const colors = new Uint8Array(3 * numVerts);
        colors.forEach((_, i) => { colors[i] = rgb[i % 3]; });
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3, true));

        geometries.push(geometry);
      }
    }

    lonHelper.parent.remove(lonHelper);
    return geometries.length
      ? BufferGeometryUtils.mergeBufferGeometries(geometries, false)
      : new THREE.BufferGeometry();
  }

  /* ---------- Layers ---------- */
  async function loadAll() {
    const rasters = [
      { key: "tree",   name: "Tree Cover in 2000", hueRange: [0.28, 0.38], url: TREECOVER_DATA_URL, opts: {} },
      { key: "gdpasc", name: "GDP 2000 (ASC)",     hueRange: [0.60, 0.60], url: GDP_ASC_URL,        opts: { invertLightness: true } }
    ];
    await Promise.all(rasters.map(async r => { r.file = parseData(await loadFile(r.url)); }));

    const rasterMeshes = new Map();
    for (const r of rasters) {
      const geom = makeBoxes(r.file, r.hueRange, 150_000, r.opts);
      const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ vertexColors: true }));
      mesh.rotation.y = Math.PI * -0.5;
      mesh.visible = (r.key === "tree");
      scene.add(mesh);
      rasterMeshes.set(r.key, mesh);
    }

    const uiElem = document.querySelector("#list");
    const layers = [
      { kind: "asc", key: "tree",   name: "Tree Cover in 2000" },
      { kind: "asc", key: "gdpasc", name: "GDP 2000 (ASC)" }
    ];

    async function selectLayer(layer) {
      rasterMeshes.forEach(m => (m.visible = false));
      const m = rasterMeshes.get(layer.key);
      if (m) m.visible = true;

      [...uiElem.children].forEach(li => li.classList.remove("active"));
      const li = [...uiElem.children].find(el => el.textContent === layer.name);
      if (li) li.classList.add("active");
      requestRenderIfNotRequested();
    }

    layers.forEach((layer, i) => {
      const li = document.createElement("li");
      li.textContent = layer.name;
      li.classList.add("year");
      if (i === 0) li.classList.add("active");
      uiElem.appendChild(li);
      li.addEventListener("click", () => selectLayer(layer));
    });

    return () => {};
  }

  /* ---------- Navigation + interactions ---------- */
  function goToCountryDetails(countryCode) {
    const routes = {
      BRA: "../countries/brazil.html",
      POL: "../countries/poland.html",
      KOR: "../countries/south-korea.html",
    };
    window.location.href = routes[countryCode] || "/";
  }

  let lastHoverLabel = null;
  function onPointerMove(event) {
    setMouseFromEvent(mouse, event, renderer.domElement);
    raycaster.setFromCamera(mouse, camera);

    const hit = raycaster.intersectObjects(labelGroup.children, true)[0];
    const hovered = hit ? hit.object : null;

    if (hovered !== lastHoverLabel) {
      if (lastHoverLabel && lastHoverLabel.userData.updateHover) {
        lastHoverLabel.userData.updateHover(false);
      }
      if (hovered && hovered.userData.updateHover) {
        hovered.userData.updateHover(true);
      }
      lastHoverLabel = hovered;
      renderer.domElement.style.cursor = hovered ? "pointer" : "auto";
      requestRenderIfNotRequested();
    }
  }

  function onCountryClick(event) {
    setMouseFromEvent(mouse, event, renderer.domElement);
    raycaster.setFromCamera(mouse, camera);

    // Try label hit first
    const labelHit = raycaster.intersectObjects(labelGroup.children, true)[0];
    if (labelHit && labelHit.object.userData.countryCode) {
      goToCountryDetails(labelHit.object.userData.countryCode);
      requestRenderIfNotRequested();
      return;
    }

    // Fallback to globe -> polygon
    const hit = raycaster.intersectObject(earthMesh, false)[0];
    if (!hit) return;

    const invYaw = -earthMesh.rotation.y;
    const p = hit.point.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), invYaw);
    const { lat, lon } = vector3ToLatLon(p);
    const pt = turf.point([lon, -lat + geoJsonLatOffset]);
    const feature = COUNTRY_FEATURES.find(f => turf.booleanPointInPolygon(pt, f));
    if (feature) {
      goToCountryDetails(feature.properties.CODE);
      requestRenderIfNotRequested();
    }
  }

  function dispatchUI(e) {
    switch (e.type) {
      case "pointermove": onPointerMove(e); break;
      case "click":       onCountryClick(e); break;
      case "resize":
      case "change":      requestRenderIfNotRequested(); break;
    }
  }

  /* ---------- Load everything ---------- */
  async function loadGlobalBoundariesAndCountries() {
    await loadGlobalBoundaries();
    await loadCountries();
  }

  let updateMorphTargets = () => {};
  Promise.all([loadGlobalBoundariesAndCountries(), loadAll()]).then(() => {
    requestRenderIfNotRequested();
  });

  /* ---------- Render loop ---------- */
  function resizeRendererToDisplaySize(renderer) {
    const canvas = renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const needResize = canvas.width !== width || canvas.height !== height;
    if (needResize) renderer.setSize(width, height, false);
    return needResize;
  }

  let renderRequested = false;
  function render() {
    renderRequested = undefined;
    if (resizeRendererToDisplaySize(renderer)) {
      const canvas = renderer.domElement;
      camera.aspect = canvas.clientWidth / canvas.clientHeight;
      camera.updateProjectionMatrix();
    }
    if (tweenManager.update()) requestRenderIfNotRequested();
    controls.update();
    renderer.render(scene, camera);
  }
  render();

  // listeners
  canvas.addEventListener("pointermove", dispatchUI, false);
  canvas.addEventListener("click",       dispatchUI, false);
  window.addEventListener("resize",      dispatchUI, false);
  controls.addEventListener("change",    dispatchUI);

  function requestRenderIfNotRequested() {
    if (!renderRequested) { renderRequested = true; requestAnimationFrame(render); }
  }
  function setMouseFromEvent(mouse, event, canvas) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    mouse.x = x * 2 - 1;
    mouse.y = -y * 2 + 1;
  }
}

main();
