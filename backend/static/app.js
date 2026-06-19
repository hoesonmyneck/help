const API = '';
let map, regionsLayer, raionsLayer, labelsLayer;
let sduChart = null;
let tileLayer = null;
let regionGeoJSON = null, raionGeoJSON = null;
let regionCentroids = {}, raionCentroids = {};
let regionStats = {}, raionStats = {};
let currentRegion = null, currentRaion = null;
let currentSdu = null;
let currentGender = null;
let currentAgeGroup = null;
let _sduSeq = 0;

function buildFilterParams(geoMode = 'full') {
  const p = new URLSearchParams();
  if (geoMode === 'full') {
    if (currentRaion) p.set('raion_id', currentRaion);
    else if (currentRegion) p.set('region_id', currentRegion);
  } else if (geoMode === 'region' && currentRegion) {
    p.set('region_id', currentRegion);
  }
  if (currentSdu)      p.set('sdu_filter',   currentSdu);
  if (currentGender)   p.set('gender_filter', String(currentGender));
  if (currentAgeGroup) p.set('age_group',     currentAgeGroup);
  return p;
}

function setGenderFilter(g) {
  currentGender = (currentGender === g) ? null : g;
  _refreshAfterFilterChange();
}
function setAgeFilter(key) {
  currentAgeGroup = (currentAgeGroup === key) ? null : key;
  _refreshAfterFilterChange();
}
let currentPage = 1;
let ageChart = null;

function stripHelpPrefix(name) {
  if (!name) return name;
  return name.replace(/^\s*СОЦИАЛЬНАЯ\s+ПОМОЩЬ\s+/i, '');
}

function fmtCompact(v) {
  if (!v || v === 0) return '';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + ' млн';
  if (v >= 1_000) return Math.round(v / 1_000) + ' тыс';
  return String(Math.round(v));
}

const PAY_TYPE_DESCRIPTIONS = {
  'НА ЛЕЧЕНИЕ (ОЗДОРОВЛЕНИЕ)': 'МИО предоставляют единовременную социальную помощь гражданам для возмещения расходов на лечение и оздоровление',
  'ЛИЦАМ С ИНВАЛИДНОСТЬЮ 1 ГРУППЫ, ИСПОЛЬЗУЮЩИХ АППАРАТ ГЕМОДИАЛИЗА': 'МИО предоставляют денежную помощь для возмещения дополнительных расходов, связанных с проведением гемодиализа',
  'НА ОПОРНО-ДВИГАТЕЛЬНЫЙ АППАРАТ': 'МИО предоставляют социальную помощь на приобретение и ремонт протезно-ортопедических изделий и иных средств, способствующих передвижению',
  'ДЕТЯМ С ИНВАЛИДНОСТЬЮ НА ЛЕЧЕНИЕ': 'МИО предоставляют денежную помощь для оплаты лечения, медицинской реабилитации и оздоровления детей с инвалидностью',
  'ЛИЦАМ, СТРАДАЮЩИМ ХРОНИЧЕСКОЙ ПОЧЕЧНОЙ НЕДОСТАТОЧНОСТЬЮ': 'МИО предоставляют денежную помощь для компенсации расходов, связанных с лечением и проведением процедур гемодиализа',
  'НА ЛЕКАРСТВЕННОЕ ОБЕСПЕЧЕНИЕ': 'МИО предоставляют денежную помощь на приобретение лекарственных средств по медицинским показаниям',
  'НА САНАТОРНО-КУРОРТНОЕ ЛЕЧЕНИЕ': 'МИО предоставляют денежную помощь на оплату санаторно-курортного лечения и оздоровления',
  'СОПРОВОЖДАЮЩЕМУ ЛИЦО С ИНВАЛИДНОСТЬЮ ПЕРВОЙ ГРУППЫ НА САНАТОРНО-КУРОРТНОЕ ЛЕЧЕНИЕ': 'МИО предоставляют денежную помощь на оплату для сопровождающего лица с инвалидностью 1 группы',
  'НА ОПЛАТУ КОММУНАЛЬНЫХ УСЛУГ': 'МИО предоставляют компенсацию расходов на оплату коммунальных услуг отдельным категориям граждан',
  'НА СОДЕРЖАНИЕ ЖИЛЬЯ': 'МИО предоставляют денежную помощь для возмещения расходов по содержанию жилья',
  'НА БЫТОВЫЕ НУЖДЫ': 'МИО предоставляют денежную помощь для удовлетворения первоочередных бытовых потребностей граждан',
  'НА ПРИОБРЕТЕНИЕ ТВЕРДОГО ТОПЛИВА': 'МИО предоставляют денежную помощь на приобретение твердого топлива для отопления жилого помещения в отопительный сезон',
  'В ВИДЕ ДЕНЕЖНОЙ ПОМОЩИ': 'МИО предоставляют единовременную или периодическую денежную выплату лицам, нуждающимся в социальной поддержке.',
};

/* ── Auth (real backend, httponly JWT cookie) ── */
let CURRENT_USER = null;

async function fetchMe() {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'include' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch {}
  location.reload();
}

function showLogin() {
  const ov = document.createElement('div');
  ov.className = 'auth-overlay';
  ov.innerHTML = `
    <form class="auth-card" id="auth-form">
      <div class="auth-logo">🏛️</div>
      <div class="auth-title">Анализ по мерам государственной поддержке МИО</div>
      <div class="auth-sub">Войдите в систему, чтобы продолжить</div>
      <input type="text" id="auth-login" placeholder="Логин" autocomplete="username" autofocus>
      <input type="password" id="auth-pass" placeholder="Пароль" autocomplete="current-password">
      <div class="auth-error" id="auth-error"></div>
      <button type="submit" id="auth-submit">Войти</button>
    </form>`;
  document.body.appendChild(ov);
  document.getElementById('auth-login').focus();
  document.getElementById('auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('auth-error');
    const btn = document.getElementById('auth-submit');
    errEl.textContent = '';
    const login = document.getElementById('auth-login').value.trim();
    const password = document.getElementById('auth-pass').value;
    btn.disabled = true;
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      const data = await r.json();
      if (!r.ok) {
        errEl.textContent = data.detail || 'Ошибка входа';
        document.getElementById('auth-pass').value = '';
        btn.disabled = false;
        return;
      }
      if (data.requires_2fa) {
        errEl.style.color = 'var(--tx-dim)';
        errEl.textContent = 'Подтвердите вход с помощью ЭЦП…';
        await runEdsSecondFactor(data.challenge, errEl, btn);
        return;
      }
      location.reload();
    } catch (err) {
      errEl.textContent = 'Сеть недоступна';
      btn.disabled = false;
    }
  });
}

/* ── ЭЦП второй фактор через NCALayer (Фаза 3) ── */
const NCALAYER_URLS = ['wss://127.0.0.1:13579/', 'ws://127.0.0.1:14579/'];

