import io
from contextlib import asynccontextmanager
from fastapi import FastAPI, Query, Request, Depends, HTTPException, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy import func, distinct
from sqlalchemy.orm import Session
from database import engine, Payment, User, BudgetItem, RegionBudget
from load_data import (load_excel, load_budget, load_region_budget, load_reference_data,
                       replace_payments_from_file,
                       region_help_ids, raion_help_ids,
                       all_region_katos, pay_type_names, REGION_NAMES,
                       raion_names_ref, raion_reg_ref, settings_rows, settings_pay_names)
import auth
import os

# Внешний базовый URL сервиса (как его видит браузер пользователя через портал).
# Используется для абсолютной ссылки redirectUrl в SSO-ответе.
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "https://interaction.enbek.kz:8443").rstrip("/")

EXCLUDED_PAY_SUBSTRINGS = {'АБОНЕНТСКУЮ ПЛАТУ ЗА ТЕЛЕФОН'}

def _is_excluded(pname: str | None) -> bool:
    if not pname:
        return False
    u = pname.upper()
    return any(s in u for s in EXCLUDED_PAY_SUBSTRINGS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_excel()
    load_budget()
    load_region_budget()
    load_reference_data()
    auth.seed_admin()
    yield


app = FastAPI(lifespan=lifespan)

# Public API paths that must work without a session (login flow itself)
_PUBLIC_API = {"/api/auth/login", "/api/auth/login-2fa", "/api/auth/sso",
               "/api/auth/sso/consume"}


@app.middleware("http")
async def auth_gate(request: Request, call_next):
    """Protect every /api/* endpoint with the session cookie, except the login flow."""
    path = request.url.path
    if path.startswith("/api/") and path not in _PUBLIC_API:
        token = request.cookies.get(auth.COOKIE_NAME)
        valid = False
        if token:
            try:
                auth._decode_access(token)
                valid = True
            except HTTPException:
                valid = False
        if not valid:
            return JSONResponse({"detail": "Требуется авторизация"}, status_code=401)
    return await call_next(request)


def get_db():
    with Session(engine) as session:
        yield session


# ─────────────────────────── Auth & admin ───────────────────────────
class LoginBody(BaseModel):
    login: str
    password: str


class Login2FABody(BaseModel):
    challenge: str
    signature: str


class CreateUserBody(BaseModel):
    login: str
    password: str
    is_eds: bool = False
    role: str = "user"


class PasswordBody(BaseModel):
    password: str


def _user_out(u: User) -> dict:
    return {"id": u.id, "login": u.login, "role": u.role,
            "is_eds": u.is_eds, "iin": u.iin, "fio": u.fio}


@app.post("/api/auth/login")
def api_login(body: LoginBody):
    with Session(engine) as db:
        user = db.query(User).filter(User.login == body.login.strip()).first()
        if not user or not auth.verify_password(body.password, user.password_hash):
            raise HTTPException(status_code=401, detail="Неверный логин или пароль")
        if user.is_eds:
            # пароль верный → второй фактор: ЭЦП
            challenge = auth.generate_challenge(user.id)
            return {"requires_2fa": True, "challenge": challenge}
        token = auth.create_access_token(user)
        resp = JSONResponse(_user_out(user))
        auth.set_auth_cookie(resp, token)
        return resp


@app.post("/api/auth/login-2fa")
def api_login_2fa(body: Login2FABody):
    try:
        payload = auth.decode_challenge(body.challenge)
    except auth.EDSError as e:
        raise HTTPException(status_code=401, detail=str(e))
    with Session(engine) as db:
        user = db.get(User, payload.get("uid"))
        if not user:
            raise HTTPException(status_code=401, detail="Пользователь не найден")
        try:
            eds = auth.verify_eds_signature(body.challenge, body.signature)
        except auth.EDSError as e:
            raise HTTPException(status_code=401, detail=str(e))
        if eds["iin"] != (user.iin or user.login):
            raise HTTPException(status_code=401,
                detail=f"ИИН в ЭЦП ({eds['iin']}) не совпадает с аккаунтом")
        user.fio = eds["fio"]
        db.commit()
        token = auth.create_access_token(user)
        resp = JSONResponse(_user_out(user))
        auth.set_auth_cookie(resp, token)
        return resp


@app.get("/api/auth/sso")
def api_sso(request: Request,
            token: str = Query(None), iin: str = Query(None),
            bin: str = Query(None), type: str = Query(None), fio: str = Query(None)):
    """Доверенный переход с портала ecosystem.enbek.kz.

    Портал уже авторизовал человека (ЭЦП ФЛ/ЮЛ) и перенаправляет браузер сюда,
    передавая постоянный токен + личность (ИИН для ФЛ / БИН для ЮЛ).
    Токен принимается в заголовке X-SSO-Token либо в query-параметре token.
    """
    if not auth.SSO_TOKEN:
        raise HTTPException(status_code=503, detail="SSO не настроен")
    tok = request.headers.get("X-SSO-Token") or token
    if not auth.sso_token_valid(tok):
        raise HTTPException(status_code=403, detail="Недействительный токен")

    t = (type or "").strip().lower()
    if t == "ul":
        identifier = (bin or "").strip()
    elif t == "fl":
        identifier = (iin or "").strip()
    else:
        identifier = (bin or iin or "").strip()   # тип не указан — берём что прислали

    if not (identifier.isdigit() and len(identifier) == 12):
        raise HTTPException(status_code=400, detail="Не передан корректный ИИН/БИН (12 цифр)")

    user = auth.find_or_create_portal_user(identifier, (fio or None))
    access = auth.create_access_token(user)
    resp = RedirectResponse(url="/", status_code=303)
    auth.set_auth_cookie(resp, access)
    return resp


class SsoBody(BaseModel):
    iin: str | None = None
    bin: str | None = None
    canSign: bool = False
    isOrganizationHead: bool = False
    fio: str | None = None


def _sso_token_from_request(request: Request, query_token: str | None = None) -> str | None:
    """Достаём SSO-токен из Authorization: Bearer, X-SSO-Token или query."""
    authz = request.headers.get("Authorization") or ""
    if authz.lower().startswith("bearer "):
        return authz[7:].strip()
    return request.headers.get("X-SSO-Token") or query_token


def _sso_fail(status: int, message: str) -> JSONResponse:
    """Ответ в формате контракта портала enbek.kz для ошибок."""
    return JSONResponse(
        {"success": False, "message": message, "redirectUrl": ""},
        status_code=status,
    )


@app.post("/api/auth/sso")
def api_sso_post(body: SsoBody, request: Request):
    """Доверенный вход с портала enbek.kz по POST.

    Портал авторизовал человека (ЭЦП) и серверным запросом сообщает личность:
    ИИН ФЛ и/или БИН организации. Токен — в заголовке Authorization: Bearer <token>.
    Ответ в формате контракта портала: {success, message, redirectUrl}.
    redirectUrl содержит одноразовую ссылку, по которой браузер пользователя
    входит в кабинет (ставится сессия), действует 2 минуты.
    """
    if not auth.SSO_TOKEN:
        return _sso_fail(503, "SSO не настроен")
    tok = _sso_token_from_request(request)
    if not auth.sso_token_valid(tok):
        return _sso_fail(403, "Недействительный токен")

    bin_ = (body.bin or "").strip()
    iin_ = (body.iin or "").strip()
    # Глава/подписант организации → вход от имени ЮЛ (БИН), иначе как ФЛ (ИИН)
    if (body.isOrganizationHead or body.canSign) and bin_:
        identifier = bin_
    else:
        identifier = iin_ or bin_

    if not (identifier.isdigit() and len(identifier) == 12):
        return _sso_fail(400, "Не передан корректный ИИН/БИН (12 цифр)")

    user = auth.find_or_create_portal_user(identifier, (body.fio or None))
    ticket = auth.create_login_ticket(user)
    return JSONResponse({
        "success": True,
        "message": "OK",
        "redirectUrl": f"{PUBLIC_BASE_URL}/api/auth/sso/consume?ticket={ticket}",
    })


@app.get("/api/auth/sso/consume")
def api_sso_consume(ticket: str = Query(...)):
    """Браузер пользователя приходит по одноразовому тикету → ставим сессию и в кабинет."""
    payload = auth.decode_login_ticket(ticket)
    with Session(engine) as db:
        user = db.get(User, payload.get("uid"))
        if not user:
            raise HTTPException(status_code=401, detail="Пользователь не найден")
        access = auth.create_access_token(user)
    resp = RedirectResponse(url="/", status_code=303)
    auth.set_auth_cookie(resp, access)
    return resp


@app.get("/api/auth/me")
def api_me(user: User = Depends(auth.current_user)):
    return _user_out(user)


@app.post("/api/auth/logout")
def api_logout():
    resp = JSONResponse({"ok": True})
    auth.clear_auth_cookie(resp)
    return resp


@app.get("/api/admin/users")
def api_admin_users(admin: User = Depends(auth.require_admin)):
    with Session(engine) as db:
        users = db.query(User).order_by(User.id).all()
        return [_user_out(u) for u in users]


@app.post("/api/admin/users")
def api_admin_create_user(body: CreateUserBody, admin: User = Depends(auth.require_admin)):
    login = body.login.strip()
    if not login or not body.password:
        raise HTTPException(status_code=400, detail="Логин и пароль обязательны")
    if body.is_eds and not login.isdigit():
        raise HTTPException(status_code=400, detail="Для ЭЦП-аккаунта логин должен быть ИИН (12 цифр)")
    role = "admin" if body.role == "admin" else "user"
    with Session(engine) as db:
        if db.query(User).filter(User.login == login).first():
            raise HTTPException(status_code=409, detail="Такой логин уже существует")
        user = User(
            login=login,
            password_hash=auth.hash_password(body.password),
            role=role,
            is_eds=body.is_eds,
            iin=login if body.is_eds else None,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return _user_out(user)


@app.put("/api/admin/users/{user_id}/password")
def api_admin_set_password(user_id: int, body: PasswordBody, admin: User = Depends(auth.require_admin)):
    if not body.password:
        raise HTTPException(status_code=400, detail="Пароль не может быть пустым")
    with Session(engine) as db:
        user = db.get(User, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        user.password_hash = auth.hash_password(body.password)
        db.commit()
        return {"ok": True}


@app.post("/api/admin/upload-data")
async def api_admin_upload_data(file: UploadFile = File(...), admin: User = Depends(auth.require_admin)):
    """Загрузить новый Excel с выплатами: очистить таблицу и залить заново (только админ)."""
    name = (file.filename or "").lower()
    if not name.endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=400, detail="Нужен файл .xlsx")
    content = await file.read()
    try:
        count = replace_payments_from_file(io.BytesIO(content))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ошибка загрузки: {e}")
    return {"ok": True, "rows": count}


@app.delete("/api/admin/users/{user_id}")
def api_admin_delete_user(user_id: int, admin: User = Depends(auth.require_admin)):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="Нельзя удалить самого себя")
    with Session(engine) as db:
        user = db.get(User, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="Пользователь не найден")
        db.delete(user)
        db.commit()
        return {"ok": True}


def _all_raions_for_region(region_id, db_katos: set[str]) -> list[str]:
    """All raion kato strings for a region: reference RAION.xlsx ∪ DB records."""
    ref = {d for d, r in raion_reg_ref.items() if r == str(region_id)}
    combined = ref | db_katos
    return sorted(combined, key=lambda k: (int(k) if k.isdigit() else 0, k))


def apply_extra_filters(q, sdu_filter=None, gender_filter=None, age_group=None):
    if sdu_filter:
        q = q.filter(func.upper(Payment.sdu_tzhs) == sdu_filter.upper())
    if gender_filter:
        q = q.filter(Payment.gender_id == int(gender_filter))
    if age_group:
        if age_group == 'до18':
            q = q.filter(Payment.vozrast < 18)
        elif age_group == '18-39':
            q = q.filter(Payment.vozrast >= 18, Payment.vozrast < 40)
        elif age_group == '40-59':
            q = q.filter(Payment.vozrast >= 40, Payment.vozrast < 60)
        elif age_group == '60+':
            q = q.filter(Payment.vozrast >= 60)
    return q


def build_filter(q, region_id, raion_id, sdu_filter=None, gender_filter=None, age_group=None):
    if raion_id is not None:
        q = q.filter(Payment.kato_raion == raion_id)
    elif region_id is not None:
        q = q.filter(Payment.kato_region == region_id)
    return apply_extra_filters(q, sdu_filter, gender_filter, age_group)


@app.get("/api/kpi")
def kpi(region_id: int = Query(None), raion_id: int = Query(None), sdu_filter: str = Query(None), gender_filter: str = Query(None), age_group: str = Query(None), pay_type_id: int = Query(None)):
    with Session(engine) as db:
        base = db.query(Payment)
        base = build_filter(base, region_id, raion_id, sdu_filter, gender_filter, age_group)
        if pay_type_id is not None:
            base = base.filter(Payment.pay_type_id == pay_type_id)

        total_max = base.with_entities(func.sum(Payment.max_pay_sum)).scalar() or 0
        total_dec = base.with_entities(func.sum(Payment.dec_pay_sum)).scalar() or 0
        app_count = base.with_entities(func.count(Payment.id)).scalar() or 0
        # «Фактические» метрики — только по реально выполненным выплатам (статус 'Выполнено')
        fact_help_type_count = (
            base.filter(Payment.app_status == 'Выполнено')
            .with_entities(func.count(distinct(Payment.pay_type_id)))
            .scalar() or 0
        )
        fact_recipients = (
            base.filter(Payment.app_status == 'Выполнено')
            .with_entities(func.count(distinct(Payment.sicid)))
            .scalar() or 0
        )
        unique_recipients = base.with_entities(func.count(distinct(Payment.sicid))).scalar() or 0
        male_count = base.filter(Payment.gender_id == 1).with_entities(func.count(distinct(Payment.sicid))).scalar() or 0
        female_count = base.filter(Payment.gender_id == 2).with_entities(func.count(distinct(Payment.sicid))).scalar() or 0

        sdu_rows = (
            base.with_entities(func.upper(Payment.sdu_tzhs), func.count(Payment.id))
            .group_by(func.upper(Payment.sdu_tzhs))
            .all()
        )
        sdu = {(cat or '?').upper(): cnt for cat, cnt in sdu_rows}

        from sqlalchemy import case as sa_case
        age_group = sa_case(
            (Payment.vozrast < 18, 'до 18'),
            (Payment.vozrast < 40, '18-39'),
            (Payment.vozrast < 60, '40-59'),
            else_='60+'
        )
        age_rows = (
            base.with_entities(age_group, func.count(Payment.id))
            .group_by(age_group)
            .all()
        )
        age = {grp: cnt for grp, cnt in age_rows}

        # From settings: help types (all) and people categories (only configured max sum)
        # tuple = (kato_reg, kato_dis, pay_id, pay_name, cat, max_val|None)
        if raion_id is not None:
            geo = [r for r in settings_rows if r[1] == str(raion_id)]
        elif region_id is not None:
            geo = [r for r in settings_rows if r[0] == str(region_id)]
        else:
            geo = settings_rows
        help_type_count = len({r[2] for r in geo if not _is_excluded(r[3])})
        people_cat_count = len({r[4] for r in geo if r[5] is not None})

        # Фактически выплачено: DELIV_SUM for rows where APP_STATUS = 'Выполнено'
        deliv_total = (
            base.filter(Payment.app_status == 'Выполнено')
            .with_entities(func.sum(Payment.deliv_sum))
            .scalar() or 0
        )

        # Бюджет: from region_budgets (budget.xlsx); no raion-level breakdown
        bq = db.query(func.sum(RegionBudget.budget))
        if raion_id is not None:
            budget_total = 0.0
        elif region_id is not None:
            budget_total = float(bq.filter(RegionBudget.kato_region == region_id).scalar() or 0)
        else:
            budget_total = float(bq.scalar() or 0)

        return {
            "total_max_pay_sum": float(total_max),
            "total_dec_pay_sum": float(total_dec),
            "total_deliv_sum": float(deliv_total),
            "budget_total": float(budget_total),
            "app_count": app_count,
            "fact_help_type_count": fact_help_type_count,
            "fact_recipients": fact_recipients,
            "unique_recipients": unique_recipients,
            "male_count": male_count,
            "female_count": female_count,
            "sdu": sdu,
            "age": age,
            "help_type_count": help_type_count,
            "people_cat_count": people_cat_count,
        }


@app.get("/api/regions")
def regions(sdu_filter: str = Query(None), gender_filter: str = Query(None), age_group: str = Query(None)):
    with Session(engine) as db:
        rows = apply_extra_filters(db.query(
            Payment.kato_region,
            Payment.kato_regname,
            func.count(Payment.id).label("count"),
            func.sum(Payment.max_pay_sum).label("total_max"),
            func.count(distinct(Payment.pay_type_id)).label("pay_type_count"),
            func.count(distinct(Payment.cat_type_id)).label("cat_type_count"),
        ), sdu_filter, gender_filter, age_group).group_by(Payment.kato_region, Payment.kato_regname).all()

        return [
            {
                "id_reg": r.kato_region,
                "name": r.kato_regname,
                "count": r.count,
                "total_max": float(r.total_max or 0),
                "pay_type_count": r.pay_type_count,
                "cat_type_count": r.cat_type_count,
            }
            for r in rows
        ]


@app.get("/api/raions")
def raions(region_id: int = Query(...), sdu_filter: str = Query(None), gender_filter: str = Query(None), age_group: str = Query(None)):
    with Session(engine) as db:
        rows = apply_extra_filters(db.query(
            Payment.kato_raion,
            Payment.kato_rainame,
            func.count(Payment.id).label("count"),
            func.sum(Payment.max_pay_sum).label("total_max"),
            func.count(distinct(Payment.pay_type_id)).label("pay_type_count"),
            func.count(distinct(Payment.cat_type_id)).label("cat_type_count"),
        ).filter(
            Payment.kato_region == region_id
        ), sdu_filter, gender_filter, age_group).group_by(Payment.kato_raion, Payment.kato_rainame).all()

        return [
            {
                "id_rai": r.kato_raion,
                "name": r.kato_rainame,
                "count": r.count,
                "total_max": float(r.total_max or 0),
                "pay_type_count": r.pay_type_count,
                "cat_type_count": r.cat_type_count,
            }
            for r in rows
        ]


@app.get("/api/ranking")
def ranking(region_id: int = Query(None), sdu_filter: str = Query(None), gender_filter: str = Query(None), age_group: str = Query(None)):
    with Session(engine) as db:
        def _q(): return db.query(
            Payment.kato_region.label("id") if region_id is None else Payment.kato_raion.label("id"),
            Payment.kato_regname.label("name") if region_id is None else Payment.kato_rainame.label("name"),
            func.count(Payment.id).label("count"),
            func.count(Payment.dec_pay_sum).label("accepted"),
            func.count(distinct(Payment.sicid)).label("recipients"),
            func.sum(Payment.dec_pay_sum).label("total_dec"),
        )
        if region_id is None:
            rows = apply_extra_filters(_q(), sdu_filter, gender_filter, age_group) \
                .group_by(Payment.kato_region, Payment.kato_regname) \
                .order_by(func.sum(Payment.dec_pay_sum).desc()).all()
        else:
            rows = apply_extra_filters(_q().filter(Payment.kato_region == region_id), sdu_filter, gender_filter, age_group) \
                .group_by(Payment.kato_raion, Payment.kato_rainame) \
                .order_by(func.sum(Payment.dec_pay_sum).desc()).all()

        result = []
        for r in rows:
            total_dec = float(r.total_dec) if r.total_dec is not None else None
            result.append({
                "id": r.id,
                "name": r.name,
                "count": r.count,
                "accepted": r.accepted,
                "recipients": r.recipients,
                "total_dec": round(total_dec, 2) if total_dec is not None else None,
            })
        return result


SORTABLE_TABLE_COLS = {'max_pay_sum', 'dec_pay_sum', 'mrp', 'vozrast'}
FILTERABLE_TABLE_COLS = {
    'app_status', 'kato_regname', 'kato_rainame',
    'pay_type', 'cat_type', 'period', 'sdu_tzhs', 'gender_id',
}


@app.get("/api/distinct")
def distinct_values(col: str = Query(...), region_id: int = Query(None), region_name: str = Query(None)):
    if col not in FILTERABLE_TABLE_COLS:
        return []
    with Session(engine) as db:
        attr = getattr(Payment, col)
        q = db.query(func.distinct(attr)).filter(attr.isnot(None))
        if region_id is not None:
            q = q.filter(Payment.kato_region == region_id)
        elif region_name and col == 'kato_rainame':
            q = q.filter(Payment.kato_regname == region_name)
        return sorted([str(r[0]) for r in q.all() if r[0] is not None and str(r[0]).strip()])


YELLOW_COLUMNS = [
    "app_date", "app_status", "iin", "kato_reg", "kato_dis",
    "pay_type_id", "pay_type", "cat_type_id", "cat_type", "period",
    "max_pay_sum", "dec_pay_sum", "mrp", "sys_date", "sicid",
    "gender_id", "vozrast", "sdu_tzhs", "kato_region", "kato_raion",
    "kato_regname", "kato_rainame",
]


@app.get("/api/table")
def table(
    request: Request,
    region_id: int = Query(None),
    raion_id: int = Query(None),
    sort_col: str = Query(None),
    sort_dir: str = Query('desc'),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
):
    with Session(engine) as db:
        q = db.query(Payment)
        q = build_filter(q, region_id, raion_id)

        for key, val in request.query_params.items():
            if key.startswith('f_') and val:
                col_name = key[2:]
                if col_name in FILTERABLE_TABLE_COLS:
                    q = q.filter(getattr(Payment, col_name) == val)

        if sort_col in SORTABLE_TABLE_COLS:
            col_attr = getattr(Payment, sort_col)
            q = q.order_by(col_attr.desc() if sort_dir == 'desc' else col_attr.asc())

        total = q.count()
        records = q.offset((page - 1) * limit).limit(limit).all()

        def fmt(p):
            return {
                col: (
                    str(getattr(p, col)) if getattr(p, col) is not None else None
                )
                for col in YELLOW_COLUMNS
            }

        return {
            "total": total,
            "page": page,
            "limit": limit,
            "pages": (total + limit - 1) // limit,
            "data": [fmt(r) for r in records],
        }


@app.get("/api/summary")
def summary(region_id: int = Query(None), sdu_filter: str = Query(None), gender_filter: str = Query(None), age_group: str = Query(None)):
    from sqlalchemy import case as sa_case
    # Макс сумма = сумма max_pay_sum только по записям с фактической выплатой
    paid_max = func.sum(sa_case((Payment.dec_pay_sum.isnot(None), Payment.max_pay_sum), else_=0))

    def pct(ts, ms):
        return round(ts / ms * 100, 1) if ms else 0.0

    def sdu_q(q):
        return apply_extra_filters(q, sdu_filter, gender_filter, age_group)

    with Session(engine) as db:
        if region_id is None:
            rows = sdu_q(db.query(
                Payment.kato_region,
                Payment.kato_regname,
                func.count(distinct(Payment.cat_type_id)).label("cat_count"),
                func.sum(Payment.dec_pay_sum).label("total_sum"),
                paid_max.label("max_sum"),
            )).group_by(Payment.kato_region, Payment.kato_regname).all()

            db_dict = {str(r.kato_region): r for r in rows}
            name_map = {str(r.kato_region): r.kato_regname
                        for r in db.query(Payment.kato_region, Payment.kato_regname).distinct().all()}

            bgt_rows = db.query(RegionBudget.kato_region, RegionBudget.budget).all()
            geo_budget = {str(r[0]): float(r[1] or 0) for r in bgt_rows}
            nat_budget = sum(geo_budget.values())

            region_pt_counts = {str(r[0]): r[1] for r in db.query(
                Payment.kato_region, func.count(distinct(Payment.pay_type_id))
            ).group_by(Payment.kato_region).all()}
            result = []
            for kato in all_region_katos:
                r = db_dict.get(kato)
                ts = float(r.total_sum or 0) if r else 0.0
                ms = float(r.max_sum or 0) if r else 0.0
                result.append({
                    "id": r.kato_region if r else (int(kato) if kato.isdigit() else kato),
                    "name": r.kato_regname if r else (name_map.get(kato) or REGION_NAMES.get(kato, kato)),
                    "help_types": region_pt_counts.get(kato, 0),
                    "cat_count": r.cat_count if r else 0,
                    "total_sum": round(ts, 2),
                    "max_sum": round(ms, 2),
                    "pct": pct(ts, ms),
                    "budget": geo_budget.get(kato, 0.0),
                })

            nat_cat = sdu_q(db.query(func.count(distinct(Payment.cat_type_id)))).scalar() or 0
            nat_total = float(sdu_q(db.query(func.sum(Payment.dec_pay_sum))).scalar() or 0)
            nat_max = float(sdu_q(db.query(paid_max)).scalar() or 0)
            nat_help = len([p for p, n in settings_pay_names.items() if not _is_excluded(n)])
            total = {
                "id": None, "name": "Республика Казахстан", "is_total": True,
                "help_types": nat_help, "cat_count": nat_cat,
                "total_sum": round(nat_total, 2), "max_sum": round(nat_max, 2),
                "pct": pct(nat_total, nat_max), "budget": nat_budget,
            }
        else:
            rows = sdu_q(db.query(
                Payment.kato_raion,
                Payment.kato_rainame,
                func.count(distinct(Payment.cat_type_id)).label("cat_count"),
                func.sum(Payment.dec_pay_sum).label("total_sum"),
                paid_max.label("max_sum"),
            ).filter(Payment.kato_region == region_id)).group_by(Payment.kato_raion, Payment.kato_rainame).all()

            dis_budget = {}
            reg_budget = float(db.query(RegionBudget.budget).filter(RegionBudget.kato_region == region_id).scalar() or 0)

            db_dict = {str(r.kato_raion): r for r in rows}
            all_dis = _all_raions_for_region(region_id, set(db_dict.keys()))
            result = []
            for d in all_dis:
                r = db_dict.get(d)
                ts = float(r.total_sum or 0) if r else 0.0
                ms = float(r.max_sum or 0) if r else 0.0
                name = (r.kato_rainame if r else raion_names_ref.get(d) or f'Район {d}')
                result.append({
                    "id": int(d) if d.isdigit() else d, "name": name,
                    "help_types": len(raion_help_ids.get(d, set())),
                    "cat_count": r.cat_count if r else 0, "total_sum": round(ts, 2),
                    "max_sum": round(ms, 2), "pct": pct(ts, ms),
                    "budget": dis_budget.get(d, 0.0),
                })

            rt = float(sdu_q(db.query(func.sum(Payment.dec_pay_sum)).filter(Payment.kato_region == region_id)).scalar() or 0)
            rm = float(sdu_q(db.query(paid_max).filter(Payment.kato_region == region_id)).scalar() or 0)
            rc = sdu_q(db.query(func.count(distinct(Payment.cat_type_id))).filter(Payment.kato_region == region_id)).scalar() or 0
            total = {
                "id": None, "name": REGION_NAMES.get(str(region_id)) or f"Регион {region_id}", "is_total": True,
                "help_types": len(region_help_ids.get(str(region_id), set())),
                "cat_count": rc, "total_sum": round(rt, 2), "max_sum": round(rm, 2),
                "pct": pct(rt, rm), "budget": reg_budget,
            }

        result.sort(key=lambda x: x["total_sum"], reverse=True)
        return {"rows": result, "total": total}


@app.get("/api/coverage-groups")
def coverage_groups(region_id: int = Query(None)):
    with Session(engine) as db:
        groups_def = sorted(pay_type_names.items())   # [(42, 'name'), ...]
        columns = [{'id': pid, 'name': pname} for pid, pname in groups_def]

        if region_id is None:
            name_map = {str(r.kato_region): r.kato_regname
                        for r in db.query(Payment.kato_region, Payment.kato_regname).distinct().all()}

            covered_rows = db.query(
                Payment.kato_region,
                Payment.pay_type_id,
                func.count(distinct(Payment.cat_type_id)).label("covered"),
            ).group_by(Payment.kato_region, Payment.pay_type_id).all()

            covered_map: dict[str, dict[int, int]] = {}
            for row in covered_rows:
                covered_map.setdefault(str(row.kato_region), {})[row.pay_type_id] = row.covered

            kato_list = all_region_katos
        else:
            name_map = {str(r.kato_raion): r.kato_rainame
                        for r in db.query(Payment.kato_raion, Payment.kato_rainame)
                        .filter(Payment.kato_region == region_id).distinct().all()}

            covered_rows = db.query(
                Payment.kato_raion,
                Payment.pay_type_id,
                func.count(distinct(Payment.cat_type_id)).label("covered"),
            ).filter(Payment.kato_region == region_id)\
             .group_by(Payment.kato_raion, Payment.pay_type_id).all()

            covered_map = {}
            for row in covered_rows:
                covered_map.setdefault(str(row.kato_raion), {})[row.pay_type_id] = row.covered

            kato_list = _all_raions_for_region(region_id, set(name_map.keys()))
            for d in kato_list:
                name_map.setdefault(d, raion_names_ref.get(d) or f'Район {d}')

        result = []
        for kato in kato_list:
            geo_id = int(kato) if kato.isdigit() else kato
            if region_id is None:
                geo_name = name_map.get(kato) or REGION_NAMES.get(kato, kato)
            else:
                geo_name = name_map.get(kato, kato)
            ref = region_help_ids.get(kato, set()) if region_id is None else raion_help_ids.get(kato, set())
            geo_covered = covered_map.get(kato, {})

            groups_data = [
                {
                    'group': pname,
                    'covered': geo_covered.get(pid, 0),
                    'available': pid in ref,
                }
                for pid, pname in groups_def
            ]
            result.append({'id': geo_id, 'name': geo_name, 'groups': groups_data})

        rows = sorted(result, key=lambda x: sum(g['covered'] for g in x['groups']), reverse=True)

        # Total row — nationwide covered categories per pay type
        if region_id is None:
            nat_covered = {row.pay_type_id: row.covered for row in db.query(
                Payment.pay_type_id,
                func.count(distinct(Payment.cat_type_id)).label("covered"),
            ).group_by(Payment.pay_type_id).all()}
            nat_ref = set().union(*region_help_ids.values()) if region_help_ids else set()
            total_name = "Республика Казахстан"
            total_ref = nat_ref
        else:
            nat_covered = {row.pay_type_id: row.covered for row in db.query(
                Payment.pay_type_id,
                func.count(distinct(Payment.cat_type_id)).label("covered"),
            ).filter(Payment.kato_region == region_id).group_by(Payment.pay_type_id).all()}
            total_name = REGION_NAMES.get(str(region_id)) or f"Регион {region_id}"
            total_ref = region_help_ids.get(str(region_id), set())

        total = {
            'id': None, 'name': total_name, 'is_total': True,
            'groups': [
                {'group': pname, 'covered': nat_covered.get(pid, 0), 'available': pid in total_ref}
                for pid, pname in groups_def
            ],
        }
        return {'columns': columns, 'rows': rows, 'total': total}


@app.get("/api/help-presence")
def help_presence(region_id: int = Query(None), sdu_filter: str = Query(None), gender_filter: str = Query(None), age_group: str = Query(None)):
    """Per region/raion: which pay types are configured (max sum set in settings) → ✓/✕,
    plus a mini-table (виды помощи / категории — should be provided; кол-во людей / сумма — actual)."""
    from collections import defaultdict
    with Session(engine) as db:
        def af(q): return apply_extra_filters(q, sdu_filter, gender_filter, age_group)

        # Columns = pay types from the settings file, excluding phone subscription
        pay_defs = [(pid, pname) for pid, pname in sorted(settings_pay_names.items())
                    if not _is_excluded(pname)]
        columns = [{'id': pid, 'name': pname} for pid, pname in pay_defs]

        if region_id is None:
            # ---- region level ----
            geo_pay = defaultdict(set)   # kato_reg -> {pay_id with max}
            geo_cat = defaultdict(set)   # kato_reg -> {cat with max}
            geo_pay_cat = defaultdict(lambda: defaultdict(set))  # kato_reg -> pid -> {cat}
            nat_pay, nat_cat = set(), set()
            nat_pay_cat = defaultdict(set)                       # pid -> {cat} nationwide
            for kreg, kdis, pid, pname, cat, mx in settings_rows:
                if mx is None or _is_excluded(pname):
                    continue
                geo_pay[kreg].add(pid); geo_cat[kreg].add(cat)
                geo_pay_cat[kreg][pid].add(cat)
                nat_pay.add(pid); nat_cat.add(cat)
                nat_pay_cat[pid].add(cat)

            from sqlalchemy import case as sa_case
            pay_rows = af(db.query(Payment.kato_region,
                                func.count(distinct(Payment.sicid)),
                                func.sum(Payment.dec_pay_sum),
                                func.sum(sa_case((Payment.app_status == 'Выполнено', Payment.deliv_sum), else_=0))
                                )).group_by(Payment.kato_region).all()
            geo_people = {str(r[0]): r[1] for r in pay_rows}
            geo_sum = {str(r[0]): float(r[2] or 0) for r in pay_rows}
            geo_deliv = {str(r[0]): float(r[3] or 0) for r in pay_rows}
            name_map = {str(r.kato_region): r.kato_regname
                        for r in db.query(Payment.kato_region, Payment.kato_regname).distinct().all()}
            nat_people = af(db.query(func.count(distinct(Payment.sicid)))).scalar() or 0
            nat_sum = float(af(db.query(func.sum(Payment.dec_pay_sum))).scalar() or 0)
            nat_deliv = float(af(db.query(func.sum(sa_case((Payment.app_status == 'Выполнено', Payment.deliv_sum), else_=0)))).scalar() or 0)

            # Budget per region from budget.xlsx
            bgt_rows = db.query(RegionBudget.kato_region, RegionBudget.budget).all()
            geo_budget = {str(r[0]): float(r[1] or 0) for r in bgt_rows}
            nat_budget = sum(geo_budget.values())

            # Actual payment sum per (region, pay_type_id)
            mx_rows = af(db.query(Payment.kato_region, Payment.pay_type_id,
                               func.sum(Payment.dec_pay_sum).label("tot_mx")) \
                        .filter(Payment.pay_type_id.isnot(None))) \
                        .group_by(Payment.kato_region, Payment.pay_type_id).all()
            geo_pid_max: dict = defaultdict(dict)
            for r in mx_rows:
                geo_pid_max[str(r.kato_region)][r.pay_type_id] = float(r.tot_mx or 0)
            nat_pid_max: dict = {}
            for pid_d in geo_pid_max.values():
                for pid, v in pid_d.items():
                    nat_pid_max[pid] = nat_pid_max.get(pid, 0) + v

            body = []
            for kato in all_region_katos:
                present = geo_pay.get(kato, set())
                body.append({
                    'id': int(kato) if kato.isdigit() else kato,
                    'name': REGION_NAMES.get(kato) or name_map.get(kato) or kato,
                    'presence': [{"p": geo_pid_max.get(kato, {}).get(pid, 0.0) > 0,
                                  "mx": geo_pid_max.get(kato, {}).get(pid, 0.0)}
                                 for pid, _ in pay_defs],
                    'pay_cat_lists': [sorted(geo_pay_cat.get(kato, {}).get(pid, ())) for pid, _ in pay_defs],
                    'mini': {
                        'vidy': len(geo_pay.get(kato, set())),
                        'kategorii': len(geo_cat.get(kato, set())),
                        'lyudei': geo_people.get(kato, 0),
                        'summa': _fmt_money(geo_sum.get(kato, 0.0)),
                        'summa_val': geo_sum.get(kato, 0.0),
                        'deliv': _fmt_money(geo_deliv.get(kato, 0.0)),
                        'deliv_val': geo_deliv.get(kato, 0.0),
                        'budget': _fmt_money(geo_budget.get(kato, 0.0)),
                        'budget_val': geo_budget.get(kato, 0.0),
                    },
                })
            body.sort(key=lambda x: x['name'])

            total = {
                'id': None, 'name': 'Республика Казахстан', 'is_total': True,
                'presence': [{"p": nat_pid_max.get(pid, 0.0) > 0, "mx": nat_pid_max.get(pid, 0.0)}
                             for pid, _ in pay_defs],
                'pay_cat_lists': [sorted(nat_pay_cat.get(pid, ())) for pid, _ in pay_defs],
                'mini': {'vidy': len(pay_defs), 'kategorii': len(nat_cat),
                         'lyudei': nat_people, 'summa': _fmt_money(nat_sum), 'summa_val': nat_sum,
                         'deliv': _fmt_money(nat_deliv), 'deliv_val': nat_deliv,
                         'budget': _fmt_money(nat_budget), 'budget_val': nat_budget},
            }
            return {'columns': columns, 'rows': [total] + body, 'level': 'region'}

        # ---- raion level (drilled into a region) ----
        dis_pay = defaultdict(set); dis_cat = defaultdict(set)
        dis_pay_cat = defaultdict(lambda: defaultdict(set))  # kato_dis -> pid -> {cat}
        reg_pay_cat = defaultdict(set)                        # pid -> {cat} for region total
        for kreg, kdis, pid, pname, cat, mx in settings_rows:
            if mx is None or kreg != str(region_id) or _is_excluded(pname):
                continue
            dis_pay[kdis].add(pid); dis_cat[kdis].add(cat)
            dis_pay_cat[kdis][pid].add(cat)
            reg_pay_cat[pid].add(cat)

        from sqlalchemy import case as sa_case
        pay_rows = af(db.query(Payment.kato_raion, Payment.kato_rainame,
                            func.count(distinct(Payment.sicid)),
                            func.sum(Payment.dec_pay_sum),
                            func.sum(sa_case((Payment.app_status == 'Выполнено', Payment.deliv_sum), else_=0))
                            ) \
                     .filter(Payment.kato_region == region_id)) \
                     .group_by(Payment.kato_raion, Payment.kato_rainame).all()
        dis_names, dis_people, dis_sum, dis_deliv = {}, {}, {}, {}
        for r in pay_rows:
            d = str(r[0]); dis_names[d] = r[1]; dis_people[d] = r[2]; dis_sum[d] = float(r[3] or 0); dis_deliv[d] = float(r[4] or 0)
        all_dis = _all_raions_for_region(region_id, set(dis_names.keys()) | set(dis_pay.keys()))
        for d in all_dis:
            dis_names.setdefault(d, raion_names_ref.get(d) or f"Район {d}")

        reg_people = af(db.query(func.count(distinct(Payment.sicid))) \
                       .filter(Payment.kato_region == region_id)).scalar() or 0
        reg_sum = float(af(db.query(func.sum(Payment.dec_pay_sum))
                        .filter(Payment.kato_region == region_id)).scalar() or 0)
        reg_deliv = float(af(db.query(func.sum(sa_case((Payment.app_status == 'Выполнено', Payment.deliv_sum), else_=0)))
                        .filter(Payment.kato_region == region_id)).scalar() or 0)

        # Budget from budget.xlsx — region total only, no raion breakdown
        dis_budget = {}
        reg_budget = float(db.query(RegionBudget.budget).filter(RegionBudget.kato_region == region_id).scalar() or 0)

        reg_pay_all, reg_cat_all = set(), set()
        for s in dis_pay.values(): reg_pay_all |= s
        for s in dis_cat.values(): reg_cat_all |= s

        # Actual payment sum per (raion, pay_type_id)
        mx_rows2 = af(db.query(Payment.kato_raion, Payment.pay_type_id,
                            func.sum(Payment.dec_pay_sum).label("tot_mx")) \
                     .filter(Payment.kato_region == region_id,
                             Payment.pay_type_id.isnot(None))) \
                     .group_by(Payment.kato_raion, Payment.pay_type_id).all()
        dis_pid_max: dict = defaultdict(dict)
        for r in mx_rows2:
            dis_pid_max[str(r.kato_raion)][r.pay_type_id] = float(r.tot_mx or 0)
        reg_pid_max: dict = {}
        for pid_d in dis_pid_max.values():
            for pid, v in pid_d.items():
                reg_pid_max[pid] = reg_pid_max.get(pid, 0) + v

        body = []
        for d in all_dis:
            present = dis_pay.get(d, set())
            body.append({
                'id': int(d) if d.isdigit() else d,
                'name': dis_names[d],
                'presence': [{"p": dis_pid_max.get(d, {}).get(pid, 0.0) > 0,
                              "mx": dis_pid_max.get(d, {}).get(pid, 0.0)}
                             for pid, _ in pay_defs],
                'pay_cat_lists': [sorted(dis_pay_cat.get(d, {}).get(pid, ())) for pid, _ in pay_defs],
                'mini': {
                    'vidy': len(dis_pay.get(d, set())),
                    'kategorii': len(dis_cat.get(d, set())),
                    'lyudei': dis_people.get(d, 0),
                    'summa': _fmt_money(dis_sum.get(d, 0.0)),
                    'summa_val': dis_sum.get(d, 0.0),
                    'deliv': _fmt_money(dis_deliv.get(d, 0.0)),
                    'deliv_val': dis_deliv.get(d, 0.0),
                    'budget': _fmt_money(dis_budget.get(d, 0.0)),
                    'budget_val': dis_budget.get(d, 0.0),
                },
            })
        body.sort(key=lambda x: x['name'])

        total = {
            'id': None, 'name': REGION_NAMES.get(str(region_id)) or f'Регион {region_id}',
            'is_total': True,
            'presence': [{"p": reg_pid_max.get(pid, 0.0) > 0, "mx": reg_pid_max.get(pid, 0.0)}
                         for pid, _ in pay_defs],
            'pay_cat_lists': [sorted(reg_pay_cat.get(pid, ())) for pid, _ in pay_defs],
            'mini': {'vidy': len(reg_pay_all), 'kategorii': len(reg_cat_all),
                     'lyudei': reg_people, 'summa': _fmt_money(reg_sum), 'summa_val': reg_sum,
                     'deliv': _fmt_money(reg_deliv), 'deliv_val': reg_deliv,
                     'budget': _fmt_money(reg_budget), 'budget_val': reg_budget},
        }
        return {'columns': columns, 'rows': [total] + body, 'level': 'raion'}


def _fmt_money(v):
    if v is None:
        return "—"
    s = f"{int(v):,}" if float(v).is_integer() else f"{v:,.2f}".rstrip("0").rstrip(".")
    return s.replace(",", " ")


@app.get("/api/raion-payments")
def raion_payments(raion_id: int = Query(...), sdu_filter: str = Query(None),
                   gender_filter: str = Query(None), age_group: str = Query(None)):
    with Session(engine) as db:
        q = db.query(
            Payment.sicid, Payment.pay_type, Payment.vozrast,
            Payment.gender_id, Payment.sdu_tzhs, Payment.dec_pay_sum
        ).filter(Payment.kato_raion == raion_id)
        q = apply_extra_filters(q, sdu_filter, gender_filter, age_group)
        rows = q.order_by(Payment.sicid).limit(2000).all()
        return [
            {
                'sicid': r.sicid,
                'pay_type': r.pay_type or '—',
                'vozrast': r.vozrast,
                'gender': 'М' if r.gender_id == 1 else ('Ж' if r.gender_id == 2 else '—'),
                'sdu': r.sdu_tzhs or '—',
                'dec_sum': float(r.dec_pay_sum or 0),
            }
            for r in rows
        ]


@app.get("/api/cat-regions")
def cat_regions(region_id: int = Query(None)):
    """Entitlement view from PAYMENT_SETTING (who is eligible "in general").
    Category → regions (+ pay types & max sum) → raions (+ pay types & max sum).
    Ignores the map drill — entitlement is shown nation-wide."""
    from collections import defaultdict

    # cat -> reg -> dis -> {pay_name: max_val}  (only rows with a configured max sum)
    tree: dict = defaultdict(lambda: defaultdict(lambda: defaultdict(dict)))
    for reg, dis, pid, pname, cat, mx in settings_rows:
        if mx is None or not cat or not pname:
            continue
        cur = tree[cat][reg][dis].get(pname)
        if cur is None or mx > cur:
            tree[cat][reg][dis][pname] = mx

    result = []
    for cat, regs in tree.items():
        regions_list = []
        for reg, raions in regs.items():
            reg_pay: dict = defaultdict(set)   # pay_name -> set of max vals across raions
            raion_list = []
            for dis, pays in raions.items():
                raion_pay = []
                for pname, mx in pays.items():
                    reg_pay[pname].add(mx)
                    raion_pay.append({"name": pname, "max": _fmt_money(mx)})
                raion_pay.sort(key=lambda x: x["name"])
                raion_list.append({
                    "id": dis,
                    "name": raion_names_ref.get(dis) or (f"Район {dis}" if dis else "—"),
                    "pay_types": raion_pay,
                })
            raion_list.sort(key=lambda x: x["name"])

            reg_pay_list = []
            for pname, vals in reg_pay.items():
                vmin, vmax = min(vals), max(vals)
                label = _fmt_money(vmin) if vmin == vmax else f"{_fmt_money(vmin)} – {_fmt_money(vmax)}"
                reg_pay_list.append({"name": pname, "max": label})
            reg_pay_list.sort(key=lambda x: x["name"])

            regions_list.append({
                "id": int(reg) if reg and reg.isdigit() else reg,
                "name": REGION_NAMES.get(reg) or (reg or "—"),
                "pay_types": reg_pay_list,
                "raions": raion_list,
            })
        regions_list.sort(key=lambda x: x["name"])
        result.append({
            "cat_type": cat,
            "geo_count": len(regions_list),
            "regions": regions_list,
        })
    result.sort(key=lambda x: (-x["geo_count"], x["cat_type"]))
    return result


@app.get("/api/uncovered-cats")
def uncovered_cats(region_id: int = Query(None)):
    """Rating of regions/raions by how many categories are NOT served.
    Click count → list of uncovered category names."""
    with Session(engine) as db:
        all_cats = {c[0] for c in db.query(distinct(Payment.cat_type))
                    .filter(Payment.cat_type.isnot(None)).all() if c[0]}

        if region_id is None:
            rows = db.query(Payment.kato_region, Payment.kato_regname, Payment.cat_type)\
                     .filter(Payment.cat_type.isnot(None)).distinct().all()
            covered_map: dict[str, dict] = {}
            for kr, name, cat in rows:
                g = covered_map.setdefault(str(kr), {"name": name, "cats": set()})
                g["cats"].add(cat)

            result = []
            for kato in all_region_katos:
                info = covered_map.get(kato)
                name = info["name"] if info else REGION_NAMES.get(kato, kato)
                covered = info["cats"] if info else set()
                uncovered = sorted(all_cats - covered)
                result.append({
                    "id": int(kato) if kato.isdigit() else kato,
                    "name": name,
                    "uncovered_count": len(uncovered),
                    "uncovered_cats": uncovered,
                })
        else:
            rows = db.query(Payment.kato_raion, Payment.kato_rainame, Payment.cat_type)\
                     .filter(Payment.kato_region == region_id)\
                     .filter(Payment.cat_type.isnot(None)).distinct().all()
            covered_map: dict[str, dict] = {}
            for kr, name, cat in rows:
                g = covered_map.setdefault(str(kr), {"name": name, "cats": set()})
                g["cats"].add(cat)

            all_dis = _all_raions_for_region(region_id, set(covered_map.keys()))
            result = []
            for kato in all_dis:
                info = covered_map.get(kato)
                name = info["name"] if info else raion_names_ref.get(kato) or f'Район {kato}'
                uncovered = sorted(all_cats - (info["cats"] if info else set()))
                result.append({
                    "id": int(kato) if kato.isdigit() else kato,
                    "name": name,
                    "uncovered_count": len(uncovered),
                    "uncovered_cats": uncovered,
                })

        return sorted(result, key=lambda x: x["uncovered_count"], reverse=True)


@app.get("/api/breakdown")
def breakdown(
    region_id: int = Query(None),
    raion_id: int = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(100, ge=1, le=500),
    sort_dir: str = Query('desc'),
):
    with Session(engine) as db:
        # Top level → group by region; inside region → group by raion
        if region_id is not None:
            geo_id_col   = Payment.kato_raion
            geo_name_col = Payment.kato_rainame
            level = 'raion'
        else:
            geo_id_col   = Payment.kato_region
            geo_name_col = Payment.kato_regname
            level = 'region'

        q = db.query(
            geo_id_col.label("geo_id"),
            geo_name_col.label("geo_name"),
            Payment.pay_type,
            Payment.cat_type,
            func.sum(Payment.dec_pay_sum).label("total_sum"),
        )

        if raion_id is not None:
            q = q.filter(Payment.kato_raion == raion_id)
        elif region_id is not None:
            q = q.filter(Payment.kato_region == region_id)

        q = q.group_by(geo_id_col, geo_name_col, Payment.pay_type, Payment.cat_type)
        sum_col = func.sum(Payment.dec_pay_sum)
        # Primary: region/raion name alphabetically; secondary: sum (toggleable)
        q = q.order_by(
            geo_name_col.asc(),
            sum_col.desc() if sort_dir == 'desc' else sum_col.asc(),
        )

        total = q.count()
        rows = q.offset((page - 1) * limit).limit(limit).all()

        return {
            "total": total,
            "page": page,
            "pages": (total + limit - 1) // limit,
            "level": level,
            "data": [
                {
                    "geo_id":    r.geo_id,
                    "geo_name":  r.geo_name or '—',
                    "pay_type":  r.pay_type or '—',
                    "cat_type":  r.cat_type or '—',
                    "total_sum": round(float(r.total_sum or 0), 2),
                }
                for r in rows
            ],
        }


@app.get("/api/paytypes-top")
def paytypes_top(region_id: int = Query(None), raion_id: int = Query(None), sdu_filter: str = Query(None), gender_filter: str = Query(None), age_group: str = Query(None)):
    with Session(engine) as db:
        q = db.query(
            Payment.pay_type,
            func.sum(Payment.dec_pay_sum).label("total_sum"),
        )
        q = build_filter(q, region_id, raion_id, sdu_filter, gender_filter, age_group)
        q = q.filter(Payment.pay_type.isnot(None), Payment.dec_pay_sum.isnot(None))
        q = q.group_by(Payment.pay_type)
        q = q.order_by(func.sum(Payment.dec_pay_sum).desc())
        rows = q.all()
        top = rows[:6]
        rest = rows[6:]
        result = [{"name": r.pay_type, "total": round(float(r.total_sum or 0), 2)} for r in top]
        if rest:
            rest_sum = sum(float(r.total_sum or 0) for r in rest)
            result.append({"name": f"Прочие ({len(rest)} видов)", "total": round(rest_sum, 2)})
        return result


@app.get("/api/anomalies/kpi")
def anomalies_kpi():
    with Session(engine) as db:
        pending = db.query(func.count(Payment.id)).filter(
            Payment.app_status == 'НОВОЕ'
        ).scalar() or 0

        cks_ab = db.query(func.count(Payment.id)).filter(
            func.upper(Payment.sdu_tzhs).in_(['A', 'B'])
        ).scalar() or 0

        type_region_counts = db.query(
            Payment.pay_type,
            func.count(distinct(Payment.kato_region)).label("reg_count"),
        ).filter(Payment.pay_type.isnot(None)).group_by(Payment.pay_type).all()
        geo_unique = sum(1 for _, cnt in type_region_counts if cnt <= 2)

        paid_pairs = {
            (str(r.kato_region), r.pay_type_id)
            for r in db.query(Payment.kato_region, Payment.pay_type_id)
            .filter(Payment.dec_pay_sum > 0).distinct().all()
        }
        declared_pairs = {
            (str(kreg), pid)
            for kreg, kdis, pid, pname, cat, mx in settings_rows if mx is not None
        }
        empty_count = len(declared_pairs - paid_pairs)

        return {
            "pending": int(pending),
            "cks_ab": int(cks_ab),
            "geo_unique": int(geo_unique),
            "empty_declared": int(empty_count),
        }


@app.get("/api/anomalies/pending")
def anomalies_pending():
    with Session(engine) as db:
        rows = db.query(
            Payment.kato_regname,
            Payment.kato_rainame,
            Payment.pay_type,
            func.count(Payment.id).label("cnt"),
            func.sum(Payment.max_pay_sum).label("total_max"),
            func.min(Payment.app_date).label("earliest"),
        ).filter(Payment.app_status == 'НОВОЕ').group_by(
            Payment.kato_regname, Payment.kato_rainame, Payment.pay_type
        ).order_by(Payment.kato_regname, func.count(Payment.id).desc()).all()

        return [
            {
                "region": r.kato_regname or '—',
                "raion": r.kato_rainame or '—',
                "pay_type": r.pay_type or '—',
                "count": r.cnt,
                "total_max": round(float(r.total_max or 0), 2),
                "earliest": str(r.earliest) if r.earliest else '—',
            }
            for r in rows
        ]


@app.get("/api/anomalies/cks-ab")
def anomalies_cks_ab(region_id: int = Query(None), raion_id: int = Query(None), gender_filter: str = Query(None), age_group: str = Query(None)):
    with Session(engine) as db:
        base_cond = [func.upper(Payment.sdu_tzhs).in_(['A', 'B']), Payment.dec_pay_sum > 0]

        def af(q):
            return apply_extra_filters(q, gender_filter=gender_filter, age_group=age_group)

        if raion_id is not None:
            # District level — group by region name
            q = db.query(
                Payment.kato_regname,
                func.upper(Payment.sdu_tzhs).label("cks"),
                Payment.pay_type,
                func.count(Payment.id).label("cnt"),
                func.count(distinct(Payment.sicid)).label("recipients"),
                func.sum(Payment.dec_pay_sum).label("total_dec"),
            ).filter(*base_cond, Payment.kato_raion == raion_id)
            rows = af(q).group_by(
                Payment.kato_regname, func.upper(Payment.sdu_tzhs), Payment.pay_type
            ).order_by(Payment.kato_regname, func.count(Payment.id).desc()).all()
            return [{"region": r.kato_regname or '—', "cks": r.cks or '—', "pay_type": r.pay_type or '—',
                     "count": r.cnt, "recipients": r.recipients, "total_dec": round(float(r.total_dec or 0), 2)}
                    for r in rows]

        elif region_id is not None:
            # Region drilled — group by raion
            q = db.query(
                Payment.kato_raion.label("raion_id"),
                Payment.kato_rainame.label("raion"),
                func.upper(Payment.sdu_tzhs).label("cks"),
                Payment.pay_type,
                func.count(Payment.id).label("cnt"),
                func.count(distinct(Payment.sicid)).label("recipients"),
                func.sum(Payment.dec_pay_sum).label("total_dec"),
            ).filter(*base_cond, Payment.kato_region == region_id)
            rows = af(q).group_by(
                Payment.kato_raion, Payment.kato_rainame, func.upper(Payment.sdu_tzhs), Payment.pay_type
            ).order_by(Payment.kato_rainame, func.count(Payment.id).desc()).all()
            return [{"raion_id": r.raion_id, "raion": r.raion or '—', "cks": r.cks or '—',
                     "pay_type": r.pay_type or '—', "count": r.cnt, "recipients": r.recipients,
                     "total_dec": round(float(r.total_dec or 0), 2)}
                    for r in rows]

        else:
            # National level — group by region, include region_id for drill
            q = db.query(
                Payment.kato_region.label("region_id"),
                Payment.kato_regname,
                func.upper(Payment.sdu_tzhs).label("cks"),
                Payment.pay_type,
                func.count(Payment.id).label("cnt"),
                func.count(distinct(Payment.sicid)).label("recipients"),
                func.sum(Payment.dec_pay_sum).label("total_dec"),
            ).filter(*base_cond)
            rows = af(q).group_by(
                Payment.kato_region, Payment.kato_regname, func.upper(Payment.sdu_tzhs), Payment.pay_type
            ).order_by(Payment.kato_regname, func.count(Payment.id).desc()).all()
            return [{"region_id": r.region_id, "region": r.kato_regname or '—', "cks": r.cks or '—',
                     "pay_type": r.pay_type or '—', "count": r.cnt, "recipients": r.recipients,
                     "total_dec": round(float(r.total_dec or 0), 2)}
                    for r in rows]


@app.get("/api/anomalies/utilization")
def anomalies_utilization(region_id: int = Query(None), sdu_filter: str = Query(None), gender_filter: str = Query(None), age_group: str = Query(None)):
    with Session(engine) as db:
        def af(q): return apply_extra_filters(q, sdu_filter, gender_filter, age_group)
        if region_id is None:
            rows = af(db.query(
                Payment.kato_region,
                Payment.kato_regname,
                func.count(Payment.id).label("cnt"),
                func.sum(Payment.max_pay_sum).label("total_max"),
                func.sum(Payment.dec_pay_sum).label("total_dec"),
            ).filter(Payment.max_pay_sum > 0)).group_by(
                Payment.kato_region, Payment.kato_regname
            ).all()

            result = []
            seen_names: set[str] = set()
            for r in rows:
                mx = float(r.total_max or 0)
                dc = float(r.total_dec or 0)
                pct = round(dc / mx * 100, 1) if mx > 0 else 0.0
                name = r.kato_regname or '—'
                seen_names.add(name.strip().lower())
                result.append({
                    "id": r.kato_region,
                    "name": name,
                    "count": r.cnt,
                    "total_max": round(mx, 2),
                    "total_dec": round(dc, 2),
                    "pct": pct,
                    "clickable": True,
                })

            for absent in ["АБАЙСКАЯ ОБЛАСТЬ", "УЛЫТАУСКАЯ ОБЛАСТЬ"]:
                if absent.lower() not in seen_names:
                    result.append({
                        "id": None, "name": absent, "count": 0,
                        "total_max": 0.0, "total_dec": 0.0, "pct": 0.0,
                        "clickable": False,
                    })

            result.sort(key=lambda x: x["name"])
            return result
        else:
            rows = af(db.query(
                Payment.pay_type,
                func.count(Payment.id).label("cnt"),
                func.sum(Payment.max_pay_sum).label("total_max"),
                func.sum(Payment.dec_pay_sum).label("total_dec"),
            ).filter(
                Payment.kato_region == region_id,
                Payment.max_pay_sum > 0
            )).group_by(Payment.pay_type).all()

            result = []
            for r in rows:
                mx = float(r.total_max or 0)
                dc = float(r.total_dec or 0)
                pct = round(dc / mx * 100, 1) if mx > 0 else 0.0
                result.append({
                    "pay_type": r.pay_type or '—',
                    "count": r.cnt,
                    "total_max": round(mx, 2),
                    "total_dec": round(dc, 2),
                    "pct": pct,
                })
            result.sort(key=lambda x: x["pct"])
            return result


@app.get("/api/anomalies/unique-help")
def anomalies_unique_help(region_id: int = Query(None)):
    from collections import defaultdict
    pay_type_regions: dict = defaultdict(set)
    for kreg, kdis, pid, pname, cat, mx in settings_rows:
        if pname and not _is_excluded(pname):
            pay_type_regions[pname].add(kreg)

    result = []
    for pname, regions in pay_type_regions.items():
        if len(regions) <= 2:
            if region_id is None or str(region_id) in regions:
                result.append({
                    "pay_type": pname,
                    "reg_count": len(regions),
                    "regions": [REGION_NAMES.get(r, r) for r in sorted(regions)],
                })
    result.sort(key=lambda x: x["reg_count"])
    return result


@app.get("/api/anomalies/empty-help")
def anomalies_empty_help():
    with Session(engine) as db:
        paid_pairs = {
            (str(r.kato_region), r.pay_type_id)
            for r in db.query(Payment.kato_region, Payment.pay_type_id)
            .filter(Payment.dec_pay_sum > 0).distinct().all()
        }

        declared: dict = {}
        for kreg, kdis, pid, pname, cat, mx in settings_rows:
            if mx is None:
                continue
            key = (str(kreg), pid)
            if key not in declared:
                declared[key] = (REGION_NAMES.get(str(kreg), str(kreg)), pname or f'Вид {pid}')

        result = [
            {"region": reg_name, "pay_type": pay_name}
            for (kreg, pid), (reg_name, pay_name) in declared.items()
            if (kreg, pid) not in paid_pairs
        ]
        result.sort(key=lambda x: (x["region"], x["pay_type"]))
        return result


@app.get("/api/anomalies/demographic")
def anomalies_demographic(sdu_filter: str = Query(None), gender_filter: str = Query(None), age_group: str = Query(None)):
    from sqlalchemy import case as sa_case
    with Session(engine) as db:
        rows = apply_extra_filters(db.query(
            Payment.pay_type,
            func.count(Payment.id).label("total"),
            func.sum(sa_case((Payment.gender_id == 1, 1), else_=0)).label("male_cnt"),
            func.sum(sa_case((Payment.gender_id == 2, 1), else_=0)).label("female_cnt"),
            func.avg(Payment.vozrast).label("avg_age"),
        ).filter(Payment.pay_type.isnot(None)), sdu_filter, gender_filter, age_group).group_by(Payment.pay_type).all()

        result = []
        for r in rows:
            total = r.total or 0
            male = int(r.male_cnt or 0)
            female = int(r.female_cnt or 0)
            pct_m = round(male / total * 100, 1) if total > 0 else 0.0
            pct_f = round(female / total * 100, 1) if total > 0 else 0.0
            avg_age = round(float(r.avg_age), 1) if r.avg_age else None

            flags = []
            if pct_m > 60:
                flags.append(f"Муж {pct_m}%")
            if pct_f > 60:
                flags.append(f"Жен {pct_f}%")
            if avg_age is not None and avg_age > 60:
                flags.append(f"Возраст {avg_age}")

            result.append({
                "pay_type": r.pay_type,
                "total": total,
                "pct_male": pct_m,
                "pct_female": pct_f,
                "avg_age": avg_age,
                "flags": flags,
                "low_data": total < 10,
            })
        result.sort(key=lambda x: (x["low_data"], -len(x["flags"]), -max(x["pct_male"], x["pct_female"])))
        return result


@app.get("/api/anomalies/utilization-raion")
def anomalies_utilization_raion(raion_id: int = Query(None), region_id: int = Query(None), sdu_filter: str = Query(None), gender_filter: str = Query(None), age_group: str = Query(None)):
    with Session(engine) as db:
        def af(q): return apply_extra_filters(q, sdu_filter, gender_filter, age_group)
        if raion_id is None:
            q = db.query(
                Payment.kato_raion,
                Payment.kato_rainame,
                Payment.kato_regname,
                func.count(Payment.id).label("cnt"),
                func.sum(Payment.max_pay_sum).label("total_max"),
                func.sum(Payment.dec_pay_sum).label("total_dec"),
            ).filter(Payment.kato_raion.isnot(None))
            if region_id is not None:
                q = q.filter(Payment.kato_region == region_id)
            rows = af(q).group_by(
                Payment.kato_raion, Payment.kato_rainame, Payment.kato_regname
            ).all()

            result = []
            for r in rows:
                total_max = float(r.total_max or 0)
                total_dec = float(r.total_dec or 0)
                pct = round(total_dec / total_max * 100, 1) if total_max > 0 else 0.0
                result.append({
                    "raion_id": r.kato_raion,
                    "raion": r.kato_rainame or f"Район {r.kato_raion}",
                    "region": r.kato_regname or "",
                    "count": r.cnt,
                    "total_max": total_max,
                    "total_dec": total_dec,
                    "pct": pct,
                })
            result.sort(key=lambda x: x["pct"])
            return result
        else:
            rows = af(db.query(
                Payment.pay_type,
                func.count(Payment.id).label("cnt"),
                func.sum(Payment.max_pay_sum).label("total_max"),
                func.sum(Payment.dec_pay_sum).label("total_dec"),
            ).filter(
                Payment.kato_raion == raion_id,
                Payment.pay_type.isnot(None),
            )).group_by(Payment.pay_type).all()

            result = []
            for r in rows:
                total_max = float(r.total_max or 0)
                total_dec = float(r.total_dec or 0)
                pct = round(total_dec / total_max * 100, 1) if total_max > 0 else 0.0
                result.append({
                    "pay_type": r.pay_type,
                    "count": r.cnt,
                    "total_max": total_max,
                    "total_dec": total_dec,
                    "pct": pct,
                })
            result.sort(key=lambda x: x["pct"])
            return result


@app.get("/api/anomalies/pay-gap")
def anomalies_pay_gap(sdu_filter: str = Query(None), gender_filter: str = Query(None), age_group: str = Query(None)):
    from collections import defaultdict
    from sqlalchemy import case as sa_case
    with Session(engine) as db:
        rows = apply_extra_filters(db.query(
            Payment.pay_type,
            Payment.kato_rainame,
            Payment.kato_regname,
            func.count(Payment.id).label("cnt"),
            func.sum(sa_case((Payment.dec_pay_sum > 0, 1), else_=0)).label("approved"),
            func.max(Payment.max_pay_sum).label("total_max"),
        ).filter(
            Payment.pay_type.isnot(None),
            Payment.kato_rainame.isnot(None),
        ), sdu_filter, gender_filter, age_group).group_by(
            Payment.pay_type, Payment.kato_rainame, Payment.kato_regname
        ).all()

        pay_type_data: dict = defaultdict(list)
        for r in rows:
            if _is_excluded(r.pay_type):
                continue
            pay_type_data[r.pay_type].append({
                "raion": r.kato_rainame or "—",
                "region": r.kato_regname or "",
                "cnt": r.cnt,
                "approved": int(r.approved or 0),
                "total_max": float(r.total_max or 0),
            })

        result = []
        for pay_type, districts in pay_type_data.items():
            vals = [d["total_max"] for d in districts if d["total_max"] > 0]
            if len(vals) < 2:
                continue
            min_val = min(vals)
            max_val = max(vals)
            if min_val <= 0:
                continue
            ratio = round(max_val / min_val, 1)
            if ratio < 2.0:
                continue
            districts_sorted = sorted(
                [d for d in districts if d["total_max"] > 0],
                key=lambda d: d["total_max"]
            )
            result.append({
                "pay_type": pay_type,
                "ratio": ratio,
                "district_count": len(districts_sorted),
                "total_cnt": sum(d["cnt"] for d in districts),
                "total_approved": sum(d["approved"] for d in districts),
                "districts": districts_sorted,
            })

        result.sort(key=lambda x: -x["ratio"])
        return {
            "gaps": result,
            "total": len(pay_type_data),
        }


@app.get("/api/geo-stats")
def geo_stats(region_id: int = Query(None), raion_id: int = Query(None)):
    """Per-help-type stats for a geo unit: recipients, total_dec, budget.
    Без параметров — сводка по всей стране."""
    with Session(engine) as db:
        base = db.query(Payment)
        if raion_id is not None:
            base = base.filter(Payment.kato_raion == raion_id)
        elif region_id is not None:
            base = base.filter(Payment.kato_region == region_id)
        # иначе — без фильтра (вся страна)

        from sqlalchemy import case as sa_case
        pay_rows = (
            base.with_entities(
                Payment.pay_type_id,
                func.count(distinct(Payment.sicid)).label('recipients'),
                func.count(distinct(
                    sa_case((Payment.app_status == 'Выполнено', Payment.sicid))
                )).label('fact_recipients'),
                func.sum(Payment.dec_pay_sum).label('total_dec'),
                func.sum(
                    sa_case((Payment.app_status == 'Выполнено', Payment.deliv_sum), else_=0)
                ).label('total_deliv'),
            )
            .group_by(Payment.pay_type_id)
            .all()
        )

        result = {}
        for r in pay_rows:
            if r.pay_type_id is None:
                continue
            result[r.pay_type_id] = {
                'recipients': r.recipients or 0,
                'fact_recipients': r.fact_recipients or 0,
                'total_dec': float(r.total_dec or 0),
                'total_deliv': float(r.total_deliv or 0),
                'budget': 0.0,
            }

        # Бюджет из budget.xlsx
        if region_id is not None:
            total_budget = float(
                db.query(RegionBudget.budget)
                .filter(RegionBudget.kato_region == region_id)
                .scalar() or 0
            )
        elif raion_id is not None:
            parent = db.query(Payment.kato_region).filter(Payment.kato_raion == raion_id).first()
            total_budget = float(
                db.query(RegionBudget.budget)
                .filter(RegionBudget.kato_region == (parent[0] if parent else -1))
                .scalar() or 0
            ) if parent else 0.0
        else:
            # вся страна — сумма по всем регионам
            total_budget = float(db.query(func.sum(RegionBudget.budget)).scalar() or 0)

        result['_budget'] = total_budget
        return result


@app.get("/api/dynamics")
def dynamics(
    region_id: int = Query(None),
    raion_id: int = Query(None),
    period: str = Query('week'),
    sdu_filter: str = Query(None),
    gender_filter: str = Query(None),
    age_group: str = Query(None),
):
    """Time series of application count and sum grouped by day or week (APP_DATE)."""
    from sqlalchemy import cast, Date as SADate
    with Session(engine) as db:
        if period == 'day':
            date_expr = Payment.app_date
        else:
            date_expr = func.date_trunc('week', cast(Payment.app_date, SADate))

        from sqlalchemy import case as sa_case
        q = build_filter(
            db.query(
                date_expr.label('period'),
                func.count(distinct(Payment.sicid)).label('people'),
                func.sum(Payment.dec_pay_sum).label('total_dec'),
                func.sum(Payment.max_pay_sum).label('total_max'),
                func.sum(
                    sa_case((Payment.app_status == 'Выполнено', Payment.deliv_sum), else_=0)
                ).label('total_deliv'),
            ).filter(Payment.app_date.isnot(None)),
            region_id, raion_id, sdu_filter, gender_filter, age_group,
        )
        rows = q.group_by(date_expr).order_by(date_expr).all()
        return [
            {
                'period':      r.period.strftime('%Y-%m-%d') if hasattr(r.period, 'strftime') else str(r.period)[:10],
                'people':      r.people or 0,
                'total_dec':   float(r.total_dec   or 0),
                'total_max':   float(r.total_max   or 0),
                'total_deliv': float(r.total_deliv or 0),
            }
            for r in rows if r.period is not None
        ]


@app.get("/api/ranking-oblasts")
def ranking_oblasts(region_id: int = Query(None)):
    """Regions (or raions of a region) ranked by actual paid sum and recipient count."""
    from sqlalchemy import case as sa_case
    with Session(engine) as db:
        if region_id is not None:
            rows = (
                db.query(
                    Payment.kato_raion.label('geo_id'),
                    Payment.kato_rainame.label('geo_name'),
                    func.count(distinct(Payment.sicid)).label('recipients'),
                    func.count(distinct(
                        sa_case((Payment.app_status == 'Выполнено', Payment.sicid))
                    )).label('fact_recipients'),
                    func.sum(
                        sa_case((Payment.app_status == 'Выполнено', Payment.deliv_sum), else_=0)
                    ).label('total_deliv'),
                    func.sum(Payment.dec_pay_sum).label('total_dec'),
                )
                .filter(Payment.kato_region == region_id)
                .group_by(Payment.kato_raion, Payment.kato_rainame)
                .all()
            )
            budget_map = {}  # no raion-level budget in budget.xlsx
            result = []
            for r in rows:
                if r.geo_id is None:
                    continue
                result.append({
                    'id': r.geo_id,
                    'name': r.geo_name or f'Район {r.geo_id}',
                    'recipients': r.recipients or 0,
                    'fact_recipients': r.fact_recipients or 0,
                    'total_deliv': float(r.total_deliv or 0),
                    'total_dec': float(r.total_dec or 0),
                    'budget': budget_map.get(r.geo_id, 0.0),
                })
        else:
            rows = (
                db.query(
                    Payment.kato_region.label('geo_id'),
                    Payment.kato_regname.label('geo_name'),
                    func.count(distinct(Payment.sicid)).label('recipients'),
                    func.count(distinct(
                        sa_case((Payment.app_status == 'Выполнено', Payment.sicid))
                    )).label('fact_recipients'),
                    func.sum(
                        sa_case((Payment.app_status == 'Выполнено', Payment.deliv_sum), else_=0)
                    ).label('total_deliv'),
                    func.sum(Payment.dec_pay_sum).label('total_dec'),
                )
                .group_by(Payment.kato_region, Payment.kato_regname)
                .all()
            )
            bgt_rows = db.query(RegionBudget.kato_region, RegionBudget.budget).all()
            budget_map = {r[0]: float(r[1] or 0) for r in bgt_rows}
            result = []
            for r in rows:
                if r.geo_id is None:
                    continue
                name = r.geo_name or REGION_NAMES.get(str(r.geo_id), str(r.geo_id))
                result.append({
                    'id': r.geo_id,
                    'name': name,
                    'recipients': r.recipients or 0,
                    'fact_recipients': r.fact_recipients or 0,
                    'total_deliv': float(r.total_deliv or 0),
                    'total_dec': float(r.total_dec or 0),
                    'budget': budget_map.get(r.geo_id, 0.0),
                })
        return result


@app.get("/api/pay-type-stats")
def pay_type_stats(
    region_id: int = Query(None),
    raion_id: int = Query(None),
    sdu_filter: str = Query(None),
    gender_filter: str = Query(None),
    age_group: str = Query(None),
):
    """Per-pay-type totals: app count, budget, dec sum, delivered sum."""
    from sqlalchemy import case as sa_case
    with Session(engine) as db:
        q = apply_extra_filters(
            build_filter(
                db.query(
                    Payment.pay_type_id,
                    Payment.pay_type,
                    func.count(Payment.id).label('cnt'),
                    func.sum(Payment.dec_pay_sum).label('total_dec'),
                    func.sum(
                        sa_case((Payment.app_status == 'Выполнено', Payment.deliv_sum), else_=0)
                    ).label('total_deliv'),
                ),
                region_id, raion_id,
            ),
            sdu_filter, gender_filter, age_group,
        ).group_by(Payment.pay_type_id, Payment.pay_type).all()

        # Budget per pay_type_id (optionally filtered by region/raion)
        bq = db.query(BudgetItem.pay_type_id, func.sum(BudgetItem.plansum))
        if raion_id is not None:
            bq = bq.filter(BudgetItem.kato_raion == raion_id)
        elif region_id is not None:
            bq = bq.filter(BudgetItem.kato_region == region_id)
        budget_map = {r[0]: float(r[1] or 0) for r in bq.group_by(BudgetItem.pay_type_id).all()}

        result = []
        for r in q:
            if r.pay_type_id is None:
                continue
            result.append({
                'pay_type_id': r.pay_type_id,
                'pay_type': r.pay_type or '—',
                'count': r.cnt or 0,
                'budget': budget_map.get(r.pay_type_id, 0.0),
                'total_dec': round(float(r.total_dec or 0), 2),
                'total_deliv': round(float(r.total_deliv or 0), 2),
            })

        result.sort(key=lambda x: x['total_dec'], reverse=True)
        return result


@app.get("/api/paytype-geo")
def paytype_geo(pay_type_id: int = Query(...), region_id: int = Query(None)):
    """Сумма заявок и факт выплачено по регионам (или районам) для одного вида помощи."""
    from sqlalchemy import case as sa_case
    with Session(engine) as db:
        if region_id is not None:
            rows = db.query(
                Payment.kato_raion, Payment.kato_rainame,
                func.sum(Payment.dec_pay_sum),
                func.sum(sa_case((Payment.app_status == 'Выполнено', Payment.deliv_sum), else_=0)),
            ).filter(Payment.pay_type_id == pay_type_id, Payment.kato_region == region_id)\
             .group_by(Payment.kato_raion, Payment.kato_rainame).all()
        else:
            rows = db.query(
                Payment.kato_region, Payment.kato_regname,
                func.sum(Payment.dec_pay_sum),
                func.sum(sa_case((Payment.app_status == 'Выполнено', Payment.deliv_sum), else_=0)),
            ).filter(Payment.pay_type_id == pay_type_id)\
             .group_by(Payment.kato_region, Payment.kato_regname).all()
        result = [{"id": r[0], "name": r[1] or '—',
                   "total_dec": float(r[2] or 0), "total_deliv": float(r[3] or 0)}
                  for r in rows if (r[2] or 0) > 0]
        result.sort(key=lambda x: x["total_dec"], reverse=True)
        return result


app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static"), html=True), name="static")
