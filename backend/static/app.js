const API = '';
let map, regionsLayer, raionsLayer, labelsLayer;
let sduChart = null;
let tileLayer = null;
let regionGeoJSON = null, raionGeoJSON = null;
let regionCentroids = {}, raionCentroids = {};
let regionStats = {}, raionStats = {};
let currentRegion = null, currentRaion = null;
let currentSduSet = [];      // мультивыбор уровней благосостояния ЦКС (A/B/C/D/E)
let currentGender = null;
let currentAgeSet = [];      // мультивыбор возрастных групп (до 18 / 18-39 / 40-59 / 60+)
let currentPayType = null;   // pay_type_id выбранного вида помощи — глобальный фильтр
let _sduSeq = 0;

// переключатель значения в массиве-фильтре (мультивыбор)
function _toggleInArr(arr, v) {
  const i = arr.indexOf(v);
  if (i < 0) arr.push(v); else arr.splice(i, 1);
  return arr;
}
// добавляет демографические фильтры (ЦКС/пол/возраст) в URLSearchParams
function _applyDemoFilters(p) {
  if (currentSduSet.length) p.set('sdu_filter',   currentSduSet.join(','));
  if (currentGender)        p.set('gender_filter', String(currentGender));
  if (currentAgeSet.length) p.set('age_group',     currentAgeSet.join(','));
  return p;
}
function _demoQS() { return _applyDemoFilters(new URLSearchParams()).toString(); }
// собирает URL из непустых query-фрагментов ('a=1', '', 'b=2') → path?a=1&b=2
function _url(path, ...q) { const s = q.filter(Boolean).join('&'); return s ? `${path}?${s}` : path; }

function buildFilterParams(geoMode = 'full') {
  const p = new URLSearchParams();
  if (geoMode === 'full') {
    if (currentRaion) p.set('raion_id', currentRaion);
    else if (currentRegion) p.set('region_id', currentRegion);
  } else if (geoMode === 'region' && currentRegion) {
    p.set('region_id', currentRegion);
  }
  if (currentPayType)  p.set('pay_type_id', String(currentPayType));
  return _applyDemoFilters(p);
}

function setGenderFilter(g) {
  currentGender = (currentGender === g) ? null : g;
  _refreshAfterFilterChange();
}
function setAgeFilter(key) {
  _toggleInArr(currentAgeSet, key);
  _refreshAfterFilterChange();
}
let currentPage = 1;
let ageChart = null;

function stripHelpPrefix(name) {
  if (!name) return name;
  // на казахском: берём перевод полного названия и убираем хвост «әлеуметтік көмек»
  if (window.LANG === 'kk') {
    const kk = t(name);
    if (kk !== name) return kk.replace(/\s*әлеуметтік көмек\s*$/i, '').trim() || kk;
  }
  const s = name.replace(/^\s*СОЦИАЛЬНАЯ\s+ПОМОЩЬ\s+/i, '');
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function toggleHelpTypesList(ev) {
  if (ev) ev.stopPropagation();
  _kpiCardToggle('kpi-card-help-types', () => {
    const list = document.getElementById('kpi-help-list');
    const populate = (cols) => {
      if (!cols.length) { list.innerHTML = '<div class="kpi-help-item">Нет данных</div>'; return; }
      list.innerHTML = cols.map((c, i) =>
        `<div class="kpi-help-item"><span class="kpi-help-num">${i + 1}</span>${stripHelpPrefix(c.name)}</div>`
      ).join('');
    };
    if (presenceColumns.length) {
      populate(presenceColumns);
    } else {
      list.innerHTML = '<div class="kpi-help-item" style="opacity:.5">Загрузка…</div>';
      fetch('/api/help-presence').then(r => r.json()).then(d => populate(d.columns || []));
    }
  });
}

function _kpiCardToggle(cardId, renderFn) {
  const card = document.getElementById(cardId);
  const col  = card?.closest('.kpi-col-left, .kpi-col-right');
  if (!card) return;
  if (card.classList.contains('expanded')) {
    card.classList.add('closing');
    card.addEventListener('animationend', () => {
      card.classList.remove('expanded', 'closing');
      col?.classList.remove('kpi-expanding');
    }, { once: true });
    return;
  }
  col?.classList.add('kpi-expanding');
  card.classList.add('expanded');
  renderFn();
}

function _fmtRegionName(s) {
  if (!s) return s;
  const l = s.toLowerCase();
  if (l.startsWith('г.') || l.startsWith('г. ')) {
    return 'г.' + l.slice(2).replace(/^\s*([а-яёa-z])/i, (m, ch) => m.replace(ch, ch.toUpperCase()));
  }
  return l.charAt(0).toUpperCase() + l.slice(1);
}

function _fmtBudgetBln(v) {
  if (!v) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + ' млрд ₸';
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + ' млн ₸';
  return Math.round(v).toLocaleString('ru') + ' ₸';
}

function toggleBudgetList(ev) {
  if (ev) ev.stopPropagation();
  _kpiCardToggle('kpi-card-budget', () => {
    const list = document.getElementById('kpi-budget-list');
    const populate = (rows) => {
      const items = rows
        .filter(r => !r.is_total)
        .sort((a, b) => (b.mini?.budget_val || 0) - (a.mini?.budget_val || 0));
      if (!items.length) { list.innerHTML = '<div class="kpi-help-item">Нет данных</div>'; return; }
      list.innerHTML = items.map((r, i) =>
        `<div class="kpi-help-item">
          <span class="kpi-help-num">${i + 1}</span>
          <span class="kpi-help-name">${_fmtRegionName(r.name)}</span>
          <span class="kpi-help-val">${_fmtBudgetBln(r.mini?.budget_val)}</span>
        </div>`
      ).join('');
    };
    if (presenceRows.length) {
      populate(presenceRows);
    } else {
      list.innerHTML = '<div class="kpi-help-item" style="opacity:.5">Загрузка…</div>';
      fetch('/api/help-presence').then(r => r.json()).then(d => populate(d.rows || []));
    }
  });
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

// ── Модальное окно контактов поддержки ──
function openSupportModal() {
  const m = document.getElementById('support-modal');
  if (m) m.style.display = 'flex';
}
function closeSupportModal() {
  const m = document.getElementById('support-modal');
  if (m) m.style.display = 'none';
}
function openPlansModal() {
  const m = document.getElementById('plans-modal');
  if (m) m.style.display = 'flex';
}
function closePlansModal() {
  const m = document.getElementById('plans-modal');
  if (m) m.style.display = 'none';
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeSupportModal(); closePlansModal(); }
});

