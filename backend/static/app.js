const API = '';
let map, regionsLayer, raionsLayer, labelsLayer;
let sduChart = null;
let tileLayer = null;
let regionGeoJSON = null, raionGeoJSON = null;
let regionCentroids = {}, raionCentroids = {};
let regionStats = {}, raionStats = {};
let currentRegion = null, currentRaion = null;
let currentPage = 1;
let ageChart = null;

function stripHelpPrefix(name) {
  if (!name) return name;
  return name.replace(/^\s*СОЦИАЛЬНАЯ\s+ПОМОЩЬ\s+/i, '');
}

/* ── Pseudo-auth (client-side only) ── */
const AUTH_USER = 'admin';
const AUTH_PASS = 'crtr2026';
function isAuthed() { return sessionStorage.getItem('mgp_auth') === 'ok'; }
function logout() { sessionStorage.removeItem('mgp_auth'); location.reload(); }

function showLogin() {
  const ov = document.createElement('div');
  ov.className = 'auth-overlay';
  ov.innerHTML = `
    <form class="auth-card" id="auth-form">
      <div class="auth-title">МГП</div>
      <div class="auth-sub">Вход в систему</div>
      <input type="text" id="auth-login" placeholder="Логин" autocomplete="username" autofocus>
      <input type="password" id="auth-pass" placeholder="Пароль" autocomplete="current-password">
      <div class="auth-error" id="auth-error"></div>
      <button type="submit">Войти</button>
    </form>`;
  document.body.appendChild(ov);
  document.getElementById('auth-login').focus();
  document.getElementById('auth-form').addEventListener('submit', e => {
    e.preventDefault();
    const u = document.getElementById('auth-login').value.trim();
    const p = document.getElementById('auth-pass').value;
    if (u === AUTH_USER && p === AUTH_PASS) {
      sessionStorage.setItem('mgp_auth', 'ok');
      location.reload();
    } else {
      document.getElementById('auth-error').textContent = 'Неверный логин или пароль';
      document.getElementById('auth-pass').value = '';
    }
  });
}

function toggleFullscreen(btn) {
  const section = btn.closest('.table-section, .map-panel');
  if (!section) return;
  const fs = section.classList.toggle('is-fullscreen');
  document.body.classList.toggle('fs-open', fs);
  btn.textContent = fs ? '✕' : '⛶';
  btn.title = fs ? 'Закрыть' : 'Во весь экран';
  if (section.classList.contains('map-panel') && map) {
    setTimeout(() => map.invalidateSize(), 60);
    setTimeout(() => map.invalidateSize(), 360);
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    let hadMap = false;
    document.querySelectorAll('.is-fullscreen').forEach(s => {
      s.classList.remove('is-fullscreen');
      if (s.classList.contains('map-panel')) hadMap = true;
      const btn = s.querySelector('.expand-btn');
      if (btn) { btn.textContent = '⛶'; btn.title = 'Во весь экран'; }
    });
    document.body.classList.remove('fs-open');
    if (hadMap && map) setTimeout(() => map.invalidateSize(), 60);
  }
});

const TABLE_COLS = [
  { key: 'app_date',     label: 'Дата заявки' },
  { key: 'app_status',   label: 'Статус',           filterable: true },
  { key: 'sicid',        label: 'SICID' },
  { key: 'kato_regname', label: 'Регион',            filterable: true },
  { key: 'kato_rainame', label: 'Район',             filterable: true },
  { key: 'pay_type',     label: 'Тип выплаты',       filterable: true },
  { key: 'cat_type',     label: 'Категория',         filterable: true },
  { key: 'period',       label: 'Период',            filterable: true },
  { key: 'max_pay_sum',  label: 'MAX выплата',       sortable: true },
  { key: 'dec_pay_sum',  label: 'Выплачено',         sortable: true },
  { key: 'mrp',          label: 'МРП',               sortable: true },
  { key: 'gender_id',    label: 'Пол',              filterable: true },
  { key: 'vozrast',      label: 'Возраст',           sortable: true },
  { key: 'sdu_tzhs',     label: 'Уровень благосостояния',         filterable: true },
  { key: 'sys_date',     label: 'Дата системы' },
];

let tableSortCol = null;
let tableSortDir = 'desc';
let tableFilters = {};

async function init() {
  map = L.map('map', { zoomControl: true, attributionControl: false }).setView([48, 68], 4);
  const isLight = document.documentElement.dataset.theme === 'light';
  tileLayer = L.tileLayer(
    isLight
      ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
      : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    { attribution: '© OpenStreetMap © CARTO', maxZoom: 18 }
  ).addTo(map);
  requestAnimationFrame(() => requestAnimationFrame(() => map.invalidateSize()));

  const [regGeo, raiGeo, stats, regC, raiC] = await Promise.all([
    fetch('/map/regions_polygon.json').then(r => r.json()),
    fetch('/map/raion_polygon.json').then(r => r.json()),
    fetch('/api/regions').then(r => r.json()),
    fetch('/map/region_centroids.json').then(r => r.json()),
    fetch('/map/raion_centroids.json').then(r => r.json()),
  ]);

  regionGeoJSON = regGeo;
  raionGeoJSON = raiGeo;
  stats.forEach(s => { regionStats[s.id_reg] = s; });
  regC.forEach(c => { regionCentroids[c.id_reg] = c.centroid; });
  raiC.forEach(c => { raionCentroids[Math.round(c.id_rai)] = c.centroid; });

  renderRegions();
  await refreshKPI();
  await Promise.all([loadTable(1), loadSummary(), loadCoverageGroups(), loadCatRegions(), loadUncovered(), loadHelpPresence()]);
}

function getColor(value, max) {
  if (!max || max === 0) return 'rgba(15,22,58,0.85)';
  const t = Math.min(value / max, 1);
  // deep indigo → royal blue → vivid blue → cyan → teal-mint
  const stops = [
    [15, 22, 58],
    [24, 60, 160],
    [48, 120, 220],
    [30, 190, 200],
    [0,  220, 180],
  ];
  const seg = t * (stops.length - 1);
  const lo = Math.floor(seg), hi = Math.min(lo + 1, stops.length - 1);
  const f = seg - lo;
  const [r, g, b] = stops[lo].map((v, i) => Math.round(v + (stops[hi][i] - v) * f));
  return `rgba(${r},${g},${b},0.88)`;
}