function _openNCALayer() {
  return new Promise((resolve, reject) => {
    let i = 0;
    (function tryNext() {
      if (i >= NCALAYER_URLS.length) return reject(new Error('NCALayer недоступен. Запустите программу NCALayer.'));
      const ws = new WebSocket(NCALAYER_URLS[i++]);
      const t = setTimeout(() => { try { ws.close(); } catch (_) {} tryNext(); }, 3000);
      ws.addEventListener('open',  () => { clearTimeout(t); resolve(ws); });
      ws.addEventListener('error', () => { clearTimeout(t); try { ws.close(); } catch (_) {} tryNext(); });
    })();
  });
}

async function runEdsSecondFactor(challenge, errEl, btn) {
  let ws;
  try {
    ws = await _openNCALayer();
  } catch (e) {
    errEl.style.color = '';
    errEl.textContent = e.message;
    if (btn) btn.disabled = false;
    return;
  }
  let handshakeReceived = false;

  function sendSignRequest() {
    const base64Data = btoa(unescape(encodeURIComponent(challenge)));
    ws.send(JSON.stringify({
      module: 'kz.gov.pki.knca.commonUtils',
      method: 'createCAdESFromBase64',
      args: ['PKCS12', 'SIGNATURE', base64Data, true],   // attached=true обязателен
    }));
  }

  ws.onmessage = async (event) => {
    const response = JSON.parse(event.data);
    if (!handshakeReceived && response.result?.version) {
      handshakeReceived = true;
      sendSignRequest();
      return;
    }
    if (response.code && response.code !== '200') {
      errEl.style.color = '';
      errEl.textContent = response.message || 'Подпись отменена';
      if (btn) btn.disabled = false;
      try { ws.close(); } catch (_) {}
      return;
    }
    const signature = response.responseObject ||
                      (typeof response.result === 'string' ? response.result : null);
    try { ws.close(); } catch (_) {}
    if (!signature) {
      errEl.style.color = '';
      errEl.textContent = 'Не удалось получить подпись';
      if (btn) btn.disabled = false;
      return;
    }
    try {
      const r = await fetch('/api/auth/login-2fa', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge, signature }),
      });
      const data = await r.json();
      if (!r.ok) {
        errEl.style.color = '';
        errEl.textContent = data.detail || 'Ошибка проверки ЭЦП';
        if (btn) btn.disabled = false;
        return;
      }
      location.reload();
    } catch (err) {
      errEl.style.color = '';
      errEl.textContent = 'Сеть недоступна';
      if (btn) btn.disabled = false;
    }
  };
}

/* ── Админ-панель: управление аккаунтами (Фаза 2) ── */
function setupAdminPanel() {
  // Кнопка в шапке (только для админа)
  const header = document.querySelector('header');
  const logoutBtn = document.querySelector('.logout-btn');
  if (header && !document.getElementById('admin-panel-btn')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'admin-panel-btn';
    btn.className = 'logout-btn';
    btn.title = 'Управление аккаунтами';
    btn.textContent = 'Аккаунты';
    btn.onclick = openAdminPanel;
    header.insertBefore(btn, logoutBtn || null);
  }
  // Модалка
  if (!document.getElementById('admin-modal')) {
    const ov = document.createElement('div');
    ov.id = 'admin-modal';
    ov.className = 'rdm-overlay';
    ov.style.display = 'none';
    ov.onclick = (e) => { if (e.target === ov) closeAdminPanel(); };
    ov.innerHTML = `
      <div class="rdm-box admin-box">
        <div class="rdm-header">
          <span>Управление аккаунтами</span>
          <button type="button" class="rdm-close" onclick="closeAdminPanel()">✕</button>
        </div>
        <div class="rdm-body">
          <form id="admin-create-form" class="admin-form">
            <div class="admin-form-row">
              <input type="text" id="admin-new-login" placeholder="Логин (или ИИН для ЭЦП)" autocomplete="off">
              <input type="text" id="admin-new-pass" placeholder="Пароль" autocomplete="off">
              <label class="admin-eds-check">
                <input type="checkbox" id="admin-new-eds"> ЭЦП
              </label>
              <select id="admin-new-role">
                <option value="user">Пользователь</option>
                <option value="admin">Администратор</option>
              </select>
              <button type="submit">Создать</button>
            </div>
            <div class="admin-form-err" id="admin-form-err"></div>
          </form>
          <table class="rdm-table admin-table">
            <thead><tr>
              <th>ID</th><th>Логин</th><th>Роль</th><th class="col-center">ЭЦП</th><th>ФИО</th><th></th>
            </tr></thead>
            <tbody id="admin-users-body"></tbody>
          </table>
        </div>
      </div>`;
    document.body.appendChild(ov);
    document.getElementById('admin-create-form').addEventListener('submit', adminCreateUser);
  }
}

function openAdminPanel() {
  document.getElementById('admin-modal').style.display = 'flex';
  loadAdminUsers();
}
function closeAdminPanel() {
  document.getElementById('admin-modal').style.display = 'none';
}

async function loadAdminUsers() {
  const body = document.getElementById('admin-users-body');
  body.innerHTML = `<tr><td colspan="6" class="loading">Загрузка...</td></tr>`;
  try {
    const r = await fetch('/api/admin/users', { credentials: 'include' });
    if (!r.ok) throw new Error();
    const users = await r.json();
    body.innerHTML = users.map(u => `
      <tr>
        <td>${u.id}</td>
        <td>${u.login}</td>
        <td>${u.role === 'admin' ? 'Администратор' : 'Пользователь'}</td>
        <td class="col-center">${u.is_eds ? '✓' : '—'}</td>
        <td>${u.fio || '—'}</td>
        <td class="col-center admin-actions">
          <button type="button" class="admin-pw-btn" onclick="adminSetPassword(${u.id}, '${u.login.replace(/'/g, "\\'")}')" title="Сменить пароль">🔑</button>
          ${u.id === CURRENT_USER.id ? ''
            : `<button type="button" class="admin-del-btn" onclick="adminDeleteUser(${u.id})" title="Удалить">✕</button>`}
        </td>
      </tr>`).join('');
  } catch {
    body.innerHTML = `<tr><td colspan="6" class="loading">Ошибка загрузки</td></tr>`;
  }
}

async function adminCreateUser(e) {
  e.preventDefault();
  const errEl = document.getElementById('admin-form-err');
  errEl.textContent = '';
  const login = document.getElementById('admin-new-login').value.trim();
  const password = document.getElementById('admin-new-pass').value;
  const is_eds = document.getElementById('admin-new-eds').checked;
  const role = document.getElementById('admin-new-role').value;
  try {
    const r = await fetch('/api/admin/users', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password, is_eds, role }),
    });
    const data = await r.json();
    if (!r.ok) { errEl.textContent = data.detail || 'Ошибка создания'; return; }
    document.getElementById('admin-new-login').value = '';
    document.getElementById('admin-new-pass').value = '';
    document.getElementById('admin-new-eds').checked = false;
    document.getElementById('admin-new-role').value = 'user';
    loadAdminUsers();
  } catch {
    errEl.textContent = 'Сеть недоступна';
  }
}

