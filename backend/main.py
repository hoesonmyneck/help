from contextlib import asynccontextmanager
from fastapi import FastAPI, Query, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy import func, distinct
from sqlalchemy.orm import Session
from database import engine, Payment
from load_data import load_excel, load_reference_data, region_help_ids, raion_help_ids
import os


PAY_GROUPS = [
    {'name': 'Медицинская', 'ids': [42, 43, 44, 45, 46, 47, 48, 49]},
    {'name': 'ЖКХ и быт',  'ids': [50, 51, 52, 53, 54]},
    {'name': 'Денежная',    'ids': [55]},
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_excel()
    load_reference_data()
    yield


app = FastAPI(lifespan=lifespan)


def get_db():
    with Session(engine) as session:
        yield session


def build_filter(q, region_id, raion_id):
    if raion_id is not None:
        q = q.filter(Payment.kato_raion == raion_id)
    elif region_id is not None:
        q = q.filter(Payment.kato_region == region_id)
    return q


@app.get("/api/kpi")
def kpi(region_id: int = Query(None), raion_id: int = Query(None)):
    with Session(engine) as db:
        base = db.query(Payment)
        base = build_filter(base, region_id, raion_id)

        total_max = base.with_entities(func.sum(Payment.max_pay_sum)).scalar() or 0
        total_dec = base.with_entities(func.sum(Payment.dec_pay_sum)).scalar() or 0
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
            (Payment.vozrast < 18, 'до18'),
            (Payment.vozrast < 26, '18-25'),
            (Payment.vozrast < 36, '25-35'),
            (Payment.vozrast < 46, '35-45'),
            (Payment.vozrast < 56, '45-55'),
            else_='55+'
        )
        age_rows = (
            base.with_entities(age_group, func.count(Payment.id))
            .group_by(age_group)
            .all()
        )
        age = {grp: cnt for grp, cnt in age_rows}

        return {
            "total_max_pay_sum": float(total_max),
            "total_dec_pay_sum": float(total_dec),
            "unique_recipients": unique_recipients,
            "male_count": male_count,
            "female_count": female_count,
            "sdu": sdu,
            "age": age,
        }


@app.get("/api/regions")
def regions():
    with Session(engine) as db:
        rows = db.query(
            Payment.kato_region,
            Payment.kato_regname,
            func.count(Payment.id).label("count"),
            func.sum(Payment.max_pay_sum).label("total_max"),
            func.count(distinct(Payment.pay_type_id)).label("pay_type_count"),
            func.count(distinct(Payment.cat_type_id)).label("cat_type_count"),
        ).group_by(Payment.kato_region, Payment.kato_regname).all()

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
def raions(region_id: int = Query(...)):
    with Session(engine) as db:
        rows = db.query(
            Payment.kato_raion,
            Payment.kato_rainame,
            func.count(Payment.id).label("count"),
            func.sum(Payment.max_pay_sum).label("total_max"),
            func.count(distinct(Payment.pay_type_id)).label("pay_type_count"),
            func.count(distinct(Payment.cat_type_id)).label("cat_type_count"),
        ).filter(
            Payment.kato_region == region_id
        ).group_by(Payment.kato_raion, Payment.kato_rainame).all()

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
def ranking(region_id: int = Query(None)):
    with Session(engine) as db:
        if region_id is None:
            rows = db.query(
                Payment.kato_region.label("id"),
                Payment.kato_regname.label("name"),
                func.count(Payment.id).label("count"),
                func.count(Payment.dec_pay_sum).label("accepted"),
                func.count(distinct(Payment.sicid)).label("recipients"),
                func.sum(Payment.dec_pay_sum).label("total_dec"),
            ).group_by(Payment.kato_region, Payment.kato_regname) \
             .order_by(func.sum(Payment.dec_pay_sum).desc()).all()
        else:
            rows = db.query(
                Payment.kato_raion.label("id"),
                Payment.kato_rainame.label("name"),
                func.count(Payment.id).label("count"),
                func.count(Payment.dec_pay_sum).label("accepted"),
                func.count(distinct(Payment.sicid)).label("recipients"),
                func.sum(Payment.dec_pay_sum).label("total_dec"),
            ).filter(Payment.kato_region == region_id) \
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
def distinct_values(col: str = Query(...), region_id: int = Query(None)):
    if col not in FILTERABLE_TABLE_COLS:
        return []
    with Session(engine) as db:
        attr = getattr(Payment, col)
        q = db.query(func.distinct(attr)).filter(attr.isnot(None))
        if region_id is not None:
            q = q.filter(Payment.kato_region == region_id)
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
def summary(region_id: int = Query(None)):
    with Session(engine) as db:
        if region_id is None:
            rows = db.query(
                Payment.kato_region,
                Payment.kato_regname,
                func.count(distinct(Payment.cat_type_id)).label("cat_count"),
                func.sum(Payment.dec_pay_sum).label("total_sum"),
            ).group_by(Payment.kato_region, Payment.kato_regname).all()

            result = [
                {
                    "id": r.kato_region,
                    "name": r.kato_regname,
                    "help_types": len(region_help_ids.get(str(r.kato_region), set())),
                    "cat_count": r.cat_count,
                    "total_sum": round(float(r.total_sum or 0), 2),
                }
                for r in rows
            ]
        else:
            rows = db.query(
                Payment.kato_raion,
                Payment.kato_rainame,
                func.count(distinct(Payment.cat_type_id)).label("cat_count"),
                func.sum(Payment.dec_pay_sum).label("total_sum"),
            ).filter(Payment.kato_region == region_id).group_by(Payment.kato_raion, Payment.kato_rainame).all()

            result = [
                {
                    "id": r.kato_raion,
                    "name": r.kato_rainame,
                    "help_types": len(raion_help_ids.get(str(r.kato_raion), set())),
                    "cat_count": r.cat_count,
                    "total_sum": round(float(r.total_sum or 0), 2),
                }
                for r in rows
            ]

        return sorted(result, key=lambda x: x["total_sum"], reverse=True)


