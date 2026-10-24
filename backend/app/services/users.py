from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.auth.supabase import Identity
from app.models.domain import User


def provision_user(db: Session, identity: Identity) -> User:
    # UNIQUE + ON CONFLICT also handles concurrent first requests from separate workers.
    db.execute(
        insert(User)
        .values(**identity.model_dump())
        .on_conflict_do_nothing(index_elements=[User.auth_user_id])
    )
    db.commit()
    return db.scalars(select(User).where(User.auth_user_id == identity.auth_user_id)).one()
