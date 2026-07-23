"""Выгрузка отчёта: два листа — «Аналитика по видам помощи» и «Аналитика по регионам».
Каждая строка разбита на группу «Итоги» и группы по категориям благосостояния (ЦКС: A, B, C, …).
Бюджет и пол/возраст в отчёт не выгружаются (по требованию).
Форматы: XLSX (openpyxl) и PDF (reportlab).
"""
import io

from sqlalchemy import func, distinct, case as sa_case
from sqlalchemy.orm import Session

from database import Payment
from load_data import (all_region_katos, REGION_NAMES, raion_names_ref,
                       raion_reg_ref, pay_type_names)

NO_CKS = "Без ЦКС"

# Подписи столбцов внутри группы
SUB_TOTAL = ["Принято заявлений", "Сумма заявок, ₸", "Факт. выплачено", "Сумма выплат, ₸", "% выплаты"]
SUB_CAT = ["Принято заявлений", "Сумма заявок, ₸", "Факт. выплачено", "Сумма выплат, ₸", "% выплаты"]


# ─────────────────────────── helpers ───────────────────────────
def _metrics():
    """4 агрегата в фиксированном порядке: заявлений, сумма заявок, факт. получателей, сумма выплат."""
    return [
        func.count(Payment.id),
        func.sum(Payment.dec_pay_sum),
        func.count(distinct(sa_case((Payment.deliv_sum > 0, Payment.sicid)))),
        func.sum(Payment.deliv_sum),
    ]


def _tup(row, off):
    """Достаём метрики из строки, начиная со смещения off."""
    return (int(row[off] or 0), float(row[off + 1] or 0),
            int(row[off + 2] or 0), float(row[off + 3] or 0))


def _norm_cat(v):
    if v is None:
        return NO_CKS
    s = str(v).strip().upper()
    return s or NO_CKS


def _order_cats(cats):
    named = sorted(c for c in cats if c != NO_CKS)
    if NO_CKS in cats:
        named.append(NO_CKS)
    return named


def _tc(s):
    """Регион/район из справочника приходят КАПСОМ — первая заглавная, остальное строчное.
    Города вида «Г.ШЫМКЕНТ» приводим к «г.Шымкент» (строчный маркер города + заглавное название)."""
    s = (s or "").strip()
    if not s:
        return s
    base = s[:1].upper() + s[1:].lower()
    if len(base) > 2 and base[:2] == "Г." and base[2:3].isalpha():
        return "г." + base[2].upper() + base[3:]
    return base


def _pct(dec, deliv):
    return round(deliv / dec * 100, 1) if dec else 0.0


def _all_raions_for_region(region_id, db_katos):
    ref = {d for d, r in raion_reg_ref.items() if r == str(region_id)}
    combined = ref | set(db_katos)
    return sorted(combined, key=lambda k: (int(k) if k.isdigit() else 0, k))


def _only_cks(q):
    """Только записи с заполненным ЦКС — записи без категории в отчёт не идут."""
    return q.filter(Payment.sdu_tzhs.isnot(None), func.trim(Payment.sdu_tzhs) != '')


def _aggregate(db, dim_col, region_filter):
    """Возвращает (totals, percat, cats):
    totals[key]=(4 метрики) сгруппировано по dim; percat[key][cat]=(4 метрики)."""
    tq = _only_cks(db.query(dim_col, *_metrics()))
    if region_filter is not None:
        tq = tq.filter(Payment.kato_region == region_filter)
    totals = {str(r[0]): _tup(r, 1) for r in tq.group_by(dim_col).all() if r[0] is not None}

    cq = _only_cks(db.query(dim_col, func.upper(Payment.sdu_tzhs), *_metrics()))
    if region_filter is not None:
        cq = cq.filter(Payment.kato_region == region_filter)
    percat, cats = {}, set()
    for r in cq.group_by(dim_col, func.upper(Payment.sdu_tzhs)).all():
        if r[0] is None:
            continue
        cat = _norm_cat(r[1])
        cats.add(cat)
        percat.setdefault(str(r[0]), {})[cat] = _tup(r, 2)
    return totals, percat, cats


def _grand(db, region_filter):
    """Итоговая строка (Республика/регион): (метрики, percat)."""
    gq = _only_cks(db.query(*_metrics()))
    if region_filter is not None:
        gq = gq.filter(Payment.kato_region == region_filter)
    total = _tup(gq.one(), 0)

    gcq = _only_cks(db.query(func.upper(Payment.sdu_tzhs), *_metrics()))
    if region_filter is not None:
        gcq = gcq.filter(Payment.kato_region == region_filter)
    gpercat = {_norm_cat(r[0]): _tup(r, 1) for r in gcq.group_by(func.upper(Payment.sdu_tzhs)).all()}
    return total, gpercat