function regionStyle(feature) {
  const s = regionStats[feature.properties.id_reg] || {};
  const maxVal = Math.max(...Object.values(regionStats).map(r => r.total_max || 0), 1);
  return {
    fillColor: getColor(s.total_max || 0, maxVal),
    weight: 1,
    color: '#3a5090',
    fillOpacity: 0.75,
  };
}

function raionStyle(feature) {
  const stats = raionStats[feature.properties.id_rai] || {};
  const maxVal = Math.max(...Object.values(raionStats).map(r => r.total_max || 0), 1);
  return {
    fillColor: getColor(stats.total_max || 0, maxVal),
    weight: 1,
    color: '#3a5090',
    fillOpacity: 0.75,
  };
}

function clearLabels() {
  if (labelsLayer) { map.removeLayer(labelsLayer); labelsLayer = null; }
}

function addLabel(latlng, text) {
  return L.marker(latlng, {
    icon: L.divIcon({
      className: 'map-label',
      html: `<span>${text}</span>`,
      iconSize: null,
      iconAnchor: [0, 0],
    }),
    interactive: false,
  });
}

// Label shows entitled (положенные) counts: виды помощи / категории людей
function entitledLabel(id) {
  const row = presenceById[Math.round(id)];
  if (!row || !row.mini) return null;
  return `${row.mini.vidy}/${row.mini.kategorii}`;
}

function renderRegionLabels() {
  clearLabels();
  labelsLayer = L.layerGroup();
  Object.entries(regionCentroids).forEach(([id, c]) => {
    if (!c) return;
    const label = entitledLabel(id);
    if (label == null) return;
    labelsLayer.addLayer(addLabel([c[1], c[0]], label));
  });
  labelsLayer.addTo(map);
}

function renderRaionLabels() {
  clearLabels();
  labelsLayer = L.layerGroup();
  Object.entries(raionStats).forEach(([id, s]) => {
    const c = raionCentroids[Math.round(id)];
    if (!c) return;
    const label = entitledLabel(id) ?? `${s.pay_type_count ?? '?'}/${s.cat_type_count ?? '?'}`;
    labelsLayer.addLayer(addLabel([c[1], c[0]], label));
  });
  labelsLayer.addTo(map);
}

function renderRegions() {
  if (raionsLayer) { map.removeLayer(raionsLayer); raionsLayer = null; }
  if (regionsLayer) { map.removeLayer(regionsLayer); }

  regionsLayer = L.geoJSON(regionGeoJSON, {
    style: regionStyle,
    onEachFeature(feature, layer) {
      const s = regionStats[feature.properties.id_reg] || {};
      layer.on({
        mouseover(e) {
          e.target.setStyle({ weight: 2, color: '#7090ff', fillOpacity: 0.9 });
          cancelHideGeoPanel();
          showGeoPanel(feature.properties.id_reg, s.name || feature.properties.region, e.originalEvent);
        },
        mouseout(e) { regionsLayer.resetStyle(e.target); scheduleHideGeoPanel(); },
        click() { hideGeoPanelNow(); drillRegion(feature.properties.id_reg); },
      });
    },
  }).addTo(map);

  renderRegionLabels();
}

async function drillRegionFromRanking(regionId) {
  // Same as drillRegion but without map scroll / fitBounds
  currentRegion = regionId;
  currentRaion = null;
  currentPage = 1;

  const data = await fetch(`/api/raions?region_id=${regionId}`).then(r => r.json());
  raionStats = {};
  data.forEach(r => { raionStats[r.id_rai] = r; });

  // Update map layers silently (no fitBounds)
  const filtered = {
    ...raionGeoJSON,
    features: raionGeoJSON.features.filter(f => f.properties.id_reg == regionId),
  };
  if (regionsLayer) { map.removeLayer(regionsLayer); }
  if (raionsLayer) { map.removeLayer(raionsLayer); }
  raionsLayer = L.geoJSON(filtered, {
    style: raionStyle,
    onEachFeature(feature, layer) {
      const s = raionStats[Math.round(feature.properties.id_rai)] || {};
      layer.on({
        mouseover(e) {
          e.target.setStyle({ weight: 2, color: '#7090ff', fillOpacity: 0.9 });
          cancelHideGeoPanel();
          showGeoPanel(feature.properties.id_rai, s.name || feature.properties.raion, e.originalEvent);
        },
        mouseout(e) { raionsLayer.resetStyle(e.target); scheduleHideGeoPanel(); },
        click() { hideGeoPanelNow(); selectRaion(feature.properties.id_rai); },
      });
    },
  }).addTo(map);
  renderRaionLabels();

  const regionName = regionStats[regionId]?.name || `Регион ${regionId}`;
  updateBreadcrumb(regionName, null);
  loadDistinct('kato_rainame');
  await refreshKPI();
  await Promise.all([loadTable(1), loadSummary(), loadCoverageGroups(), loadCatRegions(), loadUncovered(), loadHelpPresence()]);
}

async function drillRegion(regionId) {
  currentRegion = regionId;
  currentRaion = null;
  currentPage = 1;

  const data = await fetch(`/api/raions?region_id=${regionId}`).then(r => r.json());
  raionStats = {};
  data.forEach(r => { raionStats[r.id_rai] = r; });

  const filtered = {
    ...raionGeoJSON,
    features: raionGeoJSON.features.filter(f => f.properties.id_reg === regionId || f.properties.id_reg == regionId),
  };

  if (regionsLayer) { map.removeLayer(regionsLayer); }
  if (raionsLayer) { map.removeLayer(raionsLayer); }

  raionsLayer = L.geoJSON(filtered, {
    style: raionStyle,
    onEachFeature(feature, layer) {
      const s = raionStats[Math.round(feature.properties.id_rai)] || {};
      layer.on({
        mouseover(e) {
          e.target.setStyle({ weight: 2, color: '#7090ff', fillOpacity: 0.9 });
          cancelHideGeoPanel();
          showGeoPanel(feature.properties.id_rai, s.name || feature.properties.raion, e.originalEvent);
        },
        mouseout(e) { raionsLayer.resetStyle(e.target); scheduleHideGeoPanel(); },
        click() { hideGeoPanelNow(); selectRaion(feature.properties.id_rai); },
      });
    },
  }).addTo(map);

  map.fitBounds(raionsLayer.getBounds(), { padding: [20, 20] });
  renderRaionLabels();

  const regionName = regionStats[regionId]?.name || `Регион ${regionId}`;
  updateBreadcrumb(regionName, null);
  loadDistinct('kato_rainame');
  await refreshKPI();
  await Promise.all([loadTable(1), loadSummary(), loadCoverageGroups(), loadCatRegions(), loadUncovered(), loadHelpPresence()]);
}

