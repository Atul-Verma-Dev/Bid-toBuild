/* ============================================================
   ZONE MONITORING MODULE

   Connects to the Smart Event Crowd Management backend REST API.
   Falls back to the built-in mock state when the backend is unreachable.
   ============================================================ */

// Base URL of the FastAPI backend. Override for local dev / other origins.
const API_BASE = (typeof window !== "undefined" && window.API_BASE) || "http://127.0.0.1:8000";

// API helper: GET JSON
async function apiGet(path) {
  const res = await fetch(API_BASE + path, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body.detail && body.detail.message) || `Request failed: ${res.status}`);
  }
  return res.json();
}

// API helper: PATCH JSON (used for occupancy 업데이트를 통해 crowd 상태를 변경)
async function apiPatch(path, payload) {
  const res = await fetch(API_BASE + path, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${localStorage.getItem("token") || ""}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body.detail && body.detail.message) || `Request failed: ${res.status}`);
  }
  return res.json();
}

// API helper: POST JSON
async function apiPost(path, payload) {
  const res = await fetch(API_BASE + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${localStorage.getItem("token") || ""}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body.detail && body.detail.message) || `Request failed: ${res.status}`);
  }
  return res.json();
}

// Attempt a live sync from the backend; on failure keep the mock state so the
// dashboard still renders for demo/demo-out-of-box use.
async function syncZonesFromApi() {
  try {
    state.zones = await apiGet("/venues") || [];
    state.syncSource = "api";
    state.lastSyncAt = new Date().toISOString();
    state.connectionOk = true;
  } catch (err) {
    state.connectionOk = false;
    state.lastSyncAt = null;
    showToast(`API offline — using demo data (${err.message})`, "warning");
  }
}

// Status labels the UI expects (mirror the backend's: NORMAL/MODERATE/WARNING/CRITICAL/OVERCROWDED).
const STATUS_LABELS = {
  normal: "Safe",
  moderate: "Getting Busy",
  warning: "Warning",
  critical: "Critical",
  overcrowded: "Overcrowded",
};

// Mock state
const MOCK_STAFF = [
  { id: 101, name: "Rahul" },
  { id: 102, name: "Priya" },
  { id: 103, name: "Arjun" },
  { id: 104, name: "Ananya" },
  { id: 105, name: "Vikram" },
  { id: 106, name: "Sneha" },
  { id: 107, name: "Rohan" },
  { id: 108, name: "Isha" },
  { id: 109, name: "Karan" },
  { id: 110, name: "Mira" },
  { id: 111, name: "Aarav" },
  { id: 112, name: "Diya" },
];

const state = {
  zones: [],
  staff: {
    total: MOCK_STAFF.length,
    available: MOCK_STAFF.length,
    deployed: 0,
    busy: 0,
  },
  simulation: {
    activeZoneId: 1,
    step: 1,
  },
  alerts: [],
  recommendations: [],
  lastRefreshed: null,
  syncSource: "mock",
  lastSyncAt: null,
  connectionOk: false,
};

// ----------------------------------------------------------------
// Pure domain logic
// ----------------------------------------------------------------
function calculateOccupancyPercentage(zone) {
  if (!zone || !zone.capacity || zone.capacity <= 0) return 0;
  return Math.round((zone.currentCount / zone.capacity) * 100);
}

// Mirror the backend thresholds (same as backend.py crowd.py).
function getZoneStatus(zone) {
  const p = calculateOccupancyPercentage(zone);
  if (p > 100) return "OVERCROWDED";
  if (p >= 95) return "CRITICAL";
  if (p >= 85) return "WARNING";
  if (p >= 70) return "MODERATE";
  return "NORMAL";
}

function formatGrowth(zone) {
  // Migrate the mock “growthRate” concept using a deterministic
  // crowd growth estimate so closed/downtime zones show a stable value.
  if (!zone || !zone.capacity || zone.capacity <= 0) return "0 people/min";

  // Use the tracked occupancy delta when it is provided. Otherwise fall back to
  // a small default so the UI still shows a meaningful growth indicator.
  const occupancy = calculateOccupancyPercentage(zone);
  const rawGrowth = zone.growthRate; // backend does not send this field
  if (typeof rawGrowth === "number") return rawGrowth >= 0 ? `+${rawGrowth}` : String(rawGrowth);
  if (zone.lastOccupancy != null && zone.occupancy != null) {
    const delta = zone.occupancy - zone.lastOccupancy;
    return formatChange(delta);
  }
  return "0 people/min";
}

