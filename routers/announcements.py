"""Announcement endpoints. Reads are public; writes require an admin token."""

from fastapi import APIRouter, Depends, HTTPException, Query, status

from auth import require_admin
from database import get_db, now_iso
from models import AnnouncementCreate, AnnouncementOut, AnnouncementType, AnnouncementUpdate

router = APIRouter(prefix="/announcements", tags=["announcements"])


def _to_dict(row) -> dict:
    return {
        "id": row["id"],
        "message": row["message"],
        "type": row["type"],
        "venue_id": row["venue_id"],
        "active": bool(row["active"]),
        "created_at": row["created_at"],
    }


def _get_or_404(db, announcement_id: int):
    row = db.execute(
        "SELECT * FROM announcements WHERE id = ?", (announcement_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Announcement {announcement_id} not found.",
        )
    return row


@router.get("", response_model=list[AnnouncementOut], summary="List announcements")
def list_announcements(
    type: AnnouncementType | None = Query(default=None, description="Filter by type"),
    venue_id: int | None = Query(default=None, description="Filter by venue"),
    active_only: bool = Query(default=True, description="Only return active announcements"),
    limit: int = Query(default=50, ge=1, le=200),
    db=Depends(get_db),
):
    query = "SELECT * FROM announcements WHERE 1 = 1"
    params: list = []
    if type is not None:
        query += " AND type = ?"
        params.append(type.value)
    if venue_id is not None:
        query += " AND (venue_id = ? OR venue_id IS NULL)"
        params.append(venue_id)
    if active_only:
        query += " AND active = 1"
    query += " ORDER BY created_at DESC, id DESC LIMIT ?"
    params.append(limit)

    rows = db.execute(query, params).fetchall()
    return [_to_dict(row) for row in rows]


@router.post(
    "",
    response_model=AnnouncementOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create an announcement (admin)",
)
def create_announcement(
    payload: AnnouncementCreate,
    _admin=Depends(require_admin),
    db=Depends(get_db),
):
    if payload.venue_id is not None:
        venue = db.execute(
            "SELECT id FROM venues WHERE id = ?", (payload.venue_id,)
        ).fetchone()
        if venue is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Venue {payload.venue_id} not found.",
            )
    cursor = db.execute(
        "INSERT INTO announcements (message, type, venue_id, created_at) VALUES (?, ?, ?, ?)",
        (payload.message, payload.type.value, payload.venue_id, now_iso()),
    )
    return _to_dict(_get_or_404(db, cursor.lastrowid))


@router.patch(
    "/{announcement_id}",
    response_model=AnnouncementOut,
    summary="Update or deactivate an announcement (admin)",
)
def update_announcement(
    announcement_id: int,
    payload: AnnouncementUpdate,
    _admin=Depends(require_admin),
    db=Depends(get_db),
):
    _get_or_404(db, announcement_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields provided to update.",
        )
    fields, values = [], []
    for field, value in changes.items():
        if field == "type" and value is not None:
            value = value.value
        if field == "active":
            value = 1 if value else 0
        fields.append(f"{field} = ?")
        values.append(value)
    values.append(announcement_id)
    db.execute(f"UPDATE announcements SET {', '.join(fields)} WHERE id = ?", values)
    return _to_dict(_get_or_404(db, announcement_id))


@router.delete(
    "/{announcement_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an announcement (admin)",
)
def delete_announcement(
    announcement_id: int, _admin=Depends(require_admin), db=Depends(get_db)
):
    _get_or_404(db, announcement_id)
    db.execute("DELETE FROM announcements WHERE id = ?", (announcement_id,))
    return None