async function adminSetPassword(id, login) {
  const password = prompt(`Новый пароль для «${login}»:`);
  if (password == null) return;
  if (!password.trim()) { alert('Пароль не может быть пустым'); return; }
  try {
    const r = await fetch(`/api/admin/users/${id}/password`, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!r.ok) { const d = await r.json(); alert(d.detail || 'Ошибка смены пароля'); return; }
    alert('Пароль изменён');
  } catch {
    alert('Сеть недоступна');
  }
}

async function adminDeleteUser(id) {
  if (!confirm('Удалить этот аккаунт?')) return;
  try {
    const r = await fetch(`/api/admin/users/${id}`, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) { const d = await r.json(); alert(d.detail || 'Ошибка удаления'); return; }
    loadAdminUsers();
  } catch {
    alert('Сеть недоступна');
  }
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

  // Set today's date in header
  (() => {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const el = document.getElementById('header-date');
    if (el) el.textContent = `данные актуализированы ${dd}.${mm}.${d.getFullYear()}`;
  })();

  // Map legend
  const mapLegend = L.control({ position: 'bottomright' });
  mapLegend.onAdd = function() {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = `
      <div class="ml-item"><span class="ml-dot" style="background:#c0392b"></span>0 видов помощи</div>
      <div class="ml-item"><span class="ml-dot" style="background:#e67e22"></span>1–4 вида</div>
      <div class="ml-item"><span class="ml-dot" style="background:#27ae60"></span>5 и более</div>`;
    return div;
  };
  mapLegend.addTo(map);

  renderRegions();
  await refreshKPI();
  await Promise.all([loadSummary(), loadHelpPresence(), loadGapAnalysis()]);
}

function getColor(vidy) {
  if (vidy === 0)  return '#c0392b';
  if (vidy <= 4)   return '#e67e22';
  return '#27ae60';
}

let maxEntitledVidy = 1;

function geoVidy(id) {
  return presenceById[Math.round(id)]?.mini?.vidy || 0;
}

function regionStyle(feature) {
  return {
    fillColor: getColor(geoVidy(feature.properties.id_reg)),
    weight: 1,
    color: '#3a5090',
    fillOpacity: 0.75,
  };
}

function raionStyle(feature) {
  return {
    fillColor: getColor(geoVidy(feature.properties.id_rai)),
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

// Label: виды помощи в регионе / общее число видов помощи (14)
function entitledLabel(id) {
  const row = presenceById[Math.round(id)];
  if (!row || !row.mini) return null;
  const totalTypes = presenceColumns.length || 14;
  return `${row.mini.vidy}/${totalTypes}`;
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
  await Promise.all([loadSummary(), loadHelpPresence(), loadGapAnalysis()]);
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
  await Promise.all([loadSummary(), loadHelpPresence(), loadGapAnalysis()]);
}

async function selectRaion(raionId) {
  currentRaion = raionId;
  currentPage = 1;
  const raionName = raionStats[raionId]?.name || `Район ${raionId}`;
  const regionName = regionStats[currentRegion]?.name || '';
  updateBreadcrumb(regionName, raionName);
  await refreshKPI();
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
  // Charts bake tick/label colours at render time → re-render for the new theme
  refreshKPI();
  Object.values(_gapCharts).forEach(c => { try { c.destroy(); } catch(_) {} });
  Object.keys(_gapCharts).forEach(k => delete _gapCharts[k]);
  _gapData.forEach((_, i) => {
    const body = document.getElementById(`gap-body-${i}`);
    if (body && body.style.display !== 'none') renderGapChart(i);
  });
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
  loadSummary();
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
  loadSummary();
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


async function refreshKPI(sduSeq) {
  const params = buildFilterParams();

  const data = await fetch(`/api/kpi?${params}`).then(r => r.json());
  if (sduSeq < _sduSeq) return; // stale — a newer sdu change superseded this call

  animateCounter('kpi-dec',         data.total_dec_pay_sum,  v => formatNum(v));
  animateCounter('kpi-recipients',  data.unique_recipients,  v => formatInt(v));
  animateCounter('kpi-help-types',  data.help_type_count || 0,  v => formatInt(v));
  renderGenderAgeBar(data.male_count || 0, data.female_count || 0, data.age || {});
  renderSduChart(data.sdu || {});
}

let genderChart = null;
function renderGenderChart(male, female) {
  const items = [
    { label: 'Мужчины', val: male,   color: '#5b8af8' },
    { label: 'Женщины', val: female, color: '#f875c3' },
  ];
  const total = male + female;
  const legend = document.getElementById('gender-legend');
  if (legend) {
    legend.innerHTML = items.map(it => {
      const pct = total ? Math.round(it.val / total * 100) : 0;
      return `<div class="sdu-legend-item" title="${it.label}: ${formatInt(it.val)} (${pct}%)">
        <span class="sdu-dot" style="background:${it.color}"></span>
        <span class="sdu-leg-label">${it.label}</span>
        <span class="sdu-leg-val">${formatInt(it.val)} (${pct}%)</span>
      </div>`;
    }).join('');
  }
  const ctx = document.getElementById('gender-chart').getContext('2d');
  if (genderChart) genderChart.destroy();
  genderChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: items.map(i => i.label),
      datasets: [{ data: items.map(i => i.val), backgroundColor: items.map(i => i.color), borderWidth: 0, hoverOffset: 6 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${formatInt(ctx.raw)}` } },
      },
    },
  });
}

const SDU_META = {
  A: { label: 'A — Высокий',                      color: '#2ecc71' },
  B: { label: 'B — Состоятельный',                color: '#4ecdc4' },
  C: { label: 'C — Стабильный',                   color: '#f7dc6f' },
  D: { label: 'D — Испытывающий нужду',           color: '#e67e22' },
  E: { label: 'E — Крайняя нуждаемость',          color: '#e74c3c' },
};

function renderSduChart(sdu) {
  const keys = ['A', 'B', 'C', 'D', 'E'];
  const values = keys.map(k => sdu[k] || 0);
  const total = values.reduce((a, b) => a + b, 0);

  const pcts = values.map(v => total ? Math.round(v / total * 100) : 0);

  // Legend — clickable for filtering (percentages now drawn above the bars)
  const legend = document.getElementById('sdu-legend');
  legend.innerHTML = keys.map(k => {
    const count = sdu[k] || 0;
    const pct = total ? Math.round(count / total * 100) : 0;
    const isActive = currentSdu === k;
    return `<div class="sdu-legend-item${isActive ? ' sdu-active' : ''}"
      onclick="setSduFilter('${k}')"
      title="${SDU_META[k].label}: ${formatInt(count)} (${pct}%)">
      <span class="sdu-dot" style="background:${SDU_META[k].color}"></span>
      <span class="sdu-leg-label">${SDU_META[k].label}</span>
    </div>`;
  }).join('');

  // Show/hide clear button
  const clearBtn = document.getElementById('sdu-clear-btn');
  if (clearBtn) clearBtn.style.display = currentSdu ? 'inline-flex' : 'none';

  const isLight = document.documentElement.dataset.theme === 'light';
  const tickColor = isLight ? '#202124' : '#ffffff';
  const axisColor = isLight ? '#5f6368' : '#aaaaaa';
  const gridColor = isLight ? 'rgba(60,64,67,0.10)' : 'rgba(255,255,255,0.07)';

  // Draws "NN%" centred above each bar
  const sduPctLabels = {
    id: 'sduPctLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.font = "700 11px 'Roboto', sans-serif";
      ctx.fillStyle = tickColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      meta.data.forEach((bar, i) => {
        ctx.fillText(pcts[i] + '%', bar.x, bar.y - 4);
      });
      ctx.restore();
    }
  };

  const ctx = document.getElementById('sdu-chart').getContext('2d');
  if (sduChart) sduChart.destroy();
  sduChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: keys,
      datasets: [{
        data: values,
        backgroundColor: keys.map(k => SDU_META[k].color + (currentSdu && currentSdu !== k ? '66' : '')),
        borderColor: keys.map(k => currentSdu === k ? (isLight ? '#202124' : '#fff') : 'transparent'),
        borderWidth: 2,
        borderRadius: 4,
      }],
    },
    plugins: [sduPctLabels],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 18 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: c => SDU_META[c[0].label]?.label || c[0].label,
            label: c => ` ${formatInt(c.raw)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: tickColor, font: { weight: '700' } },
        },
        y: {
          grid: { color: gridColor },
          ticks: { color: axisColor, callback: v => fmtCompact(v) || String(v) },
        },
      },
      onClick(e, elements) {
        if (elements.length) {
          const k = keys[elements[0].index];
          if (currentSdu === k) clearSduFilter(); else setSduFilter(k);
        }
      },
      onHover(_e, elements, chart) {
        chart.canvas.style.cursor = elements.length ? 'pointer' : 'default';
      },
    },
  });
}

