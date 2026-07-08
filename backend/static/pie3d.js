import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let S = null;
let _pieMode = 'dec';   // 'dec' = сумма заявок, 'deliv' = факт выплачено
let _lastRows = [];     // кешируем для перерисовки при смене режима
const SVGNS = 'http://www.w3.org/2000/svg';
const PALETTE = [
  0x5b8af8, 0x4ecdc4, 0xf875c3, 0xffb454, 0x9b8cff, 0x63e6a0,
  0xff7a7a, 0x57c7ff, 0xc0e457, 0xff9e6d, 0x8be0d0, 0xd58bff,
];

function fmtMoney(v) {
  if (!v) return '0 ₸';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1).replace('.', ',') + ' млрд ₸';
  if (a >= 1e6) return (v / 1e6).toFixed(1).replace('.', ',') + ' млн ₸';
  if (a >= 1e3) return Math.round(v / 1e3) + ' тыс ₸';
  return Math.round(v) + ' ₸';
}
function stripHelpPrefix(name) {
  if (!name) return name;
  return name.replace(/^\s*СОЦИАЛЬНАЯ\s+ПОМОЩЬ\s+/i, '');
}

function ensureScene() {
  if (S) return S;
  const wrap = document.getElementById('pie3d-wrap');
  const tip = document.getElementById('pie3d-tip');
  if (!wrap) return null;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x141831, 24, 64);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 300);
  const CAM_START = new THREE.Vector3(0, 13, 15);
  camera.position.copy(CAM_START);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  wrap.appendChild(renderer.domElement);

  // слой подписей (HTML) + выноски (SVG)
  const leaderSvg = document.createElementNS(SVGNS, 'svg');
  leaderSvg.classList.add('pie3d-leaders');
  wrap.appendChild(leaderSvg);
  const labelLayer = document.createElement('div');
  labelLayer.className = 'pie3d-labels';
  wrap.appendChild(labelLayer);

  scene.add(new THREE.AmbientLight(0x8fa3d6, 0.62));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(8, 20, 10); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1; key.shadow.camera.far = 70;
  key.shadow.camera.left = -16; key.shadow.camera.right = 16;
  key.shadow.camera.top = 16; key.shadow.camera.bottom = -16;
  scene.add(key);
  const p1 = new THREE.PointLight(0x4ecdc4, 0.6, 70); p1.position.set(-14, 8, -10); scene.add(p1);
  const p2 = new THREE.PointLight(0xf875c3, 0.4, 70); p2.position.set(14, 6, -14); scene.add(p2);

  let grid = new THREE.GridHelper(30, 15, 0x3a4570, 0x2a3252);
  scene.add(grid);
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(11, 48),
    new THREE.MeshStandardMaterial({ color: 0x1b2140, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.02; floor.receiveShadow = true;
  scene.add(floor);

  // адаптация под светлую/тёмную тему
  const applyTheme = () => {
    const light = document.documentElement.dataset.theme === 'light';
    scene.fog = new THREE.Fog(light ? 0xeef1f6 : 0x141831, light ? 28 : 24, light ? 74 : 64);
    floor.material.color.set(light ? 0xe2e6ee : 0x1b2140);
    scene.remove(grid);
    grid.geometry.dispose(); grid.material.dispose();
    grid = new THREE.GridHelper(30, 15, light ? 0xaab2c4 : 0x3a4570, light ? 0xd0d5df : 0x2a3252);
    scene.add(grid);
  };
  applyTheme();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.target.set(0, 1.5, 0);
  controls.minDistance = 9; controls.maxDistance = 34;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.autoRotate = true; controls.autoRotateSpeed = 0.45;

  const sliceGroup = new THREE.Group();
  scene.add(sliceGroup);

  // hover по кускам
  const ray = new THREE.Raycaster(); const ptr = new THREE.Vector2();
  let hovered = null;
  renderer.domElement.addEventListener('pointermove', (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObjects(sliceGroup.children.filter(o => o.isMesh), false)[0];
    const obj = hit ? hit.object : null;
    if (obj !== hovered) {
      if (hovered) hovered.material.emissiveIntensity = hovered.userData.baseEmis;
      hovered = obj;
      if (hovered) hovered.material.emissiveIntensity = 0.7;
      renderer.domElement.style.cursor = hovered ? 'pointer' : 'grab';
    }
    if (obj && tip) {
      const d = obj.userData.d;
      const vk = obj.userData.valKey || 'total_dec';
      const label = vk === 'total_deliv' ? 'Сумма фактической выплаты' : 'Сумма принятых заявлений';
      tip.style.display = 'block';
      tip.style.left = (e.clientX - r.left + 14) + 'px';
      tip.style.top = (e.clientY - r.top + 14) + 'px';
      const dimLine = vk === 'total_deliv'
        ? `Количество услугополучателей: ${formatInt(d.fact_recipients || 0)}`
        : `Количество заявлений: ${d.count}`;
      const pct = vk === 'total_deliv' ? d.pctRecip : d.pctCount;
      tip.innerHTML = `<b>${stripHelpPrefix(d.pay_type)}</b><br>${label}: ${fmtMoney(d[vk])} · ${pct}%<br>` +
        `<span class="cube3d-tip-dim">${dimLine}</span>`;
    } else if (tip) { tip.style.display = 'none'; }
  });
  renderer.domElement.addEventListener('pointerleave', () => {
    if (hovered) { hovered.material.emissiveIntensity = hovered.userData.baseEmis; hovered = null; }
    if (tip) tip.style.display = 'none';
  });

  // клик по куску (отличаем от вращения по смещению указателя)
  let downXY = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downXY = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downXY) return;
    const moved = Math.hypot(e.clientX - downXY.x, e.clientY - downXY.y);
    downXY = null;
    if (moved > 6) return; // это было вращение, не клик
    const r = renderer.domElement.getBoundingClientRect();
    ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObjects(sliceGroup.children.filter(o => o.isMesh), false)[0];
    if (hit && hit.object.userData.d.pay_type_id != null) {
      openDetail(hit.object.userData.d, hit.object.userData.hex);
    }
  });

  document.getElementById('pie3d-detail-close')?.addEventListener('click', closeDetail);
  document.getElementById('pie3d-detail-back')?.addEventListener('click', () => { detail.region = null; loadDetail(); });

  function resize() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    leaderSvg.setAttribute('width', w); leaderSvg.setAttribute('height', h);
  }
  new ResizeObserver(resize).observe(wrap);
  resize();

  // плавный сдвиг вида влево, когда открыта панель деталей
  let shiftCur = 0, shiftTarget = 0;
  const setShift = (f) => { shiftTarget = f; };

  const clock = new THREE.Clock();
  (function loop() {
    requestAnimationFrame(loop);
    const t = clock.getElapsedTime();
    sliceGroup.children.forEach(m => {
      if (!m.isMesh) return;
      const k = Math.max(0, Math.min(1, (t - m.userData.t0 - m.userData.delay) / 0.55));
      const e = 1 - Math.pow(1 - k, 3);
      m.scale.y = Math.max(0.001, e);
    });

    // применяем/анимируем сдвиг кадра
    shiftCur += (shiftTarget - shiftCur) * 0.15;
    if (Math.abs(shiftTarget - shiftCur) < 0.0005) shiftCur = shiftTarget;
    const cw = renderer.domElement.clientWidth, ch = renderer.domElement.clientHeight;
    if (cw && ch) {
      if (shiftCur > 0.0005) camera.setViewOffset(cw, ch, cw * shiftCur, 0, cw, ch);
      else camera.clearViewOffset();
    }

    controls.update();
    renderer.render(scene, camera);
    layoutLabels(S, t);
  })();

  S = { scene, camera, renderer, controls, sliceGroup, leaderSvg, labelLayer, clock, labels: [], setShift, applyTheme };
  return S;
}

function updatePieLegend(mode) {
  const h = document.getElementById('pie3d-legend-h');
  const a = document.getElementById('pie3d-legend-a');
  if (h) h.textContent = 'Высота сектора = ' + (mode === 'deliv' ? 'сумма фактической выплаты' : 'сумма заявлений');
  if (a) a.textContent = 'Угол сектора = ' + (mode === 'deliv' ? 'кол-во услугополучателей' : 'количество заявлений');
}

function buildPie(s, rows) {
  const mode = _pieMode;
  const valKey = mode === 'deliv' ? 'total_deliv' : 'total_dec';
  const empty = document.getElementById('pie3d-empty');
  updatePieLegend(mode);

  // очистка прошлых кусков
  while (s.sliceGroup.children.length) {
    const o = s.sliceGroup.children[s.sliceGroup.children.length - 1];
    s.sliceGroup.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) { o.material.map?.dispose?.(); o.material.dispose(); }
  }
  s.labels.forEach(L => { L.el.remove(); L.line.remove(); });
  s.labels = [];

  let data = (rows || []).filter(r => (r[valKey] || 0) > 0);
  if (!data.length) { if (empty) empty.style.display = 'flex'; return; }
  if (empty) empty.style.display = 'none';

  data.sort((a, b) => b[valKey] - a[valKey]);
  if (data.length > 12) {
    const top = data.slice(0, 11);
    const rest = data.slice(11);
    top.push({
      pay_type:        `Прочие (${rest.length})`,
      count:           rest.reduce((s, r) => s + (r.count           || 0), 0),
      fact_recipients: rest.reduce((s, r) => s + (r.fact_recipients || 0), 0),
      total_dec:       rest.reduce((s, r) => s + (r.total_dec       || 0), 0),
      total_deliv:     rest.reduce((s, r) => s + (r.total_deliv     || 0), 0),
    });
    data = top;
  }

  const totalCount = data.reduce((s, r) => s + (r.count || 0), 0) || 1;
  const totalRecip = data.reduce((s, r) => s + (r.fact_recipients || 0), 0) || 1;
  const totalVal   = data.reduce((s, r) => s + (r[valKey] || 0), 0) || 1;
  const maxVal     = Math.max(...data.map(r => r[valKey])) || 1;

  const rOuter = 5.4, pad = 0.03;
  const minAng = Math.min(0.16, (Math.PI * 2) / data.length * 0.6);
  const distributable = Math.PI * 2 - minAng * data.length;
  let a = -Math.PI / 2;
  const t0 = s.clock.getElapsedTime();

  data.forEach((d, i) => {
    const _p = (d.count || 0) / totalCount * 100;
    d.pctCount = _p < 1 ? _p.toFixed(2) : Math.round(_p);
    const _pr = (d.fact_recipients || 0) / totalRecip * 100;
    d.pctRecip = _pr < 1 ? _pr.toFixed(2) : Math.round(_pr);
    d.pctVal   = Math.round((d[valKey] || 0) / totalVal * 100);
    const _base  = mode === 'deliv' ? (d.fact_recipients || 0) / totalRecip : (d.count || 0) / totalCount;
    const ang    = minAng + _base * distributable;
    const a0 = a + pad / 2, a1 = a + ang - pad / 2;
    const height = 0.7 + ((d[valKey] || 0) / maxVal) * 6.0;

    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(Math.cos(a0) * rOuter, Math.sin(a0) * rOuter);
    shape.absarc(0, 0, rOuter, a0, a1, false);
    shape.lineTo(0, 0);
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: height, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.07, bevelSegments: 2, steps: 1,
    });
    geo.rotateX(-Math.PI / 2);

    const hex = PALETTE[i % PALETTE.length];
    const mat = new THREE.MeshStandardMaterial({
      color: hex, emissive: hex, emissiveIntensity: 0.14, metalness: 0.4, roughness: 0.34,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.scale.y = 0.001;
    mesh.userData = { d, hex, baseEmis: 0.14, t0, delay: i * 0.07, valKey };
    s.sliceGroup.add(mesh);

    const mid = (a0 + a1) / 2;
    const anchor = new THREE.Vector3(Math.cos(mid) * rOuter, height, Math.sin(mid) * rOuter);

    const el = document.createElement('div');
    el.className = 'pie3d-lab';
    el.style.setProperty('--clr', '#' + hex.toString(16).padStart(6, '0'));
    el.innerHTML = `<b>${stripHelpPrefix(d.pay_type)}</b><span>${fmtMoney(d[valKey])}</span>`;
    s.labelLayer.appendChild(el);

    const line = document.createElementNS(SVGNS, 'polyline');
    line.setAttribute('class', 'pie3d-leader');
    line.style.stroke = '#' + hex.toString(16).padStart(6, '0');
    s.leaderSvg.appendChild(line);

    s.labels.push({ el, line, anchor, d, t0, delay: i * 0.07 });
    a += ang;
  });
}

