"""Pydantic request/response models. Field names are stable for the frontend."""

from enum import Enum

from pydantic import BaseModel, Field

TIME_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"  # HH:MM, 24-hour


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
