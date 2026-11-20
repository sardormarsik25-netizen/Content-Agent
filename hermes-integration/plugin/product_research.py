"""Resolve product imagery from trusted manufacturer pages and bind it to renders."""
import hashlib
import http.client
import ipaddress
import json
import re
import socket
import ssl
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

from .video_contract import fields, string

USER_AGENT = "HermesContentAgent"
MAX_PAGE = 8_000_000
MAX_IMAGE = 8_000_000
DEFAULT_HOSTS = {"on": ["on.com"], "ikea": ["ikea.com"], "nike": ["nike.com"],
                 "adidas": ["adidas.com"]}
ALIASES = {"on running": "on", "on-running": "on", "on cloud": "on"}
IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
RIGHTS = ("user-authorized commercial", "licensed commercial", "internal review")


def normalized(value):
    return " ".join(re.findall(r"[^\W_]+", value.casefold())) if isinstance(value, str) else ""


def brand_key(value):
    name = normalized(value)
    return ALIASES.get(name, name)


def includes(value, target):
    return bool(normalized(target)) and f" {normalized(target)} " in f" {normalized(value)} "


def identity(value):
    fields(value, {"brand", "model", "category", "variant"}, "product")
    for key in ("brand", "model", "category", "variant"):
        string(value.get(key, ""), 160, f"product.{key}")
        if key != "variant" and not normalized(value.get(key)):
            raise ValueError(f"Identify the exact product {key} before researching")
    return (brand_key(value["brand"]), *(normalized(value.get(key)) for key in ("model", "category", "variant")))


def https_url(value):
    string(value, 4096, "source URL")
    parts = urlsplit(value)
    if (parts.scheme != "https" or not parts.hostname or parts.netloc != parts.hostname
            or not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", parts.hostname)
            or parts.fragment or any(ord(char) <= 32 for char in value)):
        raise ValueError("Use a public HTTPS source URL without credentials, ports, or fragments")
    return parts


def public_ip(value):
    ip = ipaddress.ip_address(value)
    return ip.is_global and not ip.is_multicast and not ip.is_reserved


class PublicHTTPS(http.client.HTTPSConnection):
    def connect(self):
        records = list(dict.fromkeys(info[4][0] for info in socket.getaddrinfo(
            self.host, 443, type=socket.SOCK_STREAM)))
        if not records or any(not public_ip(ip) for ip in records):
            raise ValueError("Source must resolve exclusively to public IP addresses")
        deadline = time.monotonic() + self.timeout
        last_error = None
        for endpoint in records[:4]:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("HTTPS connect deadline exceeded")
            try:
                with_socket = socket.create_connection((endpoint, 443), timeout=min(remaining, 3))
                try:
                    self.sock = self._context.wrap_socket(with_socket, server_hostname=self.host)
                except OSError:
                    with_socket.close()
                    raise
                return
            except (PermissionError, ssl.SSLCertVerificationError):
                raise
            except OSError as error:
                last_error = error
        if last_error is not None:
            raise last_error
        raise OSError("Could not connect to the source")


class TransientSourceError(OSError):
    pass