// Раскладка HTML-подписей: проекция якоря → колонки слева/справа с защитой от наложения.
function layoutLabels(s, t) {
  if (!s || !s.labels.length) return;
  const W = s.renderer.domElement.clientWidth;
  const H = s.renderer.domElement.clientHeight;
  if (!W || !H) return;
  const cx = W / 2;

  // направление от центра пирога к камере (в плоскости XZ)
  const camDir = new THREE.Vector2(s.camera.position.x, s.camera.position.z);
  if (camDir.lengthSq() < 1e-6) camDir.set(0, 1);
  camDir.normalize();

  const items = s.labels.map(L => {
    const v = L.anchor.clone().project(s.camera);
    const aDir = new THREE.Vector2(L.anchor.x, L.anchor.z);
    const facing = aDir.lengthSq() > 1e-6 ? aDir.normalize().dot(camDir) : 1;
    return { L, ax: (v.x * 0.5 + 0.5) * W, ay: (-v.y * 0.5 + 0.5) * H, facing };
  });

  // прячем куски, повёрнутые от камеры (их выноски пересекали бы пирог)
  items.forEach(o => {
    o.vis = o.facing > 0.1;
    if (!o.vis) { o.L.el.style.opacity = 0; o.L.line.style.opacity = 0; }
  });

  const GAP = 36;
  function place(arr, side) {
    arr.sort((p, q) => p.ay - q.ay);
    let prev = -Infinity;
    arr.forEach(o => { o.ly = Math.max(o.ay, prev + GAP); prev = o.ly; });
    const overflow = prev - (H - 14);
    if (overflow > 0) arr.forEach(o => { o.ly -= overflow; });

    arr.forEach(o => {
      const el = o.L.el;
      const grown = Math.min(1, Math.max(0, (t - o.L.t0 - o.L.delay - 0.4)));
      const fade = Math.max(0, Math.min(1, (o.facing - 0.1) / 0.3)); // плавно гаснут к краю
      const op = grown * fade;
      el.style.opacity = op;
      el.style.top = o.ly + 'px';
      if (side === 'L') { el.style.left = '8px'; el.style.right = 'auto'; }
      else { el.style.right = '8px'; el.style.left = 'auto'; }

      const lw = el.offsetWidth;
      const lx = side === 'L' ? 8 + lw : W - 8 - lw;
      o.L.line.setAttribute('points', `${o.ax},${o.ay} ${lx},${o.ly} ${side === 'L' ? lx + 6 : lx - 6},${o.ly}`);
      o.L.line.style.opacity = op * 0.5;
    });
  }

  const vis = items.filter(o => o.vis);
  place(vis.filter(o => o.ax < cx), 'L');
  place(vis.filter(o => o.ax >= cx), 'R');
}