function showLogin() {
  const ov = document.createElement('div');
  ov.className = 'auth-overlay';
  ov.innerHTML = `
    <form class="auth-card" id="auth-form">
      <div class="auth-logo">🏛️</div>
      <div class="auth-title">Анализ по мерам государственной поддержки МИО</div>
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
    // «Аккаунты» — верхний ряд стека, «Планы развития» — нижний
    const actions = document.getElementById('header-actions');
    if (actions) actions.insertBefore(btn, actions.firstChild);
    else header.insertBefore(btn, logoutBtn || null);
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
          <div class="admin-upload">
            <div class="admin-upload-title">Обновление данных</div>
            <div class="admin-upload-hint"></div>
            <div class="admin-upload-row">
              <input type="file" id="admin-data-file" accept=".xlsx,.xlsm">
              <button type="button" id="admin-data-upload-btn" onclick="adminUploadData()">Загрузить и обновить</button>
            </div>
            <div class="admin-upload-status" id="admin-upload-status"></div>
          </div>
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

async function adminUploadData() {
  const input = document.getElementById('admin-data-file');
  const statusEl = document.getElementById('admin-upload-status');
  const btn = document.getElementById('admin-data-upload-btn');
  const file = input.files && input.files[0];
  if (!file) { statusEl.className = 'admin-upload-status err'; statusEl.textContent = 'Выберите файл .xlsx'; return; }
  if (!confirm(`Заменить все данные выплат данными из «${file.name}»?`)) return;

  btn.disabled = true;
  statusEl.className = 'admin-upload-status';
  statusEl.textContent = 'Загрузка и обработка файла…';
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/admin/upload-data', { method: 'POST', credentials: 'include', body: fd });
    const data = await r.json();
    if (!r.ok) { statusEl.className = 'admin-upload-status err'; statusEl.textContent = data.detail || 'Ошибка загрузки'; return; }
    statusEl.className = 'admin-upload-status ok';
    statusEl.textContent = `Готово: загружено ${formatInt(data.rows)} строк. Обновляю страницу…`;
    setTimeout(() => location.reload(), 1200);
  } catch {
    statusEl.className = 'admin-upload-status err';
    statusEl.textContent = 'Сеть недоступна';
  } finally {
    btn.disabled = false;
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
  const section = btn.closest('.table-section, .map-panel, .ranking-panel');
  if (!section) return;
  const fs = section.classList.toggle('is-fullscreen');
  document.body.classList.toggle('fs-open', fs);
  btn.textContent = fs ? '✕' : '⛶';
  btn.title = fs ? 'Закрыть' : 'Во весь экран';
  if (section.classList.contains('map-panel') && map) {
    setTimeout(() => map.invalidateSize(), 60);
    setTimeout(() => map.invalidateSize(), 360);
    applyFsZoom(fs);
  }
  _syncPie3DTab(section, fs);
}

// В полноэкранном режиме приближаем карту на 1 уровень, но только если открыта
// вся страна (не вошли в регион/район). При выходе — возвращаем обратно.
let _fsZoomBoost = false;
let _mapNeedsFit = false;   // отложенный fitBounds, если карта drill'илась в скрытой вкладке

// Единый вид «вся страна»: инициализация, возврат из региона (goBack),
// кнопка «дом» и возврат из 3D в 2D. Дробный зум работает за счёт zoomSnap: 0.5.
const KZ_VIEW = { center: [48, 67], zoom: 4.5 };

// Целевой зум страны С УЧЁТОМ полноэкранного буста (+1). Любой жёсткий сброс вида
// (goBack, кнопка «дом», возврат из 3D) обязан его учитывать, иначе флаг
// _fsZoomBoost рассинхронизируется с реальным зумом и при выходе из фуллскрина
// единица вычтется «вхолостую» (баг: 4.5 → 3.5).
const _kzZoom = () => KZ_VIEW.zoom + (_fsZoomBoost ? 1 : 0);
function applyFsZoom(fs) {
  if (!map) return;
  const atCountry = currentRegion == null && currentRaion == null;
  if (fs && !_fsZoomBoost && atCountry) {
    _fsZoomBoost = true;
    setTimeout(() => { try { map.setZoom(map.getZoom() + 1); } catch (_) {} }, 120);
  } else if (!fs && _fsZoomBoost) {
    _fsZoomBoost = false;
    // Снимаем буст только если он реально «сидит» в текущем зуме. Если пользователь
    // ушёл в регион, зум задан fitBounds'ом — вычитать из него единицу нельзя.
    if (atCountry) {
      setTimeout(() => { try { map.setZoom(map.getZoom() - 1); } catch (_) {} }, 120);
    }
  }
}

// Вкладка «3D-пирог» доступна только в полноэкранном режиме первой группы таблиц
function _syncPie3DTab(section, fs) {
  const pieBtn = section.querySelector('.pie3d-tab-btn');
  if (!pieBtn) return;
  pieBtn.style.display = fs ? '' : 'none';
  if (!fs && pieBtn.classList.contains('active')) {
    section.querySelector('.tab-btn[data-tab="presence"]')?.click();
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
      _syncPie3DTab(s, false);
    });
    document.body.classList.remove('fs-open');
    if (hadMap && map) { setTimeout(() => map.invalidateSize(), 60); applyFsZoom(false); }
  }
});

const TABLE_COLS = [
  { key: 'app_date',     label: 'Дата заявки' },
  { key: 'app_status',   label: 'Статус',           filterable: true },
  { key: 'sicid',        label: 'SICID' },
  { key: 'kato_regname', label: 'Регион',            filterable: true },
  { key: 'kato_rainame', label: 'Район',             filterable: true },
  { key: 'pay_type',     label: 'Вид помощи',       filterable: true },
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
  setupMapTabs();   // перенести Динамику / 3D-пирог / Данные в блок карты
  // zoomSnap: 0.5 — иначе Leaflet округляет зум до целых и дробный 4.5 не удержится
  map = L.map('map', { zoomControl: true, attributionControl: false, zoomSnap: 0.5 })
    .setView(KZ_VIEW.center, KZ_VIEW.zoom);

  // Home button — resets view smoothly via flyTo
  new (L.Control.extend({
    options: { position: 'topleft' },
    onAdd(m) {
      const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      const a = L.DomUtil.create('a', 'lc-home-btn', div);
      a.href = '#';
      a.title = 'Сбросить вид карты';
      a.setAttribute('role', 'button');
      a.innerHTML = '⌂';
      L.DomEvent.on(a, 'click', e => {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);
        m.flyTo(KZ_VIEW.center, _kzZoom(), { duration: 0.7 });
      });
      return div;
    }
  }))().addTo(map);

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
    if (el) el.textContent = `${t('данные актуализированы')} ${dd}.${mm}.${d.getFullYear()}`;
  })();

  // Map legend
  const mapLegend = L.control({ position: 'bottomright' });
  mapLegend.onAdd = function() {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = `
      <div class="ml-title">Утвержденные виды помощи в МИО </div>
      <div class="ml-item"><span class="ml-dot" style="background:#c0392b"></span>0 видов помощи</div>
      <div class="ml-item"><span class="ml-dot" style="background:#e67e22"></span>1–4 вида</div>
      <div class="ml-item"><span class="ml-dot" style="background:#27ae60"></span>5 и более</div>`;
    return div;
  };
  mapLegend.addTo(map);
  updateMapLegend();

  renderRegions();
  await refreshKPI();
  await Promise.all([loadSummary(), loadHelpPresence(), loadGapAnalysis()]);
}

function getColor(vidy) {
  if (vidy === 0)  return '#c0392b';
  if (vidy <= 4)   return '#e67e22';
  return '#27ae60';
}

// Покраска по проценту «факт выплачено / сумма заявок»
function getColorPct(pct) {
  if (pct < 10)  return '#c0392b';
  if (pct < 20)  return '#e67e22';
  return '#27ae60';
}

let maxEntitledVidy = 1;
let mapColorMode = 'vidy';   // 'vidy' — по видам помощи, 'pct' — по % выплат

function geoVidy(id) {
  return presenceById[Math.round(id)]?.mini?.vidy || 0;
}

function geoPct(id) {
  const m = presenceById[Math.round(id)]?.mini;
  if (!m || !m.summa_val) return 0;
  return m.deliv_val / m.summa_val * 100;
}

function geoFill(id) {
  return mapColorMode === 'pct' ? getColorPct(geoPct(id)) : getColor(geoVidy(id));
}

function regionStyle(feature) {
  return {
    fillColor: geoFill(feature.properties.id_reg),
    weight: 1,
    color: '#3a5090',
    fillOpacity: 0.75,
  };
}

function raionStyle(feature) {
  // город-целиком (Астана/Шымкент): у полигона региона нет id_rai — красим по
  // единственному «району» (7100/7900)
  const id = REGIONS_NO_RAION.has(+currentRegion)
    ? Number(Object.keys(raionStats)[0])
    : feature.properties.id_rai;
  return {
    fillColor: geoFill(id),
    weight: 1,
    color: '#3a5090',
    fillOpacity: 0.75,
  };
}

// Переключение режима покраски карты
function setMapColorMode(mode) {
  if (mode === mapColorMode) return;
  mapColorMode = mode;
  document.querySelectorAll('.map-color-modes .mcm-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  if (currentRegion) raionsLayer?.setStyle(raionStyle);
  else regionsLayer?.setStyle(regionStyle);
  updateMapLegend();
}

function updateMapLegend() {
  const div = document.querySelector('.map-legend');
  if (!div) return;
  if (mapColorMode === 'pct') {
    div.innerHTML = `
      <div class="ml-title">Фактическая выплата / Принятые заявления</div>
      <div class="ml-item"><span class="ml-dot" style="background:#c0392b"></span>менее 10%</div>
      <div class="ml-item"><span class="ml-dot" style="background:#e67e22"></span>10–20%</div>
      <div class="ml-item"><span class="ml-dot" style="background:#27ae60"></span>20% и более</div>`;
  } else {
    div.innerHTML = `
      <div class="ml-title">Утвержденные виды помощи в МИО </div>
      <div class="ml-item"><span class="ml-dot" style="background:#c0392b"></span>0 видов помощи</div>
      <div class="ml-item"><span class="ml-dot" style="background:#e67e22"></span>1–4 вида</div>
      <div class="ml-item"><span class="ml-dot" style="background:#27ae60"></span>5 и более</div>`;
  }
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

function _toTitleCase(s) {
  if (!s) return s;
  const l = s.toLowerCase();
  // города республиканского значения: «г.Астана» — префикс строчный, название с заглавной
  const m = l.match(/^г\.\s*(.+)$/);
  if (m) return 'г.' + m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return l.charAt(0).toUpperCase() + l.slice(1);
}

const REGIONS_NO_NPA = new Set([10, 62]);

// Города республиканского значения без районного деления: Астана (71), Шымкент (79).
// При заходе в такой регион на карте не показываем районы, а рисуем регион целиком
// одной фигурой. Алматы (75) сюда НЕ входит — у него районы есть.
const REGIONS_NO_RAION = new Set([71, 79]);

// Построить слой «районов» для 2D-drill. Для городов без районов (Астана/Шымкент)
// берём цельный полигон региона и трактуем его как единственный «район» (7100/7900).
function _buildDrillLayer(regionId) {
  const whole = REGIONS_NO_RAION.has(+regionId);
  const src = whole ? regionGeoJSON : raionGeoJSON;
  const filtered = {
    ...src,
    features: src.features.filter(f => f.properties.id_reg == regionId),
  };
  const soleId = whole ? Number(Object.keys(raionStats)[0]) : null;   // 7100 / 7900
  const idOf = f => whole ? soleId : f.properties.id_rai;
  const layer = L.geoJSON(filtered, {
    style: raionStyle,
    onEachFeature(feature, lyr) {
      lyr.bindTooltip(() => raionStats[idOf(feature)]?.name || _regionName(regionId),
                      { sticky: true, className: 'map-name-tip' });
      lyr.on({
        mouseover(e) { e.target.setStyle({ weight: 2, color: '#7090ff', fillOpacity: 0.9 }); },
        mouseout(e)  { layer.resetStyle(e.target); },
        click()      { const id = idOf(feature); if (id != null) selectRaion(id); },
      });
    },
  });
  return layer;
}

function _npaEmptyMsg(regionId) {
  return REGIONS_NO_NPA.has(+regionId) ? 'Не предусмотрено в НПА' : 'Нет обращений';
}

function _regionName(id) {
  const n = regionStats[id]?.name || presenceById[Math.round(id)]?.name;
  return n ? t(_toTitleCase(n)) : `Регион ${id}`;
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
    // город-целиком (Астана/Шымкент): у единственного «района» нет своего центроида —
    // берём центроид региона
    let c = raionCentroids[Math.round(id)];
    if (!c && REGIONS_NO_RAION.has(+currentRegion)) c = regionCentroids[currentRegion];
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
      layer.bindTooltip(() => {
        const rid = feature.properties.id_reg;
        const n = regionStats[rid]?.name || presenceById[Math.round(rid)]?.name || '';
        return _toTitleCase(n) || '';
      }, { sticky: true, className: 'map-name-tip' });
      layer.on({
        mouseover(e) { e.target.setStyle({ weight: 2, color: '#7090ff', fillOpacity: 0.9 }); },
        mouseout(e)  { regionsLayer.resetStyle(e.target); },
        click()      { drillRegion(feature.properties.id_reg); },
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
  if (regionsLayer) { map.removeLayer(regionsLayer); }
  if (raionsLayer) { map.removeLayer(raionsLayer); }
  raionsLayer = _buildDrillLayer(regionId).addTo(map);
  renderRaionLabels();

  const regionName = _regionName(regionId);
  updateBreadcrumb(regionName, null);
  loadDistinct('kato_rainame');
  await refreshKPI();
  await Promise.all([loadSummary(), loadHelpPresence(), loadGapAnalysis()]);
  loadRankingPanel();
  loadDynamics();
  loadPayTypes();
  _syncAnomalyGeo();
}

async function drillRegion(regionId) {
  currentRegion = regionId;
  currentRaion = null;
  currentPage = 1;

  const data = await fetch(`/api/raions?region_id=${regionId}`).then(r => r.json());
  raionStats = {};
  data.forEach(r => { raionStats[r.id_rai] = r; });

  if (regionsLayer) { map.removeLayer(regionsLayer); }
  if (raionsLayer) { map.removeLayer(raionsLayer); }

  raionsLayer = _buildDrillLayer(regionId).addTo(map);

  // Если блок карты сейчас показывает не вкладку «Карта» (нулевой размер
  // контейнера), откладываем fitBounds до момента открытия вкладки.
  if (document.getElementById('mtab-map')?.classList.contains('active')) {
    map.fitBounds(raionsLayer.getBounds(), { padding: [20, 20] });
  } else {
    _mapNeedsFit = true;
  }
  renderRaionLabels();

  const regionName = _regionName(regionId);
  updateBreadcrumb(regionName, null);
  if (_shouldShowGeoSide()) showGeoSidePanel(regionId, regionName, false);
  loadDistinct('kato_rainame');
  await refreshKPI();
  await Promise.all([loadSummary(), loadHelpPresence(), loadGapAnalysis()]);
  loadRankingPanel();
  loadDynamics();
  loadPayTypes();
  _syncAnomalyGeo();
}

async function selectRaion(raionId) {
  currentRaion = raionId;
  currentPage = 1;
  const raionName = raionStats[raionId]?.name || `Район ${raionId}`;
  const regionName = _regionName(currentRegion);
  updateBreadcrumb(regionName, raionName);
  if (_shouldShowGeoSide()) showGeoSidePanel(raionId, raionName, true);
  await refreshKPI();
  loadDynamics();
  loadPayTypes();
  _syncAnomalyGeo();
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
  window.refreshMap3DTheme?.();
  refreshGpSduChartsTheme();
}

/* Смена языка. Вызывается из i18n.js после перевода статики.
 * Статику и уже отрисованный DOM i18n.js уже обработал; здесь пересобираем то,
 * что «запекает» текст при рендере: Chart.js, шапку таблицы данных, 3D-сцены,
 * хлебные крошки. */
window.onLangChange = function () {
  // шапка вкладки «Данные» строится один раз — пересобрать под новый язык
  _dataTableInit = false;

  // Chart.js запекает подписи при создании → уничтожаем, пересоздадутся
  Object.values(_gapCharts).forEach(c => { try { c.destroy(); } catch (_) {} });
  Object.keys(_gapCharts).forEach(k => delete _gapCharts[k]);

  updateBreadcrumb(
    currentRegion != null ? _regionName(currentRegion) : null,
    currentRaion  != null ? (raionStats[currentRaion]?.name || null) : null
  );

  _refreshAfterFilterChange();   // внутри: refreshKPI → refreshActiveMapTab
  if (currentRegion) renderRaionLabels(); else renderRegionLabels();

  // календарь диапазона: обновить текст поля и, если открыт, названия месяцев/дней
  _updateDynDateUI();
  const _cp = document.getElementById('dyn-cal-pop');
  if (_cp && !_cp.hidden) _renderDynCal();
};

function goBack() {
  currentRegion = null;
  currentRaion = null;
  currentPage = 1;
  hideGeoPanelNow();
  hideGeoSidePanel();
  updateBreadcrumb(null, null);
  clearLabels();
  renderRegions();
  map.setView(KZ_VIEW.center, _kzZoom());
  // hideGeoSidePanel() закрывает drill-панель CSS-анимацией (~420мс) и дёргает
  // invalidateSize() на 60/460мс — уже ПОСЛЕ этого setView. Пока контейнер меняет
  // ширину, вид успевает съехать, поэтому переустанавливаем его, когда карта
  // приняла финальный размер.
  setTimeout(() => { try { map.setView(KZ_VIEW.center, _kzZoom()); } catch (_) {} }, 500);
  refreshKPI();
  loadSummary();
  loadHelpPresence();
  loadRankingPanel();
  loadDynamics();
  loadPayTypes();
  _syncAnomalyGeo();
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

// сперва переводим (t() на русском — тождество), потом убираем родовое слово
function _stripRegionWord(name) {
  return t(name || '').replace(/\s*(область|облысы)\s*/gi, ' ').trim();
}
function _stripRaionWord(name) {
  return t(name || '').replace(/\s*(район|ауданы)\s*/gi, ' ').trim();
}

function updateBreadcrumb(region, raion) {
  let html = '<span onclick="goBack()">Казахстан</span>';
  if (region) html += ` / <span onclick="drillRegion(${currentRegion})">${_stripRegionWord(region)}</span>`;
  if (raion) html += ` / ${_stripRaionWord(raion)}`;
  const el = document.getElementById('breadcrumb');
  if (el) el.innerHTML = html;
  // Дубликат в баре вкладок блока карты (виден в полноэкранном режиме)
  const fs = document.getElementById('map-fs-breadcrumb');
  if (fs) fs.innerHTML = html;
}


// ── Гео-панель в левой колонке (при клике на регион/район на карте) ──────────
function _shouldShowGeoSide() {
  const mapActive = document.querySelector('.map-tabs .mtab-btn[data-mtab="map"].active');
  const sideOpen  = document.querySelector('.main-layout.map-drill-active');
  return !!(mapActive || sideOpen);
}

async function showGeoSidePanel(geoId, geoName, isRaion) {
  const layout = document.querySelector('.main-layout');
  const panel  = document.getElementById('kpi-geo-side');
  if (!panel || !layout) return;
  layout.classList.add('map-drill-active');
  panel.innerHTML = '<div class="gp-main"><div class="gp-body"><div class="gp-title">Загрузка…</div></div></div>';
  _gsPayFilter = null; _gsGeoId = geoId; _gsGeoIsRaion = isRaion; _gsGeoName = geoName;
  _geoSort['gs'] = { col: null, dir: 1 };   // сброс сортировки при смене гео
  if (map) { setTimeout(() => map.invalidateSize(), 60); setTimeout(() => map.invalidateSize(), 460); }

  try {
    const geoParam  = isRaion ? `raion_id=${geoId}` : `region_id=${geoId}`;
    const presParam = isRaion ? `region_id=${currentRegion}` : `region_id=${geoId}`;
    const demo = _demoQS();
    const [stats, kpi, pres] = await Promise.all([
      fetch(_url('/api/geo-stats', geoParam, demo)).then(r => r.json()),
      fetch(_url('/api/kpi', geoParam, demo)).then(r => r.json()),
      fetch(_url('/api/help-presence', presParam, demo)).then(r => r.json()),
    ]);

    const columns = pres.columns || [];
    const presRow = isRaion
      ? ((pres.rows || []).find(r => r.id === geoId) || (pres.rows || [])[0] || {})
      : ((pres.rows || []).find(r => r.is_total) || {});
    // Показываем ВСЕ виды помощи (даже с нулями)
    const provided = columns.length
      ? columns.map((c, i) => ({ c, cnt: (presRow.pay_cat_lists?.[i] || []).length }))
      : [];

    const backLabel = isRaion
      ? `← ${_stripRegionWord(_regionName(currentRegion))}`
      : '← Казахстан';
    const backClick = isRaion ? `drillRegion(${currentRegion})` : `goBack()`;

    const _effRegion = isRaion ? currentRegion : geoId;
    panel.innerHTML =
      _buildGeoMainHtml(geoName, provided, stats, kpi, 'gs', _npaEmptyMsg(_effRegion), geoName);
    renderGeoPanelCharts(kpi, 'gs');
  } catch(e) {
    panel.innerHTML = '<div class="gp-title" style="padding:20px">Ошибка загрузки</div>';
    console.error('geoSide', e);
  }
}

function hideGeoSidePanel() {
  const layout = document.querySelector('.main-layout');
  if (!layout?.classList.contains('map-drill-active')) return;
  layout.classList.remove('map-drill-active');
  const panel = document.getElementById('kpi-geo-side');
  if (panel) setTimeout(() => { panel.innerHTML = ''; }, 450);
  if (map) { setTimeout(() => map.invalidateSize(), 60); setTimeout(() => map.invalidateSize(), 460); }
}

async function refreshKPI(sduSeq) {
  const params = buildFilterParams();

  const [data, ptRows] = await Promise.all([
    fetch(`/api/kpi?${params}`).then(r => r.json()),
    fetch(`/api/pay-type-stats?${params}`).then(r => r.json()).catch(() => []),
  ]);
  if (sduSeq < _sduSeq) return; // stale — a newer sdu change superseded this call

  animateCounter('kpi-dec',         data.total_dec_pay_sum,   v => formatCompact(v));
  animateCounter('kpi-deliv',       data.total_deliv_sum || 0, v => formatCompact(v));
  animateCounter('kpi-budget',      data.budget_total || 0,    v => formatCompact(v));
  animateCounter('kpi-recipients',  data.fact_recipients || 0, v => formatInt(v));
  animateCounter('kpi-help-types',  data.help_type_count || 0, v => formatInt(v));
  animateCounter('kpi-app-count',   data.app_count || 0,      v => formatInt(v));
  renderTopMgp(ptRows);

  // проценты
  const decPct = data.budget_total ? (data.total_dec_pay_sum || 0) / data.budget_total * 100 : 0;
  setText('kpi-dec-pct', decPct.toFixed(2).replace('.', ',') + '%');
  const delivPct = data.total_dec_pay_sum ? Math.round((data.total_deliv_sum || 0) / data.total_dec_pay_sum * 100) : 0;
  setText('kpi-deliv-pct', delivPct + '%');

  // графики ЦКС/Пол-Возраст в KPI удалены; функции с guard'ами безопасны для тултипа
  renderGenderAgeBar(data.male_count || 0, data.female_count || 0, data.age || {});
  renderSduChart(data.sdu || {});

  refreshActiveMapTab();   // обновить активную вкладку блока карты под новый регион/район
}

let _lastTopMgpRows = [];
function toggleTopMgpList(ev) {
  if (ev) ev.stopPropagation();
  _kpiCardToggle('kpi-card-top-mgp', _populateTopMgpList);
}
function _populateTopMgpList() {
  const list = document.getElementById('kpi-top-mgp-list');
  if (!list) return;
  const items = [..._lastTopMgpRows]
    .filter(r => (r.total_dec || 0) > 0)
    .sort((a, b) => (b.total_dec || 0) - (a.total_dec || 0));
  if (!items.length) { list.innerHTML = '<div class="kpi-help-item">Нет данных</div>'; return; }
  list.innerHTML = items.map((r, i) => {
    const name = stripHelpPrefix(r.pay_type || '—');
    return `<div class="kpi-help-item">
      <span class="kpi-help-num">${i + 1}</span>
      <span class="kpi-help-name" title="${name}">${name}</span>
      <span class="kpi-help-val">${formatCompact(r.total_dec || 0)} ₸</span>
    </div>`;
  }).join('');
}

function renderTopMgp(rows) {
  _lastTopMgpRows = rows || [];
  const el = document.getElementById('kpi-top-mgp');
  if (!el) return;
  // если карточка раскрыта — обновить полный список под новый регион/фильтр
  const card = document.getElementById('kpi-card-top-mgp');
  if (card && card.classList.contains('expanded')) _populateTopMgpList();
  const top4 = (rows || []).slice(0, 4);
  if (!top4.length) { el.innerHTML = '<div class="kpi-empty">Нет данных</div>'; return; }
  el.innerHTML =
    `<div class="kpi-top-mgp-hdr">
      <span>#</span><span>Вид помощи</span><span>Сумма</span>
    </div>` +
    top4.map((r, i) => {
      const name = stripHelpPrefix(r.pay_type || '—');
      const val = formatCompact(r.total_dec || 0) + ' ₸';
      return `<div class="kpi-top-mgp-item">
        <span class="kpi-top-mgp-num">${i + 1}</span>
        <span class="kpi-top-mgp-name" title="${name}">${name}</span>
        <span class="kpi-top-mgp-val">${val}</span>
      </div>`;
    }).join('');
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
  if (!document.getElementById('sdu-chart')) return;
  const keys = ['A', 'B', 'C', 'D', 'E'];
  const values = keys.map(k => sdu[k] || 0);
  const total = values.reduce((a, b) => a + b, 0);

  const pcts = values.map(v => total ? Math.round(v / total * 100) : 0);

  const legend = document.getElementById('sdu-legend');
  if (legend) legend.innerHTML = '';

  // Show/hide clear button
  const clearBtn = document.getElementById('sdu-clear-btn');
  if (clearBtn) clearBtn.style.display = currentSduSet.length ? 'inline-flex' : 'none';

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
        backgroundColor: keys.map(k => SDU_META[k].color + (currentSduSet.length && !currentSduSet.includes(k) ? '66' : '')),
        borderColor: keys.map(k => currentSduSet.includes(k) ? (isLight ? '#202124' : '#fff') : 'transparent'),
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
            title: c => t(SDU_META[c[0].label]?.label || c[0].label),
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
        if (elements.length) toggleSduFilter(keys[elements[0].index]);
      },
      onHover(_e, elements, chart) {
        chart.canvas.style.cursor = elements.length ? 'pointer' : 'default';
      },
    },
  });
}

function toggleSduFilter(k) {
  _toggleInArr(currentSduSet, k);
  _refreshAfterFilterChange();
}

function clearSduFilter() {
  currentSduSet = [];
  _refreshAfterFilterChange();
}

// Сброс всех демографических фильтров (ЦКС + пол + возраст) разом
function clearAllFilters() {
  currentSduSet = [];
  currentGender = null;
  currentAgeSet = [];
  _refreshAfterFilterChange();
}
function _anyDemoFilter() {
  return currentSduSet.length > 0 || currentGender != null || currentAgeSet.length > 0;
}
// Кнопка «Снять фильтры» в шапке блока «Пол / Возраст» (видна только при активных фильтрах)
function _clearFiltersBtn() {
  return `<button type="button" class="ga-clear-btn${_anyDemoFilter() ? '' : ' ga-clear-hidden'}" onclick="clearAllFilters()">Снять фильтры</button>`;
}

function _invalidateAnomCaches() {
  Object.keys(_anTabCache).forEach(k => delete _anTabCache[k]);
  Object.keys(_anUtilCache).forEach(k => delete _anUtilCache[k]);
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

let _rankingData = null;

async function loadRankingPanel() {
  const url = _url('/api/ranking-oblasts',
    currentRegion ? `region_id=${currentRegion}` : '',
    currentPayType ? `pay_type_id=${currentPayType}` : '',
    _demoQS());
  try {
    const r = await fetch(url, { credentials: 'include' });
    _rankingData = r.ok ? await r.json() : [];
  } catch { _rankingData = []; }
  _renderRankingTab('sum');
  _renderRankingTab('recipients');
}

function _renderRankingTab(tab) {
  if (!_rankingData) return;
  const tbody = document.getElementById(`ranking-tbody-${tab}`);
  if (!tbody) return;
  const sorted = [..._rankingData].sort((a, b) =>
    tab === 'sum' ? b.total_deliv - a.total_deliv : b.recipients - a.recipients
  );
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--tx-muted)">Нет данных</td></tr>';
    return;
  }
  tbody.innerHTML = sorted.map((row, i) => {
    const rank = i + 1;
    const rankClass = rank <= 3 ? ` rank-${rank}` : '';
    const name = (row.name || '—');
    const recipCell = tab === 'recipients' ? `<td class="col-right">${formatInt(row.recipients || 0)}</td>` : '';
    return `<tr class="coverage-row" onclick="_rankingItemClick(${row.id})" style="cursor:pointer">
      <td class="col-center"><span class="ranking-rank${rankClass}">${rank}</span></td>
      <td>${name}</td>
      ${recipCell}
      <td class="col-right">${row.total_dec > 0 ? formatNum(row.total_dec) + ' ₸' : '—'}</td>
      <td class="col-right rk-deliv">${row.total_deliv > 0 ? formatNum(row.total_deliv) + ' ₸' : '—'}</td>
    </tr>`;
  }).join('');
}

// ── Dynamics chart ────────────────────────────────────────────
let _dynChart = null;
let _dynPeriod = 'week';
let _dynMetric = 'count';
let _dynData   = null;
let _dynFrom   = null;   // 'YYYY-MM-DD' или null
let _dynTo     = null;
let _dynBounds = null;   // {min, max} — доступный диапазон дат из данных без фильтра

async function loadDynamics() {
  const fp = buildFilterParams('full');
  fp.set('period', _dynPeriod);
  if (_dynFrom) fp.set('date_from', _dynFrom);
  if (_dynTo)   fp.set('date_to', _dynTo);
  try {
    const r = await fetch(`/api/dynamics?${fp}`, { credentials: 'include' });
    _dynData = r.ok ? await r.json() : [];
  } catch { _dynData = []; }
  _updateDynDateUI();
  renderDynamics(_dynData);
}

// ── Range-календарь (один попап: клик — начало, клик — конец) ──────
const _CAL_MONTHS = {
  ru: ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'],
  kk: ['Қаңтар','Ақпан','Наурыз','Сәуір','Мамыр','Маусым','Шілде','Тамыз','Қыркүйек','Қазан','Қараша','Желтоқсан'],
};
const _CAL_DOW = {
  ru: ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'],
  kk: ['Дс','Сс','Ср','Бс','Жм','Сб','Жс'],
};
let _dynCalView = null;   // {y, m} — отображаемый месяц (m 0-based)
let _dynSelFrom = null;   // выбор в процессе (первый клик)
let _dynSelTo   = null;
let _dynHover   = null;   // предпросмотр диапазона при наведении

const _calLang = () => (window.LANG === 'kk' ? 'kk' : 'ru');
const _isoYMD  = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function _fmtShort(iso) {           // '2026-06-01' → '01.06.26'
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y.slice(2)}`;
}

