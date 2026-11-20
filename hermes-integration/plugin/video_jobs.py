"""Persist video plans and render attempts in the Content Agent workspace."""
import json
import logging
import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from uuid import uuid4

from .video_contract import validate as validate_remotion

log = logging.getLogger(__name__)
RENDER_LEASE_SECONDS = 2700


def validate_plan(action, plan):
    scenes = plan.get("scenes")
    if not isinstance(scenes, list) or not scenes or any(not isinstance(s, dict) for s in scenes):
        raise ValueError("Provide a nonempty JSON array of scene objects")
    strategy = plan.get("strategy")
    if strategy is not None:
        if not isinstance(strategy, dict):
            raise ValueError("strategy must be a JSON object")
        for key in ("task_id", "company_id", "hook", "cta"):
            if not isinstance(strategy.get(key), str) or not strategy[key].strip():
                raise ValueError(f"strategy.{key} must be a nonempty string")
        hooks = strategy.get("hook_options")
        if (not isinstance(hooks, list) or len(hooks) != 3
                or any(not isinstance(hook, str) or not hook.strip() for hook in hooks)
                or len(set(hooks)) != 3 or strategy["hook"] not in hooks):
            raise ValueError("strategy needs three distinct hooks including the selected hook")
    if action != "remotion":
        return None  # The existing TypeScript planner validates the full video plan.
    duration = sum(validate_remotion(plan)) / 30
    if strategy is not None and not 15 <= duration <= 30:
        raise ValueError("Strategy videos must be between 15 and 30 seconds")
    if duration > 60:
        raise ValueError("Video must be at most 60 seconds")
    return duration


def video_job(workspace, action, payload, render, evaluate):
    job_id = payload.get("job_id")
    if action in ("video_status", "video_retry"):
        if not isinstance(job_id, str) or not re.fullmatch(r"[0-9a-f]{32}", job_id):
            raise ValueError("Provide the video job_id returned by the tool")
    else:
        validate_plan(action, payload)
        plan_json = json.dumps(payload, ensure_ascii=False, allow_nan=False)
        job_id = uuid4().hex

    with closing(sqlite3.connect(workspace / "content.db", timeout=10)) as db:
        db.row_factory = sqlite3.Row
        with db:
            db.execute("""CREATE TABLE IF NOT EXISTS video_jobs (
                id TEXT PRIMARY KEY, engine TEXT NOT NULL, plan TEXT NOT NULL,
                state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                created REAL NOT NULL, updated REAL NOT NULL, artifact TEXT, result TEXT, error TEXT
            )""")
            if action in ("video", "remotion"):
                now = time.time()
                db.execute("INSERT INTO video_jobs (id, engine, plan, state, created, updated) VALUES (?, ?, ?, 'planned', ?, ?)",
                           (job_id, action, plan_json, now, now))

        def current():
            row = db.execute("SELECT * FROM video_jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                raise ValueError("Unknown video job_id")
            return row

        def legacy_product(row):
            stored = json.loads(row["plan"])
            return row["engine"] == "remotion" and stored.get("composition") == "product" and "product" not in stored

        def response(row):
            if legacy_product(row):
                return {"job_id": job_id, "status": "blocked", "retry_available": False,
                        "error": "This older product render has unverified imagery. Create a new verified product job."}

            result = json.loads(row["result"]) if row["result"] else {}
            result.update(job_id=job_id, status=row["state"], attempts=row["attempts"],
                          elapsed_seconds=round(row["updated"] - row["created"], 2))
            result["retry_available"] = row["state"] in ("planned", "failed") or (
                row["state"] in ("rendering", "checking") and time.time() - row["updated"] >= RENDER_LEASE_SECONDS
            )
            if row["error"]:
                result["error"] = row["error"]
            return result

        row = current()
        if action == "video_status" or row["state"] == "completed" or legacy_product(row):
            return response(row)
        now = time.time()
        with db:
            claimed = db.execute("""UPDATE video_jobs
                SET state='rendering', attempts=attempts+1, updated=?, error=NULL
                WHERE id=? AND (state IN ('planned', 'failed') OR
                               (state IN ('rendering', 'checking') AND updated < ?))""",
                                 (now, job_id, now - RENDER_LEASE_SECONDS)).rowcount
        if not claimed:
            return response(current())
        row = current()
        engine = row["engine"]
        plan = json.loads(row["plan"])
        artifact = json.loads(row["artifact"]) if row["artifact"] else None
        try:
            if artifact is None:
                log.info("Video job %s render attempt %s", job_id, row["attempts"])
                artifact = render(engine, plan)
                if "error" in artifact:
                    raise ValueError(artifact["error"])
            with db:
                db.execute("UPDATE video_jobs SET state='checking', updated=?, artifact=? WHERE id=?",
                           (time.time(), json.dumps(artifact, ensure_ascii=False), job_id))
            evaluation = evaluate(engine, plan, artifact)
            path = artifact.get("video_path") or artifact["result"]["videoPath"]
            result = {**artifact, "video_path": path, "delivery": f"MEDIA:{path}", "evaluation": evaluation}
            with db:
                db.execute("UPDATE video_jobs SET state='completed', updated=?, result=? WHERE id=?",
                           (time.time(), json.dumps(result, ensure_ascii=False), job_id))
        except Exception as error:
            detail = str(error) if isinstance(error, ValueError) else f"Video processing failed ({type(error).__name__})"
            with db:
                db.execute("UPDATE video_jobs SET state='failed', updated=?, error=?, artifact=NULL WHERE id=?",
                           (time.time(), detail, job_id))
        row = current()
        log.info("Video job %s %s in %.2fs", job_id, row["state"], time.time() - now)
        return response(row)