function formatChange(delta) {
  if (delta >= 0) return `+${delta}`;
  return String(delta);
}
// ----------------------------------------------------------------
// DOM helpers
// ----------------------------------------------------------------
function $(selector, root = document) {
  return root.querySelector(selector);
}

function createZoneCard(zone) {
  const occupancy = calculateOccupancyPercentage(zone);
  const status = getZoneStatus(zone);
  const openNow = typeof zone.is_active === "boolean" ? zone.is_active : true;

  const fillClass = `zone-monitor-module__progress-fill--${status.toLowerCase()}`;
  const numberClass = `zone-monitor-module__number-value--${status.toLowerCase()}`;
  const headerClass = `${openNow ? "" : "zone-monitor-module__card--inactive"}`;

  return `
    <article class="zone-monitor-module__card" data-zone-id="${zone.id}">
      <div class="zone-monitor-module__header-row">
        <h3 class="zone-monitor-module__name">${zone.name}</h3>
        <span class="zone-monitor-module__status zone-monitor-module__status--${status.toLowerCase()}">
          <span class="zone-monitor-module__status__dot" aria-hidden="true"></span>
          ${status}
        </span>
      </div>

      <div class="zone-monitor-module__numbers">
        <div class="zone-monitor-module__number">
          <span class="zone-monitor-module__number-label">Current occupancy</span>
          <span class="zone-monitor-module__number-value ${numberClass}">${zone.occupancy || 0}</span>
        </div>
        <div class="zone-monitor-module__number">
          <span class="zone-monitor-module__number-label">Maximum capacity</span>
          <span class="zone-monitor-module__number-value">${zone.capacity}</span>
        </div>
      </div>

      <div class="zone-monitor-module__progress-wrap">
        <div class="zone-monitor-module__progress-label">
          <span>Occupancy percentage</span>
          <strong class="${numberClass}">${occupancy}%</strong>
        </div>
        <div class="zone-monitor-module__progress-track">
          <div
            class="zone-monitor-module__progress-fill ${fillClass}"
            data-progress-fill
            style="width: ${occupancy}%;"
          ></div>
        </div>
      </div>

      <div class="zone-monitor-module__hours">
        <span class="zone-monitor-module__open-badge${openNow ? "" : " zone-monitor-module__open-badge--closed"}">
          ${openNow ? "🟢 Open now" : "🔴 Closed now"}
        </span>
        <span class="zone-monitor-module__hours-text">
          ${zone.opening_time || ""}${zone.closing_time ? " - " + zone.closing_time : ""}
        </span>
      </div>
    </article>
  `;
}

