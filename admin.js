(() => {
  'use strict';

  const state = {
    session: null,
    restaurants: [],
    users: [],
    snapshot: null,
    csrfToken: '',
    range: { key: 'today', start: '', end: '' },
    analyticsRestaurantId: null,
    restaurantSort: { field: 'net_sales', direction: 'desc' },
    eventSource: null,
    eventReconnectAttempt: 0,
    eventReconnectTimer: null,
    fallbackRefreshTimer: null,
    analyticsRefreshTimer: null,
    highlightedRestaurantId: null
  };

  const icons = {
    overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>',
    restaurants: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h16"/><path d="M5 10v10h14V10"/><path d="m3 10 2-6h14l2 6"/><path d="M8 20v-5h4v5"/><path d="M5 10a3 3 0 0 0 5 0 3 3 0 0 0 5 0 3 3 0 0 0 5 0"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.7 2.8 17a2 2 0 0 0 1.74 3h14.92a2 2 0 0 0 1.74-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M18 5l2 2M15 8l2 2"/></svg>',
    store: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h16M5 10v10h14V10M3 10l2-6h14l2 6"/></svg>',
    userPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6.5L4 9M5.5 15A7 7 0 0 0 18 17.5l2-2.5"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>'
  };

  const selectors = {
    app: () => document.getElementById('adminApp'),
    loader: () => document.getElementById('authLoader'),
    main: () => document.getElementById('mainContent'),
    modal: () => document.getElementById('modalRoot')
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function safeImageUrl(value) {
    if (!value) return '';
    try {
      const parsed = new URL(value, window.location.origin);
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
    } catch {
      return '';
    }
  }

  function formatDate(value, options = {}) {
    if (!value) return 'Sin registro';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Sin registro';
    return new Intl.DateTimeFormat('es-EC', {
      day: '2-digit',
      month: options.long ? 'long' : 'short',
      year: 'numeric'
    }).format(date);
  }

  function initials(value) {
    return String(value || 'R')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map(part => part.charAt(0).toUpperCase())
      .join('') || 'R';
  }

  function hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach(node => {
      const name = node.dataset.icon;
      if (icons[name]) node.innerHTML = icons[name];
    });
  }

  function entityAvatar(restaurant, sizeClass = '') {
    const image = safeImageUrl(restaurant.logo_url);
    return `<span class="entity-avatar ${sizeClass}">${image
      ? `<img src="${escapeHtml(image)}" alt="" loading="lazy">`
      : escapeHtml(initials(restaurant.nombre))}</span>`;
  }

  async function fetchJson(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const response = await fetch(url, {
      cache: 'no-store',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) && state.csrfToken
          ? { 'X-CSRF-Token': state.csrfToken }
          : {}),
        ...(options.headers || {})
      }
    });

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (response.status === 401 || response.status === 403) {
      window.location.replace('/');
      throw new Error('La sesión administrativa ya no está disponible.');
    }

    if (!response.ok) {
      throw new Error(body?.message || 'No se pudo completar la solicitud.');
    }

    return body;
  }

  function toast(message, type = 'success') {
    const region = document.getElementById('toastRegion');
    const node = document.createElement('div');
    node.className = `toast ${type === 'error' ? 'error' : ''}`;
    node.innerHTML = `<span data-icon="${type === 'error' ? 'alert' : 'check'}" aria-hidden="true"></span><span>${escapeHtml(message)}</span>`;
    region.appendChild(node);
    hydrateIcons(node);
    window.setTimeout(() => node.remove(), 4200);
  }

  function setButtonLoading(button, loading, label = 'Guardando…') {
    if (!button) return;
    if (loading) {
      button.dataset.originalLabel = button.innerHTML;
      button.disabled = true;
      button.textContent = label;
    } else {
      button.disabled = false;
      if (button.dataset.originalLabel) button.innerHTML = button.dataset.originalLabel;
      hydrateIcons(button);
    }
  }

  function openModal(content, size = '') {
    const root = selectors.modal();
    root.innerHTML = `<section class="modal ${size}" role="dialog" aria-modal="true">${content}</section>`;
    hydrateIcons(root);
    root.querySelector('[autofocus], input, button')?.focus();
  }

  function closeModal() {
    selectors.modal().innerHTML = '';
  }

  function confirmAction({ title, message, confirmLabel = 'Continuar', danger = false }) {
    return new Promise(resolve => {
      openModal(`
        <div class="modal-header">
          <div><h2>${escapeHtml(title)}</h2></div>
          <button class="icon-button" type="button" data-confirm="false" aria-label="Cerrar"><span data-icon="close"></span></button>
        </div>
        <div class="modal-body">
          <p class="confirm-copy">${message}</p>
          <div class="modal-footer">
            <button class="button secondary" type="button" data-confirm="false">Cancelar</button>
            <button class="button ${danger ? 'danger' : ''}" type="button" data-confirm="true">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      `, 'small');

      selectors.modal().querySelectorAll('[data-confirm]').forEach(button => {
        button.addEventListener('click', () => {
          const accepted = button.dataset.confirm === 'true';
          closeModal();
          resolve(accepted);
        }, { once: true });
      });
    });
  }

  function activeRoute() {
    const path = window.location.pathname.replace(/\/+$/, '') || '/admin';
    if (/^\/admin\/analytics\/restaurants\/\d+$/.test(path)) return 'overview';
    if (/^\/admin\/restaurants\/\d+$/.test(path)) return 'restaurants';
    if (path === '/admin/restaurants') return 'restaurants';
    if (path === '/admin/users') return 'users';
    return 'overview';
  }

  function updateNavigation() {
    const active = activeRoute();
    document.querySelectorAll('[data-route]').forEach(link => {
      const selected = link.dataset.route === active;
      link.classList.toggle('active', selected);
      if (selected) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarScrim').hidden = true;
  }

  function navigate(path, { replace = false } = {}) {
    if (replace) history.replaceState({}, '', path);
    else if (window.location.pathname !== path) history.pushState({}, '', path);
    closeSidebar();
    renderRoute();
  }

  function renderLoading() {
    selectors.main().innerHTML = `
      <div class="page-header">
        <div><div class="skeleton" style="width:80px;height:12px"></div><div class="skeleton" style="width:280px;height:42px;margin-top:12px"></div></div>
      </div>
      <div class="metric-grid">
        ${Array.from({ length: 4 }, () => '<div class="metric-card"><div class="skeleton" style="width:80px;height:13px"></div><div class="skeleton" style="width:64px;height:38px;margin-top:34px"></div></div>').join('')}
      </div>`;
  }

  function renderError(error, retry) {
    selectors.main().innerHTML = `
      <section class="error-state">
        <span class="metric-icon"><span data-icon="alert"></span></span>
        <h1>No pudimos cargar esta vista</h1>
        <p>${escapeHtml(error.message || 'Ocurrió un error inesperado.')}</p>
        <button class="button" type="button" id="retryButton"><span data-icon="refresh"></span>Intentar de nuevo</button>
      </section>`;
    hydrateIcons(selectors.main());
    document.getElementById('retryButton').addEventListener('click', retry);
  }

  async function renderOverviewLegacy() {
    renderLoading();
    try {
      const data = await fetchJson('/admin/overview');
      const totals = data.totals || {};
      const total = Number(totals.restaurants || 0);
      const active = Number(totals.active_restaurants || 0);
      const inactive = Number(totals.inactive_restaurants || 0);
      const health = total ? Math.round((active / total) * 100) : 0;
      const recent = Array.isArray(data.recent_restaurants) ? data.recent_restaurants : [];

      selectors.main().innerHTML = `
        <header class="page-header">
          <div>
            <p class="eyebrow">Centro de control</p>
            <h1 class="page-title">Overview</h1>
            <p class="page-description">Una vista rápida del estado de tu red de restaurantes.</p>
          </div>
          <a class="button" href="/admin/restaurants" data-admin-link><span data-icon="plus"></span>Nuevo restaurante</a>
        </header>

        <section class="metric-grid" aria-label="Resumen administrativo">
          <article class="metric-card accent">
            <div class="metric-heading"><span>Total restaurantes</span><span class="metric-icon"><span data-icon="restaurants"></span></span></div>
            <div class="metric-value">${total}</div>
            <div class="metric-note">Registrados en Denix</div>
          </article>
          <article class="metric-card">
            <div class="metric-heading"><span>Restaurantes activos</span><span class="metric-icon"><span data-icon="check"></span></span></div>
            <div class="metric-value">${active}</div>
            <div class="metric-note">${health}% de la red habilitada</div>
          </article>
          <article class="metric-card">
            <div class="metric-heading"><span>Restaurantes inactivos</span><span class="metric-icon"><span data-icon="store"></span></span></div>
            <div class="metric-value">${inactive}</div>
            <div class="metric-note">Requieren revisión operativa</div>
          </article>
          <article class="metric-card">
            <div class="metric-heading"><span>Usuarios</span><span class="metric-icon"><span data-icon="users"></span></span></div>
            <div class="metric-value">${Number(totals.users || 0)}</div>
            <div class="metric-note">Accesos creados</div>
          </article>
        </section>

        <section class="dashboard-grid">
          <article class="panel">
            <div class="panel-header">
              <div><h2>Restaurantes recientes</h2><p>Últimas cuentas añadidas</p></div>
              <a class="text-link" href="/admin/restaurants" data-admin-link>Ver todos →</a>
            </div>
            <div class="restaurant-list">
              ${recent.length ? recent.map(restaurant => `
                <div class="recent-row">
                  <a class="entity text-link" href="/admin/restaurants/${Number(restaurant.id)}" data-admin-link>
                    ${entityAvatar(restaurant)}
                    <span><strong>${escapeHtml(restaurant.nombre)}</strong><span>ID #${Number(restaurant.id)}</span></span>
                  </a>
                  <span class="row-meta">${formatDate(restaurant.created_at)}</span>
                  <span class="status-pill ${restaurant.activo ? '' : 'inactive'}">${restaurant.activo ? 'Activo' : 'Inactivo'}</span>
                </div>`).join('') : `
                <div class="empty-state"><div><span class="empty-icon"><span data-icon="store"></span></span><h3>Aún no hay restaurantes</h3><p>Crea el primero desde la sección Restaurantes.</p></div></div>`}
            </div>
          </article>

          <article class="panel health-panel">
            <div class="panel-header"><div><h2>Estado de la red</h2><p>Disponibilidad administrativa</p></div></div>
            <div class="health-content">
              <div class="health-ring" style="--health-angle:${health * 3.6}deg">
                <div class="health-value"><strong>${health}%</strong><span>activos</span></div>
              </div>
              <div class="health-legend">
                <div class="legend-row"><span><i class="legend-dot"></i>Activos</span><strong>${active}</strong></div>
                <div class="legend-row"><span><i class="legend-dot muted"></i>Inactivos</span><strong>${inactive}</strong></div>
              </div>
            </div>
          </article>
        </section>`;
      hydrateIcons(selectors.main());
    } catch (error) {
      renderError(error, renderOverviewLegacy);
    }
  }

  const moneyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

  function formatMoney(value) {
    return moneyFormatter.format(Number(value || 0));
  }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date);
  }

  function relativeTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Sin órdenes';
    const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return 'Hace menos de un minuto';
    if (seconds < 3600) return `Hace ${Math.floor(seconds / 60)} min`;
    if (seconds < 86400) return `Hace ${Math.floor(seconds / 3600)} h`;
    return formatDate(value);
  }

  function analyticsQuery(restaurantId) {
    const params = new URLSearchParams();
    params.set('range', state.range.key);
    if (state.range.key === 'custom') {
      params.set('start', state.range.start);
      params.set('end', state.range.end);
    }
    if (restaurantId) params.set('restaurant_id', String(restaurantId));
    return params.toString();
  }

  function rangeControls(snapshot) {
    const range = snapshot.range || {};
    const custom = state.range.key === 'custom';
    const labels = [['today', 'Hoy'], ['yesterday', 'Ayer'], ['7d', 'Últimos 7 días'], ['30d', 'Últimos 30 días'], ['custom', 'Personalizado']];
    return `<section class="analytics-controls" aria-label="Filtro temporal">
      <div class="range-tabs">${labels.map(([key, label]) => `<button class="range-button ${state.range.key === key ? 'active' : ''}" type="button" data-range="${key}">${label}</button>`).join('')}</div>
      <div class="custom-range" id="customRange" ${custom ? '' : 'hidden'}>
        <div class="field"><label for="rangeStart">Fecha inicial</label><input id="rangeStart" type="date" value="${escapeHtml(state.range.start || range.start || '')}"></div>
        <div class="field"><label for="rangeEnd">Fecha final</label><input id="rangeEnd" type="date" value="${escapeHtml(state.range.end || range.end || '')}"></div>
        <button class="button compact" id="applyCustomRange" type="button">Aplicar</button>
      </div>
      <span class="timezone-note">Zona horaria: ${escapeHtml(snapshot.timezone?.name || 'UTC')}</span>
    </section>`;
  }

  function kpiCards(overview) {
    const change = overview.net_sales_change_percent;
    const trend = change === null || change === undefined
      ? 'Sin período anterior comparable'
      : `<span class="trend ${change < 0 ? 'negative' : ''}">${change >= 0 ? '↑' : '↓'} ${Math.abs(change)}%</span> vs período anterior`;
    return `<section class="analytics-kpi-grid" aria-label="Indicadores generales">
      <article class="analytics-kpi primary wide"><div class="analytics-kpi-label">Ventas netas</div><div class="analytics-kpi-value">${formatMoney(overview.net_sales)}</div><div class="analytics-kpi-note">${trend}</div></article>
      <article class="analytics-kpi"><div class="analytics-kpi-label">Órdenes</div><div class="analytics-kpi-value">${overview.orders}</div><div class="analytics-kpi-note">Processing + completed</div></article>
      <article class="analytics-kpi"><div class="analytics-kpi-label">Ticket promedio</div><div class="analytics-kpi-value">${formatMoney(overview.average_ticket)}</div><div class="analytics-kpi-note">Neto por orden válida</div></article>
      <article class="analytics-kpi"><div class="analytics-kpi-label">Ventas brutas</div><div class="analytics-kpi-value">${formatMoney(overview.gross_sales)}</div><div class="analytics-kpi-note">Antes de reembolsos</div></article>
      <article class="analytics-kpi"><div class="analytics-kpi-label">Restaurantes</div><div class="analytics-kpi-value">${overview.total_restaurants}</div><div class="analytics-kpi-note split-note"><span>${overview.open_restaurants} ${overview.open_restaurants === 1 ? 'abierto' : 'abiertos'}</span><span>${overview.closed_restaurants} ${overview.closed_restaurants === 1 ? 'cerrado' : 'cerrados'}</span></div></article>
      <article class="analytics-kpi"><div class="analytics-kpi-label">Delivery</div><div class="analytics-kpi-value">${overview.delivery_orders}</div><div class="analytics-kpi-note">Órdenes de entrega</div></article>
      <article class="analytics-kpi"><div class="analytics-kpi-label">Pickup</div><div class="analytics-kpi-value">${overview.pickup_orders}</div><div class="analytics-kpi-note">Órdenes para recoger</div></article>
      <article class="analytics-kpi"><div class="analytics-kpi-label">Reembolsos</div><div class="analytics-kpi-value">${formatMoney(overview.refunds_amount)}</div><div class="analytics-kpi-note">${overview.refunds_count} ${overview.refunds_count === 1 ? 'orden' : 'órdenes'} con refund</div></article>
    </section>`;
  }

  function timelineChart(snapshot, metric = 'net_sales') {
    const timeline = snapshot.charts?.timeline || [];
    const maxValue = Math.max(1, ...timeline.map(item => Number(item[metric] || 0)));
    if (!timeline.length) return '<div class="analytics-empty">No hay ventas para graficar en este período.</div>';
    const ariaMetric = metric === 'orders' ? 'Órdenes' : 'Ventas';
    return `<div class="bar-chart" aria-label="${ariaMetric} por ${snapshot.charts.granularity === 'hour' ? 'hora' : 'día'}">${timeline.map((item, index) => {
      const height = Math.max(3, Math.round((Number(item[metric] || 0) / maxValue) * 155));
      const raw = String(item.bucket || '');
      const label = snapshot.charts.granularity === 'hour' ? raw.slice(11, 16) : raw.slice(5, 10);
      const showLabel = timeline.length <= 14 || index % Math.ceil(timeline.length / 10) === 0;
      const valueLabel = metric === 'orders' ? `${item.orders} órdenes` : formatMoney(item.net_sales);
      return `<div class="bar-column" title="${escapeHtml(label)} · ${valueLabel}"><span class="bar-value" style="height:${height}px"></span><span class="bar-label">${showLabel ? escapeHtml(label) : ''}</span></div>`;
    }).join('')}</div>`;
  }

  function rankingChart(snapshot) {
    const ranking = snapshot.charts?.restaurant_sales || [];
    const max = Math.max(1, ...ranking.map(item => Number(item.net_sales || 0)));
    if (!ranking.length) return '<div class="analytics-empty">No hay restaurantes para mostrar.</div>';
    return `<div class="ranking-list">${ranking.map(item => `<div class="ranking-item"><strong title="${escapeHtml(item.nombre)}">${escapeHtml(item.nombre)}</strong><span class="ranking-track"><i class="ranking-fill" style="width:${Math.max(2, Math.round((Number(item.net_sales || 0) / max) * 100))}%"></i></span><em>${formatMoney(item.net_sales)}</em></div>`).join('')}</div>`;
  }

  function performanceCards(restaurants) {
    if (!restaurants.length) return '<div class="empty-state"><div><h3>No hay restaurantes</h3><p>No existen cuentas para este filtro.</p></div></div>';
    return restaurants.slice(0, 6).map(restaurant => `<a class="performance-card ${Number(state.highlightedRestaurantId) === restaurant.id ? 'updated' : ''}" href="/admin/analytics/restaurants/${restaurant.id}" data-admin-link>
      <div class="performance-head"><div class="entity">${entityAvatar(restaurant)}<span><strong>${escapeHtml(restaurant.nombre)}</strong><span>ID #${restaurant.id}</span></span></div><span class="status-pill ${restaurant.abierto ? '' : 'inactive'}">${restaurant.abierto ? 'Abierto' : 'Cerrado'}</span></div>
      <div class="performance-sales"><span>Ventas netas</span><strong>${formatMoney(restaurant.net_sales)}</strong></div>
      <div class="performance-metrics"><div><span>Órdenes</span><strong>${restaurant.orders}</strong></div><div><span>Ticket</span><strong>${formatMoney(restaurant.average_ticket)}</strong></div><div><span>Refunds</span><strong>${restaurant.refunds_count}</strong></div><div><span>Pickup</span><strong>${restaurant.pickup_orders}</strong></div><div><span>Delivery</span><strong>${restaurant.delivery_orders}</strong></div><div><span>Última</span><strong>${restaurant.last_order_at ? formatTime(restaurant.last_order_at) : '—'}</strong></div></div>
      <div class="last-order">${relativeTime(restaurant.last_order_at)}</div>
    </a>`).join('');
  }

  function sortedAnalyticsRestaurants(restaurants, query = '') {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = restaurants.filter(restaurant => !normalizedQuery || restaurant.nombre.toLowerCase().includes(normalizedQuery));
    const { field, direction } = state.restaurantSort;
    return [...filtered].sort((a, b) => {
      const left = field === 'nombre' ? a.nombre.toLowerCase() : Number(a[field] || 0);
      const right = field === 'nombre' ? b.nombre.toLowerCase() : Number(b[field] || 0);
      const compared = typeof left === 'string' ? left.localeCompare(right) : left - right;
      return direction === 'asc' ? compared : -compared;
    });
  }

  function analyticsTableRows(restaurants) {
    if (!restaurants.length) return '<tr><td colspan="9"><div class="analytics-empty">No hay restaurantes que coincidan con la búsqueda.</div></td></tr>';
    return restaurants.map(restaurant => `<tr data-analytics-restaurant="${restaurant.id}" tabindex="0">
      <td><div class="entity">${entityAvatar(restaurant)}<span><strong>${escapeHtml(restaurant.nombre)}</strong><span>ID #${restaurant.id}</span></span></div></td>
      <td><span class="status-pill ${restaurant.abierto ? '' : 'inactive'}">${restaurant.abierto ? 'Abierto' : 'Cerrado'}</span></td><td>${formatMoney(restaurant.net_sales)}</td><td>${restaurant.orders}</td><td>${formatMoney(restaurant.average_ticket)}</td><td>${restaurant.pickup_orders}</td><td>${restaurant.delivery_orders}</td><td>${restaurant.refunds_count} · ${formatMoney(restaurant.refunds_amount)}</td><td>${restaurant.last_order_at ? relativeTime(restaurant.last_order_at) : '—'}</td>
    </tr>`).join('');
  }

  function liveOrderRows(orders, highlighted = false) {
    if (!orders.length) return '<div class="analytics-empty">No hay órdenes válidas en este período.</div>';
    return orders.slice(0, 25).map((order, index) => `<div class="live-order ${highlighted && index === 0 ? 'new' : ''}">
      <span class="live-time">${formatTime(order.created_at)}</span><div><strong>${escapeHtml(order.restaurante_nombre || 'Restaurante')}</strong><div class="row-meta"><span class="order-number">#${escapeHtml(order.woo_order_id)}</span> · ${escapeHtml(order.customer_name || 'Cliente')}</div></div><span class="type-badge ${order.order_type === 'delivery' ? 'delivery' : ''}">${order.order_type === 'pickup' ? 'Pickup' : 'Delivery'}</span><span class="state-badge ${order.refunded ? 'refunded' : escapeHtml(order.estado)}">${order.refunded ? 'Refunded' : escapeHtml(order.estado)}</span><span class="order-total">${formatMoney(order.total)}</span>
    </div>`).join('');
  }

  function bindRangeControls(refresh) {
    document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => {
      state.range.key = button.dataset.range;
      if (state.range.key === 'custom') {
        const range = state.snapshot?.range || {};
        state.range.start ||= range.start || '';
        state.range.end ||= range.end || '';
        document.getElementById('customRange').hidden = false;
        document.querySelectorAll('[data-range]').forEach(item => item.classList.toggle('active', item === button));
        return;
      }
      refresh();
    }));
    document.getElementById('applyCustomRange')?.addEventListener('click', () => {
      state.range.start = document.getElementById('rangeStart').value;
      state.range.end = document.getElementById('rangeEnd').value;
      if (!state.range.start || !state.range.end) return toast('Selecciona ambas fechas.', 'error');
      refresh();
    });
  }

  function bindAnalyticsTable(restaurants) {
    const body = document.getElementById('analyticsRestaurantBody');
    const search = document.getElementById('analyticsRestaurantSearch');
    const bindRows = () => body.querySelectorAll('[data-analytics-restaurant]').forEach(row => {
      const open = () => navigate(`/admin/analytics/restaurants/${row.dataset.analyticsRestaurant}`);
      row.addEventListener('click', open);
      row.addEventListener('keydown', event => { if (event.key === 'Enter') open(); });
    });
    const renderRows = () => {
      body.innerHTML = analyticsTableRows(sortedAnalyticsRestaurants(restaurants, search.value));
      bindRows();
    };
    search.addEventListener('input', renderRows);
    document.querySelectorAll('[data-sort-analytics]').forEach(button => button.addEventListener('click', () => {
      const field = button.dataset.sortAnalytics;
      state.restaurantSort = state.restaurantSort.field === field
        ? { field, direction: state.restaurantSort.direction === 'asc' ? 'desc' : 'asc' }
        : { field, direction: field === 'nombre' ? 'asc' : 'desc' };
      renderRows();
    }));
    bindRows();
  }

  function renderOverviewSnapshot(snapshot, { liveUpdate = false } = {}) {
    state.snapshot = snapshot;
    state.restaurants = snapshot.restaurants || [];
    const overview = snapshot.overview || {};
    const types = snapshot.charts?.order_types || { pickup: 0, delivery: 0 };
    const totalTypes = Number(types.pickup || 0) + Number(types.delivery || 0);
    const pickupAngle = totalTypes ? (Number(types.pickup || 0) / totalTypes) * 360 : 0;
    selectors.main().innerHTML = `
      <header class="page-header"><div><p class="eyebrow">Centro de control</p><h1 class="page-title">Overview</h1><p class="page-description">Rendimiento consolidado de todos los restaurantes Denix.</p></div><a class="button secondary" href="/admin/restaurants" data-admin-link><span data-icon="store"></span>Gestionar restaurantes</a></header>
      ${rangeControls(snapshot)}
      ${kpiCards(overview)}
      <section class="analytics-section chart-grid analytics-triple"><article class="chart-card"><h3>Ventas netas por ${snapshot.charts?.granularity === 'hour' ? 'hora' : 'día'}</h3><p>Ventas brutas menos reembolsos</p>${timelineChart(snapshot)}</article><article class="chart-card"><h3>Órdenes por ${snapshot.charts?.granularity === 'hour' ? 'hora' : 'día'}</h3><p>Volumen de órdenes válidas</p>${timelineChart(snapshot, 'orders')}</article><article class="chart-card"><h3>Ventas por restaurante</h3><p>Ranking por ventas netas</p>${rankingChart(snapshot)}</article></section>
      <section class="analytics-section"><div class="section-heading"><div><h2>Restaurantes hoy</h2><p>Ordenados por ventas netas, de mayor a menor</p></div><a class="text-link" href="#restaurantAnalyticsTable">Ver tabla completa ↓</a></div><div class="restaurant-performance-grid">${performanceCards(snapshot.restaurants || [])}</div></section>
      <section class="analytics-section" id="restaurantAnalyticsTable"><div class="section-heading"><div><h2>Rendimiento por restaurante</h2><p>Selecciona una columna para ordenar</p></div><label class="search-box" style="max-width:280px"><span data-icon="search"></span><input id="analyticsRestaurantSearch" type="search" placeholder="Buscar restaurante…"></label></div><div class="analytics-table-wrap"><table class="analytics-table"><thead><tr><th><button data-sort-analytics="nombre">Restaurante ↕</button></th><th>Estado</th><th><button data-sort-analytics="net_sales">Ventas ↕</button></th><th><button data-sort-analytics="orders">Órdenes ↕</button></th><th><button data-sort-analytics="average_ticket">Ticket ↕</button></th><th>Pickup</th><th>Delivery</th><th>Refunds</th><th>Última orden</th></tr></thead><tbody id="analyticsRestaurantBody">${analyticsTableRows(sortedAnalyticsRestaurants(snapshot.restaurants || []))}</tbody></table></div></section>
      <section class="analytics-section live-layout"><div><div class="section-heading"><div><h2>Órdenes en vivo</h2><p>Últimas órdenes válidas de toda la red</p></div><span class="live-indicator"><i></i><span>LIVE</span></span></div><div class="live-orders" id="liveOrders">${liveOrderRows(snapshot.latest_orders || [], liveUpdate)}</div></div><article class="donut-card"><div><div class="donut" style="--pickup-angle:${pickupAngle}deg"><div class="donut-center"><strong>${totalTypes}</strong><span>órdenes</span></div></div><div class="donut-legend"><span>● Pickup ${types.pickup || 0}</span><span>● Delivery ${types.delivery || 0}</span></div></div></article></section>`;
    hydrateIcons(selectors.main());
    bindRangeControls(() => renderOverview());
    bindAnalyticsTable(snapshot.restaurants || []);
    window.setTimeout(() => { state.highlightedRestaurantId = null; }, 1200);
  }

  async function renderOverview(showLoading = true) {
    if (showLoading) renderLoading();
    try {
      const snapshot = await fetchJson(`/admin/api/dashboard?${analyticsQuery()}`);
      renderOverviewSnapshot(snapshot);
    } catch (error) {
      renderError(error, renderOverview);
    }
  }

  function recentOrdersTable(orders) {
    if (!orders.length) return '<div class="analytics-empty">No hay órdenes recientes para este restaurante.</div>';
    return `<div class="analytics-table-wrap recent-orders-table"><table class="analytics-table"><thead><tr><th>Número Woo</th><th>Cliente</th><th>Hora</th><th>Tipo</th><th>Total</th><th>Estado</th><th>Driver</th><th>Tracking</th></tr></thead><tbody>${orders.map(order => `<tr><td>#${escapeHtml(order.woo_order_id)}</td><td>${escapeHtml(order.customer_name)}</td><td>${formatTime(order.created_at)}</td><td><span class="type-badge ${order.order_type === 'delivery' ? 'delivery' : ''}">${escapeHtml(order.order_type)}</span></td><td>${formatMoney(order.total)}</td><td><span class="state-badge ${order.refunded ? 'refunded' : escapeHtml(order.estado)}">${order.refunded ? 'Refunded' : escapeHtml(order.estado)}</span></td><td>${escapeHtml(order.driver_name || 'Sin asignar')}</td><td>${order.tracking_url ? `<a class="tracking-link" href="${escapeHtml(order.tracking_url)}" target="_blank" rel="noopener">Ver tracking</a>` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  }

  async function renderAnalyticsDetail(id, showLoading = true) {
    state.analyticsRestaurantId = id;
    if (showLoading) renderLoading();
    try {
      const snapshot = await fetchJson(`/admin/api/dashboard?${analyticsQuery(id)}`);
      state.snapshot = snapshot;
      const restaurant = snapshot.restaurants?.[0];
      if (!restaurant) throw new Error('Restaurante no encontrado.');
      const pickupAngle = restaurant.orders ? (restaurant.pickup_orders / restaurant.orders) * 360 : 0;
      selectors.main().innerHTML = `<div class="breadcrumbs"><a href="/admin" data-admin-link>Overview</a><span>›</span><span>${escapeHtml(restaurant.nombre)}</span></div><header class="page-header analytics-detail-header"><div class="detail-heading">${entityAvatar(restaurant)}<div><p class="eyebrow">Analytics · ID #${restaurant.id}</p><h1 class="page-title">${escapeHtml(restaurant.nombre)}</h1><p class="page-description"><span class="status-pill ${restaurant.abierto ? '' : 'inactive'}">${restaurant.abierto ? 'Abierto' : 'Cerrado'}</span></p></div></div><div class="detail-actions"><a class="button secondary" href="/admin" data-admin-link>Volver</a><a class="button" href="/admin/restaurants/${restaurant.id}" data-admin-link>Configuración</a></div></header>${rangeControls(snapshot)}${kpiCards(snapshot.overview || {})}<section class="analytics-section chart-grid"><article class="chart-card"><h3>Ventas del restaurante</h3><p>Evolución dentro del período</p>${timelineChart(snapshot)}</article><article class="donut-card"><div><div class="donut" style="--pickup-angle:${pickupAngle}deg"><div class="donut-center"><strong>${restaurant.orders}</strong><span>órdenes</span></div></div><div class="donut-legend"><span>● Pickup ${restaurant.pickup_orders}</span><span>● Delivery ${restaurant.delivery_orders}</span></div></div></article></section><section class="analytics-section"><div class="section-heading"><div><h2>Órdenes recientes</h2><p>Datos combinados de pedidos y deliveries</p></div></div>${recentOrdersTable(snapshot.latest_orders || [])}</section>`;
      hydrateIcons(selectors.main());
      bindRangeControls(() => renderAnalyticsDetail(id));
    } catch (error) {
      renderError(error, () => renderAnalyticsDetail(id));
    }
  }

  function restaurantRows(restaurants) {
    if (!restaurants.length) {
      return `<div class="empty-state"><div><span class="empty-icon"><span data-icon="search"></span></span><h3>No encontramos restaurantes</h3><p>Prueba con otro nombre o cambia el filtro seleccionado.</p></div></div>`;
    }

    return restaurants.map(restaurant => `
      <div class="restaurant-row">
        <a class="entity row-link" href="/admin/restaurants/${restaurant.id}" data-admin-link>
          ${entityAvatar(restaurant)}
          <span><strong>${escapeHtml(restaurant.nombre)}</strong><span>ID #${restaurant.id}</span></span>
        </a>
        <span class="row-meta" title="${escapeHtml(restaurant.woo_url || '')}">${escapeHtml(restaurant.woo_url || 'Woo sin configurar')}</span>
        <span class="status-pill ${restaurant.activo ? '' : 'inactive'}">${restaurant.activo ? 'Activo' : 'Inactivo'}</span>
        <span class="row-meta">${formatDate(restaurant.updated_at || restaurant.created_at)}</span>
        <a class="icon-button row-action" href="/admin/restaurants/${restaurant.id}" data-admin-link aria-label="Configurar ${escapeHtml(restaurant.nombre)}"><span data-icon="arrow"></span></a>
      </div>`).join('');
  }

  function filterRestaurants() {
    const query = String(document.getElementById('restaurantSearch')?.value || '').trim().toLowerCase();
    const status = document.getElementById('restaurantStatus')?.value || 'all';
    const filtered = state.restaurants.filter(restaurant => {
      const matchesText = !query || String(restaurant.nombre || '').toLowerCase().includes(query) || String(restaurant.woo_url || '').toLowerCase().includes(query) || String(restaurant.id).includes(query);
      const matchesStatus = status === 'all' || (status === 'active' ? restaurant.activo : !restaurant.activo);
      return matchesText && matchesStatus;
    });
    document.getElementById('restaurantTableBody').innerHTML = restaurantRows(filtered);
    hydrateIcons(document.getElementById('restaurantTableBody'));
  }

  async function renderRestaurants({ openCreate = false } = {}) {
    renderLoading();
    try {
      state.restaurants = await fetchJson('/admin/restaurantes-resumen');
      selectors.main().innerHTML = `
        <header class="page-header">
          <div>
            <p class="eyebrow">Directorio</p>
            <h1 class="page-title">Restaurantes</h1>
            <p class="page-description">Gestiona las cuentas y abre la configuración individual de cada restaurante.</p>
          </div>
          <button class="button" type="button" id="newRestaurantButton"><span data-icon="plus"></span>Nuevo restaurante</button>
        </header>
        <div class="toolbar">
          <label class="search-box">
            <span data-icon="search" aria-hidden="true"></span>
            <input id="restaurantSearch" type="search" placeholder="Buscar por nombre, ID o URL Woo…" autocomplete="off">
          </label>
          <select class="filter-select" id="restaurantStatus" aria-label="Filtrar por estado">
            <option value="all">Todos los estados</option>
            <option value="active">Activos</option>
            <option value="inactive">Inactivos</option>
          </select>
        </div>
        <section class="data-table" aria-label="Lista de restaurantes">
          <div class="table-head"><span>Restaurante</span><span>WooCommerce</span><span>Estado</span><span>Actualización</span><span></span></div>
          <div id="restaurantTableBody">${restaurantRows(state.restaurants)}</div>
        </section>`;
      hydrateIcons(selectors.main());
      document.getElementById('restaurantSearch').addEventListener('input', filterRestaurants);
      document.getElementById('restaurantStatus').addEventListener('change', filterRestaurants);
      document.getElementById('newRestaurantButton').addEventListener('click', showCreateRestaurant);
      if (openCreate) showCreateRestaurant();
    } catch (error) {
      renderError(error, () => renderRestaurants());
    }
  }

  function showCreateRestaurant() {
    openModal(`
      <div class="modal-header">
        <div><h2>Nuevo restaurante</h2><p>Crea la cuenta y registra su configuración inicial.</p></div>
        <button class="icon-button" type="button" data-close-modal aria-label="Cerrar"><span data-icon="close"></span></button>
      </div>
      <div class="modal-body">
        <form id="createRestaurantForm">
          <div class="form-grid">
            <div class="field full"><label for="nombre">Nombre del restaurante</label><input id="nombre" name="nombre" required maxlength="160" autofocus placeholder="Ej. La Bonita Downtown"></div>
            <div class="field"><label for="logo">URL del logo</label><input id="logo" name="logo_url" type="url" placeholder="https://…"></div>
            <div class="field"><label for="woo">Woo URL</label><input id="woo" name="woo_url" type="url" placeholder="https://mitienda.com"></div>
            <div class="field"><label for="ck">Consumer Key</label><input id="ck" name="consumer_key" type="password" autocomplete="new-password" placeholder="ck_…"></div>
            <div class="field"><label for="cs">Consumer Secret</label><input id="cs" name="consumer_secret" type="password" autocomplete="new-password" placeholder="cs_…"></div>
            <div class="field full"><label for="shipday">Shipday API</label><input id="shipday" name="shipday_api" type="password" autocomplete="new-password" placeholder="Clave de integración"></div>
          </div>
          <div class="modal-footer">
            <button class="button secondary" type="button" data-close-modal>Cancelar</button>
            <button class="button" type="submit"><span data-icon="plus"></span>Crear restaurante</button>
          </div>
        </form>
      </div>`);
    selectors.modal().querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', closeModal));
    document.getElementById('createRestaurantForm').addEventListener('submit', crearRestaurante);
  }

  async function crearRestaurante(event) {
    event?.preventDefault?.();
    const form = event?.currentTarget || document.getElementById('createRestaurantForm');
    if (!form || !form.reportValidity()) return;
    const submit = form.querySelector('[type="submit"]');
    const values = Object.fromEntries(new FormData(form).entries());
    setButtonLoading(submit, true, 'Creando…');
    try {
      await fetchJson('/admin/restaurantes', {
        method: 'POST',
        body: JSON.stringify({
          nombre: values.nombre,
          logo_url: values.logo_url,
          woo_url: values.woo_url,
          consumer_key: values.consumer_key,
          consumer_secret: values.consumer_secret,
          shipday_api: values.shipday_api
        })
      });
      closeModal();
      toast('Restaurante creado correctamente.');
      await renderRestaurants();
    } catch (error) {
      toast(error.message, 'error');
      setButtonLoading(submit, false);
    }
  }

  function secretStatus(value) {
    return value
      ? `<span class="secret-current" title="Valor almacenado enmascarado">${escapeHtml(value)}</span>`
      : '<span class="secret-current unset">Sin configurar</span>';
  }

  function secretField({ id, label, value, placeholder, generate }) {
    return `<div class="field full">
      <label for="${id}"><span>${escapeHtml(label)}</span>${secretStatus(value)}</label>
      <div class="secret-row">
        <input id="${id}" name="${id}" type="password" autocomplete="new-password" placeholder="${escapeHtml(placeholder)}">
        ${generate ? `<button class="button secondary compact" type="button" data-generate-secret="${id}"><span data-icon="key"></span>Generar</button>` : ''}
      </div>
      <p class="field-help">Déjalo vacío para conservar el valor actual.</p>
    </div>`;
  }

  async function renderRestaurantDetail(id) {
    renderLoading();
    try {
      const restaurant = await fetchJson(`/admin/restaurantes/${id}`);
      const title = escapeHtml(restaurant.nombre);
      selectors.main().innerHTML = `
        <div class="breadcrumbs"><a href="/admin/restaurants" data-admin-link>Restaurantes</a><span>›</span><span>${title}</span></div>
        <header class="page-header">
          <div class="detail-heading">
            ${entityAvatar(restaurant)}
            <div><p class="eyebrow">Configuración · ID #${restaurant.id}</p><h1 class="page-title">${title}</h1></div>
          </div>
          <span class="status-pill ${restaurant.activo ? '' : 'inactive'}">${restaurant.activo ? 'Activo' : 'Inactivo'}</span>
        </header>

        <form id="restaurantConfigForm" class="configuration-layout">
          <div class="settings-stack">
            <section class="settings-card">
              <div class="settings-heading"><div><h2>Información general</h2><p>Identidad y dirección principal de la tienda.</p></div></div>
              <div class="form-grid">
                <div class="field"><label for="restaurantName">Nombre</label><input id="restaurantName" name="nombre" required value="${title}"></div>
                <div class="field"><label for="restaurantLogo">URL del logo</label><input id="restaurantLogo" name="logo_url" type="url" value="${escapeHtml(restaurant.logo_url || '')}" placeholder="https://…"></div>
                <div class="field full"><label for="restaurantWoo">Woo URL</label><input id="restaurantWoo" name="woo_url" type="url" value="${escapeHtml(restaurant.woo_url || '')}" placeholder="https://mitienda.com"></div>
              </div>
            </section>

            <section class="settings-card">
              <div class="settings-heading"><div><h2>WooCommerce</h2><p>Credenciales privadas para sincronizar pedidos y productos.</p></div></div>
              <div class="form-grid">
                ${secretField({ id: 'consumer_key', label: 'Consumer Key', value: restaurant.consumer_key, placeholder: 'Nueva Consumer Key' })}
                ${secretField({ id: 'consumer_secret', label: 'Consumer Secret', value: restaurant.consumer_secret, placeholder: 'Nuevo Consumer Secret' })}
              </div>
            </section>

            <section class="settings-card">
              <div class="settings-heading"><div><h2>Shipday</h2><p>Acceso privado al servicio de entregas.</p></div></div>
              <div class="form-grid">
                ${secretField({ id: 'shipday_api', label: 'Shipday API', value: restaurant.shipday_api, placeholder: 'Nueva clave Shipday' })}
              </div>
            </section>

            <section class="settings-card">
              <div class="settings-heading">
                <div><h2>Webhooks y secretos</h2><p>Claves de validación exclusivas de este restaurante.</p></div>
                <button class="button secondary compact" type="button" id="generateAllSecrets"><span data-icon="key"></span>Generar los tres</button>
              </div>
              <div class="form-grid">
                ${secretField({ id: 'webhook_token', label: 'Webhook token', value: restaurant.webhook_token, placeholder: 'Nuevo webhook token', generate: true })}
                ${secretField({ id: 'woo_webhook_secret', label: 'Woo webhook secret', value: restaurant.woo_webhook_secret, placeholder: 'Nuevo secreto Woo', generate: true })}
                ${secretField({ id: 'shipday_webhook_secret', label: 'Shipday webhook secret', value: restaurant.shipday_webhook_secret, placeholder: 'Nuevo secreto Shipday', generate: true })}
              </div>
            </section>

            <section class="settings-card">
              <div class="settings-heading"><div><h2>Estado de la cuenta</h2><p>Controla si el restaurante puede operar en la plataforma.</p></div></div>
              <div class="toggle-line">
                <div class="toggle-copy"><strong>Restaurante activo</strong><span>Permite el acceso y los flujos operativos.</span></div>
                <label class="switch"><input id="restaurantActive" name="activo" type="checkbox" ${restaurant.activo ? 'checked' : ''}><span></span></label>
              </div>
              <div class="settings-footer">
                <a class="button secondary" href="/admin/restaurants" data-admin-link>Cancelar</a>
                <button class="button" type="submit"><span data-icon="check"></span>Guardar cambios</button>
              </div>
            </section>
          </div>

          <aside class="detail-aside">
            <section class="info-card">
              <h3>Información de la cuenta</h3>
              <dl class="info-list">
                <div><dt>ID interno</dt><dd>#${restaurant.id}</dd></div>
                <div><dt>Creado</dt><dd>${formatDate(restaurant.created_at, { long: true })}</dd></div>
                <div><dt>Actualizado</dt><dd>${formatDate(restaurant.updated_at, { long: true })}</dd></div>
                <div><dt>Estado</dt><dd>${restaurant.activo ? 'Activo' : 'Inactivo'}</dd></div>
              </dl>
            </section>
            <section class="info-card security-note">
              <h3>Datos protegidos</h3>
              <p>Las credenciales solo están disponibles en esta configuración y el servidor nunca devuelve sus valores completos.</p>
            </section>
          </aside>
        </form>`;
      hydrateIcons(selectors.main());
      document.getElementById('restaurantConfigForm').addEventListener('submit', event => guardarRestaurante(event, restaurant.id));
      document.getElementById('generateAllSecrets').addEventListener('click', () => generarSecretos(restaurant.id));
      document.querySelectorAll('[data-generate-secret]').forEach(button => {
        button.addEventListener('click', () => generarSecretos(restaurant.id, [button.dataset.generateSecret]));
      });
    } catch (error) {
      renderError(error, () => renderRestaurantDetail(id));
    }
  }

  async function guardarRestaurante(event, id) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const submit = form.querySelector('[type="submit"]');
    const payload = {
      nombre: form.elements.nombre.value,
      logo_url: form.elements.logo_url.value,
      woo_url: form.elements.woo_url.value,
      activo: form.elements.activo.checked
    };

    ['consumer_key', 'consumer_secret', 'shipday_api', 'webhook_token', 'woo_webhook_secret', 'shipday_webhook_secret'].forEach(field => {
      const value = form.elements[field].value.trim();
      if (value) payload[field] = value;
    });

    setButtonLoading(submit, true);
    try {
      await fetchJson(`/admin/restaurantes/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      toast('Configuración guardada correctamente.');
      await renderRestaurantDetail(id);
    } catch (error) {
      toast(error.message, 'error');
      setButtonLoading(submit, false);
    }
  }

  function editarRestaurante(id) {
    const parsed = Number(id);
    if (Number.isInteger(parsed) && parsed > 0) navigate(`/admin/restaurants/${parsed}`);
  }

  async function generarSecretos(id, fields) {
    const count = Array.isArray(fields) ? fields.length : 3;
    const accepted = await confirmAction({
      title: count === 1 ? 'Generar un nuevo secreto' : 'Generar nuevos secretos',
      message: `Esta acción <strong>reemplazará ${count === 1 ? 'el valor actual' : 'los tres valores actuales'}</strong>. Las integraciones que usen las claves anteriores deberán actualizarse.`,
      confirmLabel: 'Generar ahora',
      danger: true
    });
    if (!accepted) return;

    try {
      await fetchJson(`/admin/restaurantes/${id}/generar-secretos`, {
        method: 'POST',
        body: JSON.stringify(Array.isArray(fields) ? { fields } : {})
      });
      toast(count === 1 ? 'Secreto generado correctamente.' : 'Los tres secretos fueron generados.');
      await renderRestaurantDetail(Number(id));
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function userRows(users) {
    if (!users.length) {
      return `<div class="empty-state"><div><span class="empty-icon"><span data-icon="users"></span></span><h3>Aún no hay usuarios</h3><p>Crea un acceso y asígnalo a un restaurante activo.</p></div></div>`;
    }
    return users.map(user => `
      <div class="user-row">
        <div class="entity"><span class="entity-avatar">${escapeHtml(initials(user.email))}</span><span><strong>${escapeHtml(user.email)}</strong><span>Usuario #${Number(user.id)}</span></span></div>
        <span class="row-meta">${escapeHtml(user.nombre || 'Restaurante no disponible')}</span>
        <span class="row-meta">ID #${Number(user.restaurante_id)}</span>
      </div>`).join('');
  }

  async function renderUsers() {
    renderLoading();
    try {
      const [users, restaurants] = await Promise.all([
        fetchJson('/admin/usuarios'),
        fetchJson('/admin/restaurantes-resumen')
      ]);
      state.users = users;
      state.restaurants = restaurants;
      selectors.main().innerHTML = `
        <header class="page-header">
          <div>
            <p class="eyebrow">Accesos</p>
            <h1 class="page-title">Usuarios</h1>
            <p class="page-description">Administra los accesos asociados a cada restaurante.</p>
          </div>
          <button class="button" type="button" id="newUserButton"><span data-icon="userPlus"></span>Nuevo usuario</button>
        </header>
        <section class="panel users-panel">
          <div class="panel-header"><div><h2>Usuarios registrados</h2><p>${users.length} ${users.length === 1 ? 'acceso creado' : 'accesos creados'}</p></div></div>
          <div class="user-list">${userRows(users)}</div>
        </section>`;
      hydrateIcons(selectors.main());
      document.getElementById('newUserButton').addEventListener('click', showCreateUser);
    } catch (error) {
      renderError(error, renderUsers);
    }
  }

  function showCreateUser() {
    const activeRestaurants = state.restaurants.filter(restaurant => restaurant.activo);
    openModal(`
      <div class="modal-header">
        <div><h2>Nuevo usuario</h2><p>Crea un acceso y asígnalo a un restaurante activo.</p></div>
        <button class="icon-button" type="button" data-close-modal aria-label="Cerrar"><span data-icon="close"></span></button>
      </div>
      <div class="modal-body">
        <form id="createUserForm">
          <div class="form-grid">
            <div class="field full"><label for="emailUser">Correo o usuario</label><input id="emailUser" name="email" required maxlength="254" autofocus autocomplete="off" placeholder="operaciones@restaurante.com"></div>
            <div class="field full"><label for="passUser">Contraseña</label><input id="passUser" name="password" type="password" required minlength="8" autocomplete="new-password" placeholder="Mínimo 8 caracteres"></div>
            <div class="field full"><label for="restUser">Restaurante</label><select id="restUser" name="restaurante_id" required><option value="">Selecciona un restaurante</option>${activeRestaurants.map(restaurant => `<option value="${restaurant.id}">${escapeHtml(restaurant.nombre)} · ID #${restaurant.id}</option>`).join('')}</select></div>
          </div>
          ${activeRestaurants.length ? '' : '<p class="confirm-copy">No hay restaurantes activos disponibles. Activa uno antes de crear el usuario.</p>'}
          <div class="modal-footer">
            <button class="button secondary" type="button" data-close-modal>Cancelar</button>
            <button class="button" type="submit" ${activeRestaurants.length ? '' : 'disabled'}><span data-icon="userPlus"></span>Crear usuario</button>
          </div>
        </form>
      </div>`);
    selectors.modal().querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', closeModal));
    document.getElementById('createUserForm').addEventListener('submit', crearUsuario);
  }

  async function crearUsuario(event) {
    event?.preventDefault?.();
    const form = event?.currentTarget || document.getElementById('createUserForm');
    if (!form || !form.reportValidity()) return;
    const submit = form.querySelector('[type="submit"]');
    const values = Object.fromEntries(new FormData(form).entries());
    setButtonLoading(submit, true, 'Creando…');
    try {
      await fetchJson('/admin/usuarios', {
        method: 'POST',
        body: JSON.stringify({
          email: values.email,
          password: values.password,
          restaurante_id: values.restaurante_id
        })
      });
      closeModal();
      toast('Usuario creado correctamente.');
      await renderUsers();
    } catch (error) {
      toast(error.message, 'error');
      setButtonLoading(submit, false);
    }
  }

  function setLiveStatus(status) {
    const indicator = document.getElementById('liveIndicator');
    if (!indicator) return;
    indicator.className = `live-indicator ${status === 'live' ? '' : status}`;
    indicator.querySelector('span').textContent = status === 'live' ? 'LIVE' : status === 'offline' ? 'OFFLINE' : 'CONNECTING';
    const mobile = document.getElementById('mobileLiveIndicator');
    mobile?.classList.toggle('live', status === 'live');
    if (mobile) mobile.title = status === 'live' ? 'Actualizaciones en vivo' : 'Reconectando actualizaciones';
  }

  function pulseLiveIndicator() {
    const indicator = document.getElementById('liveIndicator');
    if (!indicator) return;
    indicator.classList.remove('pulse');
    void indicator.offsetWidth;
    indicator.classList.add('pulse');
  }

  function isAnalyticsRoute() {
    return window.location.pathname === '/admin' || /^\/admin\/analytics\/restaurants\/\d+$/.test(window.location.pathname);
  }

  async function refreshAnalyticsView({ liveUpdate = false } = {}) {
    if (!isAnalyticsRoute() || document.hidden) return;
    const detail = window.location.pathname.match(/^\/admin\/analytics\/restaurants\/(\d+)$/);
    const refreshButtons = document.querySelectorAll('[data-refresh-dashboard]');
    refreshButtons.forEach(button => button.classList.add('spinning'));
    try {
      if (detail) await renderAnalyticsDetail(Number(detail[1]), false);
      else {
        const snapshot = await fetchJson(`/admin/api/dashboard?${analyticsQuery()}`);
        renderOverviewSnapshot(snapshot, { liveUpdate });
      }
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      refreshButtons.forEach(button => button.classList.remove('spinning'));
    }
  }

  function scheduleAnalyticsRefresh() {
    window.clearTimeout(state.analyticsRefreshTimer);
    state.analyticsRefreshTimer = window.setTimeout(() => refreshAnalyticsView({ liveUpdate: true }), 700);
  }

  function startFallbackRefresh() {
    if (state.fallbackRefreshTimer) return;
    state.fallbackRefreshTimer = window.setInterval(() => {
      if (isAnalyticsRoute() && !document.hidden) refreshAnalyticsView();
    }, 15000);
  }

  function stopFallbackRefresh() {
    window.clearInterval(state.fallbackRefreshTimer);
    state.fallbackRefreshTimer = null;
  }

  function handleAdminEvent(event) {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    pulseLiveIndicator();
    state.highlightedRestaurantId = payload.restaurante_id;
    if (payload.type === 'order_created' && state.snapshot && window.location.pathname === '/admin') {
      const restaurant = state.snapshot.restaurants?.find(item => item.id === Number(payload.restaurante_id));
      const incoming = {
        ...payload.order,
        restaurante_id: Number(payload.restaurante_id),
        restaurante_nombre: restaurant?.nombre || 'Restaurante',
        restaurante_logo_url: restaurant?.logo_url || null,
        refunded: false,
        refund_amount: 0
      };
      state.snapshot.latest_orders = [incoming, ...(state.snapshot.latest_orders || []).filter(order => !(order.restaurante_id === incoming.restaurante_id && String(order.woo_order_id) === String(incoming.woo_order_id)))].slice(0, 25);
      const feed = document.getElementById('liveOrders');
      if (feed) feed.innerHTML = liveOrderRows(state.snapshot.latest_orders, true);
    }
    scheduleAnalyticsRefresh();
  }

  function connectAdminEvents() {
    if (!window.EventSource || state.eventSource) return startFallbackRefresh();
    window.clearTimeout(state.eventReconnectTimer);
    setLiveStatus('connecting');
    const source = new EventSource('/admin/events');
    state.eventSource = source;
    source.addEventListener('connected', () => {
      state.eventReconnectAttempt = 0;
      setLiveStatus('live');
      stopFallbackRefresh();
    });
    ['order_created', 'order_updated', 'restaurant_status_changed', 'refund_updated', 'delivery_updated'].forEach(type => source.addEventListener(type, handleAdminEvent));
    source.onerror = () => {
      source.close();
      state.eventSource = null;
      setLiveStatus('offline');
      startFallbackRefresh();
      const delay = Math.min(30000, 1000 * (2 ** state.eventReconnectAttempt));
      state.eventReconnectAttempt += 1;
      state.eventReconnectTimer = window.setTimeout(connectAdminEvents, delay);
    };
  }

  async function renderRoute() {
    updateNavigation();
    selectors.main().focus({ preventScroll: true });
    const path = window.location.pathname.replace(/\/+$/, '') || '/admin';
    const analyticsDetail = path.match(/^\/admin\/analytics\/restaurants\/(\d+)$/);
    if (analyticsDetail) return renderAnalyticsDetail(Number(analyticsDetail[1]));
    const detail = path.match(/^\/admin\/restaurants\/(\d+)$/);
    if (detail) return renderRestaurantDetail(Number(detail[1]));
    if (path === '/admin/restaurants') return renderRestaurants();
    if (path === '/admin/users') return renderUsers();
    if (path !== '/admin') return navigate('/admin', { replace: true });
    return renderOverview();
  }

  async function logout() {
    const accepted = await confirmAction({
      title: 'Cerrar sesión',
      message: '¿Quieres salir del panel administrativo?',
      confirmLabel: 'Cerrar sesión'
    });
    if (!accepted) return;
    try {
      await fetchJson('/logout', { method: 'POST' });
    } finally {
      window.location.replace('/');
    }
  }

  function bindShell() {
    document.addEventListener('click', event => {
      const link = event.target.closest('a[href^="/admin"]');
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      const url = new URL(link.href, window.location.origin);
      navigate(url.pathname);
    });
    document.getElementById('menuButton').addEventListener('click', () => {
      document.getElementById('sidebar').classList.add('open');
      document.getElementById('sidebarScrim').hidden = false;
    });
    document.getElementById('sidebarScrim').addEventListener('click', closeSidebar);
    document.getElementById('logoutButton').addEventListener('click', logout);
    document.querySelectorAll('[data-refresh-dashboard]').forEach(button => button.addEventListener('click', () => {
      if (isAnalyticsRoute()) refreshAnalyticsView();
      else renderRoute();
    }));
    window.addEventListener('popstate', renderRoute);
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && selectors.modal().childElementCount) closeModal();
    });
  }

  async function iniciarAdmin() {
    hydrateIcons();
    bindShell();
    try {
      const session = await fetchJson('/session');
      if (!session?.authenticated || String(session.user?.rol || '').toLowerCase() !== 'admin') {
        throw new Error('Se requiere una sesión administrativa.');
      }
      state.session = session;
      state.csrfToken = session.csrf_token || '';
      const email = session.user?.email || 'Administrador';
      const avatar = initials(email);
      document.getElementById('topbarDate').textContent = new Intl.DateTimeFormat('es-EC', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
      document.getElementById('profileEmail').textContent = email;
      document.getElementById('profileName').textContent = 'Administrador';
      document.getElementById('profileAvatar').textContent = avatar;
      document.getElementById('mobileAvatar').textContent = avatar;
      document.getElementById('topbarAvatar').textContent = avatar;
      document.getElementById('topbarUser').textContent = email;
      selectors.loader().hidden = true;
      selectors.app().hidden = false;
      connectAdminEvents();
      await renderRoute();
    } catch (error) {
      if (!window.location.pathname.startsWith('/admin')) return;
      selectors.loader().innerHTML = `<section class="error-state"><span class="metric-icon"><span data-icon="alert"></span></span><h1>Acceso no disponible</h1><p>${escapeHtml(error.message)}</p><a class="button" href="/">Volver al inicio</a></section>`;
      hydrateIcons(selectors.loader());
    }
  }

  window.DenixAdmin = {
    crearRestaurante,
    editarRestaurante,
    generarSecretos,
    crearUsuario
  };

  // Compatibilidad con las acciones globales del panel anterior.
  window.editarRestaurante = id => window.DenixAdmin.editarRestaurante(id);
  window.generarSecretos = id => window.DenixAdmin.generarSecretos(id);
  window.crearRestaurante = event => window.DenixAdmin.crearRestaurante(event);
  window.crearUsuario = event => window.DenixAdmin.crearUsuario(event);

  iniciarAdmin();
})();