async function selectRaion(raionId) {
  currentRaion = raionId;
  currentPage = 1;
  const raionName = raionStats[raionId]?.name || `Район ${raionId}`;
  const regionName = regionStats[currentRegion]?.name || '';
  updateBreadcrumb(regionName, raionName);
  await refreshKPI();
  await loadTable(1);
  // ranking stays on raion list when a raion is selected
}

function toggleTheme(isLight) {
  document.documentElement.dataset.theme = isLight ? 'light' : '';
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  if (tileLayer) {
    tileLayer.setUrl(
      isLight
        ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    );
  }
}

function goBack() {
  currentRegion = null;
  currentRaion = null;
  currentPage = 1;
  hideGeoPanelNow();
  updateBreadcrumb(null, null);
  clearLabels();
  renderRegions();
  map.setView([48, 68], 4);
  refreshKPI();
  loadTable(1);
  loadSummary();
  loadCoverageGroups();
  loadCatRegions();
  loadUncovered();
  loadHelpPresence();
}

function goBackFromRanking() {
  const savedScroll = window.scrollY;
  currentRegion = null;
  currentRaion = null;
  currentPage = 1;
  hideGeoPanelNow();
  updateBreadcrumb(null, null);
  clearLabels();
  renderRegions();
  refreshKPI();
  loadTable(1);
  loadSummary();
  loadCoverageGroups();
  loadCatRegions();
  loadUncovered();
  loadHelpPresence();
  requestAnimationFrame(() => window.scrollTo({ top: savedScroll, behavior: 'instant' }));
}

function updateBreadcrumb(region, raion) {
  const el = document.getElementById('breadcrumb');
  let html = '<span onclick="goBack()">Казахстан</span>';
  if (region) html += ` / <span onclick="drillRegion(${currentRegion})">${region}</span>`;
  if (raion) html += ` / ${raion}`;
  el.innerHTML = html;
}


async function refreshKPI() {
  const params = new URLSearchParams();
  if (currentRaion) params.set('raion_id', currentRaion);
  else if (currentRegion) params.set('region_id', currentRegion);

  const data = await fetch(`/api/kpi?${params}`).then(r => r.json());

  animateCounter('kpi-dec',         data.total_dec_pay_sum,  v => formatNum(v));
  animateCounter('kpi-recipients',  data.unique_recipients,  v => formatInt(v));
  animateCounter('kpi-male',        data.male_count,         v => formatInt(v));
  animateCounter('kpi-female',      data.female_count,       v => formatInt(v));
  animateCounter('kpi-help-types',  data.help_type_count || 0,  v => formatInt(v));
  animateCounter('kpi-people-cats', data.people_cat_count || 0, v => formatInt(v));
  renderSduChart(data.sdu || {});
  renderAgeChart(data.age || {});
}

const SDU_META = {
  A: { label: 'A — Отличный',    color: '#2ecc71' },
  B: { label: 'B — Хороший',     color: '#4ecdc4' },
  C: { label: 'C — Средний',     color: '#f7dc6f' },
  D: { label: 'D — Критический', color: '#e67e22' },
  E: { label: 'E — Экстренный',  color: '#e74c3c' },
};

function renderSduChart(sdu) {
  const keys = ['A', 'B', 'C', 'D', 'E'];
  const values = keys.map(k => sdu[k] || 0);
  const colors = keys.map(k => SDU_META[k].color);
  const total = values.reduce((a, b) => a + b, 0);

  // Legend
  const legend = document.getElementById('sdu-legend');
  legend.innerHTML = keys.map(k => {
    const count = sdu[k] || 0;
    const pct = total ? Math.round(count / total * 100) : 0;
    return `<div class="sdu-legend-item" title="${SDU_META[k].label}: ${formatInt(count)} (${pct}%)">
      <span class="sdu-dot" style="background:${SDU_META[k].color}"></span>
      <span class="sdu-leg-label">${SDU_META[k].label}</span>
      <span class="sdu-leg-val">${pct}%</span>
    </div>`;
  }).join('');

  const ctx = document.getElementById('sdu-chart').getContext('2d');
  if (sduChart) sduChart.destroy();
  sduChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: keys.map(k => SDU_META[k].label),
      datasets: [{ data: values, backgroundColor: colors, borderWidth: 0, hoverOffset: 6 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${formatInt(ctx.raw)}`,
          },
        },
      },
    },
  });
}

const AGE_META = [
  { key: 'до18',  label: 'До 18 лет',  color: '#a29bfe' },
  { key: '18-25', label: '18–25',       color: '#74b9ff' },
  { key: '25-35', label: '25–35',       color: '#55efc4' },
  { key: '35-45', label: '35–45',       color: '#ffeaa7' },
  { key: '45-55', label: '45–55',       color: '#fdcb6e' },
  { key: '55+',   label: '55 и более',  color: '#e17055' },
];

function renderAgeChart(age) {
  const values = AGE_META.map(m => age[m.key] || 0);
  const colors = AGE_META.map(m => m.color);
  const total = values.reduce((a, b) => a + b, 0);

  const legend = document.getElementById('age-legend');
  legend.innerHTML = AGE_META.map((m, i) => {
    const count = values[i];
    const pct = total ? Math.round(count / total * 100) : 0;
    return `<div class="sdu-legend-item" title="${m.label}: ${formatInt(count)} (${pct}%)">
      <span class="sdu-dot" style="background:${m.color}"></span>
      <span class="sdu-leg-label">${m.label}</span>
      <span class="sdu-leg-val">${pct}%</span>
    </div>`;
  }).join('');

  const ctx = document.getElementById('age-chart').getContext('2d');
  if (ageChart) ageChart.destroy();
  ageChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: AGE_META.map(m => m.label),
      datasets: [{ data: values, backgroundColor: colors, borderWidth: 0, hoverOffset: 6 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.label}: ${formatInt(ctx.raw)}`,
          },
        },
      },
    },
  });
}