function renderZones(container) {
  const grid = container || document.getElementById("zone-monitor__grid");
  if (!grid) return;

  if (!Array.isArray(state.zones) || state.zones.length === 0) {
    grid.innerHTML = `
      <div class="zone-monitor-module__empty">
        <span class="zone-monitor-module__empty-icon">▌</span>
        <p class="zone-monitor-module__empty-text">No zones monitored yet.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = state.zones.map(createZoneCard).join("");
}

function updateZone(zoneId, patch) {
  const zone = (state.zones.find((z) => z.id === zoneId) || null);
  if (!zone) return;

  Object.assign(zone, patch);

  // Re-render only the affected card so status and progress stay consistent.
  const grid = document.getElementById("zone-monitor__grid");
  const card = $(`.zone-monitor-module__card[data-zone-id="${zoneId}"]`, grid);
  if (card) {
    card.outerHTML = createZoneCard(zone);
  } else {
    renderZones();
  }
}

function simulateZoneIncrease(amount) {
  const zone = state.zones.find((z) => z.id === state.simulation.activeZoneId);
  if (!zone) return;

  const occupancy = calculateOccupancyPercentage(zone);
  const next = Math.min(zone.capacity, occupancy + amount);
  if (!zone.occupancy) zone.occupancy = occupancy;
  zone.occupancy = next;
  zone.lastOccupancy = occupancy;
  state.simulation.step += Math.abs(amount);
  refreshAll();
}

function simulateZoneDecrease(amount) {
  const zone = state.zones.find((z) => z.id === state.simulation.activeZoneId);
  if (!zone) return;

  const occupancy = calculateOccupancyPercentage(zone);
  const next = Math.max(0, occupancy - amount);
  if (!zone.occupancy) zone.occupancy = occupancy;
  zone.occupancy = next;
  zone.lastOccupancy = occupancy;
  state.simulation.step += Math.abs(amount);
  refreshAll();
}

function selectSimulationZone(zoneId) {
  state.simulation.activeZoneId = zoneId;
  refreshAll();
}

function initiateCrowdSurge() {
  const zone = state.zones.find((z) => z.id === state.simulation.activeZoneId);
  if (!zone) return;

  const surgeAmount = 100;
  // Wrap the same +100 event into the simulation pipeline.
  simulateZoneIncrease(surgeAmount);
}

function deployStaff(zoneId) {
  const zone = state.zones.find((z) => z.id === zoneId);
  if (!zone) return;

  const available = state.staff.available - state.staff.deployed;
  if (available < 1) {
    showToast("No available staff to deploy.", "error");
    return;
  }

  const toDeploy = Math.min(2, available);
  state.staff.deployed += toDeploy;
  state.staff.available -= toDeploy;
  state.staff.busy += toDeploy;

  // Re-generate alerts and recommendations so the UI stays in sync.
  state.alerts = generateAlerts(state.zones);
  state.recommendations = generateRecommendations(state.zones, zone);

  showToast(`${toDeploy} staff member(s) deployed to ${zone.name}.`);
  renderAlerts(document.getElementById("alert-list"));
  renderRecommendations(document.getElementById("recommendation-list"));
}

function refreshAll() {
  const grid = document.getElementById("zone-monitor__grid");
  if (grid) {
    renderZones(state.zones, grid);
  }

  state.alerts = generateAlerts(state.zones);
  renderAlerts(document.getElementById("alert-list"));
  renderRecommendations(document.getElementById("recommendation-list"));
  renderStaffDeployment();

  state.lastRefreshed = new Date().toISOString();
}

function renderStaffDeployment() {
  const staffPanel = document.getElementById("staff-panel");
  const staffGrid = document.getElementById("staff-grid");
  const simulationActive = document.getElementById("simulation-active");
  const select = document.getElementById("simulation-zone-select");
  const surgeBtn = document.getElementById("simulation-surge");

  if (!staffPanel || !staffGrid || !simulationActive) return;

  const staff = state.staff;
  const activeZoneId = state.simulation.activeZoneId;
  const activeZone = state.zones.find((z) => z.id === activeZoneId) || state.zones[0];
  const activeStatus = getZoneStatus(activeZone);

  const available = staff.available - staff.deployed;
  const busy = staff.busy;
  const deployed = staff.deployed;

  // Update summary counts (static elements)
  document.getElementById("staff-summary-total").textContent = staff.total;
  document.getElementById("staff-summary-available").textContent = available;
  document.getElementById("staff-summary-deployed").textContent = deployed;
  document.getElementById("staff-summary-busy").textContent = busy;
  document.getElementById("staff-total").textContent = staff.total;

  // Build staff zone cards into the grid
  staffGrid.innerHTML = state.zones
    .map((zone) => {
      const status = getZoneStatus(zone);
      const isCritical = status === "CRITICAL";
      const isWarning = status === "WARNING";

      const candidates = state.zones
        .map((z) => ({ z, status: getZoneStatus(z) }))
        .filter((x) => x.status !== "CRITICAL" && x.status !== "WARNING")
        .slice(0, 3)
        .map((x) => x.z.name);

      const criticalNames = state.zones
        .map((z) => ({ z, status: getZoneStatus(z) }))
        .filter((x) => x.status === "CRITICAL")
        .map((x) => x.z.name);

      const canDeploy = available > 0 && (status === "CRITICAL" || status === "WARNING");

      return `
        <div class="zone-monitor-module__staff-zone ${isCritical ? "zone-monitor-module__staff-zone--critical" : isWarning ? "zone-monitor-module__staff-zone--warning" : ""}" data-zone-id="${zone.id}">
          <div class="zone-monitor-module__staff-zone-header">
            <span class="zone-monitor-module__staff-zone-name">${zone.name}</span>
            <span class="zone-monitor-module__staff-zone-status ${isCritical ? "zone-monitor-module__staff-zone-status--critical" : isWarning ? "zone-monitor-module__staff-zone-status--warning" : "zone-monitor-module__staff-zone-status--safe"}">
              ${status}
            </span>
          </div>

          <div class="zone-monitor-module__staff-zone-meta">
            <span>Occupancy <strong>${occ}%</strong></span>
            <span>${zone.currentCount} / ${zone.capacity} people</span>
            <span>${zone.occupancy ?? (zone.currentCount ?? 0)} / ${zone.capacity} people</span>
          </div>

          <div class="zone-monitor-module__staff-zone-body">
            <p class="zone-monitor-module__staff-recommendation">
              ${isCritical ? `<strong>Recommended:</strong> Deploy 2 staff members.` : isWarning ? `<strong>Recommended:</strong> Monitor and consider deploying staff.` : "No deployment needed."}
            </p>

            <div class="zone-monitor-module__staff-candidates">
              ${isCritical ? `<span class="zone-monitor-module__staff-candidate zone-monitor-module__staff-candidate--available">Available nearby:</span>` : ""}
              <div class="zone-monitor-module__staff-candidates-list">
                ${candidates.length > 0 ? candidates.map((name) => `<span class="zone-monitor-module__staff-candidate-item">${name}</span>`).join("") : "<span class=\"zone-monitor-module__staff-candidate-item\">No nearby safe zones available.</span>"}
              </div>
            </div>

            <div class="zone-monitor-module__staff-candidates">
              ${isCritical ? `<span class="zone-monitor-module__staff-candidate zone-monitor-module__staff-candidate--available">Recruiting:</span>` : ""}
              <div class="zone-monitor-module__staff-candidates-list">
                ${criticalNames.map((name) => `<span class="zone-monitor-module__staff-candidate-item">${name}</span>`).join("")}
              </div>
            </div>

            <div class="zone-monitor-module__staff-actions">
              <button type="button" class="zone-monitor-module__deploy-button" data-deploy="${zone.id}" ${!canDeploy ? "disabled" : ""}>
                Deploy Staff
              </button>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  // Attach deploy handlers
  staffPanel.querySelectorAll("button[data-deploy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      deployStaff(Number(btn.dataset.deploy));
    });
  });

  // Update simulation active state
  simulationActive.className = `zone-monitor-module__simulation-active ${activeStatus === "CRITICAL" ? "zone-monitor-module__simulation-active--critical" : activeStatus === "WARNING" ? "zone-monitor-module__simulation-active--warning" : "zone-monitor-module__simulation-active--safe"}`;
  document.getElementById("simulation-active-name").textContent = activeZone.name;
  document.getElementById("simulation-active-status").textContent = activeStatus;
  document.getElementById("simulation-active-status").className = `zone-monitor-module__simulation-active-status ${activeStatus.toLowerCase()}`;
  document.getElementById("simulation-active-occupancy").textContent = `${activeZone.occupancy ?? activeZone.currentCount ?? 0} / ${activeZone.capacity}`;
  document.getElementById("simulation-active-percentage").textContent = `${activeZone.occupancy != null ? activeZone.occupancy : calculateOccupancyPercentage(activeZone)}%`;
  document.getElementById("simulation-active-growth").textContent = `${activeZone.growthRate} people/min`;

  // Update zone select options
  if (select) {
    select.innerHTML = state.zones
      .map((z) => `<option value="${z.id}" ${z.id === activeZoneId ? "selected" : ""}>${z.name}</option>`)
      .join("");
  }

  // Attach simulation control handlers
  staffPanel.querySelectorAll("button[data-simulation-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.simulationAction;
      const step = Number(btn.dataset.step);
      const zoneId = state.simulation.activeZoneId;
      const zone = state.zones.find((z) => z.id === zoneId);

      if (!zone) return;

      if (action === "increase") {
        simulateZoneIncrease(step);
      } else {
        simulateZoneDecrease(step);
      }
    });
  });

  if (surgeBtn) {
    surgeBtn.addEventListener("click", () => {
      initiateCrowdSurge();
    });
  }
}

