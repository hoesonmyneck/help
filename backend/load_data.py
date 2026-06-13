import os
from datetime import datetime, date
from openpyxl import load_workbook
from sqlalchemy import text
from sqlalchemy.orm import Session
from database import engine, Base, Payment

region_help_ids: dict[str, set] = {}   # {kato_reg_str: {pay_type_id, ...}} where flag='1'
raion_help_ids:  dict[str, set] = {}   # {kato_dis_str: {pay_type_id, ...}} where flag='1'
all_region_katos: list[str] = []       # all KATO_REG values from REGION.xlsx in order
pay_type_names:  dict[int, str] = {}   # {pay_type_id: НАИМЕНОВАНИЕ ВЫПЛАТЫ} from REGION.xlsx

# Region/raion display names by KATO code — populated from the reference files
REGION_NAMES:    dict[str, str] = {}   # {kato_reg: REG name} from REGION.xlsx
raion_names_ref: dict[str, str] = {}   # {kato_dis: DIS name} from RAION.xlsx


def _to_kato_str(val) -> str | None:
    if val is None:
        return None
    try:
        return str(int(float(val)))
    except (ValueError, TypeError):
        return str(val).strip() or None


def load_reference_data():
    base = os.path.join(os.path.dirname(__file__), "data")

    wb = load_workbook(os.path.join(base, "REGION.xlsx"), read_only=True, data_only=True)
    ws = wb.active
    region_help_ids.clear()
    pay_type_names.clear()
    all_region_katos.clear()
    REGION_NAMES.clear()
    katos_seen: list[str] = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        # cols: 0=KATO_REG, 1=PAY_TYPE_ID, 2=PAY_TYPE(name), 3=FLAG_ID, 4=FLAG(text), 5=REG(name)
        kato = _to_kato_str(row[0])
        pay_id = int(row[1]) if row[1] is not None else None
        name = str(row[2]).strip() if row[2] is not None else None
        flag = str(row[3]).strip() if row[3] is not None else ''
        reg_name = str(row[5]).strip() if row[5] is not None else None
        if kato and kato not in katos_seen:
            katos_seen.append(kato)
        if kato and reg_name:
            REGION_NAMES.setdefault(kato, reg_name)
        if pay_id and flag == '1' and kato:
            region_help_ids.setdefault(kato, set()).add(pay_id)
        if pay_id and name and pay_id not in pay_type_names:
            pay_type_names[pay_id] = name
    all_region_katos.extend(katos_seen)
    wb.close()

    wb = load_workbook(os.path.join(base, "RAION.xlsx"), read_only=True, data_only=True)
    ws = wb.active
    raion_help_ids.clear()
    raion_names_ref.clear()
    for row in ws.iter_rows(min_row=2, values_only=True):
        # cols: 0=KATO_REG, 1=KATO_DIS, 2=PAY_TYPE_ID, 3=PAY_TYPE, 4=FLAG_ID, 5=FLAG, 6=REG, 7=DIS(name)
        kato = _to_kato_str(row[1])
        pay_id = int(row[2]) if row[2] is not None else None
        flag = str(row[4]).strip() if row[4] is not None else ''
        dis_name = str(row[7]).strip() if row[7] is not None else None
        if kato and dis_name:
            raion_names_ref.setdefault(kato, dis_name)
        if kato and pay_id and flag == '1':
            raion_help_ids.setdefault(kato, set()).add(pay_id)
    wb.close()

    print(f"Reference loaded: {len(region_help_ids)} regions, {len(raion_help_ids)} raions")


def parse_date(val):
    if val is None:
        return None
    if isinstance(val, (date, datetime)):
        return val if isinstance(val, date) else val.date()
    s = str(val).strip()
    if not s:
        return None
    for fmt in ("%d.%m.%Y", "%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def parse_datetime(val):
    if val is None:
        return None
    if isinstance(val, datetime):
        return val
    s = str(val).strip()
    if not s:
        return None
    for fmt in ("%d.%m.%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%d.%m.%Y"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            pass
    return None


def parse_num(val, cast=float):
    if val is None:
        return None
    try:
        return cast(val)
    except (ValueError, TypeError):
        return None


def parse_gender(val):
    """New data has gender as text МУЖСКОЙ/ЖЕНСКИЙ; map to 1/2."""
    if val is None:
        return None
    s = str(val).strip().upper()
    if s.startswith('М'):
        return 1
    if s.startswith('Ж'):
        return 2
    return parse_num(val, int)


def load_excel():
    Base.metadata.create_all(bind=engine)

    with engine.connect() as conn:
        count = conn.execute(text("SELECT COUNT(*) FROM payments")).scalar()
        if count > 0:
            return

    path = os.path.join(os.path.dirname(__file__), "data", "cbdiapp_payment_info_for_qlik1.xlsx")
    wb = load_workbook(path, read_only=True, data_only=True)
    ws = wb.active

    rows_data = []
    for i, row in enumerate(ws.iter_rows(min_row=2, values_only=True)):
        # columns (0-indexed): 0=APP_ID, 1=APP_DATE, 2=APP_DATE_CLOSE, 3=STATUS,
        # 4=IIN, 5=KATO_REG, 6=REG(name), 7=KATO_DIS, 8=DIS(name), 9=PAY_TYPE_ID,
        # 10=PAY_TYPE, 11=CAT_TYPE_ID, 12=CAT_TYPE, 13=PERIOD, 14=UNIT_ID,
        # 15=MAX_PAY_SUM, 16=DECISION, 17=DEC_PAY_SUM, 18=DELIV_DATE, 19=DELIV_SUM,
        # 20=MRP, 21=SYS_DATE, 22=SICID, 23=GENDER(text), 24=VOZRAST, 25=AGE_GROUP,
        # 26=SDU/ЦКС, 27=KATO_REGION, 28=KATO_RAION, 29=KATO_REGNAME, 30=KATO_RAINAME
        rows_data.append(Payment(
            app_id=parse_num(row[0], int),
            app_date=parse_date(row[1]),
            app_date_close=parse_date(row[2]),
            app_status=str(row[3]).strip() if row[3] else None,
            iin=str(row[4]).strip() if row[4] else None,
            kato_reg=parse_num(row[5], int),
            kato_dis=parse_num(row[7], int),
            pay_type_id=parse_num(row[9], int),
            pay_type=str(row[10]).strip() if row[10] else None,
            cat_type_id=parse_num(row[11], int),
            cat_type=str(row[12]).strip() if row[12] else None,
            period=str(row[13]).strip() if row[13] else None,
            unit_id=parse_num(row[14], int),
            max_pay_sum=parse_num(row[15]),
            decision=str(row[16]).strip() if row[16] else None,
            dec_pay_sum=parse_num(row[17]),
            deliv_date=parse_date(row[18]),
            deliv_sum=parse_num(row[19]),
            mrp=parse_num(row[20]),
            sys_date=parse_datetime(row[21]),
            sicid=parse_num(row[22], int),
            gender_id=parse_gender(row[23]),
            vozrast=parse_num(row[24], int),
            sdu_tzhs=str(row[26]).strip() if row[26] else None,
            kato_region=parse_num(row[27], int),
            kato_raion=parse_num(row[28], int),
            kato_regname=str(row[29]).strip() if row[29] else None,
            kato_rainame=str(row[30]).strip() if row[30] else None,
        ))

    wb.close()

    with Session(engine) as session:
        session.add_all(rows_data)
        session.commit()

    print(f"Loaded {len(rows_data)} rows from Excel")