// Обновляет текст поля/кнопку сброса и держит границы диапазона данных.
function _updateDynDateUI() {
  if (!_dynFrom && !_dynTo && _dynData && _dynData.length) {
    _dynBounds = { min: _dynData[0].period, max: _dynData[_dynData.length - 1].period };
  }
  const txt   = document.getElementById('dyn-dr-text');
  const reset = document.getElementById('dyn-date-reset');
  if (txt) {
    txt.textContent = (_dynFrom && _dynTo)
      ? `${_fmtShort(_dynFrom)} – ${_fmtShort(_dynTo)}`
      : t('Весь период');
  }
  if (reset) reset.hidden = !(_dynFrom || _dynTo);
}

function _openDynCal() {
  const pop = document.getElementById('dyn-cal-pop');
  const field = document.getElementById('dyn-dr-field');
  if (!pop) return;
  _dynSelFrom = _dynFrom; _dynSelTo = _dynTo; _dynHover = null;
  const anchor = _dynFrom || (_dynBounds ? _dynBounds.max : null);
  if (anchor) { const [y, m] = anchor.split('-'); _dynCalView = { y: +y, m: +m - 1 }; }
  else { const n = new Date(); _dynCalView = { y: n.getFullYear(), m: n.getMonth() }; }
  pop.hidden = false;
  if (field) field.setAttribute('aria-expanded', 'true');
  _renderDynCal();
}
function _closeDynCal() {
  const pop = document.getElementById('dyn-cal-pop');
  const field = document.getElementById('dyn-dr-field');
  if (pop) pop.hidden = true;
  if (field) field.setAttribute('aria-expanded', 'false');
}

function _renderDynCal() {
  const grid  = document.getElementById('dyn-cal-grid');
  const dow   = document.getElementById('dyn-cal-dow');
  const title = document.getElementById('dyn-cal-title');
  const rangeEl = document.getElementById('dyn-cal-range');
  if (!grid || !_dynCalView) return;
  const lang = _calLang();
  const { y, m } = _dynCalView;
  if (title) title.textContent = `${_CAL_MONTHS[lang][m]} ${y}`;
  if (dow) dow.innerHTML = _CAL_DOW[lang].map(d => `<span>${d}</span>`).join('');

  // конец предполагаемого диапазона (для подсветки при наведении)
  let a = _dynSelFrom, b = _dynSelTo;
  if (a && !b && _dynHover) { b = _dynHover; if (b < a) { const t2 = a; a = b; b = t2; } }

  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7;   // Пн = 0
  const daysIn   = new Date(y, m + 1, 0).getDate();
  const min = _dynBounds ? _dynBounds.min : null;
  const max = _dynBounds ? _dynBounds.max : null;
  let html = '';
  for (let i = 0; i < firstDow; i++) html += '<span class="dc-cell dc-empty"></span>';
  for (let d = 1; d <= daysIn; d++) {
    const iso = _isoYMD(y, m, d);
    const disabled = (min && iso < min) || (max && iso > max);
    const cls = ['dc-cell'];
    if (disabled) cls.push('dc-disabled');
    if (iso === _dynSelFrom || iso === _dynSelTo) cls.push('dc-sel');
    if (a && b && iso >= a && iso <= b) {
      cls.push('dc-in');
      if (iso === a) cls.push('dc-start');
      if (iso === b) cls.push('dc-end');
    }
    html += `<span class="${cls.join(' ')}" ${disabled ? '' : `data-d="${iso}"`}>${d}</span>`;
  }
  grid.innerHTML = html;
  if (rangeEl) {
    rangeEl.textContent = (_dynSelFrom && _dynSelTo)
      ? `${_fmtShort(_dynSelFrom)} – ${_fmtShort(_dynSelTo)}`
      : (_dynSelFrom ? `${_fmtShort(_dynSelFrom)} – …` : '');
  }
}

function _pickDynDay(iso) {
  if (!_dynSelFrom || (_dynSelFrom && _dynSelTo)) {
    // начинаем новый диапазон
    _dynSelFrom = iso; _dynSelTo = null; _dynHover = null;
    _renderDynCal();
  } else {
    // второй клик — фиксируем диапазон
    let a = _dynSelFrom, b = iso;
    if (b < a) { const t2 = a; a = b; b = t2; }
    _dynSelFrom = a; _dynSelTo = b;
    _dynFrom = a; _dynTo = b;
    _renderDynCal();
    loadDynamics();          // применяем фильтр, попап оставляем открытым (диапазон закрашен)
  }
}