let coverageData = [];
let coverageTotal = null;
let coverageSortCol = 'total_sum';
let coverageSortDir = 'desc';

let groupsColumns = [];
let groupsRows = [];
let groupsTotal = null;
let groupsSortGroup = null;
let groupsSortDir = 'desc';

let catRegionsData = [];
let catRegionsSortBy = 'name';          // 'name' | 'count'
let catRegionsSortDir = 'asc';          // direction for the active sort
let catRegionsSearch = '';
let catRegionsExpanded = new Set();     // category index expanded
let catRegionsRegExpanded = new Set();  // `${catIdx}|${regionId}` expanded

async function loadCatRegions() {
  // Entitlement view (nation-wide), independent of the map drill
  setText('cat-regions-geo-label', 'В скольких регионах положено');

  document.getElementById('cat-regions-body').innerHTML =
    '<tr><td colspan="2" class="loading">Загрузка...</td></tr>';

  catRegionsExpanded.clear();
  catRegionsRegExpanded.clear();
  catRegionsData = await fetch(`/api/cat-regions`).then(r => r.json());
  renderCatRegions();
}

function payListHtml(title, pays) {
  if (!pays || !pays.length) return '';
  const items = pays.map(p => `<li>${stripHelpPrefix(p.name)} — ${p.max} ₸</li>`).join('');
  const t = title ? `<div class="cr-pay-title">${title}</div>` : '';
  return `${t}<ul class="cr-pay-list">${items}</ul>`;
}

function renderCatRegions() {
  let list = catRegionsData.map((r, i) => ({ ...r, _i: i }));

  if (catRegionsSearch) {
    const q = catRegionsSearch.toLowerCase();
    list = list.filter(r => (r.cat_type || '').toLowerCase().includes(q));
  }

  list.sort((a, b) => {
    const cmp = catRegionsSortBy === 'name'
      ? (a.cat_type || '').localeCompare(b.cat_type || '', 'ru')
      : a.geo_count - b.geo_count;
    return catRegionsSortDir === 'asc' ? cmp : -cmp;
  });
  const sorted = list;

  const dirArrow = catRegionsSortDir === 'asc' ? ' ▲' : ' ▼';
  const nameIcon = document.getElementById('cat-regions-name-icon');
  if (nameIcon) nameIcon.textContent = catRegionsSortBy === 'name' ? dirArrow : '';
  const icon = document.getElementById('cat-regions-sort-icon');
  if (icon) icon.textContent = catRegionsSortBy === 'count' ? dirArrow : '';

  const html = sorted.map(r => {
    const hasRegions = r.regions && r.regions.length;
    const open = catRegionsExpanded.has(r._i);
    const caret = hasRegions ? `<span class="unc-caret">${open ? '▲' : '▼'}</span> ` : '';
    const catCell = hasRegions
      ? `<td class="cr-cat" data-cat-toggle="${r._i}" style="cursor:pointer" title="${r.cat_type}">${caret}${r.cat_type}</td>`
      : `<td title="${r.cat_type}">${r.cat_type}</td>`;
    let row = `<tr>${catCell}<td class="col-right">${r.geo_count}</td></tr>`;

    if (open && hasRegions) {
      const regItems = r.regions.map(reg => {
        const key = `${r._i}|${reg.id}`;
        const regOpen = catRegionsRegExpanded.has(key);
        const hasRaions = reg.raions && reg.raions.length;
        let li = `<li>
          <div class="cr-reg" data-reg-toggle="${key}">
            <span class="unc-caret">${regOpen ? '▲' : '▼'}</span> ${reg.name}
          </div>`;
        if (regOpen) {
          li += `<div class="cr-sub">`;
          li += payListHtml('Виды помощи в регионе:', reg.pay_types);
          if (hasRaions) {
            li += `<div class="cr-raion-title">Районы:</div>`;
            li += `<ul class="cr-raion-list-2">` + reg.raions.map(rai =>
              `<li><div class="cr-raion-name">${rai.name}</div>${payListHtml(null, rai.pay_types)}</li>`
            ).join('') + `</ul>`;
          }
          li += `</div>`;
        }
        return li + `</li>`;
      }).join('');

      row += `<tr class="cr-detail-row"><td colspan="2">
        <div class="cr-detail">
          <div class="cr-detail-title">Регионы, где положено (${r.regions.length}):</div>
          <ul class="cr-reg-list">${regItems}</ul>
        </div></td></tr>`;
    }
    return row;
  }).join('');

  document.getElementById('cat-regions-body').innerHTML =
    html || '<tr><td colspan="2" class="no-data">Нет информации</td></tr>';
}

function toggleSet(set, key) {
  if (set.has(key)) set.delete(key); else set.add(key);
}

let uncoveredData = [];
let uncoveredSortDir = 'desc';
let uncoveredExpanded = new Set();

let presenceColumns = [];
let presenceRows = [];
let presenceById = {};   // geo id -> presence row (for map tooltips)
let presenceSortCol = null;   // 'vidy' | 'kategorii' | 'lyudei' | 'summa'
let presenceSortDir = 'desc';

let geoPanelTimer = null;
let geoPanelRow = null;
let geoPanelLastEv = null;

