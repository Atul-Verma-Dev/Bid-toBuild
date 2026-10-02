"""Event (program) endpoints. Reads are public; writes need a signed-in user."""

from fastapi import APIRouter, Depends, HTTPException, Query, status

from auth import get_current_user
from database import get_db, now_iso
from models import EventCreate, EventOut, EventUpdate

router = APIRouter(prefix="/events", tags=["events"])

# Every event is returned together with its venue so the UI can show at a glance
# which event is happening where.
EVENT_QUERY = """
    SELECT e.*, v.name AS venue_name
    FROM events e
    LEFT JOIN venues v ON v.id = e.venue_id
"""


def _to_dict(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "event_date": row["event_date"],
        "description": row["description"],
        "venue_id": row["venue_id"],
        "venue_name": row["venue_name"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _get_or_404(db, event_id: int):
    row = db.execute(EVENT_QUERY + " WHERE e.id = ?", (event_id,)).fetchone()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Event {event_id} not found.",
        )
    return row


def _check_venue(db, venue_id: int | None) -> None:
    """Venue assignment is optional, but when given it must exist."""
    if venue_id is None:
        return
    row = db.execute("SELECT id FROM venues WHERE id = ?", (venue_id,)).fetchone()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Venue {venue_id} not found.",
        )


@router.get("", response_model=list[EventOut], summary="List events")
def list_events(
    venue_id: int | None = Query(default=None, description="Only events in this venue"),
    db=Depends(get_db),
):
    query = EVENT_QUERY
    params: list = []
    if venue_id is not None:
        query += " WHERE e.venue_id = ?"
        params.append(venue_id)
    query += " ORDER BY e.event_date ASC, e.id ASC"
    return [_to_dict(row) for row in db.execute(query, params).fetchall()]


@router.get("/{event_id}", response_model=EventOut, summary="Get one event")
def get_event(event_id: int, db=Depends(get_db)):
    return _to_dict(_get_or_404(db, event_id))


@router.post(
    "",
    response_model=EventOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create an event",
)
def create_event(
    payload: EventCreate,
    _user=Depends(get_current_user),
    db=Depends(get_db),
):
    _check_venue(db, payload.venue_id)
    timestamp = now_iso()
    cursor = db.execute(
        """INSERT INTO events
           (name, event_date, description, venue_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (
            payload.name,
            payload.event_date,
            payload.description,
            payload.venue_id,
            timestamp,
            timestamp,
        ),
    )
    return _to_dict(_get_or_404(db, cursor.lastrowid))


@router.patch(
    "/{event_id}",
    response_model=EventOut,
    summary="Rename / edit an event, or move it to another venue",
)
def update_event(
    event_id: int,
    payload: EventUpdate,
    _user=Depends(get_current_user),
    db=Depends(get_db),
):
    _get_or_404(db, event_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields provided to update.",
        )
    if "venue_id" in changes:
        _check_venue(db, changes["venue_id"])

    fields, values = [], []
    for field, value in changes.items():
        fields.append(f"{field} = ?")
        values.append(value)
    fields.append("updated_at = ?")
    values.append(now_iso())
    values.append(event_id)

    db.execute(f"UPDATE events SET {', '.join(fields)} WHERE id = ?", values)
    return _to_dict(_get_or_404(db, event_id))


@router.delete(
    "/{event_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an event",
)
def delete_event(event_id: int, _user=Depends(get_current_user), db=Depends(get_db)):
    _get_or_404(db, event_id)
    db.execute("DELETE FROM events WHERE id = ?", (event_id,))
    return None
