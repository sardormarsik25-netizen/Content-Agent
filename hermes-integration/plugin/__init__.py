"""Native Hermes content tools; uses the parent model, never another bot poller."""
import json
import os
import re
from pathlib import Path
import sqlite3
import subprocess
from datetime import datetime, timezone
from uuid import uuid4
from .remotion_video import render
from .video_audio import fallback_providers
from .product_research import research
from .advertising import run as advertising
from .video_jobs import validate_plan, video_job

JOB_ACTIONS = ["video_status", "video_retry"]
AD_ACTIONS = ["brief_parser", "product_lookup", "product_research", "asset_library", "video_check", "voiceover", "content_memory"]


def video_request_context(user_message="", platform="", **kwargs):
    if platform != "telegram" or not isinstance(user_message, str):
        return None
    request = user_message.casefold()
    if not re.search(r"\b(video(?:ni)?|mp4|remotion)\b", request):
        return None
    if not re.search(r"\b(yasa\w*|yarat\w*|tayyorla\w*|render|generate|сделай|создай)\b", request):
        return None
    return {"context": (
        "Read creative:content-agent before rendering. Select a composition matching the brief. "
        "For ANY branded product advertised, use web_search to identify the official product page, then product_research. "
        "Render with product identity, purpose and a verified_asset_id per scene; never use stock imagery for a branded product. "
        "Pass scene.image (approved HTTPS or real local path) or asset_path, plus scene.narration when requested. "
        "If essential assets are unavailable, ask for them. Use action=remotion with the documented payload. "
        "Only send the returned delivery when status=completed."
    )}


