"""Staff deployment endpoints.

Any signed-in user (role `user` or `admin`) can deploy staff to a venue and
recall them again — staffing is an on-the-floor operation, not an admin task.
Deployments are stored in SQLite, so the count survives reloads and is shared
between the dashboard, the zone monitor, and the headcount pool.
"""

from fastapi import APIRouter, Depends, HTTPException, status

from auth import get_current_user
from database import get_db, now_iso
from models import StaffDeploymentCreate, StaffOverview

router = APIRouter(prefix="/staff", tags=["staff"])

# Total personnel available to the whole event.
STAFF_POOL_SIZE = 12


def _overview(db) -> dict:
    """Pool totals plus the staff count currently deployed to each venue."""
    rows = db.execute(
        """SELECT v.id AS venue_id,
                  v.name AS venue_name,
                  COALESCE(SUM(d.count), 0) AS staff
           FROM venues v
           LEFT JOIN staff_deployments d ON d.venue_id = v.id
           GROUP BY v.id, v.name
           ORDER BY v.name COLLATE NOCASE"""
    ).fetchall()
    per_venue = [
        {"venue_id": row["venue_id"], "venue_name": row["venue_name"], "staff": row["staff"]}
        for row in rows
    ]
    deployed = sum(zone["staff"] for zone in per_venue)
    return {
        "pool_size": STAFF_POOL_SIZE,
        "deployed": deployed,
        "available": max(STAFF_POOL_SIZE - deployed, 0),
        "per_venue": per_venue,
    }


def _check_venue(db, venue_id: int) -> None:
    row = db.execute("SELECT id FROM venues WHERE id = ?", (venue_id,)).fetchone()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Venue {venue_id} not found.",
        )


@router.get(
    "",
    response_model=StaffOverview,
    summary="Staff pool and deployments per venue",
)
def staff_overview(db=Depends(get_db)):
    return _overview(db)


@router.post(
    "/deployments",
    response_model=StaffOverview,
    status_code=status.HTTP_201_CREATED,
    summary="Deploy staff to a venue (any signed-in user)",
)
def deploy_staff(
    payload: StaffDeploymentCreate,
    user=Depends(get_current_user),
    db=Depends(get_db),
):
    _check_venue(db, payload.venue_id)

    overview = _overview(db)
    if overview["available"] < payload.count:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Only {overview['available']} of {overview['pool_size']} staff members "
                "are still available. Recall staff from another venue first."
            ),
        )

    db.execute(
        """INSERT INTO staff_deployments (venue_id, count, deployed_by, created_at)
           VALUES (?, ?, ?, ?)""",
        (payload.venue_id, payload.count, user["username"], now_iso()),
    )
    return _overview(db)


@router.delete(
    "/deployments/{venue_id}",
    response_model=StaffOverview,
    summary="Recall every staff member deployed to a venue (any signed-in user)",
)
def recall_staff(
    venue_id: int,
    _user=Depends(get_current_user),
    db=Depends(get_db),
):
    _check_venue(db, venue_id)
    db.execute("DELETE FROM staff_deployments WHERE venue_id = ?", (venue_id,))
    return _overview(db)
