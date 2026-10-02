"""Venue endpoints. Reads are public; writes need a signed-in user."""

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query, status

from auth import get_current_user
from crowd import find_redirection, venue_to_dict
from database import get_db, now_iso
from models import OccupancyUpdate, RedirectionOut, VenueCreate, VenueOut, VenueUpdate

router = APIRouter(prefix="/venues", tags=["venues"])


def _get_venue_or_404(db, venue_id: int):
    row = db.execute("SELECT * FROM venues WHERE id = ?", (venue_id,)).fetchone()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Venue {venue_id} not found.",
        )
    return row


def _events_by_venue(db) -> dict[int, dict]:
    """Map venue_id -> the event currently scheduled in it."""
    rows = db.execute(
        "SELECT id, name, event_date, venue_id FROM events WHERE venue_id IS NOT NULL"
    ).fetchall()
    return {
        row["venue_id"]: {
            "id": row["id"],
            "name": row["name"],
            "event_date": row["event_date"],
        }
        for row in rows
    }


def _with_events(db, venue: dict) -> dict:
    venue["current_event"] = _events_by_venue(db).get(venue["id"])
    return venue


def _all_venues(db) -> list[dict]:
    rows = db.execute("SELECT * FROM venues ORDER BY name COLLATE NOCASE").fetchall()
    events = _events_by_venue(db)
    venues = []
    for row in rows:
        venue = venue_to_dict(row)
        venue["current_event"] = events.get(venue["id"])
        venues.append(venue)
    return venues


@router.get("", response_model=list[VenueOut], summary="List all venues")
def list_venues(
    crowd_status: str | None = Query(default=None, description="Filter by status, e.g. CRITICAL"),
    active: bool | None = Query(default=None, description="Filter by currently-open venues"),
    db=Depends(get_db),
):
    venues = _all_venues(db)
    if crowd_status:
        venues = [v for v in venues if v["status"] == crowd_status.upper()]
    if active is not None:
        venues = [v for v in venues if v["is_active"] == active]
    return venues


@router.get("/{venue_id}", response_model=VenueOut, summary="Get a single venue")
def get_venue(venue_id: int, db=Depends(get_db)):
    return _with_events(db, venue_to_dict(_get_venue_or_404(db, venue_id)))


@router.get(
    "/{venue_id}/suggestion",
    response_model=RedirectionOut,
    summary="Get a redirection suggestion for a busy venue",
)
def get_suggestion(venue_id: int, db=Depends(get_db)):
    _get_venue_or_404(db, venue_id)
    all_venues = _all_venues(db)
    venue = next(v for v in all_venues if v["id"] == venue_id)
    return find_redirection(venue, all_venues)


@router.post(
    "",
    response_model=VenueOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create a venue (signed-in user)",
)
def create_venue(
    payload: VenueCreate, _user=Depends(get_current_user), db=Depends(get_db)
):
    timestamp = now_iso()
    try:
        cursor = db.execute(
            """INSERT INTO venues
               (name, capacity, occupancy, opening_time, closing_time, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                payload.name,
                payload.capacity,
                payload.occupancy,
                payload.opening_time,
                payload.closing_time,
                timestamp,
                timestamp,
            ),
        )
    except sqlite3.IntegrityError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A venue named '{payload.name}' already exists.",
        )
    return _with_events(db, venue_to_dict(_get_venue_or_404(db, cursor.lastrowid)))


@router.patch(
    "/{venue_id}",
    response_model=VenueOut,
    summary="Update a venue (signed-in user): rename, capacity, occupancy, or timings",
)
def update_venue(
    venue_id: int,
    payload: VenueUpdate,
    _user=Depends(get_current_user),
    db=Depends(get_db),
):
    row = _get_venue_or_404(db, venue_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields provided to update.",
        )

    fields, values = [], []
    for field, value in changes.items():
        fields.append(f"{field} = ?")
        values.append(value)
    fields.append("updated_at = ?")
    values.append(now_iso())
    values.append(venue_id)

    try:
        db.execute(f"UPDATE venues SET {', '.join(fields)} WHERE id = ?", values)
    except sqlite3.IntegrityError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A venue named '{changes.get('name')}' already exists.",
        )
    return _with_events(db, venue_to_dict(_get_venue_or_404(db, venue_id)))


@router.patch(
    "/{venue_id}/occupancy",
    response_model=VenueOut,
    summary="Update a venue's current occupancy (signed-in user)",
)
def update_occupancy(
    venue_id: int,
    payload: OccupancyUpdate,
    _user=Depends(get_current_user),
    db=Depends(get_db),
):
    _get_venue_or_404(db, venue_id)
    db.execute(
        "UPDATE venues SET occupancy = ?, updated_at = ? WHERE id = ?",
        (payload.occupancy, now_iso(), venue_id),
    )
    return _with_events(db, venue_to_dict(_get_venue_or_404(db, venue_id)))


@router.delete(
    "/{venue_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Remove a venue (signed-in user)",
)
def delete_venue(venue_id: int, _user=Depends(get_current_user), db=Depends(get_db)):
    _get_venue_or_404(db, venue_id)
    db.execute("DELETE FROM venues WHERE id = ?", (venue_id,))
    return None