@app.get("/api/coverage-groups")
def coverage_groups(region_id: int = Query(None)):
    with Session(engine) as db:
        # Global max categories per group across all data
        group_max = {
            g['name']: db.query(func.count(distinct(Payment.cat_type_id)))
                         .filter(Payment.pay_type_id.in_(g['ids'])).scalar() or 0
            for g in PAY_GROUPS
        }

        if region_id is None:
            geo_rows = db.query(Payment.kato_region, Payment.kato_regname).distinct().all()
        else:
            geo_rows = db.query(Payment.kato_raion, Payment.kato_rainame) \
                         .filter(Payment.kato_region == region_id).distinct().all()

        result = []
        for row in geo_rows:
            if region_id is None:
                geo_id, geo_name = row.kato_region, row.kato_regname
                geo_filter = Payment.kato_region == geo_id
                ref = region_help_ids.get(str(geo_id), set())
            else:
                geo_id, geo_name = row.kato_raion, row.kato_rainame
                geo_filter = Payment.kato_raion == geo_id
                ref = raion_help_ids.get(str(geo_id), set())

            groups_data = []
            for g in PAY_GROUPS:
                available = bool(ref & set(g['ids']))
                covered = db.query(func.count(distinct(Payment.cat_type_id))) \
                            .filter(geo_filter) \
                            .filter(Payment.pay_type_id.in_(g['ids'])).scalar() or 0
                max_c = group_max[g['name']]
                pct = round(covered / max_c * 100, 1) if max_c else 0
                groups_data.append({
                    'group': g['name'],
                    'covered': covered,
                    'max': max_c,
                    'pct': pct,
                    'available': available,
                })

            result.append({'id': geo_id, 'name': geo_name, 'groups': groups_data})

        return sorted(result, key=lambda x: sum(g['covered'] for g in x['groups']), reverse=True)


@app.get("/api/cat-regions")
def cat_regions(region_id: int = Query(None)):
    with Session(engine) as db:
        geo_col = Payment.kato_raion if region_id is not None else Payment.kato_region
        q = db.query(
            Payment.cat_type,
            func.count(distinct(geo_col)).label("geo_count"),
        )
        if region_id is not None:
            q = q.filter(Payment.kato_region == region_id)
        q = q.group_by(Payment.cat_type).order_by(func.count(distinct(geo_col)).desc())
        rows = q.all()
        return [{"cat_type": r.cat_type or '—', "geo_count": r.geo_count} for r in rows]


@app.get("/api/breakdown")
def breakdown(
    region_id: int = Query(None),
    raion_id: int = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(100, ge=1, le=500),
    sort_dir: str = Query('desc'),
):
    with Session(engine) as db:
        q = db.query(
            Payment.kato_rainame,
            Payment.pay_type,
            Payment.cat_type,
            func.sum(Payment.dec_pay_sum).label("total_sum"),
        )
        q = build_filter(q, region_id, raion_id)
        q = q.group_by(Payment.kato_rainame, Payment.pay_type, Payment.cat_type)
        sum_col = func.sum(Payment.dec_pay_sum)
        q = q.order_by(sum_col.desc() if sort_dir == 'desc' else sum_col.asc())

        total = q.count()
        rows = q.offset((page - 1) * limit).limit(limit).all()

        return {
            "total": total,
            "page": page,
            "pages": (total + limit - 1) // limit,
            "data": [
                {
                    "raion": r.kato_rainame or '—',
                    "pay_type": r.pay_type or '—',
                    "cat_type": r.cat_type or '—',
                    "total_sum": round(float(r.total_sum or 0), 2),
                }
                for r in rows
            ],
        }


app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static"), html=True), name="static")
