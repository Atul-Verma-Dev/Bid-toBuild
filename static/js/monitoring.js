/* ============================================================
   ZONE MONITORING MODULE
   Mock state and rendering for the event zone monitoring UI.

   Completely self-contained: no DOM references outside its own
   wrapper. Generate/refresh the UI by calling renderZones().
   ============================================================ */

// Mock state
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

function renderZones(zones, container) {
  if (!Array.isArray(zones) || zones.length === 0) {
    container.innerHTML = `
      <div class="zone-monitor-module__empty">
        <span class="zone-monitor-module__empty-icon">▌</span>
        <p class="zone-monitor-module__empty-text">No zones monitored yet.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = zones.map(createZoneCard).join("");
}

function updateZone(zoneId, patch, container) {
  const zone = (state.zones.find((z) => z.id === zoneId) || null);
  if (!zone) return;

  Object.assign(zone, patch);

  // Re-render only the affected card so status and progress stay consistent.
  const card = $(`.zone-monitor-module__card[data-zone-id="${zoneId}"]`, container);
  if (card) {
    card.outerHTML = createZoneCard(zone);
  } else {
    renderZones(state.zones, container);
  }
}

function refreshAll(container) {
  renderZones(state.zones, container);
}

// ----------------------------------------------------------------
// Public initialization
// ----------------------------------------------------------------
function initMonitoring(moduleEl, options = {}) {
  const container =
    options.container ||
    (moduleEl && moduleEl.querySelector
      ? moduleEl.querySelector(".zone-monitor-module__grid")
      : null);

  if (!container) throw new Error("Zone monitoring container not found.");

  renderZones(state.zones, container);

  // Optional live refresh (no hardcoded timers here — consumed by the
  // dashboard or a parent system).
  let timer = null;
  const startAutoRefresh = (intervalMs) => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => refreshAll(container), intervalMs || 30000);
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
    container,
    renderZones,
    updateZone,
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
  const alerts = getUnacknowledgedAlerts();
  if (alerts.length === 0) {
    container.innerHTML = `
      <div class="zone-monitor-module__alerts-empty zone-monitor-module__alerts-empty--no-alerts">
        <span class="zone-monitor-module__alerts-empty-icon">✅</span>
        <p class="zone-monitor-module__alerts-empty-text">All clear. No overcrowding alerts.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = alerts.map((alert) => `
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
  container.querySelectorAll("button[data-ack]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const alertId = btn.dataset.ack;
      const ok = acknowledgeAlert(alertId);
      if (ok) {
        renderAlerts(container);
        renderRecommendations(container);
      }
    });
  });
}

function renderRecommendations(container) {
  const activeCard = container.closest ? container.closest(".zone-monitor-module__card") : null;
  let activeZone = null;

  if (activeCard) {
    const zoneId = Number(activeCard.dataset.zoneId);
    activeZone = state.zones.find((z) => z.id === zoneId) || null;
  }

  // Pick the most crowded unacknowledged alert as the active zone.
  if (!activeZone) {
    const critical = state.alerts.find((a) => a.severity === "CRITICAL");
    const warning = state.alerts.find((a) => a.severity === "WARNING");
    if (critical) activeZone = state.zones.find((z) => z.id === critical.zoneId) || null;
    else if (warning) activeZone = state.zones.find((z) => z.id === warning.zoneId) || null;
  }

  if (!activeZone) {
    container.innerHTML = `
      <div class="zone-monitor-module__recommendations-empty">
        <span class="zone-monitor-module__recommendations-empty-icon">📋</span>
        <p class="zone-monitor-module__recommendations-empty-text">Select a crowded zone to get redirection recommendations.</p>
      </div>
    `;
    return;
  }

  const occupied = calculateOccupancyPercentage(activeZone);
  const recommendations = generateRecommendations(state.zones, activeZone);

  if (recommendations.length === 0) {
    container.innerHTML = `
      <div class="zone-monitor-module__no-safe-zones">
        <span class="zone-monitor-module__recommendations-empty-icon">🚫</span>
        <p class="zone-monitor-module__no-safe-zones-text">No safe zones available right now.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
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

  container.querySelectorAll("button[data-redirect-to]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = Number(btn.dataset.redirectTo);
      const target = state.zones.find((z) => z.id === targetId);
      if (!target) return;

      const activatedAt = new Date();
      const message = `Redirect recommendation activated for ${activeZone.name} → ${target.name} at ${activatedAt.toLocaleString()}.`;

      // Show a clear confirmation state inside the recommendations panel.
      container.innerHTML = `
        <div class="zone-monitor-module__activation">
          <span class="zone-monitor-module__activation-icon">✅</span>
          <span class="zone-monitor-module__activation-text">Redirect recommendation activated.</span>
          <div class="zone-monitor-module__activation-actions">
            <span class="zone-monitor-module__activation-notes">${message}</span>
            <button type="button" class="zone-monitor-module__activation-dismiss">Dismiss</button>
          </div>
        </div>
      `;

      container.querySelector(".zone-monitor-module__activation-dismiss").addEventListener("click", () => {
        renderRecommendations(container);
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

  // Reactive hook: refresh alerts + recommendations when zone state changes.
  const originalUpdateZone = updateZone;
  updateZone = function (zoneId, patch, containerToUse) {
    originalUpdateZone(zoneId, patch, containerToUse);
    state.alerts = generateAlerts(state.zones);
    renderAlerts(containerToUse || container);
    renderRecommendations(containerToUse || container);
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
    startAutoRefresh,
    stopAutoRefresh: () =>
      moduleEl && moduleEl.dispatchEvent(new CustomEvent("zone:monitor:stop")),
  };
}