function showGeoPanel(id, name, ev) {
  const row = presenceById[Math.round(id)];
  geoPanelRow = row;
  const panel = document.getElementById('geo-panel');
  if (!panel) return;

  let listHtml = '';
  if (row && presenceColumns.length && row.pay_cat_lists) {
    const entries = presenceColumns.map((c, i) => ({ c, i, cnt: (row.pay_cat_lists[i] || []).length }));
    // green (provided) first, then red (not provided) — stable within each group
    entries.sort((a, b) => (b.cnt > 0) - (a.cnt > 0));
    listHtml = entries.map(({ c, i, cnt }) => {
      const cls = cnt > 0 ? 'gp-yes' : 'gp-no';
      const attr = cnt > 0 ? `data-pay="${i}"` : '';
      return `<div class="gp-row ${cls}" ${attr}>
        <span class="gp-pay">${stripHelpPrefix(c.name)}:</span><span class="gp-cnt">${cnt}</span>
      </div>`;
    }).join('');
  }

  panel.innerHTML =
    `<div class="gp-main">
       <div class="gp-title">${(row && row.name) || name || '—'}</div>
       <div class="gp-list">${listHtml || '<div class="gp-empty">Нет данных</div>'}</div>
     </div>
     <div class="gp-side" id="gp-side"></div>`;

  panel.classList.add('visible');
  positionGeoPanel(ev);
}

function positionGeoPanel(ev) {
  const panel = document.getElementById('geo-panel');
  if (!panel) return;
  if (ev) geoPanelLastEv = { clientX: ev.clientX, clientY: ev.clientY };
  const e = geoPanelLastEv || { clientX: 120, clientY: 120 };
  const x = e.clientX, y = e.clientY;
  const pw = panel.offsetWidth || 420, ph = panel.offsetHeight || 240;
  const gap = 3;
  // always to the LEFT of the cursor — right edge of the panel hugs the cursor
  let left = x - gap - pw;
  if (left < 6) left = 6;                 // keep it on screen
  let top = y + gap;
  if (top + ph > window.innerHeight - 6) top = Math.max(6, window.innerHeight - ph - 6);
  panel.style.left = left + 'px';
  panel.style.right = 'auto';
  panel.style.top = top + 'px';
}

function scheduleHideGeoPanel() {
  clearTimeout(geoPanelTimer);
  geoPanelTimer = setTimeout(hideGeoPanelNow, 280);
}
function cancelHideGeoPanel() { clearTimeout(geoPanelTimer); }
function hideGeoPanelNow() {
  clearTimeout(geoPanelTimer);
  const panel = document.getElementById('geo-panel');
  if (panel) panel.classList.remove('visible');
}

async function loadHelpPresence() {
  const params = new URLSearchParams();
  if (currentRegion) params.set('region_id', currentRegion);

  document.getElementById('presence-body').innerHTML =
    '<tr><td colspan="2" class="loading">Загрузка...</td></tr>';

  const resp = await fetch(`/api/help-presence?${params}`).then(r => r.json());
  presenceColumns = resp.columns || [];
  presenceRows    = resp.rows    || [];
  presenceById = {};
  presenceRows.forEach(r => { if (r.id != null) presenceById[r.id] = r; });
  renderHelpPresence();
  // refresh map labels now that entitlement data is available
  if (map && labelsLayer) {
    if (currentRegion) renderRaionLabels(); else renderRegionLabels();
  }
}

function renderHelpPresence() {
  const geoLabel = currentRegion
    ? `Район (${regionStats[currentRegion]?.name || ''})` : 'Область';

  if (!presenceRows.length) {
    document.getElementById('presence-thead').innerHTML = '';
    document.getElementById('presence-body').innerHTML =
      '<tr><td colspan="2" class="no-data">Нет информации</td></tr>';
    return;
  }

  // Header: geo + mini-table (4 sortable cols) + one column per pay type
  const cols = presenceColumns.map(c => {
    const full = stripHelpPrefix(c.name);
    return `<th class="col-center prs-grp-hdr" title="${full}"><span class="prs-hdr-txt">${full}</span></th>`;
  }).join('');

  const miniHdr = (key, label, extraCls, title) => {
    const active = presenceSortCol === key;
    const icon = active ? (presenceSortDir === 'desc' ? ' ▼' : ' ▲') : '';
    return `<th class="col-center prs-mini-hdr sortable${active ? ' sort-active' : ''} ${extraCls || ''}" data-prs-sort="${key}" title="${title}">${label}<span class="sort-icon">${icon}</span></th>`;
  };

  document.getElementById('presence-thead').innerHTML =
    `<tr>
       <th class="prs-geo-hdr">${geoLabel}</th>
       ${miniHdr('vidy', 'Виды помощи', '', 'Виды помощи, которые должны оказываться')}
       ${miniHdr('kategorii', 'Категории', '', 'Категории, которым должна оказываться помощь')}
       ${miniHdr('lyudei', 'Людей', '', 'Количество людей, которым оказывается услуга')}
       ${miniHdr('summa', 'Сумма', 'prs-mini-sum', 'Фактически выплачено')}
       ${cols}
     </tr>`;

  // total row stays pinned on top; sort only the body rows
  const total = presenceRows.find(r => r.is_total);
  let body = presenceRows.filter(r => !r.is_total);
  if (presenceSortCol) {
    const key = presenceSortCol;
    body = [...body].sort((a, b) => {
      const av = key === 'summa' ? (a.mini?.summa_val ?? 0) : (a.mini?.[key] ?? 0);
      const bv = key === 'summa' ? (b.mini?.summa_val ?? 0) : (b.mini?.[key] ?? 0);
      return presenceSortDir === 'desc' ? bv - av : av - bv;
    });
  }
  const ordered = total ? [total, ...body] : body;

  document.getElementById('presence-body').innerHTML = ordered.map(r => {
    const isTotal = !!r.is_total;
    const clickAttr = (!currentRegion && !isTotal)
      ? `onclick="drillRegionFromRanking(${r.id})" style="cursor:pointer"` : '';
    const cls = isTotal ? 'prs-total-row' : (!currentRegion ? 'coverage-row' : '');
    const m = r.mini || {};
    const cells = r.presence.map(p => p
      ? `<td class="prs-cell prs-yes">✓</td>`
      : `<td class="prs-cell prs-no">✕</td>`
    ).join('');
    return `<tr ${clickAttr} class="${cls}">
      <td class="prs-geo-cell">${r.name || '—'}</td>
      <td class="col-center prs-mini">${m.vidy ?? 0}</td>
      <td class="col-center prs-mini">${m.kategorii ?? 0}</td>
      <td class="col-center prs-mini">${formatInt(m.lyudei ?? 0)}</td>
      <td class="col-right prs-mini prs-mini-sum">${m.summa ?? '0'} ₸</td>
      ${cells}
    </tr>`;
  }).join('');
}

async function loadUncovered() {
  const params = new URLSearchParams();
  if (currentRegion) params.set('region_id', currentRegion);

  setText('uncovered-col-name', currentRegion
    ? `Район (${regionStats[currentRegion]?.name || ''})` : 'Регион');

  document.getElementById('uncovered-body').innerHTML =
    '<tr><td colspan="2" class="loading">Загрузка...</td></tr>';

  uncoveredExpanded.clear();
  uncoveredData = await fetch(`/api/uncovered-cats?${params}`).then(r => r.json());
  renderUncovered();
}

function renderUncovered() {
  const sorted = [...uncoveredData].sort((a, b) =>
    uncoveredSortDir === 'desc'
      ? b.uncovered_count - a.uncovered_count
      : a.uncovered_count - b.uncovered_count
  );
  const icon = document.getElementById('uncovered-sort-icon');
  if (icon) icon.textContent = uncoveredSortDir === 'desc' ? ' ▼' : ' ▲';

  document.getElementById('uncovered-body').innerHTML = sorted.map(r => {
    const open = uncoveredExpanded.has(r.id);
    const countCell = r.uncovered_count > 0
      ? `<td class="col-center unc-count" onclick="toggleUncovered('${r.id}')" style="cursor:pointer">
           ${r.uncovered_count} <span class="unc-caret">${open ? '▲' : '▼'}</span>
         </td>`
      : `<td class="col-center" style="color:var(--tx-muted)">0</td>`;
    const nameCell = !currentRegion
      ? `<td class="coverage-row" onclick="drillRegionFromRanking(${r.id})" style="cursor:pointer">${r.name || '—'}</td>`
      : `<td>${r.name || '—'}</td>`;
    let html = `<tr>${nameCell}${countCell}</tr>`;
    if (open && r.uncovered_count > 0) {
      const list = r.uncovered_cats.map(c => `<li>${c}</li>`).join('');
      html += `<tr class="unc-detail-row"><td colspan="2">
        <div class="unc-detail">
          <div class="unc-detail-title">Не оказываемые категории (${r.uncovered_count}):</div>
          <ul class="unc-list">${list}</ul>
        </div></td></tr>`;
    }
    return html;
  }).join('') || '<tr><td colspan="2" class="no-data">Нет информации</td></tr>';
}

function toggleUncovered(id) {
  // id arrives as string from inline handler; data ids may be numeric
  const match = uncoveredData.find(r => String(r.id) === String(id));
  const key = match ? match.id : id;
  if (uncoveredExpanded.has(key)) uncoveredExpanded.delete(key);
  else uncoveredExpanded.add(key);
  renderUncovered();
}

function renderGroupCell(g) {
  if (!g.available) return `<td class="grp-cell grp-red">0</td>`;
  if (g.covered === 0) return `<td class="grp-cell grp-red">0</td>`;
  const cls = g.covered >= 7 ? 'grp-green' : 'grp-orange';
  return `<td class="grp-cell ${cls}">${g.covered} кат.</td>`;
}

function renderGroups() {
  if (!groupsRows.length) {
    document.getElementById('groups-body').innerHTML =
      '<tr><td colspan="4" class="no-data">Нет информации</td></tr>';
    return;
  }
  const geoLabel = currentRegion
    ? `Район (${regionStats[currentRegion]?.name || ''})` : 'Регион';

  document.getElementById('groups-thead').innerHTML = `<tr>
    <th>${geoLabel}</th>
    ${groupsColumns.map(col => {
      const active = groupsSortGroup === col.name;
      const icon = active ? (groupsSortDir === 'desc' ? ' ▼' : ' ▲') : '';
      const full = stripHelpPrefix(col.name);
      return `<th class="col-center sortable grp-col-hdr${active ? ' sort-active' : ''}" data-grp="${col.name}" title="${full}"><span class="prs-hdr-txt">${full}</span><span class="sort-icon">${icon}</span></th>`;
    }).join('')}
  </tr>`;

  document.querySelectorAll('#groups-thead th[data-grp]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const g = th.dataset.grp;
      groupsSortDir = groupsSortGroup === g && groupsSortDir === 'desc' ? 'asc' : 'desc';
      groupsSortGroup = g;
      renderGroups();
    });
  });

  const sorted = groupsSortGroup
    ? [...groupsRows].sort((a, b) => {
        const ga = a.groups.find(g => g.group === groupsSortGroup);
        const gb = b.groups.find(g => g.group === groupsSortGroup);
        const va = ga ? ga.covered : -1, vb = gb ? gb.covered : -1;
        return groupsSortDir === 'desc' ? vb - va : va - vb;
      })
    : groupsRows;

  const totalHtml = groupsTotal ? `<tr class="grp-total-row">
      <td>${groupsTotal.name}</td>
      ${groupsTotal.groups.map(g => renderGroupCell(g)).join('')}
    </tr>` : '';

  document.getElementById('groups-body').innerHTML = totalHtml + sorted.map(r => {
    const clickAttr = !currentRegion
      ? `onclick="drillRegionFromRanking(${r.id})" style="cursor:pointer"` : '';
    return `<tr ${clickAttr} class="${!currentRegion ? 'coverage-row' : ''}">
      <td>${r.name || '—'}</td>
      ${r.groups.map(g => renderGroupCell(g)).join('')}
    </tr>`;
  }).join('');
}

