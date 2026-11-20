"""Validate the Remotion contract shared by the tool, skill and renderer."""
import math
import re

COMPOSITIONS = {
    "product": "ProductCommercial", "technology": "TechnologyDemo",
    "saas": "SaasAd", "motion": "MotionGraphics", "ui": "UiAnimation",
    "social": "SocialAd", "cinematic": "CinematicShowcase", "comedy": "AnimatedComedy",
}
ROLES = ("hook", "problem", "demo", "benefit", "cta", "punchline")
MOTIONS = ("reveal", "push", "pan", "parallax", "snap", "still")
OVERLAYS = ("tracking", "metric", "workflow", "badge")
EFFECTS = ("none", "pop", "whoosh", "chime")
PLAN_KEYS = {"composition", "scenes", "accent", "voice", "music", "require_images", "strategy", "music_path", "product", "purpose", "narration_policy"}
SCENE_KEYS = {"title", "subtitle", "seconds", "role", "motion", "overlay", "sfx", "narration",
              "image", "asset_path", "background", "voiceover_path", "verified_asset_id"}


def fields(value, allowed, label):
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    unknown = set(value) - set(allowed)
    if unknown:
        raise ValueError(f"{label}: unsupported fields: {', '.join(sorted(unknown))}")


def string(value, limit, label):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f"{label} must be text up to {limit} characters")


def choice(value, options, label):
    if value not in options:
        raise ValueError(f"{label}: choose one of {', '.join(options)}")


def validate(plan):
    fields(plan, PLAN_KEYS, "Remotion payload")
    composition = plan.get("composition")
    if not isinstance(composition, str):
        raise ValueError("Choose a composition; use motion only for intentionally graphic or text-led work")
    choice(composition, COMPOSITIONS, "composition")
    branded = "product" in plan
    if composition == "product" and not branded:
        raise ValueError("Product commercials require product identity and verified assets. Run product_research first.")
    if branded:
        from .product_research import identity
        identity(plan["product"])
        choice(plan.get("purpose"), ("commercial", "internal review"), "purpose")
    elif "purpose" in plan:
        raise ValueError("purpose requires a product identity")
    accent = plan.get("accent", "#6ee7b7")
    if not isinstance(accent, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", accent):
        raise ValueError("accent must be a six-digit hex color")
    if "require_images" in plan and type(plan["require_images"]) is not bool:
        raise ValueError("require_images must be boolean")
    policy = plan.get("narration_policy", "required")
    choice(policy, ("required", "optional"), "narration_policy")
    if policy == "optional" and plan.get("music") == "none":
        raise ValueError("Optional narration requires a music bed for the music-only fallback")
    voice = plan.get("voice", "uz-UZ-MadinaNeural")
    if not isinstance(voice, str):
        raise ValueError("voice must be an Uzbek Edge voice name")
    choice(voice, ("uz-UZ-MadinaNeural", "uz-UZ-SardorNeural"), "voice")
    music = plan.get("music", "pulse")
    if not isinstance(music, str):
        raise ValueError("music must be pulse, ambient, or none")
    choice(music, ("pulse", "ambient", "none"), "music")
    if "music_path" in plan:
        string(plan["music_path"], 1024, "music_path")
        if not plan["music_path"].strip() or "music" in plan:
            raise ValueError("Provide either music or a nonempty music_path")
    scenes = plan.get("scenes")
    if not isinstance(scenes, list) or not 1 <= len(scenes) <= 10:
        raise ValueError("Provide 1–10 scenes")
    frames = []
    for index, scene in enumerate(scenes, 1):
        label = f"Scene {index}"
        fields(scene, SCENE_KEYS, label)
        string(scene.get("title"), 85, f"{label}.title")
        for key, limit in (("subtitle", 160), ("narration", 360)):
            string(scene.get(key, ""), limit, f"{label}.{key}")
        if "voiceover_path" in scene:
            string(scene["voiceover_path"], 1024, f"{label}.voiceover_path")
            if not scene["voiceover_path"].strip() or scene.get("narration", "").strip():
                raise ValueError(f"{label}: provide either narration or a nonempty voiceover_path")
        seconds = scene.get("seconds")
        if type(seconds) not in (int, float) or not 2 <= seconds <= 12:
            raise ValueError(f"{label}.seconds must be between 2 and 12")
        frames.append(math.floor(seconds * 30 + 0.5))
        for key, options in (("role", ROLES), ("motion", MOTIONS), ("sfx", EFFECTS)):
            if key in scene:
                choice(scene[key], options, f"{label}.{key}")
        if "overlay" in scene:
            overlay = scene["overlay"]
            fields(overlay, {"type", "label", "value"}, f"{label}.overlay")
            choice(overlay.get("type"), OVERLAYS, f"{label}.overlay.type")
            for key in ("label", "value"):
                string(overlay.get(key, ""), 42, f"{label}.overlay.{key}")
        sources = [key for key in ("image", "asset_path", "background", "verified_asset_id") if key in scene]
        for key in sources:
            string(scene[key], 4096, f"{label}.{key}")
            if not scene[key].strip():
                raise ValueError(f"{label}.{key} is empty")
        if len(sources) > 1:
            raise ValueError(f"{label}: provide only one image source")
        if branded and sources != ["verified_asset_id"]:
            raise ValueError(f"{label}: use only a verified_asset_id from product_research; stock and raw paths are blocked")
        if not branded and "verified_asset_id" in scene:
            raise ValueError(f"{label}: verified product imagery requires a matching product identity")
        needs_image = plan.get("require_images") or composition in ("product", "cinematic", "social", "comedy")
        needs_visual = composition in ("technology", "saas", "ui")
        if not sources and (needs_image or (needs_visual and not scene.get("overlay"))):
            raise ValueError(f"{label}: supply an approved image or a supported visual overlay for this composition")
    if sum(frames) > 1800:
        raise ValueError("Total video length cannot exceed 60 seconds")
    return frames