function showToast(message, type = "success") {
  let existing = document.querySelector(".zone-monitor-module__toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `zone-monitor-module__toast zone-monitor-module__toast--${type}`;
  toast.innerHTML = `
    <span class="zone-monitor-module__toast__icon">${type === "success" ? "✅" : "⚠️"}</span>
    <span class="zone-monitor-module__toast__message">${message}</span>
    <button type="button" class="zone-monitor-module__toast__dismiss" aria-label="Dismiss">×</button>
  `;

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.transition = "opacity 0.4s ease, transform 0.4s ease";
    toast.style.opacity = "0";
    toast.style.transform = "translateY(12px)";
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 400);
  }, 4000);
}

function initMonitoring(moduleEl, options = {}) {
  // The module is self-contained; no container injection needed.
  // All DOM elements live inside the module's static template.
  renderZones();
  renderStaffDeployment();
  renderAlerts();
  renderRecommendations();

  // Optional live refresh (no hardcoded timers here — consumed by the
  // dashboard or a parent system).
  let timer = null;
  const startAutoRefresh = (intervalMs) => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => refreshAll(), intervalMs || 30000);
  };

  moduleEl.addEventListener("zone:monitor:start", (e) => {
    startAutoRefresh(e.detail?.intervalMs);
  });

  moduleEl.addEventListener("zone:monitor:stop", () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });

  return {
    state,
    renderZones,
    renderStaffDeployment,
    renderAlerts,
    renderRecommendations,
    refreshAll,
    startAutoRefresh,
    stopAutoRefresh: () =>
      moduleEl && moduleEl.dispatchEvent(new CustomEvent("zone:monitor:stop")),
  };
}

