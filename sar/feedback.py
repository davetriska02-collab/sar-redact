import json
import os
import uuid
from datetime import datetime, timezone

_DATA_PATH = os.path.join(
    os.path.dirname(os.path.dirname(__file__)), "data", "feedback.json"
)


def _load() -> list[dict]:
    if not os.path.exists(_DATA_PATH):
        return []
    with open(_DATA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _save(items: list[dict]) -> None:
    os.makedirs(os.path.dirname(_DATA_PATH), exist_ok=True)
    with open(_DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(items, f, indent=2)


def submit_feedback(
    feedback_type: str,
    description: str,
    contact: str = "",
    submitted_by: str = "",
    submitted_by_name: str = "",
) -> dict:
    items = _load()
    entry = {
        "id": str(uuid.uuid4())[:8],
        "type": feedback_type,
        "description": description,
        "contact": contact,
        "submitted_by": submitted_by,
        "submitted_by_name": submitted_by_name,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    items.append(entry)
    _save(items)
    return entry


def get_all_feedback() -> list[dict]:
    return _load()


def delete_feedback(feedback_id: str) -> bool:
    items = _load()
    filtered = [f for f in items if f["id"] != feedback_id]
    if len(filtered) == len(items):
        return False
    _save(filtered)
    return True
