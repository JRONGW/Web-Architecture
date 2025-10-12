import "./styles.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { BufferGeometryUtils } from "three/examples/jsm/utils/BufferGeometryUtils";
import * as TWEEN from "@tweenjs/tween.js";
import * as turf from "@turf/turf";

import WORLD_TEXTURE from "../assets/world.jpg";
import WOMEN_DATA_URL from "../data/gpw_v4_basic_demographic_characteristics_rev10_a000_014ft_2010_cntm_1_deg.asc";
import MEN_DATA_URL from "../data/gpw_v4_basic_demographic_characteristics_rev10_a000_014mt_2010_cntm_1_deg.asc";

// 4 country GeoJSONs
import COUNTRY_BRAZIL from "../data/Brazil.geojson";
import COUNTRY_POLAND from "../data/Poland.geojson";
import COUNTRY_SINGAPORE from "../data/Singapore.geojson";
import COUNTRY_SOUTHKOREA from "../data/SouthKorea.geojson";
import GLOBAL_BOUNDARIES from "../data/globalboundaries.geojson";

class TweenManger {
  constructor() { this.numTweensRunning = 0; }
  _handleComplete() { --this.numTweensRunning; console.assert(this.numTweensRunning >= 0); }
  createTween(targetObject) {
    const self = this;
    ++this.numTweensRunning;
    let userCompleteFn = () => { };
    const tween = new TWEEN.Tween(targetObject).onComplete(function (...args) {
      self._handleComplete();
      userCompleteFn.call(this, ...args);
    });
    tween.onComplete = (fn) => { userCompleteFn = fn; return tween; };
    return tween;
  }
  update() { TWEEN.update(); return this.numTweensRunning > 0; }
}

// lat/lon -> Vector3 on sphere radius `radius` with optional height
function latLonToVector3(lat, lon, radius, height = 0) {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const theta = THREE.MathUtils.degToRad(lon);
  const r = radius + height;
  return new THREE.Vector3(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta)
  );
}

// Vector3 on sphere -> {lat, lon}
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