// ---- Auth bridge (does not replace the backend auth) ----
// Simple in-page login for the hackathon MVP. The backend still enforces
// role/auth on every mutation; this just stores a token for browser sessions.
function __authInit() {
  const auth = {
    token: null,
    role: null,
    username: null,
    login(username, password) {
      return apiPost("/auth/login", { username, password }).then((res) => {
        auth.token = res.access_token;
        auth.role = res.role;
        auth.username = res.username;
        localStorage.setItem("token", res.access_token);
        localStorage.setItem("auth_user", res.username);
        localStorage.setItem("auth_role", res.role);
        __applyAuthUI();
        return res;
      });
    },
    logout() {
      auth.token = null;
      auth.role = null;
      auth.username = null;
      localStorage.removeItem("token");
      localStorage.removeItem("auth_user");
      localStorage.removeItem("auth_role");
      __applyAuthUI();
    },
    getToken() { return auth.token || localStorage.getItem("token") || ""; },
    isAdmin() { return auth.role === "admin"; },
    getUser() { return auth.username || localStorage.getItem("auth_user") || null; },
  };

  const applyUI = () => {
    const roleEl = document.getElementById("session-role");
    const sessionBar = document.getElementById("session-bar");
    const loginOpen = document.getElementById("login-open");
    const loginPanel = document.getElementById("login-panel");
    if (!roleEl || !sessionBar) return;

    if (auth.getToken()) {
      sessionBar.classList.remove("hidden");
      roleEl.textContent = `👋 ${auth.getUser()} (${auth.role})`;
      loginOpen.textContent = "Switch account";
      loginPanel.classList.add("hidden");
    } else {
      sessionBar.classList.add("hidden");
      loginOpen.textContent = "Login / Demo";
      loginPanel.classList.remove("hidden");
    }
  };

  const openLogin = () => {
    document.getElementById("login-panel").classList.toggle("hidden");
  };

  const handleLogin = (e) => {
    e.preventDefault();
    const username = document.getElementById("login-username").value.trim();
    const password = document.getElementById("login-password").value;
    document.getElementById("login-error").textContent = "";
    auth.login(username, password).catch(() => {
      const errEl = document.getElementById("login-error");
      errEl.textContent = "Wrong username or password. Demo: admin / admin123 (admin) or user / user123 (user).";
    });
  };

  const handleCancel = () => {
    document.getElementById("login-panel").classList.add("hidden");
  };

  const openDemo = () => {
    document.getElementById("login-username").value = "admin";
    document.getElementById("login-password").value = "admin123";
    document.getElementById("login-title").textContent = "Admin log in (demo)";
    openLogin();
  };

  // Expose so zone-monitor.html can offer a sign-up demo link.
  window.__AUTH = auth;
  window.__AUTH.openDemo = openDemo;

  loginOpen.addEventListener("click", openLogin);
  loginPanel.querySelector("#login-cancel").addEventListener("click", handleCancel);
  loginPanel.querySelector("#login-form").addEventListener("submit", handleLogin);
  loginPanel.querySelector("#login-open").addEventListener("click", (e) => {
    // Only the login-open button is inside the panel; ignore inner re-opens.
  });
  logout.addEventListener("click", () => {
    auth.logout();
    applyUI();
  });

  applyUI();
}