function renderDynamics(rows) {
  if (!rows) return;
  const canvas = document.getElementById('dynamics-chart');
  if (!canvas) return;
  const isDark = document.documentElement.dataset.theme !== 'light';
  const lineColor  = isDark ? '#5b8af8' : '#1a73e8';
  const fillColor  = isDark ? 'rgba(91,138,248,0.15)' : 'rgba(26,115,232,0.10)';
  const gridColor  = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)';
  const tickColor  = isDark ? '#9aa0b4' : '#5f6368';

  const labels = rows.map(r => {
    const [, m, d] = r.period.split('-');
    return `${d}.${m}`;
  });
  const values = rows.map(r => {
    if (_dynMetric === 'count') return r.people;
    if (_dynMetric === 'deliv') return r.total_deliv;
    return r.total_dec;
  });

  const dynDatalabels = {
    id: 'dynDatalabels',
    afterDatasetsDraw(chart) {
      if (rows.length > 30) return;
      const { ctx } = chart;
      const meta = chart.getDatasetMeta(0);
      ctx.save();
      ctx.font = 'bold 10px sans-serif';
      ctx.fillStyle = isDark ? '#9aa0b4' : '#5f6368';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      meta.data.forEach((point, i) => {
        const val = values[i];
        if (val == null) return;
        const label = _dynMetric === 'count' ? formatInt(val) : fmtCompact(val);
        ctx.fillText(label, point.x, point.y - 5);
      });
      ctx.restore();
    }
  };

  if (_dynChart) { _dynChart.destroy(); _dynChart = null; }
  _dynChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    plugins: [dynDatalabels],
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: lineColor,
        backgroundColor: fillColor,
        borderWidth: 2,
        pointRadius: rows.length > 90 ? 0 : 3,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.35,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => _dynMetric === 'count'
              ? formatInt(ctx.parsed.y) + ' чел.'
              : formatNum(ctx.parsed.y) + ' ₸',
          },
        },
      },
      scales: {
        x: {
          ticks: { color: tickColor, maxTicksLimit: 12, maxRotation: 40, font: { size: 10 } },
          grid: { color: gridColor },
        },
        y: {
          ticks: {
            color: tickColor,
            font: { size: 10 },
            callback: v => _dynMetric === 'count' ? formatInt(v) : fmtCompact(v),
          },
          grid: { color: gridColor },
        },
      },
    },
  });
}

