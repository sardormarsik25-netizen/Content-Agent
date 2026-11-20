---
name: content-agent
description: Plan and render professional product, technology and social advertisements inside Hermes, plus posts and calendars.
---
# Content Agent inside Hermes

Use the active Hermes model and the native content_agent_render tool. For posts and calendars use save_post and save_calendar only when asked to save. For video advertisements use action=remotion and select the composition before planning the scenes.

## Required research for branded products

1. Use Hermes web_search to search for the brand and requested model, then inspect the exact official manufacturer's product page with web_extract or browser tools. Confirm brand, product category, exact model and color or SKU when specified. For an underspecified request choose a clearly named genuine variant and tell the user, or ask if the choice matters. Never present stock or generated imagery as an authentic product.
2. Call content_agent_render with action=product_research and payload {product:{brand,model,category,variant},page_url}. Use the exact category wording found on the Product record. Review returned candidate images on the official page or with vision tools. Select one showing the requested product prominently. Skip diagrams, other models and incidental lifestyle products. A missing search tool, unofficial domain or unverified match requires an approved URL or a precise clarification.
3. Call again with the same fields plus image_url and rights. Rights values: "user-authorized commercial", "licensed commercial", or "internal review". Only use a commercial value when the user confirmed suitable permission or the source license permits the intended use. A public catalog listing does not grant ad reuse. Use internal review only for user-authorized internal evaluation. Respect site restrictions. Do not rewrite or guess source URLs.
4. Render with composition=product (or another Remotion composition with the same product gate), product set to exactly the same identity, purpose="commercial" or "internal review", and one returned verified_asset_id on EVERY scene. Do not include image, asset_path or background on those scenes. Do not switch to action=video or omit product to work around failed research. Do not publish internal-review output.

The manufacturer host mapping comes from the profile plugin's approved_brand_hosts setting (normalized brand name to list of official DNS domains). Defaults cover On, IKEA, Nike and Adidas. Additional brands use the same verification process once their manufacturer domain is approved by the operator. Missing Product markup, ambiguous variants, blocked downloads or missing rights stop the product render.

## Remotion payload

Set composition to product, technology, saas, motion, ui, social, cinematic, or comedy. Use motion for explicitly requested graphic or text-led pieces. Provide 1?10 scenes, each 2?12 seconds, with at most 60 seconds total. Plan an opening hook, visual demonstration or story beat, and a CTA when appropriate. Compose each shot around its visual subject.

Example payload for a camera demonstration with animated SVG visuals:

    {
      "composition": "technology",
      "accent": "#36e2d0",
      "music": "pulse",
      "voice": "uz-UZ-MadinaNeural",
      "scenes": [
        {"title":"Hududni kuzating","subtitle":"Hodisani ko?ring","seconds":5,
         "role":"hook","motion":"reveal","overlay":{"type":"tracking","label":"Kuzatuv"},
         "narration":"Kamera hududni kuzatadi.","sfx":"whoosh"},
        {"title":"Demo so?rang","subtitle":"Bog?lanish","seconds":5,
         "role":"cta","motion":"push","overlay":{"type":"badge","label":"Demo"},
         "sfx":"chime"}
      ]
    }

Scene options: title (max 85 characters), subtitle (160), seconds, role [hook,problem,demo,benefit,cta,punchline], motion [reveal,push,pan,parallax,snap,still], overlay {type [tracking,metric,workflow,badge],label,value}, sfx [none,pop,whoosh,chime], narration (360) or voiceover_path (recorded narration), and one of image, asset_path, background. Top-level options: accent (hex), voice [uz-UZ-MadinaNeural,uz-UZ-SardorNeural], music [pulse,ambient,none] or music_path (licensed audio), require_images, and optional Strategy metadata. Keep narration short enough for its scene. Recorded narration and music paths must come from this profile's locally saved assets or audio attachments. If Edge TTS is unavailable, ask for the matching recording. Omit narration and voiceover_path for a music/SFX-only render. Set narration_policy=optional only if the user accepts music-only fallback, and disclose every narration_skipped reason returned by the tool. Choose uz-UZ-MadinaNeural or uz-UZ-SardorNeural for Uzbek speech.

## Assets and delivery

Use a real local image from this profile's asset library or image attachments via image or asset_path. Remotion public images can be referenced by basename with background. The image field accepts approved HTTPS image URLs from the On catalog CDN or Unsplash CDN. Verify the asset matches the brief and is appropriate for the requested use. For non-product creative pieces, cinematic, social and comedy scenes require images. Branded work follows the verified product contract above. Technology, SaaS and UI scenes need an image or a supported SVG overlay. For product ads use the exact requested model, or explicitly agreed concept imagery. Do not invent a file or use unrelated stock. If an approved source or a compatible image-generation tool is unavailable, ask for the needed asset. When image-generation is available, only use actual saved output and describe concept images as illustrative.

Tool actions video_status and video_retry take payload.job_id. Return actual video results and explain validation or render errors. Send the tool's MEDIA delivery line when and only when it returns status=completed. Do not publish externally without the user's instruction. The existing action=video uses the separate TypeScript rendering contract and is not the Remotion action.

## TypeScript video action

Use the following separate contract only with content_agent_render(action="video").

## Video payload example
```json
{
  "title": "Elektrik xizmati",
  "language": "uz",
  "mode": "narrated",
  "aspect_ratio": "9:16",
  "duration_seconds": 15,
  "voice": {"provider": "edge", "voice": "uz-UZ-MadinaNeural", "rate": "+20%"},
  "music": {"enabled": true, "mood": "cinematic", "volume_db": -22},
  "subtitles": {"enabled": true, "burn_in": true},
  "scenes": [
    {"narration": "Elektr ishlarini ishonchli ustaga topshiring.",
     "headline": "Elektrik xizmati", "subheadline": "Ishonchli yechim",
     "style": "aurora", "motion": "zoom-in", "transition": "fade",
     "palette": ["#050816", "#2563eb", "#22d3ee"]}
  ]
}
```

Use multiple concise scenes matching the requested length. Supported mode:
`narrated`, `music`, `silent`; aspect: `9:16`, `16:9`, `1:1`; language: uz/ru/en.
For non-narrated scenes supply `duration` seconds. Include user-provided images
via each scene's `image` absolute path. Do not invent existing image files.
Available styles: aurora, grid, spotlight, stripes, minimal.
Motion: zoom-in, zoom-out, pan-left, pan-right, none.


Operator TTS fallback: configure tts_fallbacks as a list of up to two objects with argv and voices. argv starts with a trusted absolute .exe and uses separate arguments {text_file}, {output_file}, and optionally {voice}. Map each supported Edge voice ID to the fallback provider voice ID. The executable must write a WAV to output_file. Configure only providers authorized for use. The default uses Edge only.