// CLI guard: sync live zones from the backend and boot the monitor.
if (typeof document !== "undefined") {
  const moduleRoot = document.querySelector(".zone-monitor-module");
  let started = false;

  const boot = async () => {
    await syncZonesFromApi();
    if (!started) {
      started = true;
      __authInit();
      initMonitoring(moduleRoot);

      // Pull fresh zone data on a timer while the dashboard is open.
      let timer = setInterval(async () => {
        await syncZonesFromApi();
        if (state.zones.length) refreshAll();
      }, 10000);

      moduleRoot.addEventListener("zone:monitor:stop", () => clearInterval(timer));
    }
  };

  // Start immediately, then re-sync on any zone matches so the status stays live.
  boot();
}

// ============================================================
// OVERCROWDING ALERTS + CROWD REDIRECTION
// ============================================================

const ALERT_PRESETS = {
  critical: {
    level: "CRITICAL",
    label: "Critical",
    color: "#ef4444",
    emoji: "🔴",
    message: (zone) => `${zone.name} has reached critical occupancy.`,
    action: "Redirect incoming attendees.",
  },
  warning: {
    level: "WARNING",
    label: "Warning",
    color: "#f59e0b",
    emoji: "🟡",
    message: (zone) => `${zone.name} is approaching capacity. Consider easing flow.`,
    action: "Monitor and redirect flow if occupancy climbs.",
  },
};

// Recommended alternative zones for crowd redirection.
function generateRecommendations(zones, activeZone) {
  const activeOccupancy = calculateOccupancyPercentage(activeZone);
  const safeZones = zones.filter(
    (z) => z.id !== activeZone.id && getZoneStatus(z) !== "CRITICAL"
  );

  // Prefer SAFE zones with the most available capacity first.
  const sorted = [...safeZones].sort((a, b) => {
    const availableA = (a.available_capacity != null ? a.available_capacity : a.capacity - a.occupancy) - (a.occupancy ?? 0);
    const availableB = (b.available_capacity != null ? b.available_capacity : b.capacity - b.occupancy) - (b.occupancy ?? 0);
    if (getZoneStatus(a) === "NORMAL" && getZoneStatus(b) !== "NORMAL") return -1;
    if (getZoneStatus(b) === "NORMAL" && getZoneStatus(a) !== "NORMAL") return 1;
    const avA = a.available_capacity ?? (a.capacity - a.occupancy);
    const avB = b.available_capacity ?? (b.capacity - b.occupancy);
    return (avB - avA) || 0;
  });

  const recommendations = sorted.slice(0, 4).map((z) => ({
    zone: z,
    availableCapacity: z.available_capacity ?? (z.capacity - (z.occupancy ?? z.currentCount ?? 0)),
    status: getZoneStatus(z),
    reason:
      (z.occupancy ?? z.currentCount ?? 0) === 0
        ? "Completely empty — ideal placement."
        : `${z.occupancy ?? calculateOccupancyPercentage(z)}% occupied — room available.`,
  }));

  return recommendations;
}

function generateAlerts(zones) {
  const alerts = [];
  for (const zone of zones) {
    const occupancy = calculateOccupancyPercentage(zone);
    const status = getZoneStatus(occupancy);
    if (status === "CRITICAL" || status === "WARNING") {
      const preset = ALERT_PRESETS[status.toLowerCase()];
      const issuedAt = new Date();
      const timestamp = issuedAt.toISOString();
      alerts.push({
        id: `${zone.id}-${timestamp}`,
        zoneId: zone.id,
        severity: status,
        level: preset.level,
        color: preset.color,
        zoneName: zone.name,
        currentCount: zone.currentCount,
        capacity: zone.capacity,
        occupancy,
        message: preset.message(zone),
        action: preset.action,
        timestamp,
        acknowledged: false,
      });
    }
  }
  return alerts;
}

function acknowledgeAlert(alertId) {
  const alert = state.alerts.find((a) => a.id === alertId);
  if (!alert) return false;
  alert.acknowledged = true;
  return true;
}