def register(ctx):
    root = Path(ctx.get_config("project_root", ""))
    node = ctx.get_config("node", "node")
    entry = root / "src/index.ts"
    if not root.is_absolute() or not entry.is_file():
        raise ValueError("Content Agent project_root is missing")
    ctx.register_hook("pre_llm_call", video_request_context)

    workspace = Path(__file__).resolve().parents[2] / "workspace"

    def evaluate(engine, plan, artifact):
        if engine == "remotion":
            metrics = advertising("video_check", {
                "path": artifact["video_path"], "seconds": validate_plan(engine, plan),
            }, root, ctx.get_config("ffprobe", "ffprobe"), workspace)
        else:
            result = artifact["result"]
            path = Path(result["videoPath"])
            metrics = {
                "ok": path.is_file() and path.suffix.lower() == ".mp4"
                      and result["durationSeconds"] > 0 and result["width"] > 0 and result["height"] > 0,
                "width": result["width"], "height": result["height"],
                "seconds": result["durationSeconds"], "audio": result["hasAudio"],
                "warnings": result.get("warnings", []),
            }
        if plan.get("strategy") is not None and not 14.75 <= metrics["seconds"] <= 30.25:
            metrics["ok"] = False
        if not metrics["ok"]:
            raise ValueError("Rendered MP4 failed technical checks")
        return metrics

    def handler(args, **kwargs):
        action = args.get("action", "status")
        payload = args.get("payload", {})
        if not isinstance(payload, dict):
            return json.dumps({"error": "payload must be a JSON object"})
        if action in ("video", "remotion", *JOB_ACTIONS):
            try:
                def render_plan(engine, plan):
                    return json.loads(dispatch({"action": engine, "payload": plan}))

                result = video_job(workspace, action, payload, render_plan, evaluate)
                return json.dumps(result, ensure_ascii=False)
            except ValueError as error:
                return json.dumps({"error": str(error)}, ensure_ascii=False)
            except sqlite3.Error:
                return json.dumps({"error": "Video job database unavailable"})
        return dispatch(args)

    def dispatch(args):
        action = args.get("action", "status")
        if action == "status":
            return json.dumps({"integration": "native-hermes", "video_revision": "verified-assets-narration-v1", "planner": "parent Hermes model",
                               "renderer": str(entry), "separate_bot": False,
                               "actions": ["video", "remotion", "save_post", "save_calendar", "profile", "doctor", *AD_ACTIONS, *JOB_ACTIONS]})
        payload = args.get("payload", {})
        if not isinstance(payload, dict):
            return json.dumps({"error": "payload must be a JSON object"})
        if action == "product_research":
            try:
                return json.dumps(research(payload, workspace, ctx.get_config("approved_brand_hosts", {}),
                                           ctx.get_config("ffmpeg", "ffmpeg")), ensure_ascii=False)
            except ValueError as error:
                return json.dumps({"error": str(error)}, ensure_ascii=False)
            except OSError:
                return json.dumps({"error": "Could not store the verified asset locally"})
        if action in AD_ACTIONS:
            try:
                result = advertising(action, payload, root, ctx.get_config("ffprobe", "ffprobe"),
                                     workspace)
                return json.dumps(result, ensure_ascii=False)
            except (ValueError, OSError, subprocess.SubprocessError) as error:
                return json.dumps({"error": type(error).__name__,
                                   "detail": str(error) if isinstance(error, ValueError) else "Check local files or renderer dependencies"})
        if action == "remotion":
            try:
                result = render(
                    payload, node,
                    Path(ctx.get_config("remotion_root", "C:/Users/user/Desktop/skills/remotion-video")),
                    ctx.get_config("browser", "C:/Users/user/AppData/Local/hermes/tools/chromium-1208/chrome-win64/chrome.exe"),
                    ctx.get_config("ffmpeg", "ffmpeg"), root / "python/tts_edge.py", workspace,
                    fallback_providers(ctx.get_config("tts_fallbacks", [])),
                )
                return json.dumps(result, ensure_ascii=False)
            except (ValueError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                return json.dumps({"error": str(error)}, ensure_ascii=False)
        if action in ("save_post", "save_calendar"):
            if not payload:
                return json.dumps({"error": "Generate the content in Hermes and supply it as payload"})
            out = root / "outputs" / "drafts"
            out.mkdir(parents=True, exist_ok=True)
            name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8]
            path = out / (name + "-" + action[5:] + ".json")
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            return json.dumps({"saved": str(path), "published": False}, ensure_ascii=False)
        stdin = None
        if action == "video":
            if "product" in payload:
                return json.dumps({"error": "Branded product ads require the Remotion verified asset pipeline"})
            if not isinstance(payload.get("scenes"), list) or not payload["scenes"]:
                return json.dumps({"error": "Hermes must generate a video plan with nonempty scenes first"})
            command = ["video", "--plan", "-", "--json"]
            stdin = json.dumps(payload, ensure_ascii=False)
        elif action == "profile":
            command = ["profile", "show"]
        elif action == "doctor":
            command = ["doctor-video"]
        else:
            return json.dumps({"error": "Unsupported action"})
        env = os.environ.copy()
        for setting, variable in (("ffmpeg", "FFMPEG_PATH"), ("ffprobe", "FFPROBE_PATH")):
            executable = ctx.get_config(setting, "")
            if executable:
                env[variable] = executable
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        try:
            result = subprocess.run([node, str(entry), *command], input=stdin, text=True,
                                    encoding="utf-8", errors="replace", capture_output=True,
                                    cwd=str(root), env=env, timeout=900 if action == "video" else 60,
                                    shell=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if result.returncode:
                # Raw subprocess diagnostics can contain environment secrets. Keep them local.
                return json.dumps({"error": "Content renderer failed", "exit_code": result.returncode,
                                   "action": action, "hint": "Run doctor-video locally; do not claim output exists"})
            if action == "video":
                return json.dumps({"result": json.loads(result.stdout)}, ensure_ascii=False)
            return json.dumps({"result": result.stdout[:16000]}, ensure_ascii=False)
        except subprocess.TimeoutExpired:
            return json.dumps({"error": "Content renderer timed out; completion is unconfirmed"})
        except (OSError, ValueError):
            return json.dumps({"error": "Content runtime unavailable or returned invalid JSON"})

    ctx.register_tool(
        name="content_agent_render", toolset="content-agent", handler=handler,
        description="Hermes-native content drafts, calendars and video rendering",
        schema={"name": "content_agent_render", "description":
                "Use the parent Hermes model to write posts/calendars and video plans. "
                "Use remotion for vertical ads. Required payload: composition and scenes. "
                "Compositions: product, technology, saas, motion, ui, social, cinematic, comedy. "
                "Scene fields: title, subtitle, seconds, role, motion, overlay, sfx, narration or voiceover_path, and one of image, asset_path, background. "
                "For branded ads first call product_research with product {brand,model,category,variant}, page_url and then image_url and rights. "
                "For render pass the same product, purpose, and one verified_asset_id per scene. "
                "Use narration_policy=optional only when music-only fallback is allowed. Report narration_skipped. Narration is synthesized and verified when present. Use real/approved assets; music_path is optional. "
                "This tool saves drafts or renders a supplied video plan without OpenCode. "
                "Video jobs return job_id and technical evaluation. Use video_status or video_retry with payload.job_id. "
                "Read the content-agent skill for the plan format. It never publishes or starts a bot.",
                "parameters": {"type": "object", "properties": {
                    "action": {"type": "string", "enum": ["status", "video", "remotion", "save_post", "save_calendar", "profile", "doctor", *AD_ACTIONS, *JOB_ACTIONS]},
                    "payload": {"type": "object", "description": "Action-specific payload. Remotion uses the strict contract in creative:content-agent."}},
                    "required": ["action"], "additionalProperties": False}})
    ctx.register_command("content", handler=lambda raw_args: handler({"action": "status"})
                         if raw_args.strip() == "status" else
                         "Content Agent Hermes ichiga ulangan. Video, post yoki kontent reja so'rovini oddiy xabar sifatida yozing. Holat: /content status",
                         description="Content Agent integration status and help", args_hint="[status]")