function setSduFilter(k) {
  if (currentSdu === k) return;
  currentSdu = k;
  _refreshAfterFilterChange();
}

function clearSduFilter() {
  currentSdu = null;
  _refreshAfterFilterChange();
}

function _invalidateAnomCaches() {
  Object.keys(_anTabCache).forEach(k => delete _anTabCache[k]);
  Object.keys(_anUtilCache).forEach(k => delete _anUtilCache[k]);
  Object.keys(_anRaionCache).forEach(k => delete _anRaionCache[k]);
}

async function refreshMapStats() {
  const fp = buildFilterParams('none');
  if (currentRaion) return; // raion level — map already filtered
  if (currentRegion) {
    fp.set('region_id', currentRegion);
    const data = await fetch(`/api/raions?${fp}`).then(r => r.json());
    raionStats = {};
    data.forEach(r => { raionStats[r.id_rai] = r; });
    renderRaions();
  } else {
    const data = await fetch(`/api/regions?${fp}`).then(r => r.json());
    regionStats = {};
    data.forEach(r => { regionStats[r.id_reg] = r; });
    renderRegions();
  }
}

function _refreshAfterFilterChange() {
  _invalidateAnomCaches();
  _gapData = []; _gapTotal = 0;
  Object.values(_gapCharts).forEach(c => { try { c.destroy(); } catch(_) {} });
  Object.keys(_gapCharts).forEach(k => delete _gapCharts[k]);

  const seq = ++_sduSeq;
  refreshKPI(seq);
  loadSummary(seq);
  loadHelpPresence();
  refreshMapStats();
  loadGapAnalysis();

  const activeAntab = document.querySelector('.antab-btn.active');
  if (activeAntab) loadAnomalyTab(activeAntab.dataset.antab);
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

const GA_AGE_META = [
  { key: 'до 18', label: 'до 18 лет', color: '#a29bfe' },
  { key: '18-39', label: '18–39 лет',  color: '#74b9ff' },
  { key: '40-59', label: '40–59 лет',  color: '#00b894' },
  { key: '60+',   label: '60+ лет',    color: '#fdcb6e' },
];

function renderGenderAgeBar(male, female, age) {
  const el = document.getElementById('gender-age-chart');
  if (!el) return;
  const total = male + female;
  const fPct = total > 0 ? Math.round(female / total * 100) : 50;
  const mPct = 100 - fPct;
  const ageTotal = GA_AGE_META.reduce((s, m) => s + (age[m.key] || 0), 0);
  const gfA = currentGender === 2 ? ' ga-filter-active' : '';
  const gmA = currentGender === 1 ? ' ga-filter-active' : '';
  el.innerHTML = `
    <div class="ga-gender-labels">
      <span class="ga-female-txt ga-clickable${gfA}" onclick="setGenderFilter(2)">Женщины</span>
      <span class="ga-male-txt ga-clickable${gmA}" onclick="setGenderFilter(1)">Мужчины</span>
    </div>
    <div class="ga-gender-bar-outer">
      <div class="ga-bar-f${gfA}" style="width:${fPct}%" onclick="setGenderFilter(2)" title="Женщины: ${formatInt(female)} (${fPct}%)"></div>
      <div class="ga-bar-m${gmA}" style="width:${mPct}%" onclick="setGenderFilter(1)" title="Мужчины: ${formatInt(male)} (${mPct}%)"></div>
    </div>
    <div class="ga-gender-pcts">
      <span class="ga-female-txt ga-clickable${gfA}" onclick="setGenderFilter(2)">${fPct}%</span>
      <span class="ga-male-txt ga-clickable${gmA}" onclick="setGenderFilter(1)">${mPct}%</span>
    </div>
    <div class="ga-age-hdr">Возрастные группы</div>
    ${GA_AGE_META.map(m => {
      const cnt = age[m.key] || 0;
      const pct = ageTotal > 0 ? Math.round(cnt / ageTotal * 100) : 0;
      const isActive = currentAgeGroup === m.key;
      return `<div class="ga-age-row ga-clickable${isActive ? ' ga-filter-active' : ''}" onclick="setAgeFilter('${m.key}')" title="${m.label}: ${formatInt(cnt)} (${pct}%)">
        <span class="ga-age-lbl">${m.label}</span>
        <div class="ga-age-bar-wrap"><div class="ga-age-bar" style="width:${pct}%;background:${m.color}"></div></div>
        <span class="ga-age-pct">${pct}%</span>
      </div>`;
    }).join('')}`;
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

let presenceColumns = [];
let presenceRows = [];
let presenceById = {};   // geo id -> presence row (for map tooltips)
let presenceSortCol = null;   // 'vidy' | 'lyudei' | 'summa'
let presenceSortDir = 'desc';

let geoPanelTimer = null;
let geoPanelLastEv = null;

function showGeoPanel(id, name, ev) {
  const row = presenceById[Math.round(id)];
  const panel = document.getElementById('geo-panel');
  if (!panel) return;

  let listHtml = '';
  if (row && presenceColumns.length && row.pay_cat_lists) {
    const provided = presenceColumns
      .map((c, i) => ({ c, cnt: (row.pay_cat_lists[i] || []).length }))
      .filter(e => e.cnt > 0);
    listHtml = provided.map(({ c }) =>
      `<div class="gp-row gp-yes"><span class="gp-pay">${stripHelpPrefix(c.name)}</span></div>`
    ).join('');
  }

  panel.innerHTML =
    `<div class="gp-main">
       <div class="gp-title">${(row && row.name) || name || '—'}</div>
       <div class="gp-list">${listHtml || '<div class="gp-empty">Нет данных</div>'}</div>
     </div>`;

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
  const params = buildFilterParams('region');

  document.getElementById('presence-body').innerHTML =
    '<tr><td colspan="2" class="loading">Загрузка...</td></tr>';

  const resp = await fetch(`/api/help-presence?${params}`).then(r => r.json());
  presenceColumns = resp.columns || [];
  presenceRows    = resp.rows    || [];
  presenceById = {};
  presenceRows.forEach(r => { if (r.id != null) presenceById[r.id] = r; });
  maxEntitledVidy = Math.max(1, ...presenceRows.filter(r => !r.is_total).map(r => r.mini?.vidy || 0));
  renderHelpPresence();
  // refresh map labels + fill colours now that entitlement data is available
  if (map && labelsLayer) {
    if (currentRegion) { renderRaionLabels(); raionsLayer?.setStyle(raionStyle); }
    else { renderRegionLabels(); regionsLayer?.setStyle(regionStyle); }
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
    const desc = PAY_TYPE_DESCRIPTIONS[full.trim().toUpperCase()] || '';
    const descAttr = desc ? ` data-pay-name="${full.replace(/"/g,'&quot;')}" data-pay-desc="${desc.replace(/"/g,'&quot;')}"` : '';
    return `<th class="col-center prs-grp-hdr${desc ? ' has-pay-tip' : ''}"${descAttr}><span class="prs-hdr-txt">${full}</span></th>`;
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
    const cells = r.presence.map(p => {
      const present = typeof p === 'object' ? p.p : p;
      const mx = typeof p === 'object' ? p.mx : 0;
      if (present) {
        const s = fmtCompact(mx);
        return `<td class="prs-cell prs-yes">✓${s ? `<span class="prs-cell-sum">${s}</span>` : ''}</td>`;
      }
      return `<td class="prs-cell prs-no">✕</td>`;
    }).join('');
    return `<tr ${clickAttr} class="${cls}">
      <td class="prs-geo-cell">${r.name || '—'}</td>
      <td class="col-center prs-mini">${m.vidy ?? 0}</td>
      <td class="col-center prs-mini">${formatInt(m.lyudei ?? 0)}</td>
      <td class="col-right prs-mini prs-mini-sum">${m.summa ?? '0'} ₸</td>
      ${cells}
    </tr>`;
  }).join('');
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
  const isRegionView = !!currentRegion;
  let clickAttr = '';
  if (clickable) {
    if (isRegionView) {
      const safeName = (r.name || '').replace(/'/g, "\\'");
      clickAttr = `onclick="openRaionDetail(${r.id}, '${safeName}')" style="cursor:pointer"`;
    } else {
      clickAttr = `onclick="drillRegionFromRanking(${r.id})" style="cursor:pointer"`;
    }
  }
  const cls = r.is_total ? 'prs-total-row' : (clickable ? 'coverage-row' : '');
  return `<tr ${clickAttr} class="${cls}">
    <td>${r.name || '—'}</td>
    <td class="col-center">${r.help_types}</td>
    <td class="col-right">${formatNum(r.max_sum)} ₸</td>
    <td class="col-right">${formatNum(r.total_sum)} ₸</td>
    <td class="col-right">${(r.pct ?? 0)}%</td>
  </tr>`;
}

function renderCoverage() {
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
    totalHtml + (sorted.map(r => coverageRowHtml(r, true)).join('')
      || '<tr><td colspan="6" class="no-data">Нет информации</td></tr>');
}

async function openRaionDetail(raionId, raionName) {
  const modal = document.getElementById('raion-detail-modal');
  const title = document.getElementById('raion-detail-title');
  const tbody = document.getElementById('raion-detail-body');
  title.textContent = raionName;
  tbody.innerHTML = '<tr><td colspan="6" class="loading">Загрузка...</td></tr>';
  modal.style.display = 'flex';

  const p = buildFilterParams('none');
  p.set('raion_id', raionId);
  const rows = await fetch(`/api/raion-payments?${p}`).then(r => r.json());

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="no-data">Нет данных</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `<tr>
    <td>${r.sicid ?? '—'}</td>
    <td>${r.pay_type}</td>
    <td class="col-center">${r.vozrast ?? '—'}</td>
    <td class="col-center">${r.gender}</td>
    <td class="col-center">${r.sdu}</td>
    <td class="col-right">${formatNum(r.dec_sum)} ₸</td>
  </tr>`).join('');
}

function closeRaionDetail() {
  document.getElementById('raion-detail-modal').style.display = 'none';
}

async function loadSummary(sduSeq) {
  const params = buildFilterParams('region');
  const isRegionView = !!currentRegion;

  document.getElementById('coverage-body').innerHTML =
    '<tr><td colspan="6" class="loading">Загрузка...</td></tr>';
  const regionName = isRegionView ? (regionStats[currentRegion]?.name || '') : '';
  setText('coverage-col-name', isRegionView ? `Район (${regionName})` : 'Регион');
  document.getElementById('coverage-btn-back').style.display = isRegionView ? 'inline-block' : 'none';

  const resp = await fetch(`/api/summary?${params}`).then(r => r.json());
  if (sduSeq < _sduSeq) return;
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
  if (currentSdu) params.set('f_sdu_tzhs', currentSdu);
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

// ── Anomaly section ──────────────────────────────────────────────

const _anTabCache = {};
let _anUtilRegionId = null;
let _anUtilRegionName = '';
const _anUtilCache = {};
let _anRaionDrillId = null;
let _anRaionDrillName = '';
const _anRaionCache = {};
const _anSort = {};

/* ── Pay-gap accordion ─────────────────────────────────────── */
let _gapData = [];
let _gapTotal = 0;
const _gapCharts = {};

async function loadGapAnalysis() {
  const list = document.getElementById('gap-list');
  if (_gapData.length) { if (list) renderGapAccordion(); return; }
  if (list) list.innerHTML = '<div class="loading">Загрузка...</div>';
  try {
    const data = await fetch(`/api/anomalies/pay-gap?${buildFilterParams('none')}`).then(r => r.json());
    _gapData = data.gaps || [];
    _gapTotal = data.total || 0;
    updateGapKpi();
    if (list) renderGapAccordion();
  } catch (e) { console.error('pay-gap', e); }
}

function updateGapKpi() {
  const elAn = document.getElementById('kpi-gap-anomaly');
  if (elAn) elAn.textContent = _gapData.length || '0';

  const list = document.getElementById('gap-side-list');
  if (!list) return;
  if (!_gapData.length) {
    list.innerHTML = '<div class="gsp-empty">Аномалий нет</div>';
    return;
  }
  const fmtDistrict = d => d.raion
    .replace(/\s+Г\.?А\.?$/i, ' г.а.')
    .replace(/\s+ГОРОД$/i, ' г.')
    .replace(/\s+РАЙОН$/i, ' р-н');
  list.innerHTML = _gapData.map(item => {
    const name = _shortPayType(item.pay_type);
    const badgeCls = item.ratio >= 10 ? 'gap-badge-high' : item.ratio >= 5 ? 'gap-badge-mid' : 'gap-badge-low';
    const low  = item.districts[0];
    const high = item.districts[item.districts.length - 1];
    return `<div class="kpi-card gsp-service-card">
      <div class="gsp-svc-head">
        <span class="gap-badge ${badgeCls}">×${item.ratio}</span>
        <span class="gsp-svc-name" title="${name}">${name}</span>
      </div>
      <div class="gsp-dist-row gsp-dist-low">
        <span class="gsp-arr">↓</span>
        <span class="gsp-d-name">${fmtDistrict(low)}</span>
        <span class="gsp-d-val">${fmtCompact(low.total_max) || formatNum(low.total_max)}</span>
      </div>
      <div class="gsp-dist-row gsp-dist-high">
        <span class="gsp-arr">↑</span>
        <span class="gsp-d-name">${fmtDistrict(high)}</span>
        <span class="gsp-d-val">${fmtCompact(high.total_max) || formatNum(high.total_max)}</span>
      </div>
    </div>`;
  }).join('');
}

function renderGapAccordion() {
  const list = document.getElementById('gap-list');
  if (!list) return;
  Object.values(_gapCharts).forEach(c => { try { c.destroy(); } catch(_) {} });
  Object.keys(_gapCharts).forEach(k => delete _gapCharts[k]);
  if (!_gapData.length) {
    list.innerHTML = '<div class="no-data">Аномальных разрывов не обнаружено</div>';
    return;
  }
  list.innerHTML = _gapData.map((item, i) => {
    const name = _shortPayType(item.pay_type);
    const badgeCls = item.ratio >= 10 ? 'gap-badge-high' : item.ratio >= 5 ? 'gap-badge-mid' : 'gap-badge-low';
    return `<div class="gap-item">
      <div class="gap-header" onclick="toggleGapItem(${i})">
        <span class="gap-badge ${badgeCls}">Разрыв ×${item.ratio}</span>
        <span class="gap-name">${name}</span>
        <span class="gap-stats">${item.district_count} р-нов/г · ${formatNum(item.total_cnt)} заявок · ${formatNum(item.total_approved)} одобрено</span>
        <span class="gap-chevron" id="gap-chevron-${i}">▼</span>
      </div>
      <div class="gap-body" id="gap-body-${i}" style="display:none">
        <div class="gap-chart-label">Максимальная сумма выплаты — по районам и городам</div>
        <div class="gap-canvas-wrap" style="position:relative;height:${Math.max(220, item.districts.length * 34)}px">
          <canvas id="gap-canvas-${i}"></canvas>
        </div>
      </div>
    </div>`;
  }).join('');
}

function toggleGapItem(idx) {
  const body = document.getElementById(`gap-body-${idx}`);
  const chevron = document.getElementById(`gap-chevron-${idx}`);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chevron) chevron.textContent = isOpen ? '▼' : '▲';
  if (!isOpen) renderGapChart(idx);
}

function renderGapChart(idx) {
  if (_gapCharts[idx]) return;
  const item = _gapData[idx];
  const canvas = document.getElementById(`gap-canvas-${idx}`);
  if (!canvas || !item) return;

  const districts = item.districts;
  const values = districts.map(d => d.total_max);
  const maxVal = Math.max(...values);
  const medianIdx = Math.floor(values.length / 2);
  const median = values[medianIdx];

  const isLight = document.documentElement.dataset.theme === 'light';
  const tickColor = isLight ? '#202124' : '#ffffff';
  const gridColor = isLight ? 'rgba(60,64,67,0.12)' : 'rgba(128,128,128,0.12)';

  const labels = districts.map(d => `${d.raion} (${(d.region || '').replace(/\s+ОБЛАСТЬ$/i, '')})`);
  const colors = values.map(v => {
    const t = maxVal > 0 ? v / maxVal : 0;
    return v >= median
      ? `rgba(91,138,248,${0.45 + 0.55 * t})`
      : `rgba(220,80,70,${0.35 + 0.65 * (1 - t)})`;
  });

  // Draws the value just past the tip of each horizontal bar
  const gapValueLabels = {
    id: 'gapValueLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.font = "700 10px 'Roboto', sans-serif";
      ctx.fillStyle = tickColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      meta.data.forEach((bar, i) => {
        const label = fmtCompact(values[i]) || formatNum(values[i]);
        ctx.fillText(label, bar.x + 6, bar.y);
      });
      ctx.restore();
    }
  };

  _gapCharts[idx] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderRadius: 3,
        borderSkipped: false,
      }]
    },
    plugins: [gapValueLabels],
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: 54 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${formatNum(ctx.raw)} ₸`
          }
        }
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: {
            color: tickColor,
            callback: v => v >= 1_000_000 ? (v/1_000_000).toFixed(1)+'M'
                        : v >= 1000 ? Math.round(v/1000)+'K' : v
          }
        },
        y: {
          ticks: { color: tickColor, font: { size: 11 } }
        }
      }
    }
  });
}

function anToggleSort(th) {
  const tab = th.dataset.antab, col = th.dataset.ancol;
  let sortKey = tab;
  if (tab === 'utilization') sortKey = _anUtilRegionId != null ? 'utilization-drill' : 'utilization';
  if (tab === 'utilraion')   sortKey = _anRaionDrillId != null ? 'utilraion-drill'   : 'utilraion';
  const s = _anSort[sortKey] || { col: null, dir: 'asc' };
  _anSort[sortKey] = { col, dir: s.col === col && s.dir === 'asc' ? 'desc' : 'asc' };
  document.querySelectorAll(`[data-antab="${tab}"][data-ancol]`).forEach(t => {
    const icon = t.querySelector('.an-sort-icon');
    if (icon) icon.textContent = t.dataset.ancol === col ? (_anSort[sortKey].dir === 'asc' ? ' ▲' : ' ▼') : '';
  });
  if (tab === 'utilization') {
    const ck = _anUtilRegionId != null ? String(_anUtilRegionId) : 'all';
    if (_anUtilCache[ck]) renderAnUtil(_anUtilCache[ck]); return;
  }
  if (tab === 'utilraion') {
    const ck = _anRaionDrillId != null ? `r${_anRaionDrillId}` : 'all';
    if (_anRaionCache[ck]) renderAnUtilRaion(_anRaionCache[ck]); return;
  }
  const data = _anTabCache[tab];
  if (data) renderAnomalyTab(tab, data);
}

function anSorted(data, sortKey) {
  const s = _anSort[sortKey];
  if (!s || !s.col) return data;
  return [...data].sort((a, b) => {
    let va = a[s.col] ?? -Infinity, vb = b[s.col] ?? -Infinity;
    return s.dir === 'asc' ? (va > vb ? 1 : va < vb ? -1 : 0) : (va < vb ? 1 : va > vb ? -1 : 0);
  });
}

async function loadAnomalyKpi() {
  try {
    const d = await fetch('/api/anomalies/kpi').then(r => r.json());
    document.getElementById('an-kpi-pending').textContent = formatInt(d.pending);
    document.getElementById('an-kpi-cks').textContent     = formatInt(d.cks_ab);
    document.getElementById('an-kpi-empty').textContent   = formatInt(d.empty_declared);
    document.getElementById('an-kpi-unique').textContent  = formatInt(d.geo_unique);
  } catch(e) { console.error('anomalies/kpi', e); }
}

async function loadAnUtil() {
  const fp = buildFilterParams('none');
  const cacheKey = (_anUtilRegionId != null ? String(_anUtilRegionId) : 'all') + fp;
  if (_anUtilCache[cacheKey]) { renderAnUtil(_anUtilCache[cacheKey]); return; }
  if (_anUtilRegionId != null) fp.set('region_id', _anUtilRegionId);
  const url = `/api/anomalies/utilization?${fp}`;
  try {
    const data = await fetch(url).then(r => r.json());
    _anUtilCache[cacheKey] = data;
    renderAnUtil(data);
  } catch(e) { console.error('anomalies/utilization', e); }
}

function anUtilGoBack() {
  _anUtilRegionId = null;
  _anUtilRegionName = '';
  loadAnUtil();
}

function anUtilDrill(regionId, regionName) {
  _anUtilRegionId = regionId;
  _anUtilRegionName = regionName;
  loadAnUtil();
}

async function loadAnUtilRaion() {
  const fp = buildFilterParams('none');
  const cacheKey = (_anRaionDrillId != null ? `r${_anRaionDrillId}` : 'all') + fp;
  if (_anRaionCache[cacheKey]) { renderAnUtilRaion(_anRaionCache[cacheKey]); return; }
  if (_anRaionDrillId != null) fp.set('raion_id', _anRaionDrillId);
  const url = `/api/anomalies/utilization-raion?${fp}`;
  try {
    const data = await fetch(url).then(r => r.json());
    _anRaionCache[cacheKey] = data;
    renderAnUtilRaion(data);
  } catch(e) { console.error('utilization-raion', e); }
}

function anUtilRaionGoBack() { _anRaionDrillId = null; _anRaionDrillName = ''; loadAnUtilRaion(); }
function anUtilRaionDrill(raionId, raionName) { _anRaionDrillId = raionId; _anRaionDrillName = raionName; loadAnUtilRaion(); }

async function loadAnomalyTab(tab) {
  if (tab === 'utilization') { await loadAnUtil(); return; }
  if (tab === 'utilraion')   { await loadAnUtilRaion(); return; }
  const fp = buildFilterParams('none');
  const cacheKey = tab + fp;
  if (_anTabCache[cacheKey]) { renderAnomalyTab(tab, _anTabCache[cacheKey]); return; }
  const baseUrlMap = {
    cks:    '/api/anomalies/cks-ab',
    unique: '/api/anomalies/unique-help',
    demo:   '/api/anomalies/demographic',
  };
  if (!baseUrlMap[tab]) return;
  const tabUrl = tab === 'unique' ? baseUrlMap[tab] : `${baseUrlMap[tab]}?${fp}`;
  try {
    const data = await fetch(tabUrl).then(r => r.json());
    _anTabCache[cacheKey] = data;
    renderAnomalyTab(tab, data);
  } catch(e) { console.error(`anomalies/${tab}`, e); }
}

function renderAnomalyTab(tab, data) {
  ({ cks: renderAnCks, unique: renderAnUnique, demo: renderAnDemo })[tab]?.(data);
}

function _anEmpty(tbody, cols) {
  tbody.innerHTML = `<tr><td colspan="${cols}" style="text-align:center;padding:32px;color:var(--tx-muted)">Нет данных</td></tr>`;
}

function _shortPayType(s) { return (s || '').replace(/^СОЦИАЛЬНАЯ ПОМОЩЬ\s+/i, ''); }

function renderAnCks(rows) {
  const tbody = document.getElementById('antab-cks-body');
  const sorted = anSorted(rows, 'cks');
  if (!sorted.length) { _anEmpty(tbody, 6); return; }
  tbody.innerHTML = sorted.map(r => `<tr>
    <td>${r.region}</td>
    <td class="col-center"><span class="an-cks-badge">${r.cks}</span></td>
    <td>${_shortPayType(r.pay_type)}</td>
    <td class="col-center an-alarm-cell">${formatInt(r.count)}</td>
    <td class="col-center">${formatInt(r.recipients)}</td>
    <td class="col-right">${formatNum(r.total_dec)} ₸</td>
  </tr>`).join('');
}

function renderAnUtil(rows) {
  const tbody   = document.getElementById('antab-utilization-body');
  const backBtn = document.getElementById('an-util-back');
  const geoCol  = document.getElementById('an-util-geo-col');
  const titleEl = document.getElementById('an-util-title');
  const bar     = backBtn ? backBtn.closest('.an-util-bar') : null;

  if (_anUtilRegionId != null) {
    if (bar)      bar.style.display = 'flex';
    if (backBtn)  backBtn.style.display = 'inline-block';
    if (geoCol)   geoCol.textContent = 'Вид помощи';
    if (titleEl)  titleEl.textContent = _anUtilRegionName;
    const sorted = anSorted(rows, 'utilization-drill');
    if (!sorted.length) { _anEmpty(tbody, 5); return; }
    tbody.innerHTML = sorted.map(r => {
      const cls = r.pct < 50 ? 'an-alarm-cell' : r.pct < 80 ? 'an-warn-cell' : '';
      return `<tr>
        <td>${r.pay_type}</td>
        <td class="col-center">${formatInt(r.count)}</td>
        <td class="col-right">${formatNum(r.total_max)} ₸</td>
        <td class="col-right">${formatNum(r.total_dec)} ₸</td>
        <td class="col-right ${cls}">${r.pct}%</td>
      </tr>`;
    }).join('');
  } else {
    if (bar)      bar.style.display = 'none';
    if (backBtn)  backBtn.style.display = 'none';
    if (geoCol)   geoCol.textContent = 'Регион';
    if (titleEl)  titleEl.textContent = '';
    const sorted = anSorted(rows, 'utilization');
    if (!sorted.length) { _anEmpty(tbody, 5); return; }
    tbody.innerHTML = sorted.map(r => {
      const cls = r.pct < 50 ? 'an-alarm-cell' : r.pct < 80 ? 'an-warn-cell' : '';
      const rowCls    = r.clickable ? 'coverage-row' : '';
      const clickAttr = r.clickable
        ? `onclick="anUtilDrill(${r.id}, '${(r.name || '').replace(/'/g, "\\'")}')" style="cursor:pointer"` : '';
      return `<tr class="${rowCls}" ${clickAttr}>
        <td>${r.name}</td>
        <td class="col-center">${formatInt(r.count)}</td>
        <td class="col-right">${formatNum(r.total_max)} ₸</td>
        <td class="col-right">${formatNum(r.total_dec)} ₸</td>
        <td class="col-right ${cls}">${r.pct}%</td>
      </tr>`;
    }).join('');
  }
}

