"""Authentication endpoints: log in and inspect the current user."""

from fastapi import APIRouter, Depends, HTTPException, status

from auth import create_token, get_current_user, verify_password
from database import get_db
from models import LoginRequest, TokenResponse, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse, summary="Log in as admin or user")
def login(payload: LoginRequest, db=Depends(get_db)):
    row = db.execute(
        "SELECT * FROM users WHERE username = ?", (payload.username,)
    ).fetchone()
    if row is None or not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password.",
        )
    return TokenResponse(
        access_token=create_token(row["username"], row["role"]),
        token_type="bearer",
        role=row["role"],
        username=row["username"],
    )


@router.get("/me", response_model=UserOut, summary="Get the current user")
def me(user: dict = Depends(get_current_user)):
    return UserOut(username=user["username"], role=user["role"])
