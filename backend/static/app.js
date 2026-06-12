const API = '';
let map, regionsLayer, raionsLayer, labelsLayer;
let sduChart = null;
let tileLayer = null;
let regionGeoJSON = null, raionGeoJSON = null;
let regionCentroids = {}, raionCentroids = {};
let regionStats = {}, raionStats = {};
let currentRegion = null, currentRaion = null;
let currentPage = 1;
let rankingData = [];
let rankSortCol = 'total_dec';
let rankSortDir = 'desc';
let ageChart = null;

const TABLE_COLS = [
  { key: 'app_date',     label: 'Дата заявки' },
  { key: 'app_status',   label: 'Статус',           filterable: true },
  { key: 'iin',          label: 'ИИН' },
  { key: 'kato_regname', label: 'Регион',            filterable: true },
  { key: 'kato_rainame', label: 'Район',             filterable: true },
  { key: 'pay_type',     label: 'Тип выплаты',       filterable: true },
  { key: 'cat_type',     label: 'Категория',         filterable: true },
  { key: 'period',       label: 'Период',            filterable: true },
  { key: 'max_pay_sum',  label: 'MAX выплата',       sortable: true },
  { key: 'dec_pay_sum',  label: 'Выплачено',         sortable: true },
  { key: 'mrp',          label: 'МРП',               sortable: true },
  { key: 'sicid',        label: 'SICID' },
  { key: 'gender_id',    label: 'Пол',              filterable: true },
  { key: 'vozrast',      label: 'Возраст',           sortable: true },
  { key: 'sdu_tzhs',     label: 'СДУ/ТЖС',         filterable: true },
  { key: 'sys_date',     label: 'Дата системы' },
];

let tableSortCol = null;
let tableSortDir = 'desc';
let tableFilters = {};

async function init() {
  map = L.map('map', { zoomControl: true, attributionControl: false }).setView([48, 68], 5);
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
  await Promise.all([loadTable(1), loadRanking(), loadSummary(), loadCoverageGroups(), loadBreakdown(1), loadCatRegions(), loadUncovered()]);
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

function renderRegionLabels() {
  clearLabels();
  labelsLayer = L.layerGroup();
  Object.entries(regionStats).forEach(([id, s]) => {
    const c = regionCentroids[id];
    if (!c) return;
    const label = `${s.pay_type_count ?? '?'}/${s.cat_type_count ?? '?'}`;
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
    const label = `${s.pay_type_count ?? '?'}/${s.cat_type_count ?? '?'}`;
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
      const xy = `${s.pay_type_count ?? '?'}/${s.cat_type_count ?? '?'}`;
      layer.bindTooltip(
        `<b>${s.name || feature.properties.region}</b><br>Записей: ${s.count || 0}<br>Тип/Категория: ${xy}`,
        { sticky: true }
      );
      layer.on({
        mouseover(e) { e.target.setStyle({ weight: 2, color: '#7090ff', fillOpacity: 0.9 }); },
        mouseout(e) { regionsLayer.resetStyle(e.target); },
        click() { drillRegion(feature.properties.id_reg); },
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
      const xy = `${s.pay_type_count ?? '?'}/${s.cat_type_count ?? '?'}`;
      layer.bindTooltip(
        `<b>${s.name || feature.properties.raion}</b><br>Записей: ${s.count || 0}<br>Тип/Категория: ${xy}`,
        { sticky: true }
      );
      layer.on({
        mouseover(e) { e.target.setStyle({ weight: 2, color: '#7090ff', fillOpacity: 0.9 }); },
        mouseout(e) { raionsLayer.resetStyle(e.target); },
        click() { selectRaion(feature.properties.id_rai); },
      });
    },
  }).addTo(map);
  renderRaionLabels();

  const regionName = regionStats[regionId]?.name || `Регион ${regionId}`;
  updateBreadcrumb(regionName, null);
  loadDistinct('kato_rainame');
  await refreshKPI();
  await Promise.all([loadTable(1), loadRanking(), loadSummary(), loadCoverageGroups(), loadBreakdown(1), loadCatRegions(), loadUncovered()]);
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
      const xy = `${s.pay_type_count ?? '?'}/${s.cat_type_count ?? '?'}`;
      layer.bindTooltip(
        `<b>${s.name || feature.properties.raion}</b><br>Записей: ${s.count || 0}<br>Тип/Категория: ${xy}`,
        { sticky: true }
      );
      layer.on({
        mouseover(e) { e.target.setStyle({ weight: 2, color: '#7090ff', fillOpacity: 0.9 }); },
        mouseout(e) { raionsLayer.resetStyle(e.target); },
        click() { selectRaion(feature.properties.id_rai); },
      });
    },
  }).addTo(map);

  map.fitBounds(raionsLayer.getBounds(), { padding: [20, 20] });
  renderRaionLabels();

  const regionName = regionStats[regionId]?.name || `Регион ${regionId}`;
  updateBreadcrumb(regionName, null);
  loadDistinct('kato_rainame');
  await refreshKPI();
  await Promise.all([loadTable(1), loadRanking(), loadSummary(), loadCoverageGroups(), loadBreakdown(1), loadCatRegions(), loadUncovered()]);
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
  updateBreadcrumb(null, null);
  clearLabels();
  renderRegions();
  map.setView([48, 68], 5);
  refreshKPI();
  loadTable(1);
  loadRanking();
  loadSummary();
  loadCoverageGroups();
  loadBreakdown(1);
  loadCatRegions();
  loadUncovered();
}