function renderAnUtilRaion(rows) {
  const tbody   = document.getElementById('antab-utilraion-body');
  const backBtn = document.getElementById('an-utilraion-back');
  const geoCol  = document.getElementById('an-utilraion-geo-col');
  const regTh   = document.getElementById('an-utilraion-reg-th');
  const titleEl = document.getElementById('an-utilraion-title');
  const bar     = backBtn ? backBtn.closest('.an-util-bar') : null;

  if (_anRaionDrillId != null) {
    if (bar)      bar.style.display = 'flex';
    if (backBtn)  backBtn.style.display = 'inline-block';
    if (geoCol)   geoCol.textContent = 'Вид помощи';
    if (regTh)    regTh.style.display = 'none';
    if (titleEl)  titleEl.textContent = _anRaionDrillName;
    const sorted = anSorted(rows, 'utilraion-drill');
    if (!sorted.length) { _anEmpty(tbody, 5); return; }
    tbody.innerHTML = sorted.map(r => {
      const cls = r.pct < 50 ? 'an-alarm-cell' : r.pct < 80 ? 'an-warn-cell' : '';
      return `<tr>
        <td>${_shortPayType(r.pay_type)}</td>
        <td style="display:none"></td>
        <td class="col-center">${formatInt(r.count)}</td>
        <td class="col-right">${formatNum(r.total_max)} ₸</td>
        <td class="col-right">${formatNum(r.total_dec)} ₸</td>
        <td class="col-right ${cls}">${r.pct}%</td>
      </tr>`;
    }).join('');
  } else {
    if (bar)      bar.style.display = 'none';
    if (backBtn)  backBtn.style.display = 'none';
    if (geoCol)   geoCol.textContent = 'Район';
    if (regTh)    regTh.style.display = '';
    if (titleEl)  titleEl.textContent = '';
    const sorted = anSorted(rows, 'utilraion');
    if (!sorted.length) { _anEmpty(tbody, 6); return; }
    tbody.innerHTML = sorted.map(r => {
      const cls = r.pct < 50 ? 'an-alarm-cell' : r.pct < 80 ? 'an-warn-cell' : '';
      return `<tr class="coverage-row" style="cursor:pointer" onclick="anUtilRaionDrill(${r.raion_id}, '${(r.raion||'').replace(/'/g,"\\'")}')">
        <td>${r.raion}</td>
        <td>${r.region}</td>
        <td class="col-center">${formatInt(r.count)}</td>
        <td class="col-right">${formatNum(r.total_max)} ₸</td>
        <td class="col-right">${formatNum(r.total_dec)} ₸</td>
        <td class="col-right ${cls}">${r.pct}%</td>
      </tr>`;
    }).join('');
  }
}