function getUnacknowledgedAlerts() {
  return state.alerts.filter((a) => !a.acknowledged);
}

function renderAlerts(container) {
  const alertsList = container || document.getElementById("alert-list");
  if (!alertsList) return;

  const alerts = getUnacknowledgedAlerts();
  if (alerts.length === 0) {
    alertsList.innerHTML = `
      <div class="zone-monitor-module__alerts-empty zone-monitor-module__alerts-empty--no-alerts">
        <span class="zone-monitor-module__alerts-empty-icon">✅</span>
        <p class="zone-monitor-module__alerts-empty-text">All clear. No overcrowding alerts.</p>
      </div>
    `;
    return;
  }

  alertsList.innerHTML = alerts.map((alert) => `
    <div class="zone-monitor-module__alert zone-monitor-module__alert--${alert.severity.toLowerCase()}" data-alert-id="${alert.id}">
      <div class="zone-monitor-module__alert-header">
        <div class="zone-monitor-module__alert-header-top">
          <span class="zone-monitor-module__alert-severity zone-monitor-module__alert-severity--${alert.severity.toLowerCase()}">
            ${alert.level}
          </span>
          <span class="zone-monitor-module__alert-zone">${alert.zoneName}</span>
        </div>
        <div class="zone-monitor-module__alert-occupancy">
          ${alert.currentCount} / ${alert.capacity} · ${alert.occupancy}%
        </div>
      </div>

      <div class="zone-monitor-module__alert-body">
        <p><strong>${alert.message}</strong></p>
        <p><strong>Recommended action:</strong> ${alert.action}</p>
      </div>

      <div class="zone-monitor-module__alert-footer">
        <span class="zone-monitor-module__alert-timestamp">
          ${new Date(alert.timestamp).toLocaleString()}
        </span>
        <div class="zone-monitor-module__alert-actions">
          <button type="button" class="zone-monitor-module__ack-button" data-ack="${alert.id}">
            Acknowledged
          </button>
        </div>
      </div>
    </div>
  `).join("");

  // Attach acknowledge handlers.
  alertsList.querySelectorAll("button[data-ack]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const alertId = btn.dataset.ack;
      const ok = acknowledgeAlert(alertId);
      if (ok) {
        renderAlerts();
        renderRecommendations();
      }
    });
  });
}