async function loadCoverageGroups() {
  const params = new URLSearchParams();
  if (currentRegion) params.set('region_id', currentRegion);

  document.getElementById('groups-body').innerHTML =
    '<tr><td colspan="4" class="loading">Загрузка...</td></tr>';

  try {
    const resp = await fetch(`/api/coverage-groups?${params}`).then(r => r.json());
    // Support both new {columns, rows} format and legacy array format
    if (resp && resp.columns) {
      groupsColumns = resp.columns;
      groupsRows    = resp.rows || [];
      groupsTotal   = resp.total || null;
    } else if (Array.isArray(resp)) {
      // Legacy format — derive columns from first row's groups
      groupsColumns = (resp[0]?.groups || []).map(g => ({ id: g.group, name: g.group }));
      groupsRows    = resp;
      groupsTotal   = null;
    } else {
      groupsColumns = [];
      groupsRows    = [];
      groupsTotal   = null;
    }
  } catch(e) {
    groupsColumns = [];
    groupsRows    = [];
    groupsTotal   = null;
  }
  renderGroups();
}

function coverageRowHtml(r, clickable) {
  const clickAttr = clickable
    ? `onclick="drillRegionFromRanking(${r.id})" style="cursor:pointer"` : '';
  const cls = r.is_total ? 'prs-total-row' : (clickable ? 'coverage-row' : '');
  return `<tr ${clickAttr} class="${cls}">
    <td>${r.name || '—'}</td>
    <td class="col-center">${r.help_types}</td>
    <td class="col-center">${r.cat_count}</td>
    <td class="col-right">${formatNum(r.max_sum)} ₸</td>
    <td class="col-right">${formatNum(r.total_sum)} ₸</td>
    <td class="col-right">${(r.pct ?? 0)}%</td>
  </tr>`;
}

function renderCoverage() {
  const isRegionView = !!currentRegion;
  const sorted = [...coverageData].sort((a, b) => {
    const va = a[coverageSortCol] ?? 0;
    const vb = b[coverageSortCol] ?? 0;
    return coverageSortDir === 'desc' ? vb - va : va - vb;
  });
  document.querySelectorAll('#tab-coverage th[data-sort-col]').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    const active = th.dataset.sortCol === coverageSortCol;
    icon.textContent = active ? (coverageSortDir === 'desc' ? ' ▼' : ' ▲') : '';
    th.classList.toggle('sort-active', active);
  });
  const totalHtml = coverageTotal ? coverageRowHtml(coverageTotal, false) : '';
  document.getElementById('coverage-body').innerHTML =
    totalHtml + (sorted.map(r => coverageRowHtml(r, !isRegionView)).join('')
      || '<tr><td colspan="6" class="no-data">Нет информации</td></tr>');
}

async function loadSummary() {
  const params = new URLSearchParams();
  const isRegionView = !!currentRegion;
  if (isRegionView) params.set('region_id', currentRegion);

  document.getElementById('coverage-body').innerHTML =
    '<tr><td colspan="6" class="loading">Загрузка...</td></tr>';
  const regionName = isRegionView ? (regionStats[currentRegion]?.name || '') : '';
  setText('coverage-col-name', isRegionView ? `Район (${regionName})` : 'Регион');
  document.getElementById('coverage-btn-back').style.display = isRegionView ? 'inline-block' : 'none';

  const resp = await fetch(`/api/summary?${params}`).then(r => r.json());
  coverageData  = resp.rows  || [];
  coverageTotal = resp.total || null;
  renderCoverage();
}


function initTableHead() {
  const thead = document.getElementById('table-head');

  const labelRow = TABLE_COLS.map(c => {
    if (c.sortable) {
      return `<th class="tbl-sortable" data-col="${c.key}">${c.label} <span class="sort-icon" id="tsort-${c.key}"></span></th>`;
    }
    return `<th>${c.label}</th>`;
  }).join('');

  const filterRow = TABLE_COLS.map(c => {
    if (c.filterable) {
      const genderOpts = c.key === 'gender_id'
        ? '<option value="">Все</option><option value="1">Мужской</option><option value="2">Женский</option>'
        : '<option value="">Все</option>';
      return `<th><select class="tbl-filter" data-col="${c.key}" id="tfilter-${c.key}">${genderOpts}</select></th>`;
    }
    return '<th></th>';
  }).join('');

  thead.innerHTML = `<tr>${labelRow}</tr><tr class="filter-row">${filterRow}</tr>`;

  thead.querySelectorAll('.tbl-sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      tableSortDir = tableSortCol === col && tableSortDir === 'desc' ? 'asc' : 'desc';
      tableSortCol = col;
      updateTableSortIcons();
      loadTable(1);
    });
  });

  thead.querySelectorAll('.tbl-filter').forEach(sel => {
    if (sel.dataset.col !== 'gender_id') {
      loadDistinct(sel.dataset.col);
    }
    sel.addEventListener('change', () => {
      const col = sel.dataset.col;
      if (sel.value) tableFilters[col] = sel.value;
      else delete tableFilters[col];
      loadTable(1);
    });
  });
}

async function loadDistinct(col) {
  const params = new URLSearchParams({ col });
  if (currentRegion) params.set('region_id', currentRegion);
  const vals = await fetch(`/api/distinct?${params}`).then(r => r.json());
  const sel = document.getElementById(`tfilter-${col}`);
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Все</option>' +
    vals.map(v => `<option value="${v}"${v === current ? ' selected' : ''}>${v}</option>`).join('');
}

function updateTableSortIcons() {
  TABLE_COLS.filter(c => c.sortable).forEach(c => {
    const el = document.getElementById(`tsort-${c.key}`);
    if (el) el.textContent = tableSortCol === c.key ? (tableSortDir === 'desc' ? ' ▼' : ' ▲') : '';
    const th = document.querySelector(`.tbl-sortable[data-col="${c.key}"]`);
    if (th) th.classList.toggle('sort-active', tableSortCol === c.key);
  });
}

async function loadTable(page) {
  currentPage = page;
  const params = new URLSearchParams({ page, limit: 50 });
  if (currentRaion) params.set('raion_id', currentRaion);
  else if (currentRegion) params.set('region_id', currentRegion);
  if (tableSortCol) { params.set('sort_col', tableSortCol); params.set('sort_dir', tableSortDir); }
  Object.entries(tableFilters).forEach(([k, v]) => params.set(`f_${k}`, v));

  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '<tr><td colspan="99" class="loading">Загрузка...</td></tr>';

  const data = await fetch(`/api/table?${params}`).then(r => r.json());

  setText('table-info', `Записей: ${data.total} | Страница ${data.page} из ${data.pages}`);

  const html = data.data.map(row =>
    `<tr>${TABLE_COLS.map(c => `<td>${fmtCell(c.key, row[c.key])}</td>`).join('')}</tr>`
  ).join('') || '<tr><td colspan="99" class="no-data">Нет информации</td></tr>';
  tbody.classList.remove('tbl-loaded');
  tbody.innerHTML = html;
  requestAnimationFrame(() => tbody.classList.add('tbl-loaded'));

  document.getElementById('btn-prev').disabled = page <= 1;
  document.getElementById('btn-next').disabled = page >= data.pages;
  document.getElementById('page-info').textContent = `${page} / ${data.pages}`;
}