function main() {
  const canvas = document.querySelector("#c");
  const renderer = new THREE.WebGLRenderer({ canvas });
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

  // ----- Globe (keep a handle for raycasting) -----
  let earthMesh;
  {
    const loader = new THREE.TextureLoader();
    const texture = loader.load(WORLD_TEXTURE, render);
    const geometry = new THREE.SphereGeometry(1, 64, 32);
    const material = new THREE.MeshBasicMaterial({ map: texture });
    earthMesh = new THREE.Mesh(geometry, material);
    earthMesh.rotation.y = Math.PI * -0.5; // start facing Europe
    scene.add(earthMesh);

    const atmosphereShader = {
      uniforms: {},
      vertexShader: [
        "varying vec3 vNormal;",
        "void main(){",
        "  vNormal = normalize(normalMatrix * normal);",
        "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);",
        "}"
      ].join("\n"),
      fragmentShader: [
        "varying vec3 vNormal;",
        "void main(){",
        "  float intensity = pow(0.8 - dot(vNormal, vec3(0,0,1.0)), 12.0);",
        "  gl_FragColor = vec4(1.0,1.0,1.0,1.0) * intensity;",
        "}"
      ].join("\n")
    };
    const uniforms = THREE.UniformsUtils.clone(atmosphereShader.uniforms);
    const atmosphereGeometry = new THREE.SphereGeometry(1.07, 40, 30);
    const atmosphereMaterial = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: atmosphereShader.vertexShader,
      fragmentShader: atmosphereShader.fragmentShader,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true
    });
    const atmosphereMesh = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
    atmosphereMesh.scale.set(1.1, 1.1, 1.1);
    scene.add(atmosphereMesh);
  }

  // --- same fudge used by bars ---
  const lonFudge = Math.PI * 0.5;
  const latFudge = Math.PI * -0.135;

  // projector helpers at SCENE ROOT (not under earthMesh)
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

  /** project(lat, lon) -> THREE.Vector3 using SAME mapping as bars */
  function projectLL(lat, lon) {
    lonHelperLL.rotation.y = THREE.MathUtils.degToRad(normLon(lon)) + lonFudge;
    latHelperLL.rotation.x = THREE.MathUtils.degToRad(lat) + latFudge;
    posHelperLL.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixPosition(posHelperLL.matrixWorld);
  }

  // outlines group rotated like the earth so visuals align
  const countryOutlineGroup = new THREE.Group();
  countryOutlineGroup.rotation.y = Math.PI * -0.5;
  scene.add(countryOutlineGroup);

  // Global boundaries group (behind the highlighted countries)
  const globalBoundariesGroup = new THREE.Group();
  globalBoundariesGroup.rotation.y = Math.PI * -0.5;
  scene.add(globalBoundariesGroup);

  // light-yellow, additive "glow" for highlighted countries
  const outlineMaterial = new THREE.LineBasicMaterial({
    color: 0xffffb3,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });

  // light grey material for global boundaries
  const globalBoundariesMaterial = new THREE.LineBasicMaterial({
    color: 0xcbcbcb,
    transparent: true,
    opacity: 0.2,
    depthWrite: false
  });

  // Build a THREE.Line from a linear ring (array of [lon, lat])
  // Add offset to match the data bars' positioning
  const geoJsonLatOffset = 25; // Adjust this value to align GeoJSON with base map
  
  function ringToLine(ring, material) {
    const pts = [];
    for (const [lon, lat] of ring) {
      // Negate latitude and add offset to align with base map
      pts.push(projectLL(-lat + geoJsonLatOffset, lon));
    }
    // ensure closed
    const [lon0, lat0] = ring[0];
    const [lonN, latN] = ring[ring.length - 1];
    if (lon0 !== lonN || lat0 !== latN) {
      pts.push(projectLL(-lat0 + geoJsonLatOffset, lon0));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(geom, material.clone());
  }

  function addCountryOutline(feature, parentGroup, material) {
    const g = feature.geometry;
    if (!g) return;

    const addPoly = (poly) => {
      // poly: [ outerRing, hole1, ... ]
      const outer = ringToLine(poly[0], material);
      parentGroup.add(outer);
      // optional: draw holes faintly
      for (let i = 1; i < poly.length; ++i) {
        const hole = ringToLine(poly[i], material);
        hole.material.opacity = material.opacity * 0.4;
        parentGroup.add(hole);
      }
    };

    if (g.type === "Polygon") addPoly(g.coordinates);
    else if (g.type === "MultiPolygon") for (const poly of g.coordinates) addPoly(poly);
  }

  async function loadFile(url) {
    const req = await fetch(url);
    return req.text();
  }

  function parseData(text) {
    const data = [];
    const settings = { data };
    let max, min;
    text.split("\n").forEach((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2) {
        settings[parts[0]] = parseFloat(parts[1]);
      } else if (parts.length > 2) {
        const values = parts.map((v) => {
          const value = parseFloat(v);
          if (value === settings.NODATA_value) return undefined;
          max = Math.max(max === undefined ? value : max, value);
          min = Math.min(min === undefined ? value : min, value);
          return value;
        });
        data.push(values);
      }
    });
    return Object.assign(settings, { min, max });
  }

  function dataMissingInAnySet(fileInfos, latNdx, lonNdx) {
    for (const fileInfo of fileInfos) {
      if (fileInfo.file.data[latNdx][lonNdx] === undefined) return true;
    }
    return false;
  }

  function makeBoxes(file, hueRange, fileInfos) {
    const { min, max, data } = file;
    const range = max - min;

    const lonHelper = new THREE.Object3D(); scene.add(lonHelper);
    const latHelper = new THREE.Object3D(); lonHelper.add(latHelper);
    const positionHelper = new THREE.Object3D(); positionHelper.position.z = 1; latHelper.add(positionHelper);
    const originHelper = new THREE.Object3D(); originHelper.position.z = 0.5; positionHelper.add(originHelper);

    const color = new THREE.Color();
    const lonFudge = Math.PI * 0.5;
    const latFudge = Math.PI * -0.135;
    const geometries = [];

    data.forEach((row, latNdx) => {
      row.forEach((value, lonNdx) => {
        if (dataMissingInAnySet(fileInfos, latNdx, lonNdx)) return;

        const amount = (value - min) / range;
        const geometry = new THREE.BoxGeometry(1, 1, 1);

        lonHelper.rotation.y =
          THREE.MathUtils.degToRad(lonNdx + file.xllcorner) + lonFudge;
        latHelper.rotation.x =
          THREE.MathUtils.degToRad(latNdx + file.yllcorner) + latFudge;

        positionHelper.scale.set(
          0.005,
          0.005,
          THREE.MathUtils.lerp(0.01, 0.5, amount)
        );
        originHelper.updateWorldMatrix(true, false);
        geometry.applyMatrix4(originHelper.matrixWorld);

        const hue = THREE.MathUtils.lerp(...hueRange, amount);
        const saturation = 1;
        const lightness = THREE.MathUtils.lerp(0.4, 1.0, amount);
        color.setHSL(hue, saturation, lightness);
        const rgb = color.toArray().map((v) => v * 255);

        const numVerts = geometry.getAttribute("position").count;
        const itemSize = 3;
        const colors = new Uint8Array(itemSize * numVerts);
        colors.forEach((_, ndx) => { colors[ndx] = rgb[ndx % 3]; });
        const colorAttrib = new THREE.BufferAttribute(colors, itemSize, true);
        geometry.setAttribute("color", colorAttrib);

        geometries.push(geometry);
      });
    });

    return BufferGeometryUtils.mergeBufferGeometries(geometries, false);
  }

  async function loadData(info) {
    const text = await loadFile(info.url);
    info.file = parseData(text);
  }

  const COUNTRY_FEATURES = []; // for Turf hit-test

  async function loadGlobalBoundaries() {
    try {
      const res = await fetch(GLOBAL_BOUNDARIES);
      if (!res.ok) throw new Error(`HTTP ${res.status} for global boundaries`);
      const gj = await res.json();

      const features = gj.type === "FeatureCollection" ? gj.features
        : gj.type === "Feature" ? [gj] : [];

      const polys = features.filter(
        f => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
      );

      polys.forEach(f => {
        addCountryOutline(f, globalBoundariesGroup, globalBoundariesMaterial);
      });

      console.log(`[global boundaries] Loaded ${polys.length} features`);
    } catch (e) {
      console.error(`[global boundaries] Failed to load:`, e);
    }
  }

  async function loadCountries() {
    const infos = [
      { name: "Brazil", code: "BRA", url: COUNTRY_BRAZIL },
      { name: "Poland", code: "POL", url: COUNTRY_POLAND },
      { name: "Singapore", code: "SGP", url: COUNTRY_SINGAPORE },
      { name: "South Korea", code: "KOR", url: COUNTRY_SOUTHKOREA }
    ];

    for (const info of infos) {
      try {
        const res = await fetch(info.url);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${info.url}`);
        const gj = await res.json();

        const features = gj.type === "FeatureCollection" ? gj.features
          : gj.type === "Feature" ? [gj] : [];

        const polys = features.filter(
          f => f.geometry && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
        );

        if (polys.length === 0) {
          console.warn(`[countries] No polygon features for ${info.name}`);
          continue;
        }

        polys.forEach(f => {
          // Transform geometry to match the visual offset
          const transformGeometry = (geom) => {
            const transformCoords = (coords) => {
              if (typeof coords[0] === 'number') {
                // [lon, lat] pair - apply the same transformation as visual
                const [lon, lat] = coords;
                return [lon, -lat + geoJsonLatOffset];
              }
              return coords.map(transformCoords);
            };

            const newGeom = { type: geom.type };
            if (geom.type === "Polygon") {
              newGeom.coordinates = geom.coordinates.map(ring => transformCoords(ring));
            } else if (geom.type === "MultiPolygon") {
              newGeom.coordinates = geom.coordinates.map(poly => 
                poly.map(ring => transformCoords(ring))
              );
            }
            return newGeom;
          };

          const clickFeature = {
            type: "Feature",
            properties: { NAME: info.name, CODE: info.code },
            geometry: transformGeometry(f.geometry)
          };
          COUNTRY_FEATURES.push(clickFeature);
          addCountryOutline(f, countryOutlineGroup, outlineMaterial);
        });
      } catch (e) {
        console.error(`[countries] Failed to load ${info.name}:`, e);
      }
    }
  }

  function goToCountryDetails(countryCode) {
    const routes = {
      BRA: "../countries/brazil.html",
      POL: "../countries/poland.html",
      SGP: "../countries/singapore.html",
      KOR: "../countries/south-korea.html",
    };
    window.location.href = routes[countryCode] || "/";
  }

  // CLICK: inside main so it has access to locals
  function onCountryClick(event) {
    mouse.x =  (event.clientX / window.innerWidth)  * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    const hit = raycaster.intersectObject(earthMesh, false)[0];
    if (!hit) return;

    // undo earth yaw (-π/2) before converting to lat/lon for Turf
    const p = hit.point.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI * 0.5);

    const { lat, lon } = vector3ToLatLon(p);
    const pt = turf.point([lon, lat]); // Now matches transformed GeoJSON
    const feature = COUNTRY_FEATURES.find(f => turf.booleanPointInPolygon(pt, f));

    if (feature) {
      goToCountryDetails(feature.properties.CODE);
      requestRenderIfNotRequested();
    }
  }

  // ---------------------------------------------------------

  async function loadAll() {
    const fileInfos = [
      { name: "women", hueRange: [0.9, 1.1], url: WOMEN_DATA_URL },
      { name: "men", hueRange: [0.7, 0.3], url: MEN_DATA_URL }
    ];

    await Promise.all(fileInfos.map(loadData));

    function mapValues(data, fn) {
      return data.map((row, rowNdx) => row.map((value, colNdx) => fn(value, rowNdx, colNdx)));
    }

    function makeDiffFile(baseFile, otherFile, compareFn) {
      let min, max;
      const baseData = baseFile.data;
      const otherData = otherFile.data;
      const data = mapValues(baseData, (base, rowNdx, colNdx) => {
        const other = otherData[rowNdx][colNdx];
        if (base === undefined || other === undefined) return undefined;
        const value = compareFn(base, other);
        min = Math.min(min === undefined ? value : min, value);
        max = Math.max(max === undefined ? value : max, value);
        return value;
      });
      return { ...baseFile, min, max, data };
    }

    // Derived layers
    {
      const menInfo = fileInfos[0];
      const womenInfo = fileInfos[1];
      const menFile = menInfo.file;
      const womenFile = womenInfo.file;

      const amountGreaterThan = (a, b) => Math.max(a - b, 0);

      fileInfos.push({
        name: "women > men",
        hueRange: [0.0, 0.4],
        file: makeDiffFile(womenFile, menFile, (women, men) => amountGreaterThan(women, men))
      });
      fileInfos.push({
        name: "men > women",
        hueRange: [0.6, 1.1],
        file: makeDiffFile(menFile, womenFile, (men, women) => amountGreaterThan(men, women))
      });
    }

    const geometries = fileInfos.map((info) => makeBoxes(info.file, info.hueRange, fileInfos));

    const baseGeometry = geometries[0];
    baseGeometry.morphAttributes.position = geometries.map((geometry, ndx) => {
      const attribute = geometry.getAttribute("position");
      attribute.name = `target${ndx}`;
      return attribute;
    });

    const colorAttributes = geometries.map((geometry, ndx) => {
      const attribute = geometry.getAttribute("color");
      attribute.name = `color${ndx}`;
      return { name: `morphColor${ndx}`, attribute };
    });

    const material = new THREE.MeshBasicMaterial({ vertexColors: true, morphTargets: true });

    const vertexShaderReplacements = [
      { from: "#include <morphtarget_pars_vertex>", to: `uniform float morphTargetInfluences[8];` },
      { from: "#include <morphnormal_vertex>", to: `` },
      {
        from: "#include <morphtarget_vertex>", to: `
          transformed += (morphTarget0 - position) * morphTargetInfluences[0];
          transformed += (morphTarget1 - position) * morphTargetInfluences[1];
          transformed += (morphTarget2 - position) * morphTargetInfluences[2];
          transformed += (morphTarget3 - position) * morphTargetInfluences[3];
        ` },
      {
        from: "#include <color_pars_vertex>", to: `
          varying vec3 vColor;
          attribute vec3 morphColor0;
          attribute vec3 morphColor1;
          attribute vec3 morphColor2;
          attribute vec3 morphColor3;
        ` },
      {
        from: "#include <color_vertex>", to: `
          vColor.xyz = morphColor0 * morphTargetInfluences[0] +
                       morphColor1 * morphTargetInfluences[1] +
                       morphColor2 * morphTargetInfluences[2] +
                       morphColor3 * morphTargetInfluences[3];
        ` }
    ];
    material.onBeforeCompile = (shader) => {
      vertexShaderReplacements.forEach(rep => {
        shader.vertexShader = shader.vertexShader.replace(rep.from, rep.to);
      });
    };

    const mesh = new THREE.Mesh(baseGeometry, material);
    mesh.rotation.y = Math.PI * -0.5;
    scene.add(mesh);

    function updateMorphTargets() {
      for (const { name } of colorAttributes) {
        baseGeometry.deleteAttribute(name);
      }
      const maxInfluences = 8;
      mesh.morphTargetInfluences
        .map((influence, i) => [i, influence])
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .slice(0, maxInfluences)
        .sort((a, b) => a[0] - b[0])
        .filter((a) => !!a[1])
        .forEach(([ndx], i) => {
          const name = `morphColor${i}`;
          baseGeometry.setAttribute(name, colorAttributes[ndx].attribute);
        });
    }

    function showFileInfo(fileInfos, fileInfo) {
      const targets = {};
      fileInfos.forEach((info, i) => {
        const visible = fileInfo === info;
        if (visible) info.elem.classList.add("active");
        else info.elem.classList.remove("active");
        targets[i] = visible ? 1 : 0;
      });
      tweenManager.createTween(mesh.morphTargetInfluences).to(targets, 500).start();
      requestRenderIfNotRequested();
    }

    const uiElem = document.querySelector("#list");
    fileInfos.forEach((info) => {
      const li = document.createElement("li");
      info.elem = li;
      li.textContent = info.name;
      li.classList.add("year");
      uiElem.appendChild(li);
      li.addEventListener("click", () => showFileInfo(fileInfos, info));
    });
    showFileInfo(fileInfos, fileInfos[0]);

    return updateMorphTargets;
  }

  // Wait for all: global boundaries, countries + data
  let updateMorphTargets = () => { };
  Promise.all([loadGlobalBoundaries(), loadCountries(), loadAll()]).then(([, , fn]) => {
    updateMorphTargets = fn;
    requestRenderIfNotRequested();
  });

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

    updateMorphTargets();
    controls.update();
    renderer.render(scene, camera);
  }
  render();

  function requestRenderIfNotRequested() {
    if (!renderRequested) {
      renderRequested = true;
      requestAnimationFrame(render);
    }
  }

  controls.addEventListener("change", requestRenderIfNotRequested);
  window.addEventListener("resize", requestRenderIfNotRequested);

  // Click-to-country
  canvas.addEventListener("click", onCountryClick, false);
}

main();