/**
 * OmniView Dashboard — Stage 2
 * Dynamic statistics and FastAPI backend integration
 *
 * Public interface:
 *   window.OmniViewDashboard = {
 *     init,
 *     renderDashboard,
 *     updateDashboard,
 *     renderAnalytics,
 *     destroy
 *   };
 *
 * Backend contract (verified):
 *   GET /venues  ->  list[VenueOut] with fields:
 *     { id, name, capacity, occupancy, available_capacity,
 *       occupancy_percentage, status, is_active, created_at, updated_at }
 *     status: NORMAL | MODERATE | WARNING | CRITICAL | OVERCROWDED
 *
 *   GET /announcements?active_only=true  ->  list[AnnouncementOut] with fields:
 *     { id, message, type, venue_id, active, created_at }
 *     type: INFO | WARNING | REDIRECT | EMERGENCY
 *
 * Occupancy mapping (configurable):
 *   venue.occupancy  ->  current_count
 *   status: NORMAL -> safe | MODERATE -> warning | WARNING -> warning |
 *            CRITICAL -> critical | OVERCROWDED -> critical
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Private module state
  // ---------------------------------------------------------------------------
  const state = {
    root: null,
    zones: [],
    totalAttendees: 0,
    activeZones: 0,
    overallOccupancy: 0,
    activeAlerts: 0,
    lastUpdateTime: null,
    // Chart instances — cleaned up in destroy()
    charts: {
      trend: null,
      distribution: null,
      comparison: null,
    },
    // Crowd trend history built from the live polls of this session.
    // One sample per refresh cycle (5s), oldest first, capped below.
    sessionHistory: [],
    // Test counters
    testHistoryFilterCounts: {},
    // Timer reference for the 5-second refresh cycle
    refreshTimer: null,
    // Polling state — prevents overlapping requests during refresh
    polling: false,
  };

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------
  const CONFIG = {
    // API base URL — "" means same origin (FastAPI serves this page).
    // apiGet() below falls back to http://127.0.0.1:8000 when that fails.
    apiBase: '',
    // Refresh interval in milliseconds (5 seconds)
    refreshIntervalMs: 5000,
    // How many trend samples to keep (≈35 minutes at one sample per 5s).
    maxHistorySamples: 420,
  };

  /** Records the current total attendance so the trend chart grows from real data. */
  function recordSample(total) {
    const total_ = ensureNumber(total, 0);
    const history = state.sessionHistory;
    const last = history[history.length - 1];
    const stamp = Date.now();
    // Ignore duplicate samples (same total within the same second).
    if (last && last.total === total_ && stamp - new Date(last.timestamp).getTime() < 2000) return;
    history.push({ timestamp: new Date(stamp).toISOString(), total: total_ });
    if (history.length > CONFIG.maxHistorySamples) {
      history.splice(0, history.length - CONFIG.maxHistorySamples);
    }
  }

  // ---------------------------------------------------------------------------
  // Status mapping — configurable, mirrors backend classifications
  // ---------------------------------------------------------------------------
  const STATUS_MAP = {
    normal: 'safe',
    moderate: 'warning',
    warning: 'warning',
    critical: 'critical',
    overcrowded: 'critical',
  };

  const STATUS_LABEL = {
    safe: 'Safe',
    warning: 'Warning',
    critical: 'Critical',
  };

  const STATUS_BG = {
    safe: 'ok',
    warning: 'warning',
    critical: 'critical',
  };

  // Backend has no explicit alert/severity field, so we derive active alert
  // counts from announcement types. See getActiveAlertCount().
  const ANNOUNCEMENT_TYPES = {
    info: 'INFO',
    warning: 'WARNING',
    redirect: 'REDIRECT',
    emergency: 'EMERGENCY',
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function ensureNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function calcOccupancy(current, capacity) {
    const c = ensureNumber(current, 0);
    const cap = ensureNumber(capacity, 1);
    if (cap <= 0) return 0;
    return (c / cap) * 100;
  }

  function normalizeStatus(status) {
    const key = String(status || '').toLowerCase().trim();
    return STATUS_MAP[key] || 'safe';
  }

  function getStatusLabel(status) {
    return STATUS_LABEL[status] || 'Safe';
  }

  function getStatusBgClass(status) {
    return STATUS_BG[status] || 'ok';
  }

  // ---------------------------------------------------------------------------
  // Chart.js helpers
  // ---------------------------------------------------------------------------
  function getZoneColors() {
    return [
      '#3B82F6', // Main Stage
      '#22D3EE', // Food Court
      '#2ECC71', // Gaming Arena
      '#F1C40F', // Registration Area
      '#E74C3C', // Exhibition Hall
      '#A78BFA', // VIP Lounge
    ];
  }

  function getStatusColorClass(status) {
    return status === 'critical' ? 'red' : status === 'warning' ? 'yellow' : 'green';
  }

  // ---------------------------------------------------------------------------
  // Fetch real data from the FastAPI backend
  // ---------------------------------------------------------------------------
  // Try the page's own origin first, then the local dev server (useful when
  // the file is opened directly or hosted on a different port).
  const API_FALLBACK = 'http://127.0.0.1:8000';
  let resolvedApiBase = null;

  async function apiGet(path) {
    const candidates = resolvedApiBase != null ? [resolvedApiBase] : [CONFIG.apiBase, API_FALLBACK];
    let lastError = null;

    for (const base of candidates) {
      try {
        const response = await fetch(`${base}${path}`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${path}`);
        }
        resolvedApiBase = base;
        return await response.json();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`Request failed: ${path}`);
  }

  async function fetchZones() {
    return apiGet('/venues');
  }

  async function fetchAlerts() {
    return apiGet('/announcements?active_only=true');
  }

  // ---------------------------------------------------------------------------
  // Derive dashboard statistics from the backend data
  // ---------------------------------------------------------------------------
  function computeStats(zones, announcements) {
    const total = zones.reduce((sum, z) => sum + ensureNumber(z.occupancy, 0), 0);
    const totalCapacity = zones.reduce((sum, z) => sum + ensureNumber(z.capacity, 0), 0);
    const overallOccupancy = totalCapacity > 0 ? (total / totalCapacity) * 100 : 0;

    // Active zones: backend's _all_venues() returns all venues. There is no
    // explicit "active" flag on venues in the response. The backend's
    // `is_active` indicates open/closed business hours, not an occupancy
    // alert. We use total venue count as "active zones" with a clear label.
    const activeZones = zones.length;

    // Active alerts: backend has no severity field, so we count announcements
    // that are active AND security-relevant (WARNING, REDIRECT, EMERGENCY).
    // INFO announcements are general notices, not safety alerts.
    let alertCount = 0;
    let alertsCritical = 0;
    let alertsWarning = 0;
    if (Array.isArray(announcements)) {
      announcements.forEach((a) => {
        if (a.active && a.type && a.type !== 'INFO') {
          alertCount += 1;
          if (a.type === 'EMERGENCY' || a.type === 'REDIRECT') {
            alertsCritical += 1;
          } else {
            alertsWarning += 1;
          }
        }
      });
    }

    return {
      totalAttendees: total,
      totalCapacity,
      activeZones,
      openZones: zones.filter((z) => z.is_active === true).length,
      overallOccupancy: Math.round(overallOccupancy * 100) / 100,
      activeAlerts: alertCount,
      alertsCritical,
      alertsWarning,
    };
  }

  // ---------------------------------------------------------------------------
  // Render the statistics cards
  // ---------------------------------------------------------------------------
  function renderStats(stats) {
    const root = state.root;
    if (!root) return;

    const el = (id) => root.querySelector(`#${id}`);
    const set = (id, text) => { const node = el(id); if (node) node.textContent = text; };

    set('yash-stat-total', stats.totalAttendees.toLocaleString());
    set('yash-stat-total-sub', `Across ${stats.activeZones} zone(s)`);
    set('yash-stat-active-zones', stats.activeZones);
    set('yash-stat-zones-sub', stats.openZones != null ? `${stats.openZones} open right now` : 'All zones reporting');
    set('yash-stat-occupancy', stats.overallOccupancy + '%');
    set('yash-stat-occupancy-sub', `Of ${(stats.totalCapacity || 0).toLocaleString()} total capacity`);
    set('yash-stat-alerts', stats.activeAlerts);
    set('yash-stat-alerts-sub', `${stats.alertsCritical || 0} critical, ${stats.alertsWarning || 0} warning`);

    // Centre label of the doughnut chart
    const centre = root.querySelector('.yash-chart-center-label');
    if (centre) centre.textContent = `${stats.totalAttendees.toLocaleString()} attendees`;
  }

  // ---------------------------------------------------------------------------
  // Render occupancy summary cards from live venue data
  // ---------------------------------------------------------------------------
  function renderOccupancyCards(zones) {
    const root = state.root;
    if (!root) return;

    const container = root.querySelector('.yash-occupancy-grid');
    if (!container) return;

    container.innerHTML = '';

    (zones || []).forEach((zone) => {
      const currentCount = ensureNumber(zone.occupancy, 0);
      const capacity = ensureNumber(zone.capacity, 0);
      const occupancyPercentage = calcOccupancy(currentCount, capacity);
      const status = normalizeStatus(zone.status);
      const label = getStatusLabel(status);
      const badgeCls = getStatusBgClass(status);

      const item = document.createElement('div');
      item.className = 'yash-occupancy-item';

      item.innerHTML = `
        <div class="yash-occupancy-body">
          <span class="yash-occupancy-name">${escapeHtml(zone.name)}</span>
          <span class="yash-occupancy-value">${currentCount.toLocaleString()}</span>
          <span class="yash-occupancy-capacity">/ ${capacity.toLocaleString()}</span>
        </div>
        <div class="yash-occupancy-bar">
          <div class="yash-progress yash-level-${status}"
               style="width:${Math.min(Math.max(occupancyPercentage, 0), 100)}%"></div>
        </div>
        <div class="yash-occupancy-label">${occupancyPercentage.toFixed(1)}% <span class="yash-badge yash-badge-${badgeCls}">${label}</span></div>
      `;

      container.appendChild(item);
    });
  }

  // ---------------------------------------------------------------------------
  // Render the full dashboard from backend data
  // ---------------------------------------------------------------------------
  function renderDashboard(data) {
    const root = state.root;
    if (!root) return;

    state.zones = data.zones || [];
    state.totalAttendees = data.stats.totalAttendees || 0;
    state.totalCapacity = data.stats.totalCapacity || 0;
    state.activeZones = data.stats.activeZones || 0;
    state.openZones = data.stats.openZones;
    state.overallOccupancy = data.stats.overallOccupancy || 0;
    state.activeAlerts = data.stats.activeAlerts || 0;
    state.alertsCritical = data.stats.alertsCritical || 0;
    state.alertsWarning = data.stats.alertsWarning || 0;
    state.lastUpdateTime = data.meta?.timestamp || null;

    renderStats(state);
    renderOccupancyCards(state.zones);

    // Draw or update the analytics charts with the latest zone data
    renderAnalytics(data);
  }

  // ---------------------------------------------------------------------------
  // Update dashboard in place (no duplicate creation)
  // ---------------------------------------------------------------------------
  function updateDashboard(data) {
    const root = state.root;
    if (!root) return;

    state.zones = data.zones || [];
    state.totalAttendees = data.stats.totalAttendees || 0;
    state.totalCapacity = data.stats.totalCapacity || 0;
    state.activeZones = data.stats.activeZones || 0;
    state.openZones = data.stats.openZones;
    state.overallOccupancy = data.stats.overallOccupancy || 0;
    state.activeAlerts = data.stats.activeAlerts || 0;
    state.alertsCritical = data.stats.alertsCritical || 0;
    state.alertsWarning = data.stats.alertsWarning || 0;
    state.lastUpdateTime = data.meta?.timestamp || null;

    renderStats(state);
    renderOccupancyCards(state.zones);
  }

  // ---------------------------------------------------------------------------
  // Analytics — Chart.js integration (Stage 3)
  // ---------------------------------------------------------------------------
  function renderAnalytics(history) {
    const root = state.root;
    if (!root) return;

    const zones = state.zones || [];
    if (zones.length === 0) return;

    // Total attendees for center label
    const totalAttendees = zones.reduce((sum, z) => sum + ensureNumber(z.current_count, 0), 0);

    // -------------------------------------------------------------------------
    // CHART 1: Zone Distribution (doughnut chart)
    // -------------------------------------------------------------------------
    const distributionCanvas = root.querySelector('#yash-chart-distribution');
    if (distributionCanvas) {
      const distData = {
        labels: zones.map((z) => z.name),
        datasets: [{
          data: zones.map((z) => ensureNumber(z.current_count, 0)),
          backgroundColor: getZoneColors(),
          borderWidth: 2,
          borderColor: '#080F1F',
        }],
      };

      if (state.charts.distribution) {
        state.charts.distribution.data = distData;
        state.charts.distribution.update();
      } else {
        state.charts.distribution = new Chart(distributionCanvas, {
          type: 'doughnut',
          data: distData,
          options: {
            responsive: true,
            maintainAspectRatio: true,
            cutout: '62%',
            plugins: {
              legend: {
                position: 'right',
                labels: {
                  color: '#E8EAF0',
                  font: { size: 11 },
                  padding: 12,
                  usePointStyle: true,
                  pointStyle: 'circle',
                },
              },
              tooltip: {
                backgroundColor: 'rgba(17, 28, 48, 0.95)',
                titleColor: '#E8EAF0',
                bodyColor: '#8A90A6',
                borderColor: 'rgba(30, 48, 80, 0.5)',
                borderWidth: 1,
                padding: 10,
                cornerRadius: 6,
                callbacks: {
                  label: (ctx) => {
                    const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                    const pct = ((ctx.parsed / total) * 100).toFixed(1);
                    return ` ${ctx.label}: ${ctx.parsed.toLocaleString()} (${pct}%)`;
                  },
                },
              },
              // Source label
              annotation: {
                annotations: {
                  source: {
                    type: 'label',
                    xValue: 'Source',
                    yValue: 'Live session samples',
                    position: 'bottom',
                    backgroundColor: 'rgba(30, 48, 80, 0.75)',
                    borderColor: 'rgba(30, 48, 80, 0.5)',
                    borderWidth: 1,
                    color: '#8A90A6',
                    font: { size: 10, weight: '600' },
                    padding: { x: 8, y: 4 },
                    cornerRadius: 4,
                  },
                },
              },
            },
          },
        });
      }
    }

    // -------------------------------------------------------------------------
    // CHART 2: Zone Occupancy Comparison (bar chart)
    // -------------------------------------------------------------------------
    const comparisonCanvas = root.querySelector('#yash-chart-comparison');
    if (comparisonCanvas) {
      const barData = {
        labels: zones.map((z) => z.name),
        datasets: [{
          label: 'Occupancy %',
          data: zones.map((z) => calcOccupancy(ensureNumber(z.current_count, 0), ensureNumber(z.capacity, 1))),
          backgroundColor: zones.map((z) => {
            const occ = calcOccupancy(ensureNumber(z.current_count, 0), ensureNumber(z.capacity, 1));
            if (occ >= 90) return '#E74C3C';
            if (occ >= 70) return '#F1C40F';
            return '#2ECC71';
          }),
          borderRadius: 4,
          borderSkipped: false,
        }],
      };

      if (state.charts.comparison) {
        state.charts.comparison.data = barData;
        state.charts.comparison.update();
      } else {
        state.charts.comparison = new Chart(comparisonCanvas, {
          type: 'bar',
          data: barData,
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
              legend: {
                display: false,
              },
              tooltip: {
                backgroundColor: 'rgba(17, 28, 48, 0.95)',
                titleColor: '#E8EAF0',
                bodyColor: '#8A90A6',
                borderColor: 'rgba(30, 48, 80, 0.5)',
                borderWidth: 1,
                padding: 10,
                cornerRadius: 6,
                callbacks: {
                  label: (ctx) => {
                    const zone = zones[ctx.dataIndex] || {};
                    const occ = calcOccupancy(ensureNumber(zone.current_count, 0), ensureNumber(zone.capacity, 1));
                    return ` ${occ.toFixed(1)}% (${ensureNumber(zone.current_count, 0).toLocaleString()} / ${ensureNumber(zone.capacity, 0).toLocaleString()})`;
                  },
                },
              },
              annotation: {
                annotations: {
                  source: {
                    type: 'label',
                    xValue: 'Source',
                    yValue: 'Live session samples',
                    position: 'bottom',
                    backgroundColor: 'rgba(30, 48, 80, 0.75)',
                    borderColor: 'rgba(30, 48, 80, 0.5)',
                    borderWidth: 1,
                    color: '#8A90A6',
                    font: { size: 10, weight: '600' },
                    padding: { x: 8, y: 4 },
                    cornerRadius: 4,
                  },
                },
              },
            },
            scales: {
              x: {
                display: true,
                grid: { display: false },
                ticks: {
                  color: '#8A90A6',
                  font: { size: 10 },
                  maxRotation: 45,
                },
                title: {
                  display: true,
                  text: 'Zones',
                  color: '#8A90A6',
                  font: { size: 11, weight: '600' },
                },
              },
              y: {
                display: true,
                grid: {
                  color: 'rgba(30, 48, 80, 0.25)',
                  drawBorder: false,
                },
                ticks: {
                  color: '#8A90A6',
                  font: { size: 10 },
                  callback: (val) => `${val.toFixed(0)}%`,
                },
                title: {
                  display: true,
                  text: 'Occupancy %',
                  color: '#8A90A6',
                  font: { size: 11, weight: '600' },
                },
                min: 0,
                max: 100,
              },
            },
          },
        });
      }
    }

    // -------------------------------------------------------------------------
    // CHART 3: Crowd Occupancy Trends (line chart)
    // -------------------------------------------------------------------------
    // Source: live samples collected while this page is open (one per poll).
    // The backend has no historical occupancy endpoint, so nothing is faked.
    const trendCanvas = root.querySelector('#yash-chart-trend');
    if (trendCanvas) {
      const currentHistory = Array.isArray(history) && history.length > 0
        ? history
        : state.sessionHistory;
      const labels = currentHistory.map((e) => {
        const d = new Date(e.timestamp);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      });
      const data = currentHistory.map((e) => e.total);

      if (state.charts.trend) {
        state.charts.trend.data.labels = labels;
        state.charts.trend.data.datasets[0].data = data;
        state.charts.trend.update();
      } else {
        state.charts.trend = new Chart(trendCanvas, {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: 'Total Attendance',
              data,
              borderColor: '#3B82F6',
              backgroundColor: 'rgba(59, 130, 246, 0.12)',
              fill: true,
              tension: 0.35,
              pointBackgroundColor: '#3B82F6',
              pointBorderColor: '#080F1F',
              pointRadius: 3,
              pointHoverRadius: 6,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
              legend: {
                display: false,
              },
              tooltip: {
                backgroundColor: 'rgba(17, 28, 48, 0.95)',
                titleColor: '#E8EAF0',
                bodyColor: '#8A90A6',
                borderColor: 'rgba(30, 48, 80, 0.5)',
                borderWidth: 1,
                padding: 10,
                cornerRadius: 6,
                callbacks: {
                  label: (ctx) => `Total: ${ctx.parsed.y.toLocaleString()}`,
                },
              },
              annotation: {
                annotations: {
                  source: {
                    type: 'label',
                    xValue: 'Source',
                    yValue: 'Live session samples',
                    position: 'bottom',
                    backgroundColor: 'rgba(30, 48, 80, 0.75)',
                    borderColor: 'rgba(30, 48, 80, 0.5)',
                    borderWidth: 1,
                    color: '#8A90A6',
                    font: { size: 10, weight: '600' },
                    padding: { x: 8, y: 4 },
                    cornerRadius: 4,
                  },
                },
              },
            },
            scales: {
              x: {
                display: true,
                grid: {
                  color: 'rgba(30, 48, 80, 0.25)',
                  drawBorder: false,
                },
                ticks: {
                  color: '#8A90A6',
                  font: { size: 10 },
                  maxTicksLimit: 8,
                  maxRotation: 45,
                },
                title: {
                  display: true,
                  text: 'Time',
                  color: '#8A90A6',
                  font: { size: 11, weight: '600' },
                },
              },
              y: {
                display: true,
                grid: {
                  color: 'rgba(30, 48, 80, 0.25)',
                  drawBorder: false,
                },
                ticks: {
                  color: '#8A90A6',
                  font: { size: 10 },
                  callback: (val) => val.toLocaleString(),
                },
                title: {
                  display: true,
                  text: 'Total Attendees',
                  color: '#8A90A6',
                  font: { size: 11, weight: '600' },
                },
                beginAtZero: true,
              },
            },
            interaction: {
              mode: 'index',
              intersect: false,
            },
          },
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Data refresh loop (5-second interval)
  // ---------------------------------------------------------------------------
  async function fetchData() {
    if (state.polling) return;
    state.polling = true;

    try {
      const [zonesRes, alertsRes] = await Promise.all([
        fetchZones(),
        fetchAlerts(),
      ]);

      const zones = zonesRes || [];
      const announcements = alertsRes || [];

      const stats = computeStats(zones, announcements);

      // Attach timestamps for display
      recordSample(stats.totalAttendees);

      const payload = {
        zones: zones.map((z) => ({
          id: z.id,
          name: z.name,
          capacity: z.capacity,
          // The occupancy cards read `occupancy`, the charts read `current_count`.
          occupancy: z.occupancy,
          current_count: z.occupancy,
          status: normalizeStatus(z.status),
        })),
        stats,
        meta: {
          timestamp: new Date().toISOString(),
          source: 'GET /venues',
        },
      };

      renderDashboard(payload);
      state.lastUpdateTime = new Date().toISOString();
    } catch (error) {
      console.error('Dashboard refresh failed:', error);

      // Show STALE DATA if we have existing data
      if (state.zones.length > 0 && state.root) {
        const root = state.root;
        const staleIndicator = root.querySelector('#yash-data-source-status');
        if (staleIndicator) {
          staleIndicator.textContent = 'STALE DATA';
          staleIndicator.style.color = '#F1C40F';
        }
      }

      // Log error but do not replace live data with demo data
      // The last valid data remains displayed
    } finally {
      state.polling = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Time filter controls (Applicative for line chart)
  // ---------------------------------------------------------------------------
  function setupTimeFilters() {
    const root = state.root;
    if (!root) return;

    const buttons = root.querySelectorAll('.yash-time-filter-btn');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const filter = btn.dataset.filter;
        const filteredHistory = filterHistory(filter);
        renderAnalytics(filteredHistory);
        // Track test metrics
        state.testHistoryFilterCounts[filter] = state.testHistoryFilterCounts[filter] || 0;
        state.testHistoryFilterCounts[filter] += 1;
      });
    });
  }

  function filterHistory(filter) {
    const filtered = [];
    const now = Date.now();
    const filterMinutes = { '30m': 30, '1h': 60, '6h': 360 }[filter] || 60;
    const cutoff = now - filterMinutes * 60000;

    state.sessionHistory.forEach((entry) => {
      const ts = new Date(entry.timestamp).getTime();
      if (ts >= cutoff) {
        filtered.push(entry);
      }
    });

    // Sort chronologically for proper time series
    filtered.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return filtered;
  }
  // ---------------------------------------------------------------------------
  function startRefreshLoop() {
    fetchData();
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
    }
    state.refreshTimer = setInterval(fetchData, CONFIG.refreshIntervalMs);
  }

  function stopRefreshLoop() {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Destroy
  // ---------------------------------------------------------------------------
  function destroy() {
    stopRefreshLoop();
    // Destroy all Chart.js instances to free memory and remove listeners
    Object.values(state.charts).forEach((chart) => {
      if (chart) {
        chart.destroy();
      }
    });
    state.charts = { trend: null, distribution: null, comparison: null };
    state.zones = [];
    state.totalAttendees = 0;
    state.activeZones = 0;
    state.overallOccupancy = 0;
    state.activeAlerts = 0;
    state.lastUpdateTime = null;
    state.polling = false;
  }    // ---------------------------------------------------------------------------
    // Public interface
    // ---------------------------------------------------------------------------
    const OmniViewDashboard = {
      init(rootId) {
        const root = document.querySelector(rootId || '#yash-dashboard-root');
        if (!root) {
          console.error('OmniViewDashboard: root container not found');
          return;
        }
        if (state.root) {
          // Already initialized — avoid duplicate functionality.
          return;
        }
        state.root = root;
        startRefreshLoop();
        setupTimeFilters();
      },

      renderDashboard,
      updateDashboard,
      renderAnalytics,
      destroy,
    };

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  global.OmniViewDashboard = OmniViewDashboard;

})(window);