function fmtCell(key, val) {
  if (val === null || val === undefined) return '—';
  if (key === 'gender_id') return val === '1' ? 'М' : val === '2' ? 'Ж' : val;
  if (key === 'max_pay_sum' || key === 'dec_pay_sum') return val ? formatNum(parseFloat(val)) : '—';
  return val;
}

function animateCounter(id, end, formatter) {
  const el = document.getElementById(id);
  if (!el) return;
  const prev = parseFloat(el.dataset.raw ?? end);
  el.dataset.raw = end;
  if (Math.abs(prev - end) < 0.01) { el.textContent = formatter(end); return; }
  const dur = 750;
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min((now - t0) / dur, 1);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = formatter(prev + (end - prev) * e);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function formatNum(n) {
  if (!n && n !== 0) return '—';
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 2 }).format(n);
}

function formatInt(n) {
  return new Intl.NumberFormat('ru-KZ').format(n || 0);
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

window.addEventListener('load', () => { if (map) map.invalidateSize(); });

document.addEventListener('DOMContentLoaded', () => {
  const savedTheme = localStorage.getItem('theme') || 'dark';
  if (savedTheme === 'light') {
    document.documentElement.dataset.theme = 'light';
    const sw = document.getElementById('theme-switch');
    if (sw) sw.checked = true;
  }

  // Pseudo-auth gate — show login until correct credentials are entered
  if (!isAuthed()) { showLogin(); return; }

  initTableHead();
  init();
  document.getElementById('btn-prev').addEventListener('click', () => loadTable(currentPage - 1));
  document.getElementById('btn-next').addEventListener('click', () => loadTable(currentPage + 1));

  document.querySelectorAll('#tab-coverage th[data-sort-col]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.dataset.sortCol;
      coverageSortDir = coverageSortCol === col && coverageSortDir === 'desc' ? 'asc' : 'desc';
      coverageSortCol = col;
      renderCoverage();
    });
  });

  document.getElementById('presence-thead')?.addEventListener('click', e => {
    const th = e.target.closest('[data-prs-sort]');
    if (!th) return;
    const col = th.dataset.prsSort;
    if (presenceSortCol === col) presenceSortDir = presenceSortDir === 'desc' ? 'asc' : 'desc';
    else { presenceSortCol = col; presenceSortDir = 'desc'; }
    renderHelpPresence();
  });

  document.querySelector('#cat-regions-name-header .cr-name-sort')?.addEventListener('click', () => {
    if (catRegionsSortBy === 'name') catRegionsSortDir = catRegionsSortDir === 'asc' ? 'desc' : 'asc';
    else { catRegionsSortBy = 'name'; catRegionsSortDir = 'asc'; }
    renderCatRegions();
  });

  document.getElementById('cat-regions-geo-header')?.addEventListener('click', () => {
    if (catRegionsSortBy === 'count') catRegionsSortDir = catRegionsSortDir === 'asc' ? 'desc' : 'asc';
    else { catRegionsSortBy = 'count'; catRegionsSortDir = 'desc'; }
    renderCatRegions();
  });

  document.getElementById('cat-regions-search')?.addEventListener('input', e => {
    catRegionsSearch = e.target.value.trim();
    renderCatRegions();
  });

  document.getElementById('cat-regions-body')?.addEventListener('click', e => {
    const catEl = e.target.closest('[data-cat-toggle]');
    if (catEl) { toggleSet(catRegionsExpanded, +catEl.dataset.catToggle); renderCatRegions(); return; }
    const regEl = e.target.closest('[data-reg-toggle]');
    if (regEl) { toggleSet(catRegionsRegExpanded, regEl.dataset.regToggle); renderCatRegions(); }
  });

  document.getElementById('uncovered-count-header')?.addEventListener('click', () => {
    uncoveredSortDir = uncoveredSortDir === 'desc' ? 'asc' : 'desc';
    renderUncovered();
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.getElementById(`tab-${btn.dataset.tab}`);
      if (pane) pane.classList.add('active');
    });
  });

  // Interactive map hover panel — stay open while hovered, click a pay type for categories
  const gp = document.getElementById('geo-panel');
  if (gp) {
    gp.addEventListener('mouseenter', cancelHideGeoPanel);
    gp.addEventListener('mouseleave', scheduleHideGeoPanel);
    gp.addEventListener('click', e => {
      const rowEl = e.target.closest('[data-pay]');
      if (!rowEl) return;
      const i = +rowEl.dataset.pay;
      const cats = (geoPanelRow?.pay_cat_lists?.[i]) || [];
      const name = stripHelpPrefix(presenceColumns[i]?.name || '');
      const side = document.getElementById('gp-side');
      if (!side) return;
      if (side.dataset.open === String(i)) {
        side.classList.remove('visible'); side.dataset.open = '';
        gp.querySelectorAll('.gp-row').forEach(r => r.classList.remove('gp-active'));
        positionGeoPanel();   // re-anchor after the side closes (width shrank)
        return;
      }
      side.dataset.open = String(i);
      side.innerHTML =
        `<div class="gp-side-title">${name}</div>
         <div class="gp-side-sub">Категории людей (${cats.length}):</div>
         <ul class="gp-cat-list">${cats.map(x => `<li>${x}</li>`).join('')}</ul>`;
      side.classList.add('visible');
      gp.querySelectorAll('.gp-row').forEach(r => r.classList.remove('gp-active'));
      rowEl.classList.add('gp-active');
      positionGeoPanel();     // re-anchor so the side panel grows to the LEFT
    });
  }

});