function renderAnUnique(rows) {
  const tbody = document.getElementById('antab-unique-body');
  const sorted = anSorted(rows, 'unique');
  if (!sorted.length) { _anEmpty(tbody, 3); return; }
  tbody.innerHTML = sorted.map(r => `<tr>
    <td>${r.pay_type}</td>
    <td class="col-center an-warn-cell">${r.reg_count}</td>
    <td>${(r.regions || []).join(', ')}</td>
  </tr>`).join('');
}

function renderAnDemo(rows) {
  const tbody = document.getElementById('antab-demo-body');
  const sorted = anSorted(rows, 'demo');
  if (!sorted.length) { _anEmpty(tbody, 6); return; }
  tbody.innerHTML = sorted.map(r => {
    const flagsHtml = r.flags.length
      ? r.flags.map(f => `<span class="an-flag-badge">${f}</span>`).join(' ')
      : r.low_data
        ? '<span class="an-ok-badge">норма (мало данных)</span>'
        : '<span class="an-ok-badge">норма</span>';
    return `<tr class="${r.flags.length ? 'an-row-flag' : ''}">
      <td>${_shortPayType(r.pay_type)}</td>
      <td class="col-center">${formatInt(r.total)}</td>
      <td class="col-center">${r.pct_male}%</td>
      <td class="col-center">${r.pct_female}%</td>
      <td class="col-right">${r.avg_age != null ? r.avg_age : '—'}</td>
      <td>${flagsHtml}</td>
    </tr>`;
  }).join('');
}