def fetch_once(url, max_size, types, *, allow_missing=False):
    parts = https_url(url)
    conn = PublicHTTPS(parts.hostname, timeout=8, context=ssl.create_default_context())
    try:
        path = parts.path or "/"
        if parts.query:
            path += "?" + parts.query
        conn.request("GET", path, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
        result = conn.getresponse()
        if result.status in (502, 503, 504):
            raise TransientSourceError(f"HTTPS source returned HTTP {result.status}")
        if allow_missing and result.status in (404, 410):
            return b"", ""
        if result.status != 200 or result.headers.get_content_type() not in types:
            raise ValueError("Source unavailable, redirected, or returned an unsupported content type")
        deadline = time.monotonic() + 12
        data = bytearray()
        while len(data) <= max_size:
            chunk = result.read1(min(65_536, max_size + 1 - len(data)))
            if time.monotonic() > deadline:
                raise TimeoutError("HTTPS response read deadline exceeded")
            if not chunk:
                break
            data.extend(chunk)
        if not data or len(data) > max_size:
            raise ValueError("Source response is empty or exceeds the size limit")
        return bytes(data), result.headers.get_content_type()
    finally:
        conn.close()


def fetch(url, max_size, types, *, allow_missing=False):
    for attempt in range(2):
        try:
            return fetch_once(url, max_size, types, allow_missing=allow_missing)
        except PermissionError as error:
            raise ValueError("Windows denied outbound HTTPS before TLS; run Hermes in an authorized network environment") from error
        except ssl.SSLCertVerificationError as error:
            raise ValueError("Official source TLS certificate could not be verified") from error
        except socket.gaierror as error:
            raise ValueError("Could not resolve the official source hostname") from error
        except (TransientSourceError, TimeoutError, ConnectionResetError, http.client.RemoteDisconnected) as error:
            if attempt:
                raise ValueError("Official source timed out or is temporarily unavailable after retry") from error
            time.sleep(0.4)
        except (OSError, http.client.HTTPException) as error:
            raise ValueError("Could not connect to the official HTTPS source") from error


def permitted(url, checked):
    host = https_url(url).hostname
    if host not in checked:
        crawlers, _ = fetch(f"https://{host}/robots.txt", 512_000, {"text/plain"}, allow_missing=True)
        rules = RobotFileParser()
        rules.parse(crawlers.decode("utf-8", "replace").splitlines())
        checked[host] = rules
    if not checked[host].can_fetch(USER_AGENT, url):
        raise ValueError("The source disallows automated access to this URL")


class ProductPage(HTMLParser):
    def __init__(self):
        super().__init__()
        self.structured = []
        self.active = False
        self.buffer = []

    def handle_starttag(self, tag, attrs):
        if tag == "script" and (dict(attrs).get("type") or "").lower() == "application/ld+json":
            self.active = True
            self.buffer = []

    def handle_data(self, data):
        if self.active:
            self.buffer.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.active:
            self.active = False
            try:
                self.structured.append(json.loads("".join(self.buffer)))
            except (ValueError, RecursionError):
                pass


def nodes(value):
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, list):
            pending.extend(reversed(item))
        elif isinstance(item, dict):
            yield item
            pending.extend(reversed(list(item.values())))


