import os
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, BigInteger, String, Numeric, Date, DateTime, Boolean
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://cbdi:cbdi123@localhost:5432/cbdi")

engine = create_engine(DATABASE_URL)


class Base(DeclarativeBase):
    pass


class Payment(Base):
    __tablename__ = "payments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    app_id = Column(Integer)
    app_date = Column(Date)
    app_date_close = Column(Date)
    app_status = Column(String(200))
    iin = Column(String(50))
    kato_reg = Column(BigInteger)
    kato_dis = Column(BigInteger)
    pay_type_id = Column(Integer)
    pay_type = Column(String(500))
    cat_type_id = Column(Integer)
    cat_type = Column(String(500))
    period = Column(String(100))
    unit_id = Column(Integer)
    max_pay_sum = Column(Numeric(18, 2))
    decision = Column(String(500))
    dec_pay_sum = Column(Numeric(18, 2))
    deliv_date = Column(Date)
    deliv_sum = Column(Numeric(18, 2))
    mrp = Column(Numeric(18, 2))
    sys_date = Column(DateTime)
    sicid = Column(BigInteger)
    gender_id = Column(Integer)
    vozrast = Column(Integer)
    sdu_tzhs = Column(String(10))
    kato_region = Column(Integer)
    kato_raion = Column(Integer)
    kato_regname = Column(String(300))
    kato_rainame = Column(String(300))


class BudgetItem(Base):
    __tablename__ = "budget_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    pay_type_id = Column(Integer, index=True)   # ID from help_types.xlsx
    kato_region = Column(Integer, index=True)   # 2-digit (KATO_REG // 10_000_000)
    kato_raion = Column(Integer, index=True)    # 4-digit (KATO_DIS // 100_000)
    plansum = Column(Numeric(18, 2))


class RegionBudget(Base):
    __tablename__ = "region_budgets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    kato_region = Column(Integer, index=True)
    region_name = Column(String(300))
    budget = Column(Numeric(18, 2))


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    login = Column(String(100), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(20), nullable=False, default="user")   # 'admin' | 'user'
    is_eds = Column(Boolean, nullable=False, default=False)      # требует ЭЦП 2FA
    iin = Column(String(12))                                     # для ЭЦП-аккаунтов = login
    fio = Column(String(300))                                    # ФИО из сертификата
    created_at = Column(DateTime, default=datetime.utcnow)
