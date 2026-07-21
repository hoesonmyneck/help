"""Authentication: password hashing, JWT cookies, current-user dependency, EDS (ЭЦП) 2FA.

Phase 1 uses password + JWT httponly cookie.
Phase 3 adds EDS: a signed JWT challenge + CMS-signature verification via NCALayer.
"""
import os
import re
import hmac
import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Request, HTTPException, Depends
from sqlalchemy.orm import Session
from jose import jwt, JWTError

from database import engine, User

JWT_SECRET = os.environ.get("JWT_SECRET", "change-me-in-prod-9f3a2b7c1d8e4f60")
JWT_ALGORITHM = "HS256"
ACCESS_TTL_HOURS = 12
CHALLENGE_TTL_MINUTES = 5
COOKIE_NAME = "access_token"

# Постоянный токен для перехода с портала ecosystem.enbek.kz (общий секрет).
# Пустой => SSO выключен.
SSO_TOKEN = os.environ.get("SSO_TOKEN", "")

# Стандартный пароль для прямого входа людей из белого списка ИИН
# (логин = ИИН из списка). При необходимости переопределяется через окружение.
WHITELIST_PASSWORD = os.environ.get("WHITELIST_PASSWORD", "qwerty12Q")


# ── Password hashing (stdlib pbkdf2, no extra deps) ──────────────────────────
def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return "pbkdf2_sha256$200000$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def verify_password(password: str, stored: str) -> bool:
    try:
        _algo, iters, salt_b64, dk_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(dk_b64)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(iters))
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


# ── Access token (JWT in httponly cookie) ────────────────────────────────────
def create_access_token(user: User) -> str:
    payload = {
        "sub": "access",
        "uid": user.id,
        "login": user.login,
        "role": user.role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=ACCESS_TTL_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def set_auth_cookie(response, token: str):
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=ACCESS_TTL_HOURS * 3600,
        path="/",
    )


def clear_auth_cookie(response):
    response.delete_cookie(COOKIE_NAME, path="/")


SSO_TICKET_TTL_MINUTES = 2


def create_login_ticket(user: User) -> str:
    """Одноразовый короткоживущий тикет для безопасного перевода браузера в кабинет."""
    payload = {
        "sub": "sso_ticket",
        "uid": user.id,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=SSO_TICKET_TTL_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_login_ticket(token: str) -> dict:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Тикет недействителен или истёк")
    if payload.get("sub") != "sso_ticket":
        raise HTTPException(status_code=401, detail="Тикет недействителен")
    return payload


def _decode_access(token: str) -> dict:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Недействительная сессия")
    if payload.get("sub") != "access":
        raise HTTPException(status_code=401, detail="Недействительная сессия")
    return payload


def current_user(request: Request) -> User:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    payload = _decode_access(token)
    with Session(engine) as db:
        user = db.get(User, payload.get("uid"))
        if not user:
            raise HTTPException(status_code=401, detail="Пользователь не найден")
        db.expunge(user)
        return user


def require_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Доступ только для администратора")
    return user


# ── EDS challenge (signed JWT, short TTL, uid inside) ─────────────────────────
class EDSError(Exception):
    pass


def generate_challenge(user_id: int) -> str:
    payload = {
        "sub": "eds_challenge",
        "uid": user_id,
        "nonce": secrets.token_urlsafe(32),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=CHALLENGE_TTL_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_challenge(challenge: str) -> dict:
    try:
        payload = jwt.decode(challenge, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError as e:
        raise EDSError(f"Challenge недействителен или истёк: {e}")
    if payload.get("sub") != "eds_challenge":
        raise EDSError("Challenge с неверным subject")
    return payload


# ── CMS signature verification (asn1crypto imported lazily) ───────────────────
OID_SERIAL_NUMBER = "2.5.4.5"     # содержит "IIN123456789012"
OID_SURNAME = "2.5.4.4"
OID_GIVEN_NAME = "2.5.4.42"
OID_COMMON_NAME = "2.5.4.3"


def _extract_iin(cert) -> str:
    for rdn in cert.subject.chosen:
        for attr in rdn:
            if attr["type"].dotted == OID_SERIAL_NUMBER:
                m = re.search(r"(\d{12})", str(attr["value"].native))
                if m:
                    return m.group(1)
    raise EDSError("ИИН не найден в сертификате (поле serialNumber)")


def _extract_fio(cert) -> str:
    cn = surname = given = None
    for rdn in cert.subject.chosen:
        for attr in rdn:
            oid = attr["type"].dotted
            val = str(attr["value"].native)
            if oid == OID_COMMON_NAME:
                cn = val
            elif oid == OID_SURNAME:
                surname = val
            elif oid == OID_GIVEN_NAME:
                given = val
    if cn:
        return cn
    if surname and given:
        return f"{surname} {given}"
    return surname or "Не указано"


def verify_eds_signature(challenge: str, cms_b64: str) -> dict:
    """Returns {'iin': ..., 'fio': ...}. Raises EDSError on any mismatch."""
    from asn1crypto import cms as asn1_cms  # lazy: only needed for EDS

    decode_challenge(challenge)  # свежий и валидный

    content_info = asn1_cms.ContentInfo.load(base64.b64decode(cms_b64))
    if content_info["content_type"].native != "signed_data":
        raise EDSError("CMS не является SignedData")
    signed_data = content_info["content"]

    certs = signed_data["certificates"]
    if not certs:
        raise EDSError("В CMS нет сертификата")
    cert = certs[0].chosen

    encap = signed_data["encap_content_info"]
    if encap["content"].native is None:
        raise EDSError("В CMS нет вложенных данных — подпишите с attached=true")
    original = encap["content"].native
    original_str = original.decode("utf-8") if isinstance(original, bytes) else str(original)
    if original_str.strip() != challenge.strip():
        raise EDSError("Подписанные данные не совпадают с выданным challenge")

    return {"iin": _extract_iin(cert), "fio": _extract_fio(cert)}


# ── Portal SSO (доверенный переход с ecosystem.enbek.kz) ─────────────────────
def sso_token_valid(token: str) -> bool:
    if not SSO_TOKEN:
        return False
    return hmac.compare_digest(token or "", SSO_TOKEN)


def find_or_create_portal_user(identifier: str, fio: str | None) -> User:
    """Найти аккаунт по ИИН/БИН (=login) или создать новый (доверяем порталу)."""
    with Session(engine) as db:
        user = db.query(User).filter(User.login == identifier).first()
        if not user:
            user = User(
                login=identifier,
                password_hash=hash_password(secrets.token_urlsafe(24)),  # вход только через портал
                role="user",
                is_eds=False,
                iin=identifier,
                fio=fio,
            )
            db.add(user)
            db.commit()
            db.refresh(user)
        elif fio and user.fio != fio:
            user.fio = fio
            db.commit()
            db.refresh(user)
        db.expunge(user)
        return user


# ── Seed first admin ─────────────────────────────────────────────────────────
def seed_admin():
    """Create the initial admin from env (or defaults) if no admin exists yet."""
    login = os.environ.get("ADMIN_LOGIN", "admin")
    password = os.environ.get("ADMIN_PASSWORD", "crtr2026")
    with Session(engine) as db:
        exists = db.query(User).filter(User.role == "admin").first()
        if exists:
            return
        db.add(User(
            login=login,
            password_hash=hash_password(password),
            role="admin",
            is_eds=False,
        ))
        db.commit()
        print(f"Seeded admin user '{login}'")