function _rankingItemClick(id) {
  if (!currentRegion) {
    drillRegion(id);
  } else {
    selectRaion(id);
    if (raionsLayer) {
      raionsLayer.eachLayer(layer => {
        const fid = Math.round(layer.feature?.properties?.id_rai);
        if (fid === id) {
          map.fitBounds(layer.getBounds(), { padding: [30, 30] });
          layer.setStyle({ weight: 2, color: '#7090ff', fillOpacity: 0.9 });
          setTimeout(() => { try { raionsLayer.resetStyle(layer); } catch (_) {} }, 800);
        }
      });
    }
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
  loadRankingPanel();
  loadDynamics();
  loadPayTypes();

  const activeAntab = document.querySelector('.antab-btn.active');
  if (activeAntab) loadAnomalyTab(activeAntab.dataset.antab);

  // Активную вкладку центрального блока перерисовывает refreshKPI() в конце —
  // второй вызов здесь «съедал» одноразовый флаг _pieSelfSelect, и пирог
  // перестраивался, закрывая только что открытую панель детали.
  _refreshOpenGeoPanels();
}

// Перерисовывает открытые контекстные панели (боковую гео и попап страны)
// с учётом текущих демографических фильтров.
function _refreshOpenGeoPanels() {
  const layout = document.querySelector('.main-layout');
  if (layout?.classList.contains('map-drill-active') && _gsGeoId != null) {
    showGeoSidePanel(_gsGeoId, _gsGeoName, _gsGeoIsRaion);
  }
  const gp = document.getElementById('geo-panel');
  if (gp?.classList.contains('visible') && gp.classList.contains('country-mode')) {
    _countryCache = null;              // сбрасываем кэш — данные зависят от фильтра
    showCountryPanel(null, true);
  } else {
    _countryCache = null;              // при следующем открытии подтянутся с фильтром
  }
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
      const isActive = currentAgeSet.includes(m.key);
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
const _geoPanelCache = {};
const _geoKpiCache = {};
let _geoPanelActiveId = null;
let gpSduChart = null;

// ── Состояние сортировки таблиц видов помощи (по каждому префиксу отдельно) ──
// pfx: 'mt' — вкладка видов помощи, 'gs' — боковая панель, 'gp' — панель страны/тултип
const _geoSort = {};   // { [pfx]: {col, dir} }
const _geoData = {};   // { [pfx]: {provided, stats, kpi, emptyMsg} } — кэш для пересортировки
const _raSort  = { col: null, dir: 1 };   // Аналитика по регионам

let _gsPayFilter = null; _gsGeoId = null; _gsGeoIsRaion = false; _gsGeoName = null; // фильтр в левой боковой панели
let _raGeoFilter = null; // raion_id выбранной строки в "Аналитика по регионам"
let _lastRaRows = [], _lastRaIsRaion = false;
// «Итого» кешируем отдельно, чтобы всегда вставлять первой
let _lastRaTotal = '';

// Применить/инвертировать сортировку и перерисовать только строки (не «Итого»)
function _tableGroupHdr() {
  return `<div class="gp-grp-row">` +
    `<span></span>` +
    `<span class="gp-grp-span">Принятые заявления</span>` +
    `<span class="gp-grp-span">Фактическая выплата</span>` +
    `<span class="gp-grp-span gp-grp-1">Утвержденный бюджет</span>` +
    `</div>`;
}

// Сортировка таблицы видов помощи по любому префиксу (mt / gs / gp)
function sortGeoTable(pfx, col) {
  const st = _geoSort[pfx] || (_geoSort[pfx] = { col: null, dir: 1 });
  if (st.col === col) st.dir *= -1; else { st.col = col; st.dir = 1; }
  const listEl = document.getElementById(`${pfx}-sort-list`);
  const d = _geoData[pfx];
  if (!listEl || !d) return;
  listEl.innerHTML = _tableGroupHdr() +
    `<div class="gp-hdr-row" id="${pfx}-sort-hdr">${_geoSortHdrInner(pfx)}</div>` +
    _buildGeoTotalRow(d.stats, d.kpi, d.totalLabel, true) +
    _buildGeoPanelHtml(d.provided, d.stats, pfx, d.emptyMsg);
}
function sortRaTable(col) {
  if (_raSort.col === col) _raSort.dir *= -1; else { _raSort.col = col; _raSort.dir = 1; }
  const listEl = document.getElementById('ra-sort-list');
  if (!listEl) return;
  const sorted = [..._lastRaRows].sort(_makeRaComparator());
  listEl.innerHTML = _tableGroupHdr() +
    `<div class="gp-hdr-row" id="ra-sort-hdr">${_raSortHdrInner()}</div>` +
    _lastRaTotal +
    (sorted.map((r, i) => _buildRegionRow(r, !_lastRaIsRaion, _lastRaIsRaion, i + 1)).join('') ||
     '<div class="gp-empty" style="padding:8px 4px">Нет данных</div>');
}

function _geoSortHdrInner(pfx) {
  const q = c => `sortGeoTable('${pfx}','${c}')`;
  const numHdr = `<span class="gp-rownum gp-rownum-hdr">№</span>`;
  return `<span class="gp-pay gp-hdr gp-sortable" onclick="${q('name')}">${numHdr}Вид помощи</span>
        <span class="gp-stat gp-hdr gp-sortable" onclick="${q('count')}">Кол-во</span>
        <span class="gp-stat gp-hdr gp-sortable" onclick="${q('total_dec')}">Сумма</span>
        <span class="gp-stat gp-hdr gp-sortable" onclick="${q('fact_recipients')}">Кол-во</span>
        <span class="gp-stat gp-hdr gp-sortable" onclick="${q('total_deliv')}">Сумма</span>
        <span class="gp-stat gp-hdr gp-sortable" onclick="${q('budget')}">Сумма</span>`;
}

function _raSortHdrInner() {
  const col = _lastRaIsRaion ? 'Район' : 'Регион';
  return `<span class="gp-pay gp-hdr gp-sortable" onclick="sortRaTable('name')"><span class="gp-rownum gp-rownum-hdr">№</span>${col}</span>
        <span class="gp-stat gp-hdr gp-sortable" onclick="sortRaTable('count')">Кол-во</span>
        <span class="gp-stat gp-hdr gp-sortable" onclick="sortRaTable('total_dec')">Сумма</span>
        <span class="gp-stat gp-hdr gp-sortable" onclick="sortRaTable('fact_recipients')">Кол-во</span>
        <span class="gp-stat gp-hdr gp-sortable" onclick="sortRaTable('total_deliv')">Сумма</span>
        <span class="gp-stat gp-hdr gp-sortable" onclick="sortRaTable('budget')">Сумма</span>`;
}

function _makeRaComparator() {
  const col = _raSort.col, dir = _raSort.dir;
  if (!col) return () => 0;
  return (a, b) => {
    const av = col === 'name' ? (a.name || '') : (a[col] || 0);
    const bv = col === 'name' ? (b.name || '') : (b[col] || 0);
    return col === 'name' ? dir * av.localeCompare(bv, 'ru') : dir * (av - bv);
  };
}

function _buildGeoPanelHtml(provided, stats, pfx = 'gp', emptyMsg = 'Нет данных') {
  if (!provided.length) return `<div class="gp-empty">${emptyMsg}</div>`;
  let rows = provided.map(({ c }) => {
    const s = stats && stats[c.id];
    return { c, s,
      count:           s ? (s.count || 0) : 0,
      recipients:      s ? (s.recipients || 0) : 0,
      fact_recipients: s ? (s.fact_recipients || 0) : 0,
      total_dec:       s ? (s.total_dec || 0) : 0,
      total_deliv:     s ? (s.total_deliv || 0) : 0,
      budget:          s ? (s.budget || 0) : 0,   // пока нет данных по видам помощи → 0 (столбец «—»)
    };
  });
  // Сортировка строк по выбранной колонке (независимо для каждого префикса)
  const st = _geoSort[pfx] || {};
  const col = st.col, dir = st.dir || 1;
  if (col) {
    rows.sort((a, b) => col === 'name'
      ? dir * stripHelpPrefix(a.c.name).localeCompare(stripHelpPrefix(b.c.name), 'ru')
      : dir * ((a[col] || 0) - (b[col] || 0)));
  }
  return rows.map(({ c, count, fact_recipients, total_dec, total_deliv, budget }, idx) => {
    const cnt   = formatInt(count);
    const fact  = formatInt(fact_recipients);
    const dec   = total_dec > 0 ? formatNum(total_dec) : '0';
    const deliv = total_deliv > 0 ? formatNum(total_deliv) : '0';
    const budgetTxt = budget > 0 ? formatNum(budget) + ' ₸' : '—';
    const isActive = (pfx === 'mt' && currentPayType === c.id) || (pfx === 'gs' && _gsPayFilter === c.id);
    const onclick  = pfx === 'mt' ? ` onclick="filterMtByPayType(${c.id}, this)"`
                   : pfx === 'gs' ? ` onclick="filterGsByPayType(${c.id}, this)"` : '';
    const numHtml = `<span class="gp-rownum">${idx + 1}</span>`;
    return `<div class="gp-row gp-yes${isActive ? ' gp-active' : ''}"${onclick}>
      <span class="gp-pay" title="${stripHelpPrefix(c.name)}">${numHtml}${stripHelpPrefix(c.name)}</span>
      <span class="gp-stat">${cnt}</span>
      <span class="gp-stat">${dec} ₸</span>
      <span class="gp-stat">${fact}</span>
      <span class="gp-stat">${deliv} ₸</span>
      <span class="gp-stat gp-budget">${budgetTxt}</span>
    </div>`;
  }).join('');
}

// Галочка «Без тултипа» — отключает всплывающую сводку при наведении на карту
let tooltipDisabled = false;
function setTooltipDisabled(off) {
  tooltipDisabled = !!off;
  if (tooltipDisabled) hideGeoPanelNow();
}

async function showGeoPanel(id, name, ev) {
  if (tooltipDisabled) return;
  const rid = Math.round(id);
  _geoPanelActiveId = rid;
  const row = presenceById[rid];
  const panel = document.getElementById('geo-panel');
  if (!panel) return;

  const provided = (row && presenceColumns.length && row.pay_cat_lists)
    ? presenceColumns.map((c, i) => ({ c, cnt: (row.pay_cat_lists[i] || []).length })).filter(e => e.cnt > 0)
    : [];

  const geoName = _toTitleCase((row && row.name) || name || '') || '—';
  const _emptyMsgHover = _npaEmptyMsg(currentRegion !== null ? currentRegion : rid);

  const renderPanel = (stats, kpi) => {
    panel.innerHTML = _buildGeoMainHtml(geoName, provided, stats, kpi, 'gp', _emptyMsgHover, geoName);
    panel.classList.remove('country-mode');
    panel.classList.add('visible');
    positionGeoPanel(ev);
    if (kpi) renderGeoPanelCharts(kpi);
  };

  renderPanel(_geoPanelCache[rid] || null, _geoKpiCache[rid] || null);

  if (!_geoPanelCache[rid]) {
    try {
      const param = currentRegion ? `raion_id=${rid}` : `region_id=${rid}`;
      const stats = await fetch(`/api/geo-stats?${param}`).then(r => r.json());
      _geoPanelCache[rid] = stats;
    } catch { _geoPanelCache[rid] = {}; }
    if (_geoPanelActiveId === rid && panel.classList.contains('visible')) {
      renderPanel(_geoPanelCache[rid], _geoKpiCache[rid] || null);
    }
  }

  if (!_geoKpiCache[rid]) {
    try {
      const param = currentRegion ? `raion_id=${rid}` : `region_id=${rid}`;
      _geoKpiCache[rid] = await fetch(`/api/kpi?${param}`).then(r => r.json());
    } catch { _geoKpiCache[rid] = {}; }
    if (_geoPanelActiveId === rid && panel.classList.contains('visible')) {
      renderPanel(_geoPanelCache[rid] || null, _geoKpiCache[rid]);
    }
  } else if (_geoPanelActiveId === rid && panel.classList.contains('visible')) {
    renderPanel(_geoPanelCache[rid] || null, _geoKpiCache[rid]);
  }
}

// Строка «Итого»: услугополучатели (уник.), сумма заявок, факт выплачено, бюджет
function _buildGeoTotalRow(stats, kpi, label = 'Республика Казахстан', numbered = false) {
  const k = kpi || {};
  const recip = k.app_count != null ? formatInt(k.app_count) : '—';   // число заявлений (совпадает с KPI)
  const fact = k.fact_recipients != null ? formatInt(k.fact_recipients) : '—';
  const dec = k.total_dec_pay_sum != null ? formatCompact(k.total_dec_pay_sum) + ' ₸' : '—';
  const deliv = k.total_deliv_sum != null ? formatCompact(k.total_deliv_sum) + ' ₸' : '—';
  const budget = stats && stats._budget > 0 ? formatCompact(stats._budget) + ' ₸' : '—';
  const numHtml = numbered ? `<span class="gp-rownum"></span>` : '';
  return `<div class="gp-row gp-budget-summary gp-total-kz">
      <span class="gp-pay">${numHtml}${label}</span>
      <span class="gp-stat">${recip}</span>
      <span class="gp-stat">${dec}</span>
      <span class="gp-stat">${fact}</span>
      <span class="gp-stat">${deliv}</span>
      <span class="gp-stat gp-budget">${budget}</span>
    </div>`;
}

// Спидометр: факт выплачено относительно суммы заявок (полукруг + процент + числа)
function _buildGauge(deliv, dec) {
  const pct = dec > 0 ? (deliv / dec * 100) : 0;
  const frac = Math.max(0, Math.min(1, pct / 100));
  const a = (180 - frac * 180) * Math.PI / 180;      // конечный угол дуги
  const xe = (100 + 80 * Math.cos(a)).toFixed(2);
  const ye = (100 - 80 * Math.sin(a)).toFixed(2);
  const color = frac >= 0.66 ? '#2ecc71' : frac >= 0.33 ? '#f7dc6f' : '#e67e22';
  const pctTxt = (dec > 0 ? pct.toFixed(1).replace('.', ',') : '0') + '%';
  return `<div class="gp-gauge">
      <div class="gp-gauge-title">Факт выплаты / к сумме принятых заявлении</div>
      <svg viewBox="0 0 200 120" class="gp-gauge-svg">
        <path d="M20,100 A80,80 0 0 1 180,100" fill="none" stroke="rgba(150,160,190,0.25)" stroke-width="15" stroke-linecap="round"/>
        <path d="M20,100 A80,80 0 0 1 ${xe},${ye}" fill="none" stroke="${color}" stroke-width="15" stroke-linecap="round"/>
        <text x="100" y="88" text-anchor="middle" class="gp-gauge-pct">${pctTxt}</text>
      </svg>
      <div class="gp-gauge-nums">
        <div><span class="gp-gauge-lbl">Факт выплачено</span><b>${formatCompact(deliv)} ₸</b></div>
        <div><span class="gp-gauge-lbl">Сумма принятых заявлений</span><b>${formatCompact(dec)} ₸</b></div>
      </div>
    </div>`;
}

// Общая разметка тултипа: тело (таблица + графики) + спидометр справа.
// pfx — префикс id для канвасов (чтобы плавающий тултип и вкладка «Сводка» не конфликтовали).
function _buildGeoMainHtml(titleHtml, provided, stats, kpi, pfx = 'gp', emptyMsg = 'Нет данных', totalLabel = 'Республика Казахстан') {
  const k = kpi || {};
  _geoData[pfx] = { provided, stats, kpi, emptyMsg, totalLabel };   // кэш для пересортировки по клику
  let hdr = '';
  if (provided.length) {
    hdr = `<div class="gp-hdr-row" id="${pfx}-sort-hdr">${_geoSortHdrInner(pfx)}</div>`;
  }
  const totalHtml = _buildGeoTotalRow(stats, kpi, totalLabel, true);
  const gaChartBox = `<div class="gp-chart-box">
            <div class="gp-chart-title gp-chart-title-row"><span>Пол / Возраст</span>${_clearFiltersBtn()}</div>
            <div id="${pfx}-ga-chart" class="ga-chart gp-ga"></div>
          </div>`;
  const gaugeHtml = _buildGauge(k.total_deliv_sum || 0, k.total_dec_pay_sum || 0);
  const isGeoSide = pfx === 'gs';
  return `<div class="gp-main">
      <div class="gp-body">
        <div class="gp-title">${titleHtml}</div>
        <div class="gp-list" id="${pfx}-sort-list">${hdr ? _tableGroupHdr() : ''}${hdr}${totalHtml}${_buildGeoPanelHtml(provided, stats, pfx, emptyMsg)}</div>
        <div class="gp-charts">
          <div class="gp-chart-box">
            <div class="gp-chart-title">Уровень благосостояния по ЦКС</div>
            <div class="gp-sdu-wrap"><canvas id="${pfx}-sdu-chart"></canvas></div>
          </div>
          ${isGeoSide ? gaugeHtml : gaChartBox}
        </div>
      </div>
      ${isGeoSide ? gaChartBox : gaugeHtml}
    </div>`;
}

function filterMtByPayType(payTypeId, rowEl) {
  // Повторный клик — снять фильтр. Это ГЛОБАЛЬНЫЙ фильтр по виду помощи:
  // применяется ко всем вкладкам (регионы, динамика, 3D, данные) через buildFilterParams.
  currentPayType = currentPayType === payTypeId ? null : payTypeId;
  _refreshAfterFilterChange();
}

// Клик по куску 3D-пирога = тот же глобальный фильтр по виду помощи.
// Пирог не перестраиваем (иначе закроется деталь и пропадёт выбор) — только
// перекрашиваем подсветку. Возвращаем новое значение фильтра в pie3d.js.
let _pieSelfSelect = false;
window.onPie3DSelectPayType = function (payTypeId) {
  currentPayType = currentPayType === payTypeId ? null : payTypeId;
  window.setPie3DSelected?.(currentPayType);   // мгновенная подсветка
  _pieSelfSelect = true;
  _refreshAfterFilterChange();
  return currentPayType;
};

function _replaceGauge(selector, kpi) {
  const el = document.querySelector(selector + ' .gp-gauge');
  if (!el) return;
  const div = document.createElement('div');
  div.innerHTML = _buildGauge(kpi.total_deliv_sum || 0, kpi.total_dec_pay_sum || 0);
  el.replaceWith(div.firstElementChild);
}

async function filterGsByPayType(payTypeId, rowEl) {
  _gsPayFilter = _gsPayFilter === payTypeId ? null : payTypeId;
  const row = rowEl?.closest?.('.gp-row') || rowEl;
  document.querySelectorAll('#kpi-geo-side .gp-row').forEach(r => r.classList.remove('gp-active'));
  if (_gsPayFilter !== null && row) row.classList.add('gp-active');
  const p = new URLSearchParams();
  if (_gsGeoIsRaion) p.set('raion_id', _gsGeoId);
  else               p.set('region_id', _gsGeoId);
  if (_gsPayFilter !== null) p.set('pay_type_id', _gsPayFilter);
  _applyDemoFilters(p);
  try {
    const kpi = await fetch(`/api/kpi?${p}`).then(r => r.json());
    const cv = document.getElementById('gs-sdu-chart');
    if (cv && window.Chart) { try { Chart.getChart(cv)?.destroy(); } catch(_) {} }
    delete _gpSduCharts['gs'];
    renderGpSduChart(kpi.sdu_gender || {}, 'gs');
    renderGpGenderAge(kpi.male_count || 0, kpi.female_count || 0, kpi.age || {}, 'gs', kpi.age_gender || {});
    _replaceGauge('#kpi-geo-side', kpi);
  } catch(e) { console.error('filterGsByPayType', e); }
}

const _gpSduCharts = {};
function renderGeoPanelCharts(kpi, pfx = 'gp') {
  renderGpSduChart(kpi.sdu_gender || {}, pfx);
  renderGpGenderAge(kpi.male_count || 0, kpi.female_count || 0, kpi.age || {}, pfx, kpi.age_gender || {});
}

const _lastSduByPfx = {};   // кэш данных СДУ по каждому графику — для перерисовки при смене темы
function refreshGpSduChartsTheme() {
  Object.keys(_lastSduByPfx).forEach(pfx => {
    if (document.getElementById(`${pfx}-sdu-chart`)) renderGpSduChart(_lastSduByPfx[pfx], pfx);
  });
}

// ЦКС (уровень благосостояния) — стек-бар с разбивкой по полу (муж/жен).
// sduG: { A:{m,f}, B:{m,f}, ... }
function renderGpSduChart(sduG, pfx = 'gp') {
  const cv = document.getElementById(`${pfx}-sdu-chart`);
  if (!cv || !window.Chart) return;
  _lastSduByPfx[pfx] = sduG;
  const keys = ['A', 'B', 'C', 'D', 'E'];
  const males   = keys.map(k => (sduG[k]?.m) || 0);
  const females = keys.map(k => (sduG[k]?.f) || 0);
  const totals  = keys.map((_, i) => males[i] + females[i]);
  const grand = totals.reduce((a, b) => a + b, 0);
  const pcts = totals.map(v => grand ? Math.round(v / grand * 100) : 0);
  const isLight = document.documentElement.dataset.theme === 'light';
  const tickColor = isLight ? '#202124' : '#ffffff';
  const axisColor = isLight ? '#5f6368' : '#aaaaaa';
  const gridColor = isLight ? 'rgba(60,64,67,0.10)' : 'rgba(255,255,255,0.07)';
  const pctLabels = {
    id: 'gpSduPct',
    afterDatasetsDraw(chart) {
      const meta = chart.getDatasetMeta(1);   // верхний сегмент (женщины) = верх стека
      if (!meta) return;
      const { ctx } = chart;
      ctx.save();
      ctx.font = "700 10px 'Roboto', sans-serif";
      ctx.fillStyle = tickColor; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      meta.data.forEach((bar, i) => { if (totals[i] > 0) ctx.fillText(pcts[i] + '%', bar.x, bar.y - 3); });
      ctx.restore();
    },
  };
  // подсветка мультивыбора: невыбранные приглушаем, выбранные обводим
  const sel = currentSduSet;
  const dimM = keys.map(k => (sel.length && !sel.includes(k)) ? '#5b8af855' : '#5b8af8');
  const dimF = keys.map(k => (sel.length && !sel.includes(k)) ? '#f875c355' : '#f875c3');
  const selBorder = keys.map(k => sel.includes(k) ? (isLight ? '#202124' : '#fff') : 'transparent');
  if (_gpSduCharts[pfx]) _gpSduCharts[pfx].destroy();
  _gpSduCharts[pfx] = new Chart(cv.getContext('2d'), {
    type: 'bar',
    data: {
      labels: keys,
      datasets: [
        { label: 'Мужчины', data: males,   backgroundColor: dimM, stack: 's', borderColor: selBorder, borderWidth: 2, borderSkipped: false, borderRadius: { topLeft: 0, topRight: 0 } },
        { label: 'Женщины', data: females, backgroundColor: dimF, stack: 's', borderColor: selBorder, borderWidth: 2, borderSkipped: false, borderRadius: 3 },
      ],
    },
    plugins: [pctLabels],
    options: {
      responsive: true, maintainAspectRatio: false, layout: { padding: { top: 16 } },
      interaction: { mode: 'index', intersect: false },
      onClick(e, elements) {
        if (elements.length) toggleSduFilter(keys[elements[0].index]);
      },
      onHover(_e, elements, chart) {
        chart.canvas.style.cursor = elements.length ? 'pointer' : 'default';
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => {
              const i = items[0].dataIndex;
              return [t(SDU_META[keys[i]]?.label || keys[i]), `${t('Всего')}: ${formatInt(totals[i])}`];
            },
            label: c => {
              const i = c.dataIndex, tot = totals[i] || 0, val = c.parsed.y;
              const pct = tot ? Math.round(val / tot * 100) : 0;
              const who = c.datasetIndex === 0 ? t('Мужчины') : t('Женщины');
              return ` ${who}: ${formatInt(val)} (${pct}%)`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: tickColor, font: { weight: '700' } } },
        y: { stacked: true, grid: { color: gridColor }, ticks: { color: axisColor, callback: v => fmtCompact(v) || String(v) } },
      },
    },
  });
}

function renderGpGenderAge(male, female, age, pfx = 'gp', ageG = {}) {
  const el = document.getElementById(`${pfx}-ga-chart`);
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
      const gm = ageG[m.key]?.m || 0, gf = ageG[m.key]?.f || 0;
      const gTot = gm + gf;
      const mPct = gTot ? Math.round(gm / gTot * 100) : 0;
      const fPct = gTot ? 100 - mPct : 0;
      const mW = gTot ? (gm / gTot * 100) : 0;
      const fW = gTot ? (gf / gTot * 100) : 0;
      const isActive = currentAgeSet.includes(m.key);
      const tip = `${t(m.label)}: ${formatInt(cnt)}  •  ${t('Мужчины')}: ${formatInt(gm)} (${mPct}%)  •  ${t('Женщины')}: ${formatInt(gf)} (${fPct}%)`;
      return `<div class="ga-age-row ga-clickable${isActive ? ' ga-filter-active' : ''}" onclick="setAgeFilter('${m.key}')" title="${tip}">
        <span class="ga-age-lbl">${m.label}</span>
        <div class="ga-age-bar-wrap"><div class="ga-age-split" style="width:${pct}%">
          <div class="ga-seg-m" style="width:${mW}%"></div><div class="ga-seg-f" style="width:${fW}%"></div>
        </div></div>
        <span class="ga-age-pct">${pct}%</span>
      </div>`;
    }).join('')}`;
}

// ───────── Вкладки центрального блока (Карта / Сводка / Динамика / 3D-пирог / Данные) ─────────
function setupMapTabs() {
  const move = (srcId, dstId) => {
    const src = document.getElementById(srcId), dst = document.getElementById(dstId);
    if (src && dst) while (src.firstChild) dst.appendChild(src.firstChild);
  };
  move('tab-dynamics', 'mtab-dynamics');   // перенос динамики
  move('tab-presence', 'mtab-presence');   // перенос матрицы видов помощи
  move('antab-data', 'mtab-data');         // перенос таблицы «Данные»
  const pie = document.getElementById('pie3d-wrap');
  const pieDst = document.getElementById('mtab-pie');
  if (pie && pieDst) pieDst.appendChild(pie);
}

function switchMapTab(name) {
  if (name !== 'map') hideGeoSidePanel();
  document.querySelectorAll('.map-tabs .mtab-btn').forEach(b => b.classList.toggle('active', b.dataset.mtab === name));
  document.querySelectorAll('.map-tabs .mtab-pane').forEach(p => p.classList.toggle('active', p.id === 'mtab-' + name));
  if (name === 'map') {
    if (_mapView === '3d') renderMap3DTab();
    if (typeof map !== 'undefined' && map) setTimeout(() => {
      map.invalidateSize();
      if (_mapNeedsFit && raionsLayer) {
        try { map.fitBounds(raionsLayer.getBounds(), { padding: [20, 20] }); } catch (_) {}
      }
      _mapNeedsFit = false;
    }, 60);
    if (currentRaion) {
      const raionName = raionStats[currentRaion]?.name || `Район ${currentRaion}`;
      showGeoSidePanel(currentRaion, raionName, true);
    } else if (currentRegion) {
      const regionName = _regionName(currentRegion);
      showGeoSidePanel(currentRegion, regionName, false);
    }
  }
  else if (name === 'summary') renderMapSummary();
  else if (name === 'regions') renderRegionAnalytics();
  else if (name === 'dynamics') loadDynamics();
  else if (name === 'pie') window.renderPie3D?.(currentRegion, currentRaion, currentPayType);
  else if (name === 'presence') { if (presenceRows && presenceRows.length) renderHelpPresence(); else loadHelpPresence(); }
  else if (name === 'data') ensureDataTable();
}

// Перерисовать активную вкладку блока карты при смене региона/района
function refreshActiveMapTab() {
  const selfSel = _pieSelfSelect; _pieSelfSelect = false;   // одноразовый флаг
  const active = document.querySelector('.map-tabs .mtab-btn.active');
  if (!active) return;
  switch (active.dataset.mtab) {
    case 'map': if (_mapView === '3d') renderMap3DTab(); break;
    case 'summary': renderMapSummary(); break;
    case 'regions': renderRegionAnalytics(); break;
    case 'dynamics': loadDynamics(); break;
    // клик пришёл из самого пирога → только подсветка, без перестройки
    case 'pie': if (selfSel) window.setPie3DSelected?.(currentPayType);
                else window.renderPie3D?.(currentRegion, currentRaion, currentPayType);
                break;
    case 'presence': loadHelpPresence(); break;
    case 'data': ensureDataTable(); break;
  }
}

// ── Переключатель 2D / 3D карты ──
let _mapView = '2d';
let _map3dMetric = 'dec';   // 'dec' — принятые заявления (сумма заявок), 'deliv' — фактическая выплата

function setMap3DMetric(m) {
  if (m === _map3dMetric) return;
  _map3dMetric = m;
  document.querySelectorAll('.map3d-controls .mcm-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.m3d === m));
  renderMap3DTab();
}
function switchMapView(view) {
  if (view === _mapView) return;
  _mapView = view;
  document.querySelectorAll('.map-view-seg .mv-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mview === view));
  document.getElementById('map-view-2d')?.classList.toggle('active', view === '2d');
  document.getElementById('map-view-3d')?.classList.toggle('active', view === '3d');
  if (view === '2d') {
    // Пока 2D-подвид был скрыт, у #map был нулевой размер — любой fitBounds по нему
    // (в т.ч. при 3D-drill) даёт кривой зум. Пересчитываем размер и заново подгоняем
    // карту под текущий уровень (область → её границы, страна → общий вид).
    if (typeof map !== 'undefined' && map) setTimeout(() => {
      map.invalidateSize();
      if (currentRegion != null && raionsLayer) {
        try { map.fitBounds(raionsLayer.getBounds(), { padding: [20, 20] }); } catch (_) {}
      } else {
        map.setView(KZ_VIEW.center, _kzZoom());
      }
      _mapNeedsFit = false;
    }, 60);
  } else {
    renderMap3DTab();
  }
}

// Данные для 3D-карты: полигоны текущего уровня + столбцы (высота = сумма заявок)
async function renderMap3DTab() {
  if (!window.renderMap3D) return;
  const isRaion = currentRegion != null;
  const wholeCity = isRaion && REGIONS_NO_RAION.has(+currentRegion);
  let polygons, centroids, url, idKey;
  if (wholeCity) {
    // Астана/Шымкент: рисуем регион целиком одним столбцом, без районов
    polygons = {
      ...regionGeoJSON,
      features: (regionGeoJSON?.features || []).filter(f => f.properties.id_reg == currentRegion),
    };
    centroids = regionCentroids;
    url = `/api/ranking?region_id=${currentRegion}`;
    idKey = 'id_reg';
  } else if (isRaion) {
    polygons = {
      ...raionGeoJSON,
      features: (raionGeoJSON?.features || []).filter(f => f.properties.id_reg == currentRegion),
    };
    centroids = raionCentroids;
    url = `/api/ranking?region_id=${currentRegion}`;
    idKey = 'id_rai';
  } else {
    polygons = regionGeoJSON;
    centroids = regionCentroids;
    url = '/api/ranking';
    idKey = 'id_reg';
  }
  if (currentPayType) url += (url.includes('?') ? '&' : '?') + `pay_type_id=${currentPayType}`;
  if (!polygons || !polygons.features) return;
  let rows = [];
  try { rows = await fetch(url).then(r => r.json()); }
  catch (e) { console.error('map3d ranking', e); }
  const rankMap = {};
  if (wholeCity) {
    // строки приходят по «районам» (обычно одна) — сводим в единицу региона
    const agg = { name: '', total_dec: 0, total_deliv: 0, count: 0 };
    rows.forEach(r => {
      agg.total_dec += r.total_dec || 0;
      agg.total_deliv += r.total_deliv || 0;
      agg.count += r.count || 0;
      agg.name = r.name || agg.name;
    });
    rankMap[Math.round(currentRegion)] = agg;
  } else {
    rows.forEach(r => { rankMap[Math.round(r.id)] = r; });
  }
  // высота столбца: 'dec' — сумма принятых заявлений, 'deliv' — фактически выплачено
  const valKey = _map3dMetric === 'deliv' ? 'total_deliv' : 'total_dec';
  const metricLabel = t(_map3dMetric === 'deliv' ? 'Фактическая выплата' : 'Принятые заявления');
  // строим по всем полигонам уровня: где нет заявок/сумма 0 — value=0 (модуль нарисует крестик)
  const units = {};
  polygons.features.forEach(f => {
    const id = Math.round(f.properties[idKey]);
    const c = centroids[id];
    if (!c || units[id]) return;
    const r = rankMap[id];
    units[id] = {
      id,
      // t() здесь обязателен: подписи 3D-карты рисуются на canvas и в тултип,
      // авто-перевод DOM их не достанет
      name: t(_toTitleCase(r?.name || f.properties.raion || f.properties.region || '')),
      centroid: c,
      value: r?.[valKey] || 0,
      count: r?.count || 0,
    };
  });
  // кнопка «назад» видна только когда мы внутри региона
  const backBtn = document.getElementById('map3d-back');
  if (backBtn) backBtn.style.display = isRaion ? '' : 'none';
  // легенда: текст про столбец зависит от выбранной метрики
  const legEl = document.getElementById('map3d-legend-metric');
  // textContent не создаёт узлов → авто-перевод не сработает, переводим фразу целиком
  if (legEl) legEl.textContent = t(_map3dMetric === 'deliv'
    ? 'Высота столбца = сумма фактической выплаты'
    : 'Высота столбца = сумма принятых заявлений');
  window.renderMap3D({
    polygons,
    units,
    idKey,
    metricLabel,
    level: isRaion ? 'raion' : 'region',
    onDrill: isRaion ? null : enterRegion3D,   // проваливаемся только с уровня регионов
  });
}

// Вход внутрь региона с 3D-карты: переиспользуем 2D-drill, затем перерисовываем 3D районами
async function enterRegion3D(regionId) {
  await drillRegion(regionId);
  renderMap3DTab();
}

// Назад из региона на 3D-карте к общему виду регионов
function backFromRegion3D() {
  goBack();
  renderMap3DTab();
}

// Вкладка «Сводка» — тот же контент, что во всплывающем тултипе, по текущему уровню (КЗ/регион/район)
async function renderMapSummary() {
  const body = document.getElementById('mtab-summary-body');
  if (!body) return;
  body.innerHTML = '<div class="loading" style="padding:30px">Загрузка…</div>';
  const geoQ = currentRaion != null ? `raion_id=${currentRaion}`
             : (currentRegion != null ? `region_id=${currentRegion}` : '');
  // фильтр по виду помощи применяем к цифрам (geo-stats/kpi), но НЕ к матрице (help-presence)
  const payQ = currentPayType ? `pay_type_id=${currentPayType}` : '';
  const demo = _demoQS();
  const presQ = currentRegion != null ? `region_id=${currentRegion}` : '';
  try {
    const [pres, stats, kpi] = await Promise.all([
      fetch(_url('/api/help-presence', presQ, demo)).then(r => r.json()),
      fetch(_url('/api/geo-stats', geoQ, payQ, demo)).then(r => r.json()),
      fetch(_url('/api/kpi', geoQ, payQ, demo)).then(r => r.json()),
    ]);
    const columns = pres.columns || [];
    const row = currentRaion != null
      ? ((pres.rows || []).find(r => r.id === currentRaion) || {})
      : ((pres.rows || []).find(r => r.is_total) || {});
    // Показываем ВСЕ виды помощи (даже с нулями), а не только те, где cnt > 0
    let provided = columns.length
      ? columns.map((c, i) => ({ c, cnt: (row.pay_cat_lists?.[i] || []).length })) : [];
    // выбран вид помощи → показываем только его, остальные строки скрываем
    if (currentPayType) provided = provided.filter(e => e.c.id === currentPayType);
    let title = 'Республика Казахстан';
    if (currentRaion != null) title = _toTitleCase((raionStats[currentRaion]?.name) || row.name || 'Район');
    else if (currentRegion != null) title = _toTitleCase((regionStats[currentRegion]?.name) || row.name || 'Регион');
    _geoSort['mt'] = { col: null, dir: 1 };   // сброс сортировки при смене уровня
    body.innerHTML = _buildGeoMainHtml(title, provided, stats, kpi, 'mt', _npaEmptyMsg(currentRegion), title);
    renderGeoPanelCharts(kpi, 'mt');
  } catch (e) {
    console.error('map summary', e);
    body.innerHTML = '<div class="loading" style="padding:30px">Ошибка загрузки</div>';
  }
}

// Вкладка «Аналитика по регионам» — те же метрики, но по регионам/районам.
// Синхронизирована с картой: уровень определяется глобальным currentRegion.
// Клик по региону drill'ит карту, кнопка «Все регионы» — возврат к стране.

function _buildRegionRow(r, clickable, isRaionRow, num) {
  const cnt    = formatInt(r.count || 0);
  const fact   = formatInt(r.fact_recipients || 0);
  const dec    = r.total_dec > 0 ? formatCompact(r.total_dec) + ' ₸' : '0';
  const deliv  = r.total_deliv > 0 ? formatCompact(r.total_deliv) + ' ₸' : '0';
  const budget = r.budget > 0 ? formatCompact(r.budget) + ' ₸' : '—';
  const isActive = isRaionRow && _raGeoFilter === r.id;
  const cls = (clickable || isRaionRow) ? `gp-row gp-yes${isActive ? ' gp-active' : ''}` : 'gp-row';
  const onclick = clickable  ? ` onclick="drillRegion(${r.id})"`
               : isRaionRow ? ` onclick="filterRaByRaion(${r.id}, this)"` : '';
  const numHtml = num != null ? `<span class="gp-rownum">${num}</span>` : '';
  return `<div class="${cls}"${onclick}>
      <span class="gp-pay">${numHtml}${r.name || '—'}</span>
      <span class="gp-stat">${cnt}</span>
      <span class="gp-stat">${dec}</span>
      <span class="gp-stat">${fact}</span>
      <span class="gp-stat">${deliv}</span>
      <span class="gp-stat gp-budget">${budget}</span>
    </div>`;
}

function _buildRegionAnalyticsHtml(titleHtml, rows, stats, kpi, isRaion, totalLabel = 'Республика Казахстан') {
  const k = kpi || {};
  _lastRaIsRaion = isRaion;
  const sorted = _raSort.col ? [...rows].sort(_makeRaComparator()) : rows;
  const hdr = `<div class="gp-hdr-row" id="ra-sort-hdr">${_raSortHdrInner()}</div>`;
  const list = sorted.map((r, i) => _buildRegionRow(r, !isRaion, isRaion, i + 1)).join('') ||
    '<div class="gp-empty" style="padding:8px 4px">Нет данных</div>';
  const totalHtml = _buildGeoTotalRow(stats, kpi, totalLabel, true);
  _lastRaTotal = totalHtml;
  return `<div class="gp-main">
      <div class="gp-body">
        <div class="gp-title">${titleHtml}</div>
        <div class="gp-list" id="ra-sort-list">${_tableGroupHdr()}${hdr}${totalHtml}${list}</div>
        <div class="gp-charts">
          <div class="gp-chart-box">
            <div class="gp-chart-title">Уровень благосостояния по ЦКС</div>
            <div class="gp-sdu-wrap"><canvas id="ra-sdu-chart"></canvas></div>
          </div>
          <div class="gp-chart-box">
            <div class="gp-chart-title gp-chart-title-row"><span>Пол / Возраст</span>${_clearFiltersBtn()}</div>
            <div id="ra-ga-chart" class="ga-chart gp-ga"></div>
          </div>
        </div>
      </div>
      ${_buildGauge(k.total_deliv_sum || 0, k.total_dec_pay_sum || 0)}
    </div>`;
}

async function renderRegionAnalytics() {
  const body = document.getElementById('mtab-regions-body');
  if (!body) return;
  body.innerHTML = '<div class="loading" style="padding:30px">Загрузка…</div>';
  const region = currentRegion;   // уровень синхронизирован с картой
  const geoQ = region != null ? `region_id=${region}` : '';
  const payQ = currentPayType ? `pay_type_id=${currentPayType}` : '';
  const demo = _demoQS();
  try {
    const [rows, stats, kpi] = await Promise.all([
      fetch(_url('/api/ranking-oblasts', geoQ, payQ, demo)).then(r => r.json()),
      fetch(_url('/api/geo-stats', geoQ, payQ, demo)).then(r => r.json()),
      fetch(_url('/api/kpi', geoQ, payQ, demo)).then(r => r.json()),
    ]);
    _lastRaRows = rows;
    _raGeoFilter = null;  // сброс фильтра по району при смене уровня
    _raSort.col = null;   // сброс сортировки при смене уровня
    let title, totalLabel;
    if (region != null) {
      const rname = _toTitleCase((regionStats[region]?.name) || 'Регион');
      title = `<button type="button" class="ra-back" onclick="goBack()">← Все регионы</button> ${rname}`;
      totalLabel = rname;   // итог = по этому региону
    } else {
      title = 'Республика Казахстан · по регионам';
      totalLabel = 'Республика Казахстан';
    }
    body.innerHTML = _buildRegionAnalyticsHtml(title, rows, stats, kpi, region != null, totalLabel);
    renderGeoPanelCharts(kpi, 'ra');
  } catch (e) {
    console.error('region analytics', e);
    body.innerHTML = '<div class="loading" style="padding:30px">Ошибка загрузки</div>';
  }
}

async function filterRaByRaion(raionId, rowEl) {
  _raGeoFilter = _raGeoFilter === raionId ? null : raionId;
  const row = rowEl?.closest?.('.gp-row') || rowEl;
  document.querySelectorAll('#ra-sort-list .gp-row').forEach(r => r.classList.remove('gp-active'));
  if (_raGeoFilter !== null && row) row.classList.add('gp-active');
  const p = new URLSearchParams();
  if (currentRegion != null) p.set('region_id', currentRegion);
  if (_raGeoFilter !== null) p.set('raion_id', _raGeoFilter);
  _applyDemoFilters(p);
  try {
    const kpi = await fetch(`/api/kpi?${p}`).then(r => r.json());
    const cv = document.getElementById('ra-sdu-chart');
    if (cv && window.Chart) { try { Chart.getChart(cv)?.destroy(); } catch(_) {} }
    delete _gpSduCharts['ra'];
    renderGpSduChart(kpi.sdu_gender || {}, 'ra');
    renderGpGenderAge(kpi.male_count || 0, kpi.female_count || 0, kpi.age || {}, 'ra', kpi.age_gender || {});
    _replaceGauge('#mtab-regions-body', kpi);
  } catch(e) { console.error('filterRaByRaion', e); }
}

let _countryCache = null;
async function showCountryPanel(ev, force = false) {
  if (ev) { ev.stopPropagation(); }
  const panel = document.getElementById('geo-panel');
  if (!panel) return;
  // повторный клик по кнопке — закрыть (при force — перерисовка, без закрытия)
  if (!force && panel.classList.contains('visible') && panel.classList.contains('country-mode')) {
    panel.classList.remove('visible', 'country-mode');
    return;
  }
  _geoPanelActiveId = '__country__';

  const draw = (data) => {
    const { pres, stats, kpi } = data;
    const columns = (pres && pres.columns) || [];
    const total = ((pres && pres.rows) || []).find(r => r.is_total) || {};
    const provided = (columns.length && total.pay_cat_lists)
      ? columns.map((c, i) => ({ c, cnt: (total.pay_cat_lists[i] || []).length })).filter(e => e.cnt > 0)
      : [];
    panel.innerHTML = _buildGeoMainHtml(
      'Республика Казахстан <button type="button" class="gp-close" onclick="hideGeoPanelNow()" title="Закрыть">✕</button>',
      provided, stats, kpi);
    panel.classList.add('country-mode', 'visible');
    positionGeoPanel(ev);
    if (kpi) renderGeoPanelCharts(kpi);
  };

  if (_countryCache && !force) { draw(_countryCache); return; }

  draw(_countryCache || { pres: {}, stats: {}, kpi: {} });   // мгновенный каркас/старые данные
  try {
    const demo = _demoQS();
    const [pres, stats, kpi] = await Promise.all([
      fetch(_url('/api/help-presence', demo)).then(r => r.json()),
      fetch(_url('/api/geo-stats', demo)).then(r => r.json()),
      fetch(_url('/api/kpi', demo)).then(r => r.json()),
    ]);
    _countryCache = { pres, stats, kpi };
  } catch { _countryCache = { pres: {}, stats: {}, kpi: {} }; }
  if (_geoPanelActiveId === '__country__' && panel.classList.contains('visible')) draw(_countryCache);
}

function positionGeoPanel(ev) {
  const panel = document.getElementById('geo-panel');
  if (!panel) return;
  if (ev) geoPanelLastEv = { clientX: ev.clientX, clientY: ev.clientY };
  const e = geoPanelLastEv || { clientX: 120, clientY: 120 };
  const x = e.clientX, y = e.clientY;
  const pw = panel.offsetWidth || 740, ph = panel.offsetHeight || 240;
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
       ${miniHdr('summa', 'Сумма заявок', 'prs-mini-sum', 'Сумма заявок (dec_pay_sum)')}
       ${miniHdr('deliv', 'Факт выплачено', 'prs-mini-deliv', 'Фактически выплачено')}
       ${cols}
     </tr>`;

  // total row stays pinned on top; sort only the body rows
  const total = presenceRows.find(r => r.is_total);
  let body = presenceRows.filter(r => !r.is_total);
  if (presenceSortCol) {
    const key = presenceSortCol;
    body = [...body].sort((a, b) => {
      const _mv = (r, k) => k === 'summa' ? (r.mini?.summa_val ?? 0) : k === 'deliv' ? (r.mini?.deliv_val ?? 0) : k === 'budget' ? (r.mini?.budget_val ?? 0) : (r.mini?.[k] ?? 0);
      const av = _mv(a, key), bv = _mv(b, key);
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
      <td class="col-right prs-mini prs-mini-deliv">${m.deliv ?? '0'} ₸</td>
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
      <td class="geo-name">${groupsTotal.name}</td>
      ${groupsTotal.groups.map(g => renderGroupCell(g)).join('')}
    </tr>` : '';

  document.getElementById('groups-body').innerHTML = totalHtml + sorted.map(r => {
    const clickAttr = !currentRegion
      ? `onclick="drillRegionFromRanking(${r.id})" style="cursor:pointer"` : '';
    return `<tr ${clickAttr} class="${!currentRegion ? 'coverage-row' : ''}">
      <td class="geo-name">${r.name || '—'}</td>
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
  setText('coverage-col-name', isRegionView ? `${t('Район')} (${regionName})` : t('Регион'));
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
      if (col === 'kato_regname') {
        delete tableFilters['kato_rainame'];
        const raionSel = document.getElementById('tfilter-kato_rainame');
        if (raionSel) raionSel.value = '';
        _loadDistinctFiltered('kato_rainame', sel.value || null);
      }
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

async function _loadDistinctFiltered(col, regionName) {
  const params = new URLSearchParams({ col });
  if (currentRegion) params.set('region_id', currentRegion);
  else if (regionName) params.set('region_name', regionName);
  const vals = await fetch(`/api/distinct?${params}`).then(r => r.json());
  const sel = document.getElementById(`tfilter-${col}`);
  if (!sel) return;
  sel.innerHTML = '<option value="">Все</option>' +
    vals.map(v => `<option value="${v}">${v}</option>`).join('');
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
  if (currentSduSet.length) params.set('f_sdu_tzhs', currentSduSet.join(','));
  if (currentPayType) params.set('pay_type_id', String(currentPayType));
  Object.entries(tableFilters).forEach(([k, v]) => params.set(`f_${k}`, v));

  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '<tr><td colspan="99" class="loading">Загрузка...</td></tr>';

  const data = await fetch(`/api/table?${params}`).then(r => r.json());

  setText('table-info', `${t('Записей')}: ${data.total} | ${t('Страница')} ${data.page} ${t('из')} ${data.pages}`);

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
  const prev = parseFloat(el.dataset.raw ?? 0);
  el.dataset.raw = end;
  if (Math.abs(prev - end) < 0.01) { el.textContent = formatter(end); return; }
  // 3D flip-in effect
  el.classList.remove('kpi-count-anim');
  void el.offsetWidth;
  el.classList.add('kpi-count-anim');
  const dur = 1600;
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

function formatCompact(n) {
  if (!n && n !== 0) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 1 }).format(n / 1e12) + ' трлн';
  if (abs >= 1e9)  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 1 }).format(n / 1e9)  + ' млрд';
  if (abs >= 1e6)  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 1 }).format(n / 1e6)  + ' млн';
  return formatInt(n);
}

function formatInt(n) {
  return new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(Math.round(n) || 0);
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Pay-type stats table ─────────────────────────────────────────
let _ptData = null;
let _ptSortCol = 'total_deliv';
let _ptSortDir = 'desc';

async function loadPayTypes() {
  const fp = buildFilterParams('full');
  document.getElementById('paytypes-body').innerHTML =
    '<tr><td colspan="5" class="loading">Загрузка...</td></tr>';
  try {
    const r = await fetch(`/api/pay-type-stats?${fp}`, { credentials: 'include' });
    _ptData = r.ok ? await r.json() : [];
  } catch { _ptData = []; }
  renderPayTypes();
}

function renderPayTypes() {
  if (!_ptData) return;
  const sorted = [..._ptData].sort((a, b) => {
    const av = a[_ptSortCol] ?? 0, bv = b[_ptSortCol] ?? 0;
    if (typeof av === 'string') return _ptSortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    return _ptSortDir === 'desc' ? bv - av : av - bv;
  });
  document.querySelectorAll('#paytypes-table .pt-sort').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    const active = th.dataset.ptcol === _ptSortCol;
    icon.textContent = active ? (_ptSortDir === 'desc' ? ' ▼' : ' ▲') : '';
    th.classList.toggle('sort-active', active);
  });
  const tbody = document.getElementById('paytypes-body');
  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="no-data">Нет данных</td></tr>';
    return;
  }
  tbody.innerHTML = sorted.map(r => `<tr>
    <td class="ptab-name">${_shortPayType(r.pay_type)}</td>
    <td class="col-center">${formatInt(r.count)}</td>
    <td class="col-right">${r.total_dec > 0 ? formatNum(r.total_dec) + ' ₸' : '—'}</td>
    <td class="col-right ptab-deliv">${r.total_deliv > 0 ? formatNum(r.total_deliv) + ' ₸' : '—'}</td>
  </tr>`).join('');
}

