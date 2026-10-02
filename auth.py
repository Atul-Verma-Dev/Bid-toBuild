"""Minimal authentication for the hackathon MVP.

Passwords are hashed with PBKDF2 (stdlib) and access tokens are HMAC-signed
strings that carry the username and role. No external auth libraries needed.
"""

import base64
import hashlib
import hmac
import os
import secrets
import time

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

SECRET_KEY = os.getenv("SECRET_KEY", "smart-events-dev-secret")

# auto_error=False so we can return a clear 401 message ourselves.
bearer_scheme = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    """Return a `salt$hash` string for storing in SQLite."""
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), 100_000
    ).hex()
    return f"{salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, digest = stored.split("$")
    except ValueError:
        return False
    check = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), 100_000
    ).hex()
    return hmac.compare_digest(check, digest)


def create_token(username: str, role: str) -> str:
    """Create a signed token: base64(username:role:issued_at:signature)."""
    payload = f"{username}:{role}:{int(time.time())}"
    signature = hmac.new(
        SECRET_KEY.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}:{signature}".encode()).decode()


def decode_token(token: str) -> dict | None:
    """Return {"username": ..., "role": ...} if the token is valid, else None."""
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        username, role, _issued, signature = raw.rsplit(":", 3)
    except Exception:
        return None
    payload = f"{username}:{role}:{_issued}"
    expected = hmac.new(
        SECRET_KEY.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return None
    return {"username": username, "role": role}


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict:
    """Dependency: any authenticated admin or user."""
    if credentials is None or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token. Log in at POST /auth/login.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = decode_token(credentials.credentials)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or malformed token.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    """Dependency: only admins may pass."""
    if user["role"] != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required for this operation.",
        )
    return user
