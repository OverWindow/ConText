"""Native pgvector SQL type; text wire format avoids a NumPy dependency."""

import json
import math

from sqlalchemy.dialects.postgresql.base import ischema_names
from sqlalchemy.types import UserDefinedType


class Vector(UserDefinedType):
    cache_ok = True

    def get_col_spec(self, **kw):
        return "vector"

    def bind_processor(self, dialect):
        def process(value):
            if value is None:
                return None
            if (
                not 1 <= len(value) <= 8192
                or not any(value)
                or any(
                    type(x) not in (int, float) or not math.isfinite(x) or abs(x) > 1e30
                    for x in value
                )
            ):
                raise ValueError("Invalid embedding")
            return json.dumps(value, allow_nan=False)

        return process

    def result_processor(self, dialect, coltype):
        return lambda value: json.loads(value) if isinstance(value, str) else value


ischema_names["vector"] = Vector