// ── Anomaly section ──────────────────────────────────────────────

const _anTabCache = {};
// Объединённая таблица "% Выплаты": регионы → районы региона → виды помощи района
let _anUtilRegionId = null;
let _anUtilRegionName = '';
let _anUtilRaionId = null;
let _anUtilRaionName = '';
const _anUtilCache = {};
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

  const labels = districts.map(d => `${(d.raion || '').toUpperCase()} (${(d.region || '').replace(/\s+ОБЛАСТЬ$/i, '').toUpperCase()})`);
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
  const sortKey = tab;
  const s = _anSort[sortKey] || { col: null, dir: 'asc' };
  _anSort[sortKey] = { col, dir: s.col === col && s.dir === 'asc' ? 'desc' : 'asc' };
  document.querySelectorAll(`[data-antab="${tab}"][data-ancol]`).forEach(t => {
    const icon = t.querySelector('.an-sort-icon');
    if (icon) icon.textContent = t.dataset.ancol === col ? (_anSort[sortKey].dir === 'asc' ? ' ▲' : ' ▼') : '';
  });
  if (tab === 'utilization') { loadAnUtil(); return; }
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
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('an-kpi-pending', formatInt(d.pending));
    set('an-kpi-cks',     formatInt(d.cks_ab));
    set('an-kpi-empty',   formatInt(d.empty_declared));
    set('an-kpi-unique',  formatInt(d.geo_unique));
  } catch(e) { console.error('anomalies/kpi', e); }
}

async function loadAnUtil() {
  const fp = buildFilterParams('none');
  let url, ck;
  if (_anUtilRaionId != null) {
    // уровень 3 — виды помощи района
    ck = `raion:${_anUtilRaionId}` + fp;
    fp.set('raion_id', _anUtilRaionId);
    url = `/api/anomalies/utilization-raion?${fp}`;
  } else if (_anUtilRegionId != null) {
    // уровень 2 — районы региона
    ck = `region:${_anUtilRegionId}` + fp;
    fp.set('region_id', _anUtilRegionId);
    url = `/api/anomalies/utilization-raion?${fp}`;
  } else {
    // уровень 1 — регионы
    ck = 'all' + fp;
    url = `/api/anomalies/utilization?${fp}`;
  }
  if (_anUtilCache[ck]) { renderAnUtil(_anUtilCache[ck]); return; }
  try {
    const data = await fetch(url).then(r => r.json());
    _anUtilCache[ck] = data;
    renderAnUtil(data);
  } catch(e) { console.error('anomalies/utilization', e); }
}

function anUtilResetToRegions() {
  _anUtilRegionId = null; _anUtilRegionName = '';
  _anUtilRaionId = null; _anUtilRaionName = '';
}

function anUtilBack() {
  if (_anUtilRaionId != null) { _anUtilRaionId = null; _anUtilRaionName = ''; }
  else { _anUtilRegionId = null; _anUtilRegionName = ''; }
  loadAnUtil();
}

function anUtilDrillRegion(regionId, regionName) {
  if (regionId == null) return;
  _anUtilRegionId = regionId; _anUtilRegionName = regionName;
  _anUtilRaionId = null; _anUtilRaionName = '';
  loadAnUtil();
}

function anUtilDrillRaion(raionId, raionName) {
  if (raionId == null) return;
  _anUtilRaionId = raionId; _anUtilRaionName = raionName;
  loadAnUtil();
}