def _row(label, metrics, percat_for_key, cats):
    c, dec, f, deliv = metrics
    per = {}
    for cat in cats:
        per[cat] = percat_for_key.get(cat, (0, 0.0, 0, 0.0))
    return {"label": label, "count": c, "dec": dec, "fact": f, "deliv": deliv,
            "pct": _pct(dec, deliv), "per_cat": per}


# ─────────────────────────── sheet builders ───────────────────────────
def _regions_sheet(db, region_id):
    if region_id is None:
        totals, percat, cats = _aggregate(db, Payment.kato_region, None)
        nm = {str(r[0]): r[1] for r in db.query(Payment.kato_region, Payment.kato_regname).distinct().all()
              if r[0] is not None}
        keys = list(all_region_katos)
        namef = lambda k: _tc(nm.get(k) or REGION_NAMES.get(k, k))
        row_label = "Регион"
        total_label = "Республика Казахстан"
    else:
        totals, percat, cats = _aggregate(db, Payment.kato_raion, region_id)
        nm = {str(r[0]): r[1] for r in db.query(Payment.kato_raion, Payment.kato_rainame)
              .filter(Payment.kato_region == region_id).distinct().all() if r[0] is not None}
        keys = _all_raions_for_region(region_id, totals.keys())
        namef = lambda k: _tc(nm.get(k) or raion_names_ref.get(k) or f"Район {k}")
        row_label = "Район"
        total_label = _tc(REGION_NAMES.get(str(region_id)) or f"Регион {region_id}")

    gtotal, gpercat = _grand(db, region_id)
    cat_list = _order_cats(cats | set(gpercat.keys()))
    rows = [_row(namef(k), totals.get(k, (0, 0.0, 0, 0.0)), percat.get(k, {}), cat_list) for k in keys]
    rows.sort(key=lambda r: r["count"], reverse=True)
    total = _row(total_label, gtotal, gpercat, cat_list)
    return {"name": "Аналитика по регионам", "row_label": row_label,
            "cats": cat_list, "total": total, "rows": rows}


def _paytypes_sheet(db, region_id):
    # Показатели по выбранной области (или всей РК)
    totals, percat, cats = _aggregate(db, Payment.pay_type_id, region_id)
    # Полный список видов помощи — из общенациональных данных, чтобы показывать и нулевые
    nat_totals, _np, nat_cats = _aggregate(db, Payment.pay_type_id, None)
    nm = {str(r[0]): r[1] for r in db.query(Payment.pay_type_id, Payment.pay_type).distinct().all()
          if r[0] is not None}
    keys = list(nat_totals.keys())
    namef = lambda k: (nm.get(k) or pay_type_names.get(int(k) if str(k).isdigit() else k) or k)

    gtotal, gpercat = _grand(db, region_id)
    cat_list = _order_cats(nat_cats | cats | set(gpercat.keys()))
    rows = [_row(namef(k), totals.get(k, (0, 0.0, 0, 0.0)), percat.get(k, {}), cat_list) for k in keys]
    rows.sort(key=lambda r: r["dec"], reverse=True)   # виды с суммой — вверху, нулевые — внизу
    total = _row(scope_label(region_id), gtotal, gpercat, cat_list)
    return {"name": "Аналитика по видам помощи", "row_label": "Вид помощи",
            "cats": cat_list, "total": total, "rows": rows}


def scope_label(region_id):
    if region_id is None:
        return "Республика Казахстан"
    return _tc(REGION_NAMES.get(str(region_id)) or f"Регион {region_id}")


def build_sheets(db: Session, region_id):
    """Порядок листов: сначала виды помощи, затем регионы."""
    return [_paytypes_sheet(db, region_id), _regions_sheet(db, region_id)]


# ─────────────────────────── XLSX ───────────────────────────
_CAT_FILLS = ["C8E6C9", "A5D6A7", "FFE0B2", "FFCCBC", "B3E5FC", "D1C4E9", "F0F4C3", "F8BBD0"]


