"""Pydantic request/response models. Field names are stable for the frontend."""

from enum import Enum

from pydantic import BaseModel, Field

TIME_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"  # HH:MM, 24-hour
DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}$"  # YYYY-MM-DD


class Role(str, Enum):
    admin = "admin"
    user = "user"


class AnnouncementType(str, Enum):
    INFO = "INFO"
    WARNING = "WARNING"
    REDIRECT = "REDIRECT"
    EMERGENCY = "EMERGENCY"


# --------------------------------------------------------------------------- auth


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: Role
    username: str


class UserOut(BaseModel):
    username: str
    role: Role


# ------------------------------------------------------------------------- venues


class VenueCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    capacity: int = Field(gt=0, le=1_000_000)
    occupancy: int = Field(default=0, ge=0)
    opening_time: str = Field(default="09:00", pattern=TIME_PATTERN)
    closing_time: str = Field(default="21:00", pattern=TIME_PATTERN)


class VenueUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    capacity: int | None = Field(default=None, gt=0, le=1_000_000)
    occupancy: int | None = Field(default=None, ge=0)
    opening_time: str | None = Field(default=None, pattern=TIME_PATTERN)
    closing_time: str | None = Field(default=None, pattern=TIME_PATTERN)


class OccupancyUpdate(BaseModel):
    occupancy: int = Field(ge=0)


class EventBrief(BaseModel):
    """Compact event attached to a venue so every page can show what is on there."""

    id: int
    name: str
    event_date: str


class VenueOut(BaseModel):
    id: int
    name: str
    capacity: int
    occupancy: int
    occupancy_percentage: float
    status: str
    available_capacity: int
    opening_time: str
    closing_time: str
    is_active: bool
    created_at: str
    updated_at: str
    current_event: EventBrief | None = None


# --------------------------------------------------------------------------- events


class EventCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    event_date: str = Field(pattern=DATE_PATTERN)
    description: str = Field(default="", max_length=300)
    venue_id: int | None = None


class EventUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    event_date: str | None = Field(default=None, pattern=DATE_PATTERN)
    description: str | None = Field(default=None, max_length=300)
    venue_id: int | None = None


class EventOut(BaseModel):
    id: int
    name: str
    event_date: str
    description: str
    venue_id: int | None
    venue_name: str | None
    created_at: str
    updated_at: str


# ---------------------------------------------------------------------------- staff


class StaffDeploymentCreate(BaseModel):
    venue_id: int
    count: int = Field(default=2, ge=1, le=50)


class StaffZoneOut(BaseModel):
    venue_id: int
    venue_name: str
    staff: int


class StaffOverview(BaseModel):
    pool_size: int
    deployed: int
    available: int
    per_venue: list[StaffZoneOut]


class RedirectSuggestion(BaseModel):
    venue_id: int
    venue_name: str
    occupancy_percentage: float
    status: str
    available_capacity: int
    reason: str


class RedirectionOut(BaseModel):
    venue_id: int
    venue_name: str
    status: str
    needs_redirection: bool
    suggestion: RedirectSuggestion | None = None
    reason: str | None = None


# ------------------------------------------------------------------ announcements


class AnnouncementCreate(BaseModel):
    message: str = Field(min_length=1, max_length=500)
    type: AnnouncementType = AnnouncementType.INFO
    venue_id: int | None = None


class AnnouncementUpdate(BaseModel):
    message: str | None = Field(default=None, min_length=1, max_length=500)
    type: AnnouncementType | None = None
    venue_id: int | None = None
    active: bool | None = None


class AnnouncementOut(BaseModel):
    id: int
    message: str
    type: AnnouncementType
    venue_id: int | None
    active: bool
    created_at: str