let _dataTableInit = false;
function ensureDataTable() {
  if (!_dataTableInit) { initTableHead(); _dataTableInit = true; }
  loadTable(1);
}

async function loadAnomalyTab(tab) {
  if (tab === 'utilization') { await loadAnUtil(); return; }
  if (tab === 'cks') { await loadAnCks(); return; }
  if (tab === 'data') { ensureDataTable(); return; }
  const fp = buildFilterParams('full');
  const cacheKey = tab + fp;
  if (_anTabCache[cacheKey]) { renderAnomalyTab(tab, _anTabCache[cacheKey]); return; }
  const baseUrlMap = {
    cks:    '/api/anomalies/cks-ab',
    unique: '/api/anomalies/unique-help',
  };
  if (!baseUrlMap[tab]) return;
  try {
    const data = await fetch(`${baseUrlMap[tab]}?${fp}`).then(r => r.json());
    _anTabCache[cacheKey] = data;
    renderAnomalyTab(tab, data);
  } catch(e) { console.error(`anomalies/${tab}`, e); }
}

function _syncAnomalyGeo() {
  _invalidateAnomCaches();
  _anCksRegionId = null; _anCksRegionName = '';
  if (currentRaion != null) {
    _anUtilRegionId   = currentRegion;
    _anUtilRegionName = regionStats[currentRegion]?.name || '';
    _anUtilRaionId    = currentRaion;
    _anUtilRaionName  = raionStats[currentRaion]?.name || '';
  } else if (currentRegion != null) {
    _anUtilRegionId   = currentRegion;
    _anUtilRegionName = regionStats[currentRegion]?.name || '';
    _anUtilRaionId    = null;
    _anUtilRaionName  = '';
  } else {
    _anUtilRegionId = null; _anUtilRegionName = '';
    _anUtilRaionId  = null; _anUtilRaionName  = '';
  }
  const activeAntab = document.querySelector('.antab-btn.active');
  if (activeAntab) loadAnomalyTab(activeAntab.dataset.antab);
}

function renderAnomalyTab(tab, data) {
  if (tab === 'cks') {
    const effId   = _anCksRegionId ?? currentRegion ?? null;
    const effName = _anCksRegionId != null ? _anCksRegionName
      : (currentRegion != null ? (regionStats[currentRegion]?.name || '') : '');
    renderAnCks(data, effId, effName);
  } else {
    ({ unique: renderAnUnique })[tab]?.(data);
  }
}

function _anEmpty(tbody, cols) {
  tbody.innerHTML = `<tr><td colspan="${cols}" style="text-align:center;padding:32px;color:var(--tx-muted)">Нет данных</td></tr>`;
}

function _shortPayType(s) { return (s || '').replace(/^СОЦИАЛЬНАЯ ПОМОЩЬ\s+/i, ''); }

let _anCksRegionId = null, _anCksRegionName = '';

async function loadAnCks() {
  const fp = buildFilterParams('full');
  if (_anCksRegionId != null) fp.set('region_id', _anCksRegionId);
  const effId   = _anCksRegionId ?? currentRegion ?? null;
  const effName = _anCksRegionId != null ? _anCksRegionName
    : (currentRegion != null ? (regionStats[currentRegion]?.name || '') : '');
  const data = await fetch(`/api/anomalies/cks-ab?${fp}`).then(r => r.json()).catch(() => []);
  renderAnCks(data, effId, effName);
}

function anCksDrillRegion(id) {
  drillRegion(id);
}

function anCksBack() {
  _anCksRegionId = null; _anCksRegionName = '';
  goBack();
}

function renderAnCks(rows, effRegionId, effRegionName) {
  const tbody = document.getElementById('antab-cks-body');
  const backBtn = document.getElementById('an-cks-back');
  const geoCol  = document.getElementById('an-cks-geo-col');
  const sorted  = anSorted(rows, 'cks');

  if (effRegionId != null) {
    // show back button only when user explicitly drilled in, not just because map region is selected
    if (backBtn) backBtn.style.display = _anCksRegionId != null ? 'inline-block' : 'none';
    if (geoCol)  geoCol.textContent = `${t('Район')} (${(effRegionName || '').toUpperCase()})`;
    if (!sorted.length) { _anEmpty(tbody, 6); return; }
    tbody.innerHTML = sorted.map(r => `<tr>
      <td class="geo-name">${r.raion || '—'}</td>
      <td class="col-center"><span class="an-cks-badge">${r.cks}</span></td>
      <td>${_shortPayType(r.pay_type)}</td>
      <td class="col-center an-alarm-cell">${formatInt(r.count)}</td>
      <td class="col-center">${formatInt(r.recipients)}</td>
      <td class="col-right">${formatNum(r.total_dec)} ₸</td>
    </tr>`).join('');
  } else {
    if (backBtn) backBtn.style.display = 'none';
    if (geoCol)  geoCol.textContent = t('Регион');
    if (!sorted.length) { _anEmpty(tbody, 6); return; }
    tbody.innerHTML = sorted.map(r => `<tr class="coverage-row" style="cursor:pointer"
        onclick="anCksDrillRegion(${r.region_id}, '${(r.region || '').replace(/'/g, "\\'")}')">
      <td class="geo-name">${r.region || '—'}</td>
      <td class="col-center"><span class="an-cks-badge">${r.cks}</span></td>
      <td>${_shortPayType(r.pay_type)}</td>
      <td class="col-center an-alarm-cell">${formatInt(r.count)}</td>
      <td class="col-center">${formatInt(r.recipients)}</td>
      <td class="col-right">${formatNum(r.total_dec)} ₸</td>
    </tr>`).join('');
  }
}

function renderAnUtil(rows) {
  const tbody   = document.getElementById('antab-utilization-body');
  const backBtn = document.getElementById('an-util-back');
  const geoCol  = document.getElementById('an-util-geo-col');
  const sorted  = anSorted(rows, 'utilization');

  const valCols = r => {
    const cls = r.pct < 50 ? 'an-alarm-cell' : r.pct < 80 ? 'an-warn-cell' : '';
    return `<td class="col-center">${formatInt(r.count)}</td>
        <td class="col-right">${formatNum(r.total_max)} ₸</td>
        <td class="col-right">${formatNum(r.total_dec)} ₸</td>
        <td class="col-right ${cls}">${r.pct}%</td>`;
  };

  if (_anUtilRaionId != null) {
    // Уровень 3 — виды помощи района (контекст в заголовке колонки, как в матрице)
    if (backBtn) { backBtn.style.display = 'inline-block'; backBtn.textContent = t('← Районы'); }
    if (geoCol)  geoCol.textContent = `${t('Вид помощи')} (${(_anUtilRaionName || '').toUpperCase()})`;
    if (!sorted.length) { _anEmpty(tbody, 5); return; }
    tbody.innerHTML = sorted.map(r => `<tr>
        <td>${_shortPayType(r.pay_type)}</td>
        ${valCols(r)}
      </tr>`).join('');
  } else if (_anUtilRegionId != null) {
    // Уровень 2 — районы региона
    if (backBtn) { backBtn.style.display = 'inline-block'; backBtn.textContent = t('← Все регионы'); }
    if (geoCol)  geoCol.textContent = `${t('Район')} (${(_anUtilRegionName || '').toUpperCase()})`;
    if (!sorted.length) { _anEmpty(tbody, 5); return; }
    tbody.innerHTML = sorted.map(r => `<tr class="coverage-row" style="cursor:pointer"
        onclick="anUtilDrillRaion(${r.raion_id}, '${(r.raion || '').replace(/'/g, "\\'")}')">
        <td class="geo-name">${r.raion}</td>
        ${valCols(r)}
      </tr>`).join('');
  } else {
    // Уровень 1 — регионы
    if (backBtn) backBtn.style.display = 'none';
    if (geoCol)  geoCol.textContent = t('Регион');
    if (!sorted.length) { _anEmpty(tbody, 5); return; }
    tbody.innerHTML = sorted.map(r => {
      const rowCls    = r.clickable ? 'coverage-row' : '';
      const clickAttr = r.clickable
        ? `onclick="anUtilDrillRegion(${r.id}, '${(r.name || '').replace(/'/g, "\\'")}')" style="cursor:pointer"` : '';
      return `<tr class="${rowCls}" ${clickAttr}>
        <td class="geo-name">${r.name}</td>
        ${valCols(r)}
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
    <td class="geo-name">${(r.regions || []).join(', ')}</td>
  </tr>`).join('');
}

window.addEventListener('load', () => { if (map) map.invalidateSize(); });

function initPayTooltip() {
  const tip = document.getElementById('pay-tooltip');
  if (!tip) return;
  let active = false;
  document.getElementById('mtab-presence')?.addEventListener('mouseover', e => {
    const th = e.target.closest('[data-pay-desc]');
    if (!th) { if (active) { tip.style.display = 'none'; active = false; } return; }
    const rawDesc = th.dataset.payDesc.replace(/^МИО предоставляют?\s*/i, '');
    const desc = rawDesc.charAt(0).toUpperCase() + rawDesc.slice(1);
    tip.innerHTML = `<div class="pt-title">${th.dataset.payName}</div><div class="pt-desc">${desc}</div>`;
    tip.style.display = 'block';
    active = true;
  });
  document.getElementById('mtab-presence')?.addEventListener('mousemove', e => {
    if (!active) return;
    tip.style.left = (e.clientX + 18) + 'px';
    tip.style.top  = (e.clientY + 18) + 'px';
    const r = tip.getBoundingClientRect();
    if (r.right  > window.innerWidth  - 8) tip.style.left = (e.clientX - r.width  - 8) + 'px';
    if (r.bottom > window.innerHeight - 8) tip.style.top  = (e.clientY - r.height - 8) + 'px';
  });
  document.getElementById('mtab-presence')?.addEventListener('mouseout', e => {
    if (!e.target.closest('[data-pay-desc]')) return;
    tip.style.display = 'none';
    active = false;
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const savedTheme = localStorage.getItem('theme') || 'dark';
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

  document.querySelectorAll('#paytypes-table .pt-sort').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.dataset.ptcol;
      _ptSortDir = _ptSortCol === col && _ptSortDir === 'desc' ? 'asc' : 'desc';
      _ptSortCol = col;
      renderPayTypes();
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
      if (btn.dataset.tab === 'dynamics') loadDynamics();
      if (btn.dataset.tab === 'paytypes') loadPayTypes();
      if (btn.dataset.tab === 'ranking-recipients' || btn.dataset.tab === 'ranking-sum') loadRankingPanel();
      if (btn.dataset.tab === 'pie3d') window.renderPie3D?.(currentRegion, currentRaion, currentPayType);
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
      if (btn.dataset.antab === 'utilization') {
        _anUtilRegionId   = currentRegion || null;
        _anUtilRegionName = currentRegion ? (regionStats[currentRegion]?.name || '') : '';
        _anUtilRaionId    = currentRaion  || null;
        _anUtilRaionName  = currentRaion  ? (raionStats[currentRaion]?.name  || '') : '';
      } else { const bb = document.getElementById('an-util-back'); if (bb) bb.style.display = 'none'; }
      loadAnomalyTab(btn.dataset.antab);
    });
  });
  loadAnomalyKpi();
  loadAnomalyTab('cks');
  loadRankingPanel();
  loadDynamics();

  document.querySelectorAll('[data-dperiod]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-dperiod]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _dynPeriod = btn.dataset.dperiod;
      loadDynamics();
    });
  });
  document.querySelectorAll('[data-dmetric]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-dmetric]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _dynMetric = btn.dataset.dmetric;
      renderDynamics(_dynData);
    });
  });

  const dynField   = document.getElementById('dyn-dr-field');
  const dynResetEl = document.getElementById('dyn-date-reset');
  const dynPop     = document.getElementById('dyn-cal-pop');
  if (dynField) dynField.addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = document.getElementById('dyn-cal-pop');
    if (pop && pop.hidden) _openDynCal(); else _closeDynCal();
  });
  if (dynPop) {
    dynPop.addEventListener('click', (e) => e.stopPropagation());
    dynPop.addEventListener('mouseover', (e) => {
      const c = e.target.closest('[data-d]');
      // перерисовываем только при реальной смене дня — иначе пересборка сетки
      // под курсором снова триггерит mouseover и зацикливает рендер, «съедая» клик
      if (c && _dynSelFrom && !_dynSelTo && _dynHover !== c.dataset.d) {
        _dynHover = c.dataset.d;
        _renderDynCal();
      }
    });
    dynPop.addEventListener('click', (e) => {
      const c = e.target.closest('[data-d]');
      if (c) _pickDynDay(c.dataset.d);
    });
    document.getElementById('dyn-cal-prev')?.addEventListener('click', () => {
      if (!_dynCalView) return;
      _dynCalView.m--; if (_dynCalView.m < 0) { _dynCalView.m = 11; _dynCalView.y--; }
      _renderDynCal();
    });
    document.getElementById('dyn-cal-next')?.addEventListener('click', () => {
      if (!_dynCalView) return;
      _dynCalView.m++; if (_dynCalView.m > 11) { _dynCalView.m = 0; _dynCalView.y++; }
      _renderDynCal();
    });
    document.getElementById('dyn-cal-clear')?.addEventListener('click', () => {
      _dynSelFrom = null; _dynSelTo = null; _dynHover = null;
      _dynFrom = null; _dynTo = null;
      _renderDynCal();
      loadDynamics();
    });
  }
  if (dynResetEl) dynResetEl.addEventListener('click', (e) => {
    e.stopPropagation();
    _dynFrom = null; _dynTo = null; _dynSelFrom = null; _dynSelTo = null;
    _closeDynCal();
    loadDynamics();
  });
  document.addEventListener('click', () => _closeDynCal());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _closeDynCal(); });

  document.querySelectorAll('.ranking-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ranking-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.ranking-tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.getElementById(`rtab-${btn.dataset.rtab}`);
      if (pane) pane.classList.add('active');
      _renderRankingTab(btn.dataset.rtab);
    });
  });

  // Пагинация таблицы "Данные"
  document.getElementById('btn-prev')?.addEventListener('click', () => { if (currentPage > 1) loadTable(currentPage - 1); });
  document.getElementById('btn-next')?.addEventListener('click', () => loadTable(currentPage + 1));

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