function goBackFromRanking() {
  const savedScroll = window.scrollY;
  currentRegion = null;
  currentRaion = null;
  currentPage = 1;
  updateBreadcrumb(null, null);
  clearLabels();
  renderRegions();
  refreshKPI();
  loadTable(1);
  loadRanking();
  loadSummary();
  loadCoverageGroups();
  loadBreakdown(1);
  loadCatRegions();
  loadUncovered();
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

  animateCounter('kpi-dec',        data.total_dec_pay_sum,  v => formatNum(v));
  animateCounter('kpi-recipients', data.unique_recipients,  v => formatInt(v));
  animateCounter('kpi-male',       data.male_count,         v => formatInt(v));
  animateCounter('kpi-female',     data.female_count,       v => formatInt(v));
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
let coverageSortCol = 'total_sum';
let coverageSortDir = 'desc';

let groupsColumns = [];
let groupsRows = [];
let groupsSortGroup = null;
let groupsSortDir = 'desc';

let breakdownPage = 1;
let breakdownSortDir = 'desc';

let catRegionsData = [];
let catRegionsSortDir = 'desc';

async function loadBreakdown(page = 1) {
  breakdownPage = page;
  const params = new URLSearchParams({ page, limit: 100, sort_dir: breakdownSortDir });
  if (currentRaion) params.set('raion_id', currentRaion);
  else if (currentRegion) params.set('region_id', currentRegion);

  const colName = currentRegion
    ? `Район (${regionStats[currentRegion]?.name || ''})`
    : 'Регион';
  setText('breakdown-col-name', colName);

  const icon = document.getElementById('breakdown-sort-icon');
  if (icon) icon.textContent = breakdownSortDir === 'desc' ? ' ▼' : ' ▲';

  document.getElementById('breakdown-body').innerHTML =
    '<tr><td colspan="4" class="loading">Загрузка...</td></tr>';

  const data = await fetch(`/api/breakdown?${params}`).then(r => r.json());
  const isRegionLevel = data.level === 'region';

  document.getElementById('breakdown-body').innerHTML = (data.data || []).map(r => {
    // Support both new geo_name and legacy raion field
    const name = r.geo_name !== undefined ? r.geo_name : (r.raion || '—');
    const geoCell = (isRegionLevel && r.geo_id)
      ? `<td class="coverage-row" onclick="drillRegionFromRanking(${r.geo_id})" style="cursor:pointer">${name}</td>`
      : `<td>${name}</td>`;
    return `<tr>
      ${geoCell}
      <td>${r.pay_type}</td>
      <td>${r.cat_type}</td>
      <td class="col-right">${formatNum(r.total_sum)} ₸</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="no-data">Нет информации</td></tr>';

  document.getElementById('bd-btn-prev').disabled = page <= 1;
  document.getElementById('bd-btn-next').disabled = page >= data.pages;
  document.getElementById('bd-page-info').textContent = `${page} / ${data.pages}`;
}

async function loadCatRegions() {
  const params = new URLSearchParams();
  if (currentRegion) params.set('region_id', currentRegion);

  const geoLabel = currentRegion
    ? 'Сколько районов оказывают помощь'
    : 'Сколько регионов оказывают помощь';
  setText('cat-regions-geo-label', geoLabel);

  document.getElementById('cat-regions-body').innerHTML =
    '<tr><td colspan="2" class="loading">Загрузка...</td></tr>';

  catRegionsData = await fetch(`/api/cat-regions?${params}`).then(r => r.json());
  renderCatRegions();
}

function renderCatRegions() {
  const sorted = [...catRegionsData].sort((a, b) =>
    catRegionsSortDir === 'desc' ? b.geo_count - a.geo_count : a.geo_count - b.geo_count
  );
  const icon = document.getElementById('cat-regions-sort-icon');
  if (icon) icon.textContent = catRegionsSortDir === 'desc' ? ' ▼' : ' ▲';

  document.getElementById('cat-regions-body').innerHTML = sorted.map(r =>
    `<tr><td title="${r.cat_type}">${r.cat_type}</td><td class="col-right">${r.geo_count}</td></tr>`
  ).join('') || '<tr><td colspan="2" class="no-data">Нет информации</td></tr>';
}

let uncoveredData = [];
let uncoveredSortDir = 'desc';
let uncoveredExpanded = new Set();

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
      const short = col.name.length > 28 ? col.name.slice(0, 27) + '…' : col.name;
      return `<th class="col-center sortable grp-col-hdr${active ? ' sort-active' : ''}" data-grp="${col.name}" title="${col.name}">${short}<span class="sort-icon">${icon}</span></th>`;
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

  document.getElementById('groups-body').innerHTML = sorted.map(r => {
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
    } else if (Array.isArray(resp)) {
      // Legacy format — derive columns from first row's groups
      groupsColumns = (resp[0]?.groups || []).map(g => ({ id: g.group, name: g.group }));
      groupsRows    = resp;
    } else {
      groupsColumns = [];
      groupsRows    = [];
    }
  } catch(e) {
    groupsColumns = [];
    groupsRows    = [];
  }
  renderGroups();
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
  document.getElementById('coverage-body').innerHTML = sorted.map(r => {
    const clickAttr = !isRegionView
      ? `onclick="drillRegionFromRanking(${r.id})" style="cursor:pointer"` : '';
    return `<tr ${clickAttr} class="${!isRegionView ? 'coverage-row' : ''}">
      <td>${r.name || '—'}</td>
      <td class="col-center">${r.help_types}</td>
      <td class="col-center">${r.cat_count}</td>
      <td class="col-right">${formatNum(r.total_sum)} ₸</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="no-data">Нет информации</td></tr>';
}

async function loadSummary() {
  const params = new URLSearchParams();
  const isRegionView = !!currentRegion;
  if (isRegionView) params.set('region_id', currentRegion);

  document.getElementById('coverage-body').innerHTML =
    '<tr><td colspan="4" class="loading">Загрузка...</td></tr>';
  const regionName = isRegionView ? (regionStats[currentRegion]?.name || '') : '';
  setText('coverage-col-name', isRegionView ? `Район (${regionName})` : 'Регион');
  document.getElementById('coverage-btn-back').style.display = isRegionView ? 'inline-block' : 'none';

  coverageData = await fetch(`/api/summary?${params}`).then(r => r.json());
  renderCoverage();
}

async function loadRanking() {
  const params = new URLSearchParams();
  const isRegionView = !!currentRegion;
  if (isRegionView) params.set('region_id', currentRegion);

  document.getElementById('ranking-body').innerHTML =
    '<tr><td colspan="5" class="loading">Загрузка...</td></tr>';

  setText('ranking-title', isRegionView
    ? `Рейтинг районов — ${regionStats[currentRegion]?.name || ''}`
    : 'Рейтинг регионов');
  setText('ranking-col-name', isRegionView ? 'Район' : 'Регион');
  document.getElementById('ranking-btn-back').style.display = isRegionView ? 'inline-block' : 'none';

  rankingData = await fetch(`/api/ranking?${params}`).then(r => r.json());
  renderRanking();
}

function renderRanking() {
  const isRegionView = !!currentRegion;
  const sorted = [...rankingData].sort((a, b) => {
    const va = a[rankSortCol] ?? -Infinity;
    const vb = b[rankSortCol] ?? -Infinity;
    return rankSortDir === 'desc' ? vb - va : va - vb;
  });

  const maxDec = Math.max(...sorted.map(r => r.total_dec || 0), 1);

  document.getElementById('ranking-body').innerHTML = sorted.map((r, i) => {
    const barPct = Math.round((r.total_dec || 0) / maxDec * 100);
    const clickAttr = !isRegionView
      ? `onclick="drillRegionFromRanking(${r.id})" style="cursor:pointer"`
      : '';
    return `<tr ${clickAttr} class="${!isRegionView ? 'ranking-row' : ''}">
      <td style="color:#5b6a88">${i + 1}</td>
      <td>${r.name || '—'}</td>
      <td>${formatInt(r.recipients)}</td>
      <td>
        <div class="rank-bar-wrap">
          <div class="rank-bar-track">
            <div class="rank-bar" style="width:${barPct}%;background:#5b8af8"></div>
          </div>
          <span class="rank-bar-val">${r.total_dec !== null ? formatNum(r.total_dec) + ' ₸' : '—'}</span>
        </div>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="no-data">Нет информации</td></tr>';

  // Update sort icons
  document.querySelectorAll('#ranking-col-name ~ th.sortable').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    if (th.dataset.col === rankSortCol) {
      icon.textContent = rankSortDir === 'desc' ? ' ▼' : ' ▲';
      th.classList.add('sort-active');
    } else {
      icon.textContent = '';
      th.classList.remove('sort-active');
    }
  });
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

  initTableHead();
  init();
  document.getElementById('btn-prev').addEventListener('click', () => loadTable(currentPage - 1));
  document.getElementById('btn-next').addEventListener('click', () => loadTable(currentPage + 1));
  document.getElementById('bd-btn-prev').addEventListener('click', () => loadBreakdown(breakdownPage - 1));
  document.getElementById('bd-btn-next').addEventListener('click', () => loadBreakdown(breakdownPage + 1));

  document.querySelectorAll('#tab-coverage th[data-sort-col]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.dataset.sortCol;
      coverageSortDir = coverageSortCol === col && coverageSortDir === 'desc' ? 'asc' : 'desc';
      coverageSortCol = col;
      renderCoverage();
    });
  });

  document.getElementById('breakdown-sum-header')?.addEventListener('click', () => {
    breakdownSortDir = breakdownSortDir === 'desc' ? 'asc' : 'desc';
    loadBreakdown(1);
  });

  document.getElementById('cat-regions-geo-header')?.addEventListener('click', () => {
    catRegionsSortDir = catRegionsSortDir === 'desc' ? 'asc' : 'desc';
    renderCatRegions();
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

  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (rankSortCol === col) {
        rankSortDir = rankSortDir === 'desc' ? 'asc' : 'desc';
      } else {
        rankSortCol = col;
        rankSortDir = 'desc';
      }
      renderRanking();
    });
  });
});