def label(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return label(value.get("name"))
    return ""


def product_record(document, product, page_url):
    parser = ProductPage()
    parser.feed(document.decode("utf-8", "replace"))
    brand, model, category, variant = identity(product)
    matches = {}
    for item in nodes(parser.structured):
        kind = item.get("@type")
        if kind != "Product" and not (isinstance(kind, list) and "Product" in kind):
            continue
        name = label(item.get("name"))
        sku = label(item.get("sku") or item.get("mpn"))
        actual_brand = label(item.get("brand"))
        model_names = {normalized(name), normalized(label(item.get("model"))), normalized(sku)}
        model_names.add(normalized(name).removeprefix(brand + " "))
        if brand_key(actual_brand) != brand or model not in model_names:
            continue
        if not includes(" ".join((name, label(item.get("category")))), category):
            continue
        color = label(item.get("color"))
        if variant and not includes(" ".join((name, color, sku)), variant):
            continue
        rows = item.get("image", [])
        if not isinstance(rows, list):
            rows = [rows]
        images = []
        for row in rows:
            source = (row.get("contentUrl") or row.get("url")) if isinstance(row, dict) else row
            if isinstance(source, str) and source:
                try:
                    candidate = urljoin(page_url, source)
                    https_url(candidate)
                    if candidate not in images:
                        images.append(candidate)
                except ValueError:
                    continue
        if images:
            record = {"brand": actual_brand, "model": product["model"], "name": name,
                      "category": product["category"], "variant": product.get("variant", ""),
                      "color": color, "sku": sku}
            matches[(normalized(name), normalized(color), normalized(sku), tuple(images))] = (record, images)
    if len(matches) != 1:
        raise ValueError("No unique official Product record with matching brand, model, category and variant images; confirm the model/variant or try another official product page")
    return next(iter(matches.values()))


def brand_hosts(product, configured):
    brand = identity(product)[0]
    entries = (configured or {}).get(brand, DEFAULT_HOSTS.get(brand, []))
    if not isinstance(entries, list) or not entries:
        raise ValueError("This brand has no approved manufacturer domain. Confirm the official domain and add it to approved_brand_hosts before rendering.")
    return entries


def research(payload, workspace, configured, ffmpeg):
    fields(payload, {"product", "page_url", "image_url", "rights"}, "product_research payload")
    product = payload.get("product")
    hosts = brand_hosts(product, configured)
    page_url = payload.get("page_url")
    host = https_url(page_url).hostname
    if not any(host == approved or host.endswith("." + approved) for approved in hosts):
        raise ValueError("Product page is not on the approved manufacturer domain for this brand")
    checked = {}
    permitted(page_url, checked)
    document, _ = fetch(page_url, MAX_PAGE, {"text/html", "application/xhtml+xml"})
    record, images = product_record(document, product, page_url)
    selected = payload.get("image_url")
    if not selected:
        return {"product": record, "page_url": page_url, "candidate_images": images[:8],
                "next": "Visually review a candidate on the product page, then call again with its exact image_url and confirmed rights"}
    if selected not in images:
        raise ValueError("Image URL is not listed on the matching official Product record")
    if payload.get("rights") not in RIGHTS:
        raise ValueError("Confirm commercial permission or mark the render for internal review")
    permitted(selected, checked)
    data, mime = fetch(selected, MAX_IMAGE, IMAGE_TYPES)
    if not {
        "image/jpeg": data.startswith(b"\xff\xd8\xff"),
        "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": data.startswith(b"RIFF") and data[8:12] == b"WEBP",
    }[mime]:
        raise ValueError("Official image content type does not match its bytes")
    directory = workspace / "verified-products"
    directory.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(data).hexdigest()
    receipt = {"digest": digest, "suffix": IMAGE_TYPES[mime], "product": product, "identity": record,
               "page_url": page_url, "image_url": selected, "rights": payload["rights"],
               "verified_at": datetime.now(timezone.utc).isoformat()}
    key = hashlib.sha256(json.dumps(receipt, sort_keys=True).encode()).hexdigest()
    with tempfile.TemporaryDirectory(dir=directory) as temp:
        staged = Path(temp) / ("image" + IMAGE_TYPES[mime])
        staged.write_bytes(data)
        try:
            subprocess.run([ffmpeg, "-v", "error", "-xerror", "-max_pixels", "36000000", "-i", str(staged),
                            "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"],
                           check=True, capture_output=True, timeout=15)
        except (OSError, subprocess.SubprocessError) as error:
            raise ValueError("Official image could not be decoded as a supported image") from error
        staged.replace(directory / (digest + IMAGE_TYPES[mime]))
        manifest = Path(temp) / "receipt.json"
        manifest.write_text(json.dumps(receipt, ensure_ascii=False), encoding="utf-8")
        manifest.replace(directory / (key + ".json"))
    return {"verified_asset_id": key, "product": record, "page_url": page_url,
            "image_url": selected, "rights": receipt["rights"]}


def verified_image(workspace, asset_id, product, purpose):
    if not isinstance(asset_id, str) or not re.fullmatch("[0-9a-f]{64}", asset_id):
        raise ValueError("Use a verified_asset_id returned by product_research")
    directory = workspace / "verified-products"
    try:
        receipt = json.loads((directory / (asset_id + ".json")).read_text(encoding="utf-8"))
        if hashlib.sha256(json.dumps(receipt, sort_keys=True).encode()).hexdigest() != asset_id:
            raise ValueError("Product asset receipt integrity check failed")
        if identity(receipt["product"]) != identity(product):
            raise ValueError("Verified asset brand, category, model or variant does not match the requested product")
        if purpose == "commercial" and receipt["rights"] == "internal review":
            raise ValueError("This product asset is cleared only for internal review; confirm commercial rights")
        path = directory / (receipt["digest"] + receipt["suffix"])
        if path.stat().st_size > MAX_IMAGE:
            raise ValueError("Verified image exceeds the size limit")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != receipt["digest"]:
            raise ValueError("Verified image changed on disk; research it again")
        return data
    except (OSError, KeyError) as error:
        raise ValueError("Verified product imagery is missing; run product_research first") from error