def write_xlsx(sheets, scope):
    from openpyxl import Workbook
    from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    wb.remove(wb.active)

    thin = Side(style="thin", color="D0D0D0")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)
    left = Alignment(horizontal="left", vertical="center", wrap_text=True)
    right = Alignment(horizontal="right", vertical="center")
    total_fill = PatternFill("solid", fgColor="ECEFF1")
    grp_total_fill = PatternFill("solid", fgColor="CFD8DC")
    totalrow_fill = PatternFill("solid", fgColor="FFF9C4")
    hdr_font = Font(bold=True, size=10)
    grp_font = Font(bold=True, size=10)

    MONEY = "#,##0"
    INT = "#,##0"
    PCT = '0.0"%"'

    for sh in sheets:
        cats = sh["cats"]
        ws = wb.create_sheet(title=sh["name"][:31])

        # Заголовок-название листа
        ncols = 1 + 5 + len(cats) * 5
        ws.cell(1, 1, f'{sh["name"]} — {scope}').font = Font(bold=True, size=12)
        ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=ncols)

        r1, r2 = 2, 3   # строки шапки
        # столбец-подпись строки
        c = ws.cell(r1, 1, sh["row_label"])
        c.font = hdr_font; c.alignment = center; c.fill = total_fill
        ws.merge_cells(start_row=r1, start_column=1, end_row=r2, end_column=1)

        # группа «Итоги» (5 столбцов)
        ws.merge_cells(start_row=r1, start_column=2, end_row=r1, end_column=6)
        g = ws.cell(r1, 2, "Итоги"); g.font = grp_font; g.alignment = center; g.fill = grp_total_fill
        for j, name in enumerate(SUB_TOTAL):
            cell = ws.cell(r2, 2 + j, name)
            cell.font = hdr_font; cell.alignment = center; cell.fill = total_fill; cell.border = border

        # группы по ЦКС
        base = 7
        for i, cat in enumerate(cats):
            start = base + i * 5
            fill = PatternFill("solid", fgColor=_CAT_FILLS[i % len(_CAT_FILLS)])
            ws.merge_cells(start_row=r1, start_column=start, end_row=r1, end_column=start + 4)
            g = ws.cell(r1, start, cat if cat != NO_CKS else NO_CKS)
            g.font = grp_font; g.alignment = center; g.fill = fill
            for j, name in enumerate(SUB_CAT):
                cell = ws.cell(r2, start + j, name)
                cell.font = hdr_font; cell.alignment = center; cell.fill = fill; cell.border = border

        # строки данных: сначала «Итоги»-строка, затем все прочие
        def write_row(rownum, rd, is_total):
            lab = ws.cell(rownum, 1, rd["label"])
            lab.alignment = left; lab.border = border
            if is_total:
                lab.font = Font(bold=True)
            vals = [(rd["count"], INT), (rd["dec"], MONEY), (rd["fact"], INT),
                    (rd["deliv"], MONEY), (rd["pct"], PCT)]
            for j, (v, fmt) in enumerate(vals):
                cell = ws.cell(rownum, 2 + j, v)
                cell.number_format = fmt; cell.alignment = right; cell.border = border
                if is_total:
                    cell.font = Font(bold=True)
            for i, cat in enumerate(cats):
                start = base + i * 5
                cc, cdec, cf, cdeliv = rd["per_cat"][cat]
                cvals = [(cc, INT), (cdec, MONEY), (cf, INT), (cdeliv, MONEY), (_pct(cdec, cdeliv), PCT)]
                for j, (v, fmt) in enumerate(cvals):
                    cell = ws.cell(rownum, start + j, v)
                    cell.number_format = fmt; cell.alignment = right; cell.border = border
                    if is_total:
                        cell.font = Font(bold=True)
            if is_total:
                for col in range(1, ncols + 1):
                    ws.cell(rownum, col).fill = totalrow_fill

        cur = r2 + 1
        write_row(cur, sh["total"], True); cur += 1
        for rd in sh["rows"]:
            write_row(cur, rd, False); cur += 1

        # ширины
        ws.column_dimensions["A"].width = 34
        for col in range(2, ncols + 1):
            ws.column_dimensions[get_column_letter(col)].width = 15
        ws.freeze_panes = "B4"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ─────────────────────────── PDF ───────────────────────────
def _fmt_int(v):
    return f"{int(v):,}".replace(",", " ")


def _fmt_money(v):
    return f"{int(round(v)):,}".replace(",", " ")