let detailChart = null;
const detail = { payId: null, hex: 0x5b8af8, payName: '', baseRegion: null, region: null, rows: [] };

async function openDetail(d, hex) {
  const panel = document.getElementById('pie3d-detail');
  if (!panel) return;
  detail.payId = d.pay_type_id;
  detail.hex = hex;
  detail.payName = d.pay_type;
  detail.baseRegion = (S && S.region != null) ? S.region : null; // если пирог в регионе — сразу районы
  detail.region = null;
  panel.style.display = 'flex';
  document.getElementById('pie3d-legend')?.style.setProperty('display', 'none');
  if (S) {
    S.controls.autoRotate = false;
    // сдвигаем пирог влево на половину ширины панели, чтобы она его не перекрывала
    const W = S.renderer.domElement.clientWidth || 1;
    const panelW = Math.min(560, W * 0.47);
    S.setShift((panelW / 2) / W);
  }
  await loadDetail();
}

async function loadDetail() {
  const titleEl = document.getElementById('pie3d-detail-title');
  const subEl = document.querySelector('#pie3d-detail .pie3d-detail-sub');
  const backBtn = document.getElementById('pie3d-detail-back');
  const eff = detail.region != null ? detail.region : detail.baseRegion;
  const byRaion = eff != null;
  if (titleEl) titleEl.textContent = stripHelpPrefix(detail.payName);
  if (subEl) {
    const metricLabel = _pieMode === 'deliv' ? 'Сумма фактической выплаты' : 'Сумма принятых заявлений';
    subEl.textContent = byRaion
      ? (`${metricLabel} по районам` + (detail.region != null && detail.regionName ? ' — ' + stripHelpPrefix(detail.regionName) : ''))
      : `${metricLabel} по областям`;
  }
  // «назад» доступно только когда мы провалились в область из общего вида
  if (backBtn) backBtn.style.display = (detail.baseRegion == null && detail.region != null) ? '' : 'none';

  const p = new URLSearchParams({ pay_type_id: detail.payId });
  if (eff != null) p.set('region_id', eff);
  let rows = [];
  try { rows = await fetch('/api/paytype-geo?' + p.toString()).then(r => r.json()); }
  catch (e) { console.error('paytype-geo', e); }
  // В режиме «По фактической сумме» показываем только реальные выплаты:
  // прячем регионы/районы с нулевой факт. выплатой и сортируем по ней.
  if (_pieMode === 'deliv') {
    rows = rows.filter(r => (r.total_deliv || 0) > 0)
               .sort((a, b) => (b.total_deliv || 0) - (a.total_deliv || 0));
  }
  detail.rows = rows;
  drawBars(rows, detail.hex, eff == null); // на уровне областей бары кликабельны (провал в районы)
}