function renderRecommendations(container) {
  const recommendationsList = container || document.getElementById("recommendation-list");
  if (!recommendationsList) return;

  let activeZone = null;

  // Determine the active zone: first click a card, then the most crowded alert.
  const activeCard = document.querySelector(".zone-monitor-module__card[data-zone-id].active");
  if (activeCard) {
    const zoneId = Number(activeCard.dataset.zoneId);
    activeZone = state.zones.find((z) => z.id === zoneId) || null;
  }

  if (!activeZone) {
    const critical = state.alerts.find((a) => a.severity === "CRITICAL");
    const warning = state.alerts.find((a) => a.severity === "WARNING");
    if (critical) activeZone = state.zones.find((z) => z.id === critical.zoneId) || null;
    else if (warning) activeZone = state.zones.find((z) => z.id === warning.zoneId) || null;
  }

  if (!activeZone) {
    recommendationsList.innerHTML = `
      <div class="zone-monitor-module__recommendations-empty">
        <span class="zone-monitor-module__recommendations-empty-icon">📋</span>
        <p class="zone-monitor-module__recommendations-empty-text">Select a crowded zone to get redirection recommendations.</p>
      </div>
    `;
    return;
  }

  const recommendations = generateRecommendations(state.zones, activeZone);

  if (recommendations.length === 0) {
    recommendationsList.innerHTML = `
      <div class="zone-monitor-module__no-safe-zones">
        <span class="zone-monitor-module__recommendations-empty-icon">🚫</span>
        <p class="zone-monitor-module__no-safe-zones-text">No safe zones available right now.</p>
      </div>
    `;
    return;
  }

  recommendationsList.innerHTML = `
    <div class="zone-monitor-module__recommendations-header">
      <h2 class="zone-monitor-module__recommendations-title">Recommended alternatives for ${activeZone.name}</h2>
      <span class="zone-monitor-module__recommendations-count">${recommendations.length} options</span>
    </div>
    <div class="zone-monitor-module__recommendations-list">
      ${recommendations.map((rec) => `
        <div class="zone-monitor-module__recommendation zone-monitor-module__recommendation--${rec.status.toLowerCase()}">
          <div class="zone-monitor-module__recommendation-header">
            <span class="zone-monitor-module__recommendation-name">${rec.zone.name}</span>
            <span class="zone-monitor-module__recommendation-status zone-monitor-module__recommendation-status--${rec.status.toLowerCase()}">
              ${rec.status}
            </span>
          </div>
          <div class="zone-monitor-module__recommendation-metrics">
            <span>Available capacity <strong>${rec.availableCapacity}</strong></span>
            <span>${rec.zone.currentCount} / ${rec.zone.capacity} people</span>
          </div>
          <div class="zone-monitor-module__recommendation-reason">Reason: ${rec.reason}</div>
          <div class="zone-monitor-module__recommendation-actions">
            <button type="button" class="zone-monitor-module__redirect-button" data-redirect-to="${rec.zone.id}">
              REDIRECT HERE
            </button>
          </div>
        </div>
      `).join("")}
    </div>
  `;

  recommendationsList.querySelectorAll("button[data-redirect-to]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = Number(btn.dataset.redirectTo);
      const target = state.zones.find((z) => z.id === targetId);
      if (!target) return;

      const activatedAt = new Date();
      const message = `Redirect recommendation activated for ${activeZone.name} → ${target.name} at ${activatedAt.toLocaleString()}.`;

      // Show a clear confirmation state inside the recommendations panel.
      recommendationsList.innerHTML = `
        <div class="zone-monitor-module__activation">
          <span class="zone-monitor-module__activation-icon">✅</span>
          <span class="zone-monitor-module__activation-text">Redirect recommendation activated.</span>
          <div class="zone-monitor-module__activation-actions">
            <span class="zone-monitor-module__activation-notes">${message}</span>
            <button type="button" class="zone-monitor-module__activation-dismiss">Dismiss</button>
          </div>
        </div>
      `;

      recommendationsList.querySelector(".zone-monitor-module__activation-dismiss").addEventListener("click", () => {
        renderRecommendations();
      });
    });
  });
}

function refreshAll(container) {
  renderZones(state.zones, container);
  renderAlerts(container);
  renderRecommendations(container);
}

// ----------------------------------------------------------------
// Public API (extended)
// ----------------------------------------------------------------
function initMonitoring(moduleEl, options = {}) {
  const container =
    options.container ||
    (moduleEl && moduleEl.querySelector
      ? moduleEl.querySelector(".zone-monitor-module__grid")
      : null);

  if (!container) throw new Error("Zone monitoring container not found.");

  renderZones(state.zones, container);
  state.alerts = generateAlerts(state.zones);
  renderAlerts(container);
  renderRecommendations(container);

  let timer = null;
  const startAutoRefresh = (intervalMs) => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      refreshAll(container);
    }, intervalMs || 30000);
  };

  moduleEl.addEventListener("zone:monitor:start", (e) => {
    startAutoRefresh(e.detail?.intervalMs);
  });

  moduleEl.addEventListener("zone:monitor:stop", () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });

  // Reactive hook: refresh alerts + recommendations + staff recommendations.
  const originalUpdateZone = updateZone;
  updateZone = function (zoneId, patch, containerToUse) {
    originalUpdateZone(zoneId, patch, containerToUse);
    state.alerts = generateAlerts(state.zones);
    state.recommendations = generateRecommendations(state.zones, state.zones.find((z) => z.id === zoneId) || state.zones[0]);
    state.staffRecommendations = generateRecommendations(state.zones, state.zones.find((z) => z.id === zoneId) || state.zones[0]);
    renderAlerts(document.getElementById("alert-list"));
    renderRecommendations(document.getElementById("recommendation-list"));
  };

  return {
    state,
    container,
    renderZones,
    updateZone,
    refreshAll,
    generateAlerts,
    renderAlerts,
    acknowledgeAlert,
    generateRecommendations,
    renderRecommendations,
    deployStaff,
    selectSimulationZone,
    simulateZoneIncrease,
    simulateZoneDecrease,
    initiateCrowdSurge,
    startAutoRefresh,
    stopAutoRefresh: () =>
      moduleEl && moduleEl.dispatchEvent(new CustomEvent("zone:monitor:stop")),
  };
}