def _register_font():
    """Регистрируем шрифт с кириллицей. Возвращает (regular, bold) имена шрифтов."""
    import os
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    candidates = [
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
    ]
    for reg, bold in candidates:
        if os.path.exists(reg):
            try:
                if "RPT" not in pdfmetrics.getRegisteredFontNames():
                    pdfmetrics.registerFont(TTFont("RPT", reg))
                    pdfmetrics.registerFont(TTFont("RPT-Bold", bold if os.path.exists(bold) else reg))
                return "RPT", "RPT-Bold"
            except Exception:
                pass
    return "Helvetica", "Helvetica-Bold"


def write_pdf(sheets, scope):
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import (SimpleDocTemplate, Table, TableStyle,
                                    Paragraph, PageBreak)

    FONT, FONT_B = _register_font()
    styles = getSampleStyleSheet()
    h_style = ParagraphStyle("h", parent=styles["Title"], fontName=FONT_B, fontSize=13, spaceAfter=6)
    cell_style = ParagraphStyle("c", fontName=FONT, fontSize=5.4, leading=6.2)

    story = []
    label_w = 90
    tot_w = 40
    cat_w = 34

    for si, sh in enumerate(sheets):
        cats = sh["cats"]
        ncols = 1 + 5 + len(cats) * 5
        page_h = 595  # ~A4 по высоте, ширина динамическая

        # шапка: две строки
        head1 = [sh["row_label"], "Итоги"] + [""] * 4
        for cat in cats:
            head1 += [cat] + [""] * 4
        head2 = [""] + SUB_TOTAL + SUB_CAT * len(cats)

        def P(txt):
            return Paragraph(str(txt), cell_style)

        data = [head1, [P(x) for x in head2]]

        def make_row(rd):
            r = [P(rd["label"]),
                 _fmt_int(rd["count"]), _fmt_money(rd["dec"]), _fmt_int(rd["fact"]),
                 _fmt_money(rd["deliv"]), f'{rd["pct"]}%']
            for cat in cats:
                cc, cdec, cf, cdeliv = rd["per_cat"][cat]
                r += [_fmt_int(cc), _fmt_money(cdec), _fmt_int(cf), _fmt_money(cdeliv),
                      f'{_pct(cdec, cdeliv)}%']
            return r

        data.append(make_row(sh["total"]))
        for rd in sh["rows"]:
            data.append(make_row(rd))

        col_widths = [label_w] + [tot_w] * 5 + [cat_w] * (len(cats) * 5)
        t = Table(data, colWidths=col_widths, repeatRows=2)

        ts = [
            ("SPAN", (1, 0), (5, 0)),
            ("FONTNAME", (0, 0), (-1, -1), FONT),
            ("FONTSIZE", (0, 0), (-1, -1), 5.4),
            ("FONTSIZE", (0, 0), (-1, 1), 5.6),
            ("FONTNAME", (0, 0), (-1, 1), FONT_B),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
            ("ALIGN", (0, 0), (0, -1), "LEFT"),
            ("ALIGN", (1, 0), (-1, 1), "CENTER"),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#CCCCCC")),
            ("SPAN", (0, 0), (0, 1)),
            ("BACKGROUND", (0, 0), (-1, 1), colors.HexColor("#ECEFF1")),
            ("BACKGROUND", (0, 2), (-1, 2), colors.HexColor("#FFF9C4")),
            ("FONTNAME", (0, 2), (-1, 2), FONT_B),
            ("TOPPADDING", (0, 0), (-1, -1), 1.5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
        ]
        base = 6
        cat_hexes = ["#C8E6C9", "#A5D6A7", "#FFE0B2", "#FFCCBC", "#B3E5FC",
                     "#D1C4E9", "#F0F4C3", "#F8BBD0"]
        for i, cat in enumerate(cats):
            col = base + i * 5
            ts.append(("SPAN", (col, 0), (col + 4, 0)))
            ts.append(("BACKGROUND", (col, 0), (col + 4, 1), colors.HexColor(cat_hexes[i % len(cat_hexes)])))
        t.setStyle(TableStyle(ts))

        if si == 0:
            story.append(Paragraph(f'{sh["name"]}<br/>{scope}', h_style))
        else:
            story.append(PageBreak())
            story.append(Paragraph(f'{sh["name"]}<br/>{scope}', h_style))
        story.append(t)

    # ширина берётся по самому широкому листу
    max_w = max(label_w + 5 * tot_w + len(sh["cats"]) * 5 * cat_w + 30 for sh in sheets)
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=(max_w, 595),
                            leftMargin=12, rightMargin=12, topMargin=14, bottomMargin=14)
    doc.build(story)
    return buf.getvalue()