function closeDetail() {
  const panel = document.getElementById('pie3d-detail');
  if (panel) panel.style.display = 'none';
  document.getElementById('pie3d-legend')?.style.setProperty('display', '');   // вернуть к CSS (flex)
  if (S) { S.controls.autoRotate = true; S.setShift(0); }
}

function drawBars(rows, hex, clickable) {
  const ctx = document.getElementById('pie3d-detail-chart');
  if (!ctx || !window.Chart) return;
  const color = '#' + hex.toString(16).padStart(6, '0');
  const vk = _pieMode === 'deliv' ? 'total_deliv' : 'total_dec';
  const labels = rows.map(r => stripHelpPrefix(r.name));
  const vals = rows.map(r => r[vk] || 0);
  const light = document.documentElement.dataset.theme === 'light';
  const tickColor = light ? '#3c4043' : '#cfd6e6';
  const lblColor = light ? '#202124' : '#e6ebf5';
  const gridColor = light ? 'rgba(60,64,67,0.12)' : 'rgba(255,255,255,0.08)';

  // Сумма у вершины каждого столбца: снаружи справа, а если не влезает — внутри столбца
  const valueLabels = {
    id: 'pie3dBarValues',
    afterDatasetsDraw(chart) {
      const { ctx: c, chartArea } = chart;
      const meta = chart.getDatasetMeta(0);
      c.save();
      c.font = "700 10px 'Roboto', sans-serif";
      c.textBaseline = 'middle';
      const PAD = 6;
      meta.data.forEach((bar, i) => {
        const v = vals[i];
        if (!v) return;
        const txt = fmtMoney(v);
        const w = c.measureText(txt).width;
        if (bar.x + PAD + w <= chartArea.right) {
          c.textAlign = 'left'; c.fillStyle = lblColor;
          c.fillText(txt, bar.x + PAD, bar.y);           // снаружи, справа от вершины
        } else {
          c.textAlign = 'right'; c.fillStyle = '#ffffff';
          c.fillText(txt, bar.x - PAD, bar.y);           // внутри столбца (не влезло снаружи)
        }
      });
      c.restore();
    },
  };

  if (detailChart) detailChart.destroy();
  detailChart = new window.Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: vals,
        backgroundColor: color + 'cc',
        borderColor: color,
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    plugins: [valueLabels],
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      // реагируем на всю строку (бар + подпись области), а не только на сам бар
      interaction: { mode: 'index', axis: 'y', intersect: false },
      onHover: (evt, els) => { evt.native.target.style.cursor = (clickable && els.length) ? 'pointer' : 'default'; },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => fmtMoney(c.parsed.x) } },
      },
      scales: {
        x: { ticks: { color: tickColor, callback: (v) => fmtMoney(v) }, grid: { color: gridColor } },
        y: { ticks: { color: lblColor, font: { size: 11 } }, grid: { display: false } },
      },
    },
  });

  // Нативный клик по всему канвасу (включая зону подписей слева) — провал в районы.
  ctx.onclick = clickable ? (e) => {
    const yScale = detailChart.scales.y;
    if (!yScale) return;
    const idx = Math.round(yScale.getValueForPixel(e.offsetY));
    if (idx >= 0 && idx < detail.rows.length) {
      const row = detail.rows[idx];
      if (row && row.id != null) { detail.region = row.id; detail.regionName = row.name; loadDetail(); }
    }
  } : null;
}

window.renderPie3D = async function (regionId, raionId, payTypeId) {
  const s = ensureScene();
  if (!s) return;
  s.applyTheme();
  s.region = regionId != null ? regionId : null;
  s.raion  = raionId  != null ? raionId  : null;
  s.payType = payTypeId != null ? payTypeId : null;
  closeDetail();
  const p = new URLSearchParams();
  if (raionId) p.set('raion_id', raionId);
  else if (regionId) p.set('region_id', regionId);
  if (payTypeId != null) p.set('pay_type_id', payTypeId);
  let rows = [];
  try { rows = await fetch('/api/pay-type-stats?' + p.toString()).then(r => r.json()); }
  catch (e) { console.error('pie3d fetch', e); }
  _lastRows = rows;
  buildPie(s, rows);
};

window.switchPieMode = function (mode) {
  if (mode === _pieMode) return;
  _pieMode = mode;
  document.querySelectorAll('.pie-stab').forEach(b =>
    b.classList.toggle('active', b.dataset.pmode === mode));
  const s = ensureScene();
  if (s) { closeDetail(); buildPie(s, _lastRows); }
};
