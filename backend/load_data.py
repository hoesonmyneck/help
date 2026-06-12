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

# Fallback region names by KATO code — for regions absent from the payment data
REGION_NAMES: dict[str, str] = {
    '11': 'Акмолинская область',
    '15': 'Актюбинская область',
    '19': 'Алматинская область',
    '23': 'Атырауская область',
    '27': 'Западно-Казахстанская область',
    '31': 'Жамбылская область',
    '33': 'Область Жетісу',
    '35': 'Карагандинская область',
    '39': 'Костанайская область',
    '43': 'Кызылординская область',
    '47': 'Мангистауская область',
    '55': 'Павлодарская область',
    '59': 'Северо-Казахстанская область',
    '61': 'Туркестанская область',
    '63': 'Восточно-Казахстанская область',
    '71': 'г.Астана',
    '75': 'г.Алматы',
    '79': 'г.Шымкент',
}


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
    katos_seen: list[str] = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        # cols: 0=%key, 1=KATO_REG, 2=ID ВЫПЛАТЫ, 3=НАИМЕНОВАНИЕ ВЫПЛАТЫ, 4=ФЛАГ, 5=НАЛИЧИЕ
        kato = _to_kato_str(row[1])
        pay_id = int(row[2]) if row[2] is not None else None
        name = str(row[3]).strip() if row[3] is not None else None
        flag = str(row[4]).strip() if row[4] is not None else ''
        if kato and kato not in katos_seen:
            katos_seen.append(kato)
        if pay_id and flag == '1' and kato:
            region_help_ids.setdefault(kato, set()).add(pay_id)
        if pay_id and name and pay_id not in pay_type_names:
            pay_type_names[pay_id] = name
    all_region_katos.extend(katos_seen)
    wb.close()

    wb = load_workbook(os.path.join(base, "RAION.xlsx"), read_only=True, data_only=True)
    ws = wb.active
    raion_help_ids.clear()
    for row in ws.iter_rows(min_row=2, values_only=True):
        # cols: 0=%key, 1=KATO_REG, 2=KATO_DIS, 3=ID ВЫПЛАТЫ, 4=НАЗВАНИЕ, 5=ФЛАГ, 6=НАЛИЧИЕ
        kato = _to_kato_str(row[2])
        pay_id = int(row[3]) if row[3] is not None else None
        flag = str(row[5]).strip() if row[5] is not None else ''
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
        # columns (0-indexed): 0=row_num, 1=APP_ID, 2=APP_DATE, 3=APP_DATE_CLOSE,
        # 4=APP_STATUS, 5=IIN, 6=KATO_REG, 7=KATO_DIS, 8=PAY_TYPE_ID, 9=PAY_TYPE,
        # 10=CAT_TYPE_ID, 11=CAT_TYPE, 12=PERIOD, 13=UNIT_ID, 14=MAX_PAY_SUM,
        # 15=DECISION, 16=DEC_PAY_SUM, 17=DELIV_DATE, 18=DELIV_SUM, 19=MRP,
        # 20=SYS_DATE, 21=SICID, 22=GENDER_ID, 23=VOZRAST, 24=SDU_TZHS,
        # 25=KATO_REGION, 26=KATO_RAION, 27=KATO_REGNAME, 28=KATO_RAINAME
        rows_data.append(Payment(
            app_id=parse_num(row[1], int),
            app_date=parse_date(row[2]),
            app_date_close=parse_date(row[3]),
            app_status=str(row[4]).strip() if row[4] else None,
            iin=str(row[5]).strip() if row[5] else None,
            kato_reg=parse_num(row[6], int),
            kato_dis=parse_num(row[7], int),
            pay_type_id=parse_num(row[8], int),
            pay_type=str(row[9]).strip() if row[9] else None,
            cat_type_id=parse_num(row[10], int),
            cat_type=str(row[11]).strip() if row[11] else None,
            period=str(row[12]).strip() if row[12] else None,
            unit_id=parse_num(row[13], int),
            max_pay_sum=parse_num(row[14]),
            decision=str(row[15]).strip() if row[15] else None,
            dec_pay_sum=parse_num(row[16]),
            deliv_date=parse_date(row[17]),
            deliv_sum=parse_num(row[18]),
            mrp=parse_num(row[19]),
            sys_date=parse_datetime(row[20]),
            sicid=parse_num(row[21], int),
            gender_id=parse_num(row[22], int),
            vozrast=parse_num(row[23], int),
            sdu_tzhs=str(row[24]).strip() if row[24] else None,
            kato_region=parse_num(row[25], int),
            kato_raion=parse_num(row[26], int),
            kato_regname=str(row[27]).strip() if row[27] else None,
            kato_rainame=str(row[28]).strip() if row[28] else None,
        ))

    wb.close()

    with Session(engine) as session:
        session.add_all(rows_data)
        session.commit()

    print(f"Loaded {len(rows_data)} rows from Excel")
