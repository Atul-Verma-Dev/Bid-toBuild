/* ============================================================
   OMNI VIEW — ZONE MONITORING MODULE

   Connects to the Smart Event Crowd Management backend:
     GET   /venues                  (public) every 10s
     POST  /auth/login              (demo auth, token in localStorage)
     PATCH /venues/{id}/occupancy   (admin, used by the crowd simulation)

   Falls back to a small local demo dataset when the API is offline.
   ============================================================ */

(function () {
  "use strict";

  // Same-origin first (FastAPI serves this page); fall back to the dev port.
  const API_BASES = ["", "http://127.0.0.1:8000"];
  let API_BASE = "";

  const REFRESH_INTERVAL_MS = 10000;

  const MOCK_ZONES = [
    { id: 1, name: "Main Auditorium", capacity: 800, occupancy: 760, opening_time: "08:00", closing_time: "23:00" },
    { id: 2, name: "Food Court",      capacity: 600, occupancy: 210, opening_time: "08:00", closing_time: "23:00" },
    { id: 3, name: "Tech Expo Hall",  capacity: 600, occupancy: 510, opening_time: "08:00", closing_time: "23:00" },
    { id: 4, name: "Workshop Arena",  capacity: 500, occupancy: 420, opening_time: "08:00", closing_time: "23:00" }
  ];

  const STAFF_POOL_SIZE = 12;
  const STAFF_PER_DEPLOYMENT = 2;

  const state = {
    zones: [],
    focusZoneId: null,
    simulationZoneId: null,
    growth: {},                 // zone id -> last simulated delta
    acknowledged: new Set(),    // alert ids the user dismissed
    staff: { total: STAFF_POOL_SIZE, available: STAFF_POOL_SIZE, deployed: 0 },
    live: false,
    lastSync: null
  };

  /* ------------------------------------------------------------------
     AUTH (shared localStorage keys with the dashboard page)
     ------------------------------------------------------------------ */
  const auth = {
    token: localStorage.getItem("token") || "",
    username: localStorage.getItem("auth_user") || "",
    role: localStorage.getItem("auth_role") || "",
    get isAdmin() { return this.role === "admin"; },
    save(data) {
      this.token = data.access_token;
      this.username = data.username;
      this.role = data.role;
      localStorage.setItem("token", this.token);
      localStorage.setItem("auth_user", this.username);
      localStorage.setItem("auth_role", this.role);
    },
    clear() {
      this.token = this.username = this.role = "";
      localStorage.removeItem("token");
      localStorage.removeItem("auth_user");
      localStorage.removeItem("auth_role");
    }
  };

  /* ------------------------------------------------------------------
     DOM HELPERS
     ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function showToast(message, type = "success") {
    const existing = document.querySelector(".zone-monitor-module__toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = `zone-monitor-module__toast zone-monitor-module__toast--${type}`;
    toast.innerHTML = `
      <span class="zone-monitor-module__toast__icon">${type === "error" ? "⚠️" : type === "success" ? "✅" : "ℹ️"}</span>
      <span class="zone-monitor-module__toast__message">${escapeHtml(message)}</span>
      <button type="button" class="zone-monitor-module__toast__dismiss" aria-label="Dismiss">×</button>`;

    toast.querySelector(".zone-monitor-module__toast__dismiss").addEventListener("click", () => toast.remove());
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = "opacity 0.4s ease, transform 0.4s ease";
      toast.style.opacity = "0";
      toast.style.transform = "translateY(12px)";
      setTimeout(() => toast.remove(), 400);
    }, 4000);
  }

  /* ------------------------------------------------------------------
     API
     ------------------------------------------------------------------ */
  async function apiFetch(path, options = {}) {
    const headers = Object.assign({ Accept: "application/json" }, options.headers || {});
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.auth) headers["Authorization"] = "Bearer " + auth.token;

    const res = await fetch(API_BASE + path, {
      method: options.method || "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });

    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = data && data.detail;
      const message = typeof detail === "string"
        ? detail
        : (detail && detail.message) || `Request failed (${res.status})`;
      const error = new Error(message);
      error.status = res.status;
      throw error;
    }
    return data;
  }

  async function resolveApiBase() {
    for (const base of API_BASES) {
      try {
        const res = await fetch(base + "/health", { cache: "no-store" });
        if (res.ok) { API_BASE = base; return true; }
      } catch (_) { /* try the next base */ }
    }
    return false;
  }

  /* ------------------------------------------------------------------
     DOMAIN LOGIC
     ------------------------------------------------------------------ */

  /** Normalize an API venue (or mock zone) into the shape this page renders. */
  function normalizeZone(raw) {
    return {
      id: raw.id,
      name: raw.name,
      capacity: Number(raw.capacity) || 0,
      occupancy: Number(raw.occupancy != null ? raw.occupancy : raw.current_count) || 0,
      status: raw.status || null,
      available_capacity: raw.available_capacity != null
        ? raw.available_capacity
        : Math.max((Number(raw.capacity) || 0) - (Number(raw.occupancy) || 0), 0),
      opening_time: raw.opening_time || "",
      closing_time: raw.closing_time || "",
      is_active: typeof raw.is_active === "boolean" ? raw.is_active : true
    };
  }

  function occupancyPercentage(zone) {
    if (!zone || !zone.capacity || zone.capacity <= 0) return 0;
    return Math.round((zone.occupancy / zone.capacity) * 1000) / 10;
  }

  /**
   * Severity mirrors the backend thresholds (crowd.py):
   *   <70 NORMAL · 70-84 MODERATE · 85-94 WARNING · 95-100 CRITICAL · >100 OVERCROWDED
   * Live venues keep the status the API computed; local/mock zones derive it.
   */
  function severity(zone) {
    const status = String(zone.status || "").toUpperCase();
    if (status === "OVERCROWDED") return 4;
    if (status === "CRITICAL") return 3;
    if (status === "WARNING") return 2;
    if (status === "MODERATE") return 1;
    if (status === "NORMAL") return 0;

    const pct = occupancyPercentage(zone);
    if (pct > 100) return 4;
    if (pct >= 95) return 3;
    if (pct >= 85) return 2;
    if (pct >= 70) return 1;
    return 0;
  }

  const SEVERITY_LABEL = ["NORMAL", "MODERATE", "WARNING", "CRITICAL", "OVERCROWDED"];

  /** Colour band used by the CSS: safe | warning | critical. */
  function band(zone) {
    const level = severity(zone);
    if (level >= 2) return "critical";
    if (level === 1) return "warning";
    return "safe";
  }

  function statusText(zone) {
    return String(zone.status || SEVERITY_LABEL[severity(zone)]).toUpperCase();
  }

  /** Backend rule: only venues that are not busy and still have free space. */
  function redirectionCandidates(source) {
    return state.zones
      .filter(z => z.id !== source.id
        && severity(z) <= 1
        && z.is_active
        && (z.capacity - z.occupancy) > 0)
      .sort((a, b) => (a.capacity - a.occupancy) - (b.capacity - b.occupancy))
      .map(z => ({
        zone: z,
        free: z.capacity - z.occupancy,
        status: statusText(z),
        reason: z.occupancy === 0
          ? "Completely empty — ideal placement."
          : `${occupancyPercentage(z)}% occupied — ${z.capacity - z.occupancy} free spots.`
      }));
  }

  /* ------------------------------------------------------------------
     RENDERING — zone cards
     ------------------------------------------------------------------ */
  function renderZones() {
    const grid = $("zone-monitor__grid");
    if (!grid) return;

    if (state.zones.length === 0) {
      grid.innerHTML = `
        <div class="zone-monitor-module__empty">
          <span class="zone-monitor-module__empty-icon">▌</span>
          <p class="zone-monitor-module__empty-text">No zones monitored yet.</p>
        </div>`;
      return;
    }

    grid.innerHTML = state.zones.map(zone => {
      const pct = occupancyPercentage(zone);
      const level = band(zone);
      const open = zone.is_active;
      const focused = zone.id === state.focusZoneId ? " active" : "";

      return `
        <article class="zone-monitor-module__card zone-monitor-module__card--${level} ${open ? "" : "zone-monitor-module__card--inactive"}${focused}"
                 data-zone-id="${zone.id}" role="button" tabindex="0"
                 title="Click to see redirection options for this zone">
          <div class="zone-monitor-module__header-row">
            <h3 class="zone-monitor-module__name">${escapeHtml(zone.name)}</h3>
            <span class="zone-monitor-module__status zone-monitor-module__status--${level}">
              <span class="zone-monitor-module__status__dot" aria-hidden="true"></span>
              ${escapeHtml(statusText(zone))}
            </span>
          </div>

          <div class="zone-monitor-module__numbers">
            <div class="zone-monitor-module__number">
              <span class="zone-monitor-module__number-label">Current occupancy</span>
              <span class="zone-monitor-module__number-value zone-monitor-module__number-value--${level}">${zone.occupancy}</span>
            </div>
            <div class="zone-monitor-module__number">
              <span class="zone-monitor-module__number-label">Maximum capacity</span>
              <span class="zone-monitor-module__number-value">${zone.capacity}</span>
            </div>
          </div>

          <div class="zone-monitor-module__progress-wrap">
            <div class="zone-monitor-module__progress-label">
              <span>Occupancy percentage</span>
              <strong>${pct}%</strong>
            </div>
            <div class="zone-monitor-module__progress-track">
              <div class="zone-monitor-module__progress-fill zone-monitor-module__progress-fill--${level}"
                   style="width: ${Math.min(pct, 100)}%;"></div>
            </div>
          </div>

          <div class="zone-monitor-module__hours">
            <span class="zone-monitor-module__open-badge${open ? "" : " zone-monitor-module__open-badge--closed"}">
              ${open ? "🟢 Open now" : "🔴 Closed now"}
            </span>
            <span class="zone-monitor-module__hours-text">
              ${escapeHtml(zone.opening_time)}${zone.closing_time ? " - " + escapeHtml(zone.closing_time) : ""}
            </span>
          </div>
        </article>`;
    }).join("");

    grid.querySelectorAll("[data-zone-id]").forEach(card => {
      const select = () => {
        const id = Number(card.dataset.zoneId);
        state.focusZoneId = state.focusZoneId === id ? null : id;
        renderZones();
        renderRecommendations();
      };
      card.addEventListener("click", select);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); }
      });
    });
  }

  /* ------------------------------------------------------------------
     RENDERING — overcrowding alerts
     ------------------------------------------------------------------ */
  function buildAlerts() {
    return state.zones
      .filter(zone => severity(zone) >= 2)
      .map(zone => {
        const level = severity(zone);
        return {
          id: `zone-${zone.id}`,
          zone,
          severity: level >= 3 ? "critical" : "warning",
          label: level >= 3 ? "Critical" : "Warning",
          message: level >= 3
            ? `${zone.name} has reached critical occupancy.`
            : `${zone.name} is approaching capacity. Consider easing the flow.`,
          action: level >= 3
            ? "Redirect incoming attendees to a safer zone."
            : "Monitor and redirect flow if occupancy climbs."
        };
      });
  }

  function renderAlerts() {
    const list = $("alert-list");
    if (!list) return;

    const alerts = buildAlerts().filter(a => !state.acknowledged.has(a.id));

    const counter = $("alert-count");
    if (counter) {
      counter.textContent = `${alerts.length} active`;
      counter.classList.toggle("zone-monitor-module__alerts-count--active", alerts.length > 0);
    }
    const panel = $("zone-monitor-alerts");
    if (panel) panel.classList.toggle("zone-monitor-module__alerts-panel--has-alerts", alerts.length > 0);

    if (alerts.length === 0) {
      list.innerHTML = `
        <div class="zone-monitor-module__alerts-empty zone-monitor-module__alerts-empty--no-alerts">
          <span class="zone-monitor-module__alerts-empty-icon">✅</span>
          <p class="zone-monitor-module__alerts-empty-text">All clear. No overcrowding alerts.</p>
        </div>`;
      return;
    }

    list.innerHTML = alerts.map(alert => `
      <div class="zone-monitor-module__alert zone-monitor-module__alert--${alert.severity}" data-alert-id="${alert.id}">
        <div class="zone-monitor-module__alert-header">
          <div class="zone-monitor-module__alert-header-top">
            <span class="zone-monitor-module__alert-severity zone-monitor-module__alert-severity--${alert.severity}">
              ${alert.label}
            </span>
            <span class="zone-monitor-module__alert-zone">${escapeHtml(alert.zone.name)}</span>
          </div>
          <div class="zone-monitor-module__alert-occupancy">
            ${alert.zone.occupancy} / ${alert.zone.capacity} · ${occupancyPercentage(alert.zone)}%
          </div>
        </div>

        <div class="zone-monitor-module__alert-body">
          <p><strong>${escapeHtml(alert.message)}</strong></p>
          <p><strong>Recommended action:</strong> ${escapeHtml(alert.action)}</p>
        </div>

        <div class="zone-monitor-module__alert-footer">
          <span class="zone-monitor-module__alert-timestamp">
            Status: ${escapeHtml(statusText(alert.zone))}
          </span>
          <div class="zone-monitor-module__alert-actions">
            <button type="button" class="zone-monitor-module__ack-button" data-focus="${alert.zone.id}">
              Show redirection
            </button>
            <button type="button" class="zone-monitor-module__ack-button" data-ack="${alert.id}">
              Acknowledge
            </button>
          </div>
        </div>
      </div>`).join("");

    list.querySelectorAll("[data-ack]").forEach(btn => btn.addEventListener("click", () => {
      state.acknowledged.add(btn.dataset.ack);
      showToast("Alert acknowledged.", "success");
      renderAlerts();
      renderRecommendations();
    }));

    list.querySelectorAll("[data-focus]").forEach(btn => btn.addEventListener("click", () => {
      state.focusZoneId = Number(btn.dataset.focus);
      renderZones();
      renderRecommendations();
      const target = $("zone-monitor-recommendations");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  /* ------------------------------------------------------------------
     RENDERING — redirection recommendations
     ------------------------------------------------------------------ */
  function pickRecommendationZone() {
    if (state.focusZoneId != null) {
      const focused = state.zones.find(z => z.id === state.focusZoneId);
      if (focused) return focused;
    }
    // Otherwise the busiest zone that actually needs relief.
    const busy = state.zones.slice().sort((a, b) => occupancyPercentage(b) - occupancyPercentage(a));
    return busy.find(z => severity(z) >= 1) || null;
  }

  function renderRecommendations() {
    const list = $("recommendation-list");
    const counter = $("recommendation-count");
    if (!list) return;

    const source = pickRecommendationZone();
    if (!source) {
      if (counter) counter.textContent = "0 options";
      list.innerHTML = `
        <div class="zone-monitor-module__recommendations-empty">
          <span class="zone-monitor-module__recommendations-empty-icon">📋</span>
          <p class="zone-monitor-module__recommendations-empty-text">
            Select a crowded zone to get redirection recommendations.
          </p>
        </div>`;
      return;
    }

    const recommendations = redirectionCandidates(source);
    if (counter) counter.textContent = `${recommendations.length} option(s)`;

    if (recommendations.length === 0) {
      list.innerHTML = `
        <div class="zone-monitor-module__no-safe-zones">
          <span class="zone-monitor-module__recommendations-empty-icon">🚫</span>
          <p class="zone-monitor-module__no-safe-zones-text">
            No safe zones with free capacity right now.
          </p>
        </div>`;
      return;
    }

    list.innerHTML = `
      <div class="zone-monitor-module__recommendations-header">
        <h2 class="zone-monitor-module__recommendations-title">
          Recommended alternatives for ${escapeHtml(source.name)}
        </h2>
        <span class="zone-monitor-module__recommendations-count">${recommendations.length} options</span>
      </div>
      <div class="zone-monitor-module__recommendations-list">
        ${recommendations.slice(0, 4).map(rec => `
          <div class="zone-monitor-module__recommendation zone-monitor-module__recommendation--${band(rec.zone)}">
            <div class="zone-monitor-module__recommendation-header">
              <span class="zone-monitor-module__recommendation-name">${escapeHtml(rec.zone.name)}</span>
              <span class="zone-monitor-module__recommendation-status zone-monitor-module__recommendation-status--${band(rec.zone)}">
                ${escapeHtml(rec.status)}
              </span>
            </div>
            <div class="zone-monitor-module__recommendation-metrics">
              <span>Available capacity <strong>${rec.free}</strong></span>
              <span>${rec.zone.occupancy} / ${rec.zone.capacity} people</span>
            </div>
            <div class="zone-monitor-module__recommendation-reason">Reason: ${escapeHtml(rec.reason)}</div>
            <div class="zone-monitor-module__recommendation-actions">
              <button type="button" class="zone-monitor-module__redirect-button" data-redirect-to="${rec.zone.id}">
                REDIRECT HERE
              </button>
            </div>
          </div>`).join("")}
      </div>`;

    list.querySelectorAll("[data-redirect-to]").forEach(btn => btn.addEventListener("click", () => {
      const target = state.zones.find(z => z.id === Number(btn.dataset.redirectTo));
      if (!target) return;

      showToast(`Redirection activated: ${source.name} → ${target.name}.`, "success");
      list.innerHTML = `
        <div class="zone-monitor-module__activation">
          <span class="zone-monitor-module__activation-icon">✅</span>
          <span class="zone-monitor-module__activation-text">Redirect recommendation activated.</span>
          <div class="zone-monitor-module__activation-actions">
            <span class="zone-monitor-module__activation-notes">
              ${escapeHtml(source.name)} → ${escapeHtml(target.name)} at ${new Date().toLocaleTimeString()}.
            </span>
            <button type="button" class="zone-monitor-module__activation-dismiss">Dismiss</button>
          </div>
        </div>`;
      list.querySelector(".zone-monitor-module__activation-dismiss")
        .addEventListener("click", renderRecommendations);
    }));
  }

  /* ------------------------------------------------------------------
     RENDERING — staff deployment
     ------------------------------------------------------------------ */
  function renderStaff() {
    const grid = $("staff-grid");
    if (!grid) return;

    const available = state.staff.available - state.staff.deployed;

    $("staff-summary-total").textContent = state.staff.total;
    $("staff-summary-available").textContent = available;
    $("staff-summary-deployed").textContent = state.staff.deployed;
    $("staff-summary-busy").textContent = state.staff.deployed;
    $("staff-total").textContent = `${state.staff.total} total`;

    if (state.zones.length === 0) {
      grid.innerHTML = `<div class="zone-monitor-module__empty"><p class="zone-monitor-module__empty-text">No zones to staff yet.</p></div>`;
      return;
    }

    const safeNames = state.zones.filter(z => severity(z) === 0).map(z => z.name);

    grid.innerHTML = state.zones.map(zone => {
      const level = band(zone);
      const needsStaff = level !== "safe";
      const canDeploy = available > 0 && needsStaff;

      return `
        <div class="zone-monitor-module__staff-zone zone-monitor-module__staff-zone--${level}" data-zone-id="${zone.id}">
          <div class="zone-monitor-module__staff-zone-header">
            <span class="zone-monitor-module__staff-zone-name">${escapeHtml(zone.name)}</span>
            <span class="zone-monitor-module__staff-zone-status zone-monitor-module__staff-zone-status--${level}">
              ${escapeHtml(statusText(zone))}
            </span>
          </div>

          <div class="zone-monitor-module__staff-zone-meta">
            <span>Occupancy <strong>${occupancyPercentage(zone)}%</strong></span>
            <span>${zone.occupancy} / ${zone.capacity} people</span>
          </div>

          <div class="zone-monitor-module__staff-zone-body">
            <p class="zone-monitor-module__staff-recommendation">
              ${level === "critical"
                ? "<strong>Recommended:</strong> deploy 2 staff members now."
                : level === "warning"
                  ? "<strong>Recommended:</strong> monitor and consider deploying staff."
                  : "No deployment needed."}
            </p>

            <div class="zone-monitor-module__staff-candidates">
              <span class="zone-monitor-module__staff-candidate zone-monitor-module__staff-candidate--available">Safe zones to pull from:</span>
              <div class="zone-monitor-module__staff-candidates-list">
                ${safeNames.length
                  ? safeNames.map(name => `<span class="zone-monitor-module__staff-candidate-item">${escapeHtml(name)}</span>`).join("")
                  : `<span class="zone-monitor-module__staff-candidate-item">No safe zones available.</span>`}
              </div>
            </div>

            <div class="zone-monitor-module__staff-actions">
              <button type="button" class="zone-monitor-module__deploy-button" data-deploy="${zone.id}"
                      ${canDeploy ? "" : "disabled"}>
                Deploy Staff
              </button>
            </div>
          </div>
        </div>`;
    }).join("");

    grid.querySelectorAll("[data-deploy]").forEach(btn => btn.addEventListener("click", () => {
      deployStaff(Number(btn.dataset.deploy));
    }));
  }

  function deployStaff(zoneId) {
    const zone = state.zones.find(z => z.id === zoneId);
    if (!zone) return;

    const available = state.staff.available - state.staff.deployed;
    if (available < 1) { showToast("No available staff to deploy.", "error"); return; }

    const count = Math.min(STAFF_PER_DEPLOYMENT, available);
    state.staff.deployed += count;
    showToast(`${count} staff member(s) deployed to ${zone.name}.`, "success");
    renderStaff();
  }

  /* ------------------------------------------------------------------
     RENDERING — crowd simulation
     ------------------------------------------------------------------ */
  function activeSimulationZone() {
    return state.zones.find(z => z.id === state.simulationZoneId)
      || state.zones.find(z => z.id === state.focusZoneId)
      || state.zones[0]
      || null;
  }

  function renderSimulation() {
    const select = $("simulation-zone-select");
    const panel = $("simulation-active");
    if (!select || !panel) return;

    if (state.zones.length === 0) {
      select.innerHTML = `<option value="">No zones</option>`;
      panel.className = "zone-monitor-module__simulation-active";
      $("simulation-active-name").textContent = "—";
      $("simulation-active-status").textContent = "—";
      $("simulation-active-occupancy").textContent = "0 / 0";
      $("simulation-active-percentage").textContent = "0%";
      $("simulation-active-growth").textContent = "0 people/min";
      return;
    }

    const active = activeSimulationZone();
    state.simulationZoneId = active.id;

    select.innerHTML = state.zones.map(z =>
      `<option value="${z.id}" ${z.id === active.id ? "selected" : ""}>${escapeHtml(z.name)}</option>`
    ).join("");

    const level = band(active);
    panel.className = `zone-monitor-module__simulation-active zone-monitor-module__simulation-active--${level}`;

    $("simulation-active-name").textContent = active.name;
    const statusEl = $("simulation-active-status");
    statusEl.textContent = statusText(active);
    statusEl.className = `zone-monitor-module__simulation-active-status zone-monitor-module__simulation-active-status--${level}`;

    $("simulation-active-occupancy").textContent = `${active.occupancy} / ${active.capacity}`;
    $("simulation-active-percentage").textContent = `${occupancyPercentage(active)}%`;

    const growth = state.growth[active.id] || 0;
    $("simulation-active-growth").textContent =
      `${growth >= 0 ? "+" : ""}${growth} people/min (simulated)`;
  }

  /** Applies +/- delta to a zone, locally and — when admin — on the backend. */
  async function simulate(delta) {
    const zone = activeSimulationZone();
    if (!zone) { showToast("Load a zone before simulating.", "error"); return; }

    // Allow the sim to push a zone over capacity (the backend accepts it and
    // marks the venue OVERCROWDED) — capped at 125% so numbers stay sane.
    const ceiling = Math.round(zone.capacity * 1.25);
    const next = Math.max(0, Math.min(ceiling, zone.occupancy + delta));
    const applied = next - zone.occupancy;
    zone.occupancy = next;
    zone.available_capacity = Math.max(zone.capacity - next, 0);
    state.growth[zone.id] = applied;

    if (state.live && auth.isAdmin) {
      try {
        const updated = await apiFetch(`/venues/${zone.id}/occupancy`, {
          method: "PATCH", auth: true, body: { occupancy: next }
        });
        Object.assign(zone, normalizeZone(updated));
        showToast(`${zone.name} → ${updated.occupancy} occupants (${updated.status}) saved to the backend.`, "success");
      } catch (err) {
        showToast(`Simulation is local only: ${err.message}`, "error");
      }
    } else {
      showToast(`${zone.name} → ${next} occupants (local simulation).`
        + (state.live ? " Log in as admin to persist changes." : ""),
        state.live ? "info" : "success");
    }

    refreshAll();
  }

  function refreshAll() {
    renderZones();
    renderAlerts();
    renderRecommendations();
    renderStaff();
    renderSimulation();
  }

  /* ------------------------------------------------------------------
     BACKEND SYNC
     ------------------------------------------------------------------ */
  function renderConnection() {
    const dot = $("connection-dot");
    const text = $("connection-text");
    if (dot) dot.className = `zone-monitor-module__connection-dot ${state.live ? "is-online" : "is-offline"}`;
    if (text) {
      if (state.live) {
        const stamp = state.lastSync ? state.lastSync.toLocaleTimeString() : "—";
        text.textContent = `Backend online · ${state.zones.length} zone(s) · last sync ${stamp}`
          + (auth.username ? ` · signed in as ${auth.username} (${auth.role})` : "");
      } else {
        text.textContent = "Backend offline — showing fallback demo zones. Start uvicorn to go live.";
      }
    }
  }

  async function syncZones({ silent = false } = {}) {
    try {
      const venues = await apiFetch("/venues");
      const zones = (venues || []).map(normalizeZone);
      state.zones = zones.length > 0 ? zones : MOCK_ZONES.map(normalizeZone);
      state.live = true;
      state.lastSync = new Date();
      if (state.focusZoneId != null && !state.zones.some(z => z.id === state.focusZoneId)) {
        state.focusZoneId = null;
      }
      renderConnection();
      if (!silent) refreshAll();
      return true;
    } catch (err) {
      state.live = false;
      state.zones = MOCK_ZONES.map(normalizeZone);
      renderConnection();
      refreshAll();
      if (!silent) showToast(`API offline — using demo zones (${err.message})`, "error");
      return false;
    }
  }

  /* ------------------------------------------------------------------
     AUTH UI
     ------------------------------------------------------------------ */
  function renderAuth() {
    const sessionBar = $("session-bar");
    const roleEl = $("session-role");
    const loginOpen = $("login-open");
    const panel = $("login-panel");
    if (!sessionBar || !roleEl || !loginOpen || !panel) return;

    if (auth.token) {
      sessionBar.classList.remove("hidden");
      roleEl.textContent = `👋 ${auth.username} (${auth.role})`;
      loginOpen.textContent = "Switch account";
      panel.classList.add("hidden");
    } else {
      sessionBar.classList.add("hidden");
      loginOpen.textContent = "Login / Demo";
    }
    renderConnection();
  }

  function handleLogin(event) {
    event.preventDefault();
    const username = $("login-username").value.trim();
    const password = $("login-password").value;
    const errorEl = $("login-error");
    errorEl.textContent = "";

    apiFetch("/auth/login", { method: "POST", body: { username, password } })
      .then(data => {
        auth.save(data);
        showToast(`Signed in as ${data.username} (${data.role}).`, "success");
        $("login-panel").classList.add("hidden");
        renderAuth();
        return syncZones({ silent: true });
      })
      .then(() => refreshAll())
      .catch(err => {
        errorEl.textContent = err.status === 401
          ? "Wrong username or password. Demo: admin / admin123."
          : err.message;
      });
  }

  function handleLogout() {
    auth.clear();
    showToast("Signed out. Simulation changes will stay local.", "success");
    renderAuth();
  }

  /* ------------------------------------------------------------------
     EVENT WIRING
     ------------------------------------------------------------------ */
  function wireEvents() {
    $("login-open").addEventListener("click", () => $("login-panel").classList.toggle("hidden"));
    $("login-cancel").addEventListener("click", () => $("login-panel").classList.add("hidden"));
    $("login-form").addEventListener("submit", handleLogin);
    $("logout").addEventListener("click", handleLogout);
    $("demo-account-link").addEventListener("click", (e) => {
      e.preventDefault();
      $("login-username").value = "admin";
      $("login-password").value = "admin123";
      $("login-title").textContent = "Admin log in (demo)";
    });

    $("simulation-zone-select").addEventListener("change", (e) => {
      state.simulationZoneId = Number(e.target.value);
      renderSimulation();
    });

    document.querySelectorAll("[data-simulation-action]").forEach(btn => {
      btn.addEventListener("click", () => {
        const step = Number(btn.dataset.step) || 10;
        simulate(btn.dataset.simulationAction === "decrease" ? -step : step);
      });
    });

    $("simulation-surge").addEventListener("click", () => simulate(100));

    // Re-render on window resize is unnecessary, but hide a click-outside that
    // would leave the login panel dangling open.
    document.addEventListener("click", (e) => {
      const panel = $("login-panel");
      const bar = $("auth-bar");
      if (!panel || panel.classList.contains("hidden")) return;
      if (!bar.contains(e.target)) panel.classList.add("hidden");
    });
  }

  /* ------------------------------------------------------------------
     BOOT
     ------------------------------------------------------------------ */
  (async function boot() {
    renderAuth();
    renderConnection();

    const online = await resolveApiBase();
    if (!online) {
      state.zones = MOCK_ZONES.map(normalizeZone);
      state.live = false;
      renderConnection();
      refreshAll();
      showToast("Backend offline — using demo zones. Start uvicorn to go live.", "error");
    } else {
      await syncZones();
    }

    wireEvents();
    refreshAll();

    setInterval(async () => {
      const before = JSON.stringify(state.zones.map(z => [z.id, z.occupancy]));
      await syncZones({ silent: true });
      const after = JSON.stringify(state.zones.map(z => [z.id, z.occupancy]));
      if (before !== after) refreshAll();
    }, REFRESH_INTERVAL_MS);
  })();
})();
