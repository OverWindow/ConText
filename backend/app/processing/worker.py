from celery import Celery
from celery.signals import worker_process_init

from app.core.config import get_settings

celery = Celery("documents", broker=get_settings().redis_url)
celery.conf.update(
    task_serializer="json",
    accept_content=["json"],
    task_ignore_result=True,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_soft_time_limit=100,
    task_time_limit=120,
    worker_max_tasks_per_child=20,
    worker_max_memory_per_child=600000,
    broker_connection_retry_on_startup=True,
    broker_transport_options={"visibility_timeout": 180},
    broker_connection_timeout=5,
    task_publish_retry=False,
)


@worker_process_init.connect
def reset_connections(**kwargs):
    from app.db.session import engine

    engine.dispose(close=False)


@celery.task(name="documents.process")
def process_document(version_id):
    from app.processing.engine import run

    run(version_id)


@celery.task(name="documents.analyze")
def analyze_document(key):
    from app.intelligence.engine import run

    run(key)


@celery.task(name="documents.index")
def index_document(version_id):
    from app.rag.indexing import run

    run(version_id)


@celery.task(name="documents.chat")
def answer_chat(message_id):
    from app.rag.chat import run

    run(message_id)


@celery.task(name="documents.convert")
def convert_document(version_id, format):
    from app.conversion.engine import run

    run(version_id, format)
