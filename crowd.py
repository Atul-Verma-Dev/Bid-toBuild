"""Crowd calculations: occupancy percentage, status, active window, redirection.

All status/percentage values are computed here so the frontend never has to.
"""

from datetime import datetime

# Statuses, in increasing severity.
NORMAL = "NORMAL"
MODERATE = "MODERATE"
WARNING = "WARNING"
CRITICAL = "CRITICAL"
OVERCROWDED = "OVERCROWDED"

# Statuses that trigger a redirection suggestion.
REDIRECT_TRIGGER_STATUSES = {WARNING, CRITICAL, OVERCROWDED}


def occupancy_percentage(occupancy: int, capacity: int) -> float:
    if capacity <= 0:
        return 0.0
    return round(occupancy / capacity * 100, 1)


def crowd_status(percentage: float) -> str:
    """Thresholds: <70 NORMAL, 70-84 MODERATE, 85-94 WARNING, 95-100 CRITICAL, >100 OVERCROWDED."""
    if percentage > 100:
        return OVERCROWDED
    if percentage >= 95:
        return CRITICAL
    if percentage >= 85:
        return WARNING
    if percentage >= 70:
        return MODERATE
    return NORMAL


def _to_minutes(value: str) -> int:
    hours, minutes = value.split(":")
    return int(hours) * 60 + int(minutes)


def is_active(opening_time: str, closing_time: str, now: datetime | None = None) -> bool:
    """Whether a venue is open right now. Handles windows that cross midnight."""
    now = now or datetime.now()
    current = now.hour * 60 + now.minute
    opening = _to_minutes(opening_time)
    closing = _to_minutes(closing_time)
    if opening == closing:  # treat equal times as open 24h
        return True
    if opening < closing:
        return opening <= current < closing
    return current >= opening or current < closing


def venue_to_dict(row, now: datetime | None = None) -> dict:
    """Serialize a venue row and attach all calculated fields."""
    now = now or datetime.now()
    percentage = occupancy_percentage(row["occupancy"], row["capacity"])
    # An operator can override the daily window: force a venue open (extending
    # the hours) or force it closed. 'auto' simply follows the schedule.
    override = row["open_override"] or "auto"
    if override == "open":
        open_now = True
    elif override == "closed":
        open_now = False
    else:
        open_now = is_active(row["opening_time"], row["closing_time"], now)
    return {
        "id": row["id"],
        "name": row["name"],
        "capacity": row["capacity"],
        "occupancy": row["occupancy"],
        "occupancy_percentage": percentage,
        "status": crowd_status(percentage),
        "available_capacity": max(row["capacity"] - row["occupancy"], 0),
        "opening_time": row["opening_time"],
        "closing_time": row["closing_time"],
        "is_active": open_now,
        "open_override": override,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def find_redirection(venue: dict, all_venues: list[dict]) -> dict:
    """Suggest the best destination for a venue that is filling up.

    Deterministic: pick the active venue with available capacity and the lowest
    occupancy percentage. Overcrowded/critical/warning venues are never offered.
    """
    if venue["status"] not in REDIRECT_TRIGGER_STATUSES:
        return {
            "venue_id": venue["id"],
            "venue_name": venue["name"],
            "status": venue["status"],
            "needs_redirection": False,
            "suggestion": None,
            "reason": None,
        }

    candidates = [
        candidate
        for candidate in all_venues
        if candidate["id"] != venue["id"]
        and candidate["is_active"]
        and candidate["available_capacity"] > 0
        and candidate["status"] not in REDIRECT_TRIGGER_STATUSES
    ]

    if not candidates:
        return {
            "venue_id": venue["id"],
            "venue_name": venue["name"],
            "status": venue["status"],
            "needs_redirection": True,
            "suggestion": None,
            "reason": "No venue with free capacity is currently available.",
        }

    best = min(candidates, key=lambda c: c["occupancy_percentage"])
    return {
        "venue_id": venue["id"],
        "venue_name": venue["name"],
        "status": venue["status"],
        "needs_redirection": True,
        "suggestion": {
            "venue_id": best["id"],
            "venue_name": best["name"],
            "occupancy_percentage": best["occupancy_percentage"],
            "status": best["status"],
            "available_capacity": best["available_capacity"],
            "reason": (
                f"{best['name']} is only {best['occupancy_percentage']}% full "
                f"with {best['available_capacity']} free spots."
            ),
        },
    }
