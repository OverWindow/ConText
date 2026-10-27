import logging
import time

from sqlalchemy import update

from app.conversion.engine import dispatch as dispatch_conversion
from app.db.session import SessionLocal
from app.intelligence.engine import dispatch as dispatch_analysis
from app.models.ai_connections import AIRequest
from app.processing.engine import dispatch
from app.processing.worker import (
    analyze_document,
    answer_chat,
    convert_document,
    index_document,
    process_document,
)
from app.rag.chat import dispatch as dispatch_chat
from app.rag.indexing import dispatch as dispatch_index
from app.services.sync import cleanup as cleanup_sync
from app.storage.s3 import get_storage

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    while True:
        try:
            with SessionLocal() as db:
                from app.core.config import get_settings
                if get_settings().aws_s3_bucket:
                    cleanup_sync(db, get_storage())
        except Exception:
            logging.warning("Sync cleanup unavailable; durable cleanup will retry.")
        try:
            with SessionLocal() as db:
                db.execute(
                    update(AIRequest)
                    .where(AIRequest.expires_at < int(time.time()))
                    .values(response_ciphertext=None, expires_at=None)
                )
                db.commit()
        except Exception:
            logging.warning("Temporary AI response cleanup unavailable; retrying next cycle.")
        try:
            dispatch(lambda version_id: process_document.delay(version_id))
        except Exception:
            # Do not log connection strings, source content or credentials.
            logging.warning("Processing dispatch unavailable; durable jobs will be retried.")
        try:
            dispatch_analysis(lambda key: analyze_document.delay(key))
        except Exception:
            logging.warning("Analysis dispatch unavailable; durable jobs will be retried.")
        for dispatcher, task in [(dispatch_index, index_document), (dispatch_chat, answer_chat)]:
            try:
                dispatcher(lambda key: task.delay(key))
            except Exception:
                logging.warning("RAG dispatch unavailable; durable jobs will be retried.")
        try:
            dispatch_conversion(
                lambda version_id, format: convert_document.delay(version_id, format)
            )
        except Exception:
            logging.warning("Conversion dispatch unavailable; durable jobs will be retried.")
        time.sleep(10)
