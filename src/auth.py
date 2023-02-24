"""Authentication utilities."""
from datetime import datetime, timedelta
import os
from passlib.context import CryptContext
from typing import Optional, Union

from fastapi import HTTPException
from fastapi.openapi.models import OAuthFlows as OAuthFlowsModel
from fastapi.security import OAuth2
from fastapi.security.base import SecurityBase
from fastapi.security.utils import get_authorization_scheme_param
import jwt
from starlette.status import HTTP_403_FORBIDDEN
from starlette.requests import Request

from backend import RunningDatabase
import models


# to get a string like this run `openssl rand -hex 32`
SECRET_KEY = os.environ.get("RUNNING_APP_SECRET_KEY", "REPLACE_ME")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # one week


class OAuth2PasswordBearerCookie(OAuth2):
    def __init__(
        self,
        tokenUrl: str,
        scheme_name: Optional[str] = None,
        scopes: Optional[dict] = None,
        auto_error: Optional[bool] = True,
    ):
        if not scopes:
            scopes = {}
        flows = OAuthFlowsModel(password={"tokenUrl": tokenUrl, "scopes": scopes})
        super().__init__(flows=flows, scheme_name=scheme_name, auto_error=auto_error)

    async def __call__(self, request: Request) -> Optional[str]:
        header_authorization: str = request.headers.get("Authorization")
        cookie_authorization: str = request.cookies.get("Authorization")

        header_scheme, header_param = get_authorization_scheme_param(
            header_authorization
        )
        cookie_scheme, cookie_param = get_authorization_scheme_param(
            cookie_authorization
        )

        if header_scheme.lower() == "bearer":
            authorization = True
            scheme = header_scheme
            param = header_param

        elif cookie_scheme.lower() == "bearer":
            authorization = True
            scheme = cookie_scheme
            param = cookie_param

        else:
            authorization = False

        if not authorization or scheme.lower() != "bearer":
            if self.auto_error:
                raise HTTPException(
                    status_code=HTTP_403_FORBIDDEN, detail="Not authenticated"
                )
            else:
                return None
        return param


class BasicAuth(SecurityBase):
    def __init__(self, scheme_name: Optional[str] = None, auto_error: bool = True):
        self.scheme_name = scheme_name or self.__class__.__name__
        self.auto_error = auto_error

    async def __call__(self, request: Request) -> Optional[str]:
        authorization: str = request.headers.get("Authorization")
        scheme, param = get_authorization_scheme_param(authorization)
        if not authorization or scheme.lower() != "basic":
            if self.auto_error:
                raise HTTPException(
                    status_code=HTTP_403_FORBIDDEN, detail="Not authenticated"
                )
            else:
                return None
        return param


basic_auth = BasicAuth(auto_error=False)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

oauth2_scheme = OAuth2PasswordBearerCookie(tokenUrl="/login", auto_error=False)


def verify_password(plain_password, hashed_password):
    """Verify a password matches the hashed version for a the user."""
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password):
    """Get the hash of a password."""
    return pwd_context.hash(password)


def authenticate_user(
    db: RunningDatabase, username: str, password: str
) -> Union[bool, models.CurrentUser]:
    """Authenticate a user."""
    user = db.get_user(username)
    if not user:
        # no user with this username was found
        return False
    if not verify_password(password, user.hashed_password):
        # username exists but password was incorrect
        return False
    return user


def create_access_token(*, data: dict, expires_delta: Optional[timedelta] = None):
    """Create an secure access token for an authenticated user."""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=15)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt
