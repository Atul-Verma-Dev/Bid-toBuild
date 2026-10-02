/* ============================================================
   ZONE MONITORING MODULE
   Mock state and rendering for the event zone monitoring UI.

   Completely self-contained: no DOM references outside its own
   wrapper. Generate/refresh the UI by calling renderZones().
   ============================================================ */

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
  zones: [
    {
      id: 1,
      name: "Main Stage",
      capacity: 1000,
      currentCount: 920,
      growthRate: 18,
    },
    {
      id: 2,
      name: "Food Court",
      capacity: 600,
      currentCount: 410,
      growthRate: 9,
    },
    {
      id: 3,
      name: "Gaming Arena",
      capacity: 800,
      currentCount: 760,
      growthRate: 24,
    },
    {
      id: 4,
      name: "Exhibition Hall",
      capacity: 1200,
      currentCount: 540,
      growthRate: -4,
    },
    {
      id: 5,
      name: "Registration Area",
      capacity: 900,
      currentCount: 780,
      growthRate: 12,
    },
  ],
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
  staffRecommendations: [],
};

// ----------------------------------------------------------------
// Pure domain logic
// ----------------------------------------------------------------
function calculateOccupancyPercentage(zone) {
  if (!zone || !zone.capacity || zone.capacity <= 0) return 0;
  return Math.round((zone.currentCount / zone.capacity) * 100);
}

function getZoneStatus(occupancyPercentage) {
  if (occupancyPercentage >= 90) return "CRITICAL";
  if (occupancyPercentage >= 70) return "WARNING";
  return "SAFE";
}

function formatGrowth(growthRate) {
  if (growthRate >= 0) return `+${growthRate}`;
  return String(growthRate);
}

// ----------------------------------------------------------------
// DOM helpers
// ----------------------------------------------------------------
function $(selector, root = document) {
  return root.querySelector(selector);
}

function createZoneCard(zone) {
  const occupancy = calculateOccupancyPercentage(zone);
  const status = getZoneStatus(occupancy);

  const fillClass = `zone-monitor-module__progress-fill--${status.toLowerCase()}`;
  const numberClass = `zone-monitor-module__number-value--${status.toLowerCase()}`;
  const growthClass =
    zone.growthRate > 0
      ? "zone-monitor-module__growth--positive"
      : zone.growthRate < 0
      ? "zone-monitor-module__growth--negative"
      : "";

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
          <span class="zone-monitor-module__number-value ${numberClass}">${zone.currentCount}</span>
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

      <div class="zone-monitor-module__growth">
        <span>Crowd growth rate</span>
        <span class="${growthClass}">${formatGrowth(zone.growthRate)} people/min</span>
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

  zone.currentCount = Math.min(zone.capacity, zone.currentCount + amount);
  state.simulation.step += Math.abs(amount);

  // Keep staff pool consistent: deploy staff when a zone becomes critical.
  const occupancy = calculateOccupancyPercentage(zone);
  if (occupancy >= 90) {
    const idle = state.staff.available - state.staff.deployed;
    const toDeploy = Math.min(2, idle, state.staff.total - state.staff.deployed);
    if (toDeploy > 0) {
      state.staff.deployed += toDeploy;
      state.staff.available -= toDeploy;
      state.staff.busy += toDeploy;
    }
  }

  refreshAll();
}

function simulateZoneDecrease(amount) {
  const zone = state.zones.find((z) => z.id === state.simulation.activeZoneId);
  if (!zone) return;

  zone.currentCount = Math.max(0, zone.currentCount - amount);
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
  const activeOccupancy = calculateOccupancyPercentage(activeZone);
  const activeStatus = getZoneStatus(activeOccupancy);

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
      const occ = calculateOccupancyPercentage(zone);
      const status = getZoneStatus(occ);
      const isCritical = status === "CRITICAL";
      const isWarning = status === "WARNING";

      const candidates = state.zones
        .map((z) => ({ z, occ: calculateOccupancyPercentage(z), status: getZoneStatus(occ) }))
        .filter((x) => x.status !== "CRITICAL" && x.status !== "WARNING")
        .slice(0, 3)
        .map((x) => x.z.name);

      const criticalNames = state.zones
        .map((z) => ({ z, occ: calculateOccupancyPercentage(z), status: getZoneStatus(occ) }))
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
            <span>${calculateOccupancyPercentage(zone)}% occupied</span>
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
  document.getElementById("simulation-active-occupancy").textContent = `${activeZone.currentCount} / ${activeZone.capacity}`;
  document.getElementById("simulation-active-percentage").textContent = `${calculateOccupancyPercentage(activeZone)}%`;
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

// CLI guard for development preview.
if (typeof document !== "undefined") {
  const moduleRoot = document.querySelector(".zone-monitor-module");
  if (moduleRoot) {
    initMonitoring(moduleRoot);
  }
}

// ============================================================
   OVERCROWDING ALERTS + CROWD REDIRECTION
   ============================================================

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
    (z) => z.id !== activeZone.id && getZoneStatus(calculateOccupancyPercentage(z)) !== "CRITICAL"
  );

  // Prefer SAFE zones with the most available capacity first.
  const sorted = [...safeZones].sort((a, b) => {
    const availableA = a.capacity - a.currentCount;
    const availableB = b.capacity - b.currentCount;
    if (getZoneStatus(calculateOccupancyPercentage(a)) === "SAFE" && getZoneStatus(calculateOccupancyPercentage(b)) !== "SAFE") return -1;
    if (getZoneStatus(calculateOccupancyPercentage(b)) === "SAFE" && getZoneStatus(calculateOccupancyPercentage(a)) !== "SAFE") return 1;
    return (availableB - availableA) || 0;
  });

  const recommendations = sorted.slice(0, 4).map((z) => ({
    zone: z,
    availableCapacity: z.capacity - z.currentCount,
    status: getZoneStatus(calculateOccupancyPercentage(z)),
    reason:
      z.currentCount === 0
        ? "Completely empty — ideal placement."
        : `${calculateOccupancyPercentage(z)}% occupied — room available.`,
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
