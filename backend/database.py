import os
from sqlalchemy import create_engine, Column, Integer, BigInteger, String, Numeric, Date, DateTime
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