window.addEventListener('load', () => { if (map) map.invalidateSize(); });

function initPayTooltip() {
  const tip = document.getElementById('pay-tooltip');
  if (!tip) return;
  let active = false;
  document.getElementById('tab-presence')?.addEventListener('mouseover', e => {
    const th = e.target.closest('[data-pay-desc]');
    if (!th) { if (active) { tip.style.display = 'none'; active = false; } return; }
    tip.innerHTML = `<div class="pt-title">${th.dataset.payName}</div><div class="pt-desc">${th.dataset.payDesc}</div>`;
    tip.style.display = 'block';
    active = true;
  });
  document.getElementById('tab-presence')?.addEventListener('mousemove', e => {
    if (!active) return;
    tip.style.left = (e.clientX + 18) + 'px';
    tip.style.top  = (e.clientY + 18) + 'px';
    const r = tip.getBoundingClientRect();
    if (r.right  > window.innerWidth  - 8) tip.style.left = (e.clientX - r.width  - 8) + 'px';
    if (r.bottom > window.innerHeight - 8) tip.style.top  = (e.clientY - r.height - 8) + 'px';
  });
  document.getElementById('tab-presence')?.addEventListener('mouseout', e => {
    if (!e.target.closest('[data-pay-desc]')) return;
    tip.style.display = 'none';
    active = false;
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.dataset.theme = savedTheme === 'light' ? 'light' : '';
  const sw = document.getElementById('theme-switch');
  if (sw) sw.checked = savedTheme === 'light';

  // Real auth gate — verify session cookie against the backend
  CURRENT_USER = await fetchMe();
  if (!CURRENT_USER) { showLogin(); return; }
  if (CURRENT_USER.role === 'admin') setupAdminPanel();

  initPayTooltip();
  init();


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

  document.querySelectorAll('.tab-btn:not(.antab-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn:not(.antab-btn)').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane:not(.antab-pane)').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.getElementById(`tab-${btn.dataset.tab}`);
      if (pane) pane.classList.add('active');
      if (btn.dataset.tab === 'gap') loadGapAnalysis();
    });
  });

  // Anomaly tabs
  document.querySelectorAll('.antab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.antab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.antab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.getElementById('antab-' + btn.dataset.antab);
      if (pane) pane.classList.add('active');
      if (btn.dataset.antab === 'utilization') { _anUtilRegionId = null; _anUtilRegionName = ''; }
      if (btn.dataset.antab === 'utilraion')   { _anRaionDrillId = null; _anRaionDrillName = ''; }
      loadAnomalyTab(btn.dataset.antab);
    });
  });
  loadAnomalyKpi();
  loadAnomalyTab('cks');

  // KPI chart tabs (Благосостояние / Пол-Возраст)
  document.querySelectorAll('.kpi-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.kpi-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.kpi-tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.getElementById(`ktab-${btn.dataset.ktab}`);
      if (pane) pane.classList.add('active');
      const chart = { gender: genderChart, sdu: sduChart, age: ageChart }[btn.dataset.ktab];
      if (chart) requestAnimationFrame(() => chart.resize());
    });
  });


});
