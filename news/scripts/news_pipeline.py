#!/usr/bin/env python3
"""Build the static news snapshot from public RSS/Atom feeds (stdlib only)."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import ipaddress
import re
import socket
import struct
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
DATA_PATH = ROOT / "news" / "data" / "news.json"
SNAPSHOT_PATH = ROOT / "news" / "snapshot.html"
MIN_IMAGE_WIDTH = 960
MIN_IMAGE_HEIGHT = 540
MAX_HTML_BYTES = 1_000_000
MAX_IMAGE_BYTES = 12_000_000
MAX_ENRICH_STORIES = 50
MAX_CANDIDATES_PER_STORY = 8
MAX_EDITORIAL_PROBES = 45

@dataclass(frozen=True)
class Source:
    name: str
    url: str
    category: str
    region: str
    weight: int = 1
    required_terms: tuple[str, ...] = ()
    focus: str = ""
    source_type: str = "news"

SOURCES = (
    Source("BBC News", "https://feeds.bbci.co.uk/news/rss.xml", "Politics", "World", 4),
    Source("BBC Politics", "https://feeds.bbci.co.uk/news/politics/rss.xml", "Politics", "UK", 5),
    Source("CBC Canada", "https://www.cbc.ca/cmlink/rss-canada", "Politics", "Canada", 5),
    Source("CBC World", "https://www.cbc.ca/cmlink/rss-world", "Politics", "World", 3),
    Source("NPR Politics", "https://feeds.npr.org/1014/rss.xml", "Politics", "US", 5),
    Source("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml", "Politics", "World", 4),
    Source("DW", "https://rss.dw.com/rdf/rss-en-all", "Politics", "Europe", 4),
    Source("UN News", "https://news.un.org/feed/subscribe/en/news/all/rss.xml", "Politics", "World", 4),
    Source("The Guardian China", "https://www.theguardian.com/world/china/rss", "Politics", "China", 5),
    Source("The Guardian UK", "https://www.theguardian.com/uk-news/rss", "Politics", "UK", 3),
    Source("Ars Technica", "https://feeds.arstechnica.com/arstechnica/index", "Tech", "World", 5),
    Source("BBC Technology", "https://feeds.bbci.co.uk/news/technology/rss.xml", "Tech", "World", 4),
    Source("The Guardian Technology", "https://www.theguardian.com/technology/rss", "Tech", "World", 3),
    Source("TechCrunch", "https://techcrunch.com/feed/", "Tech", "World", 4),
    Source("Electronic Frontier Foundation", "https://www.eff.org/rss/updates.xml", "Tech", "US", 4),
    Source("Rest of World", "https://restofworld.org/feed/", "Tech", "World", 5),
    Source("BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml", "Economics", "World", 5),
    Source("The Guardian Economics", "https://www.theguardian.com/business/economics/rss", "Economics", "World", 5),
    Source("The Guardian Business", "https://www.theguardian.com/business/rss", "Economics", "World", 4),
    Source("CBC Business", "https://www.cbc.ca/cmlink/rss-business", "Economics", "Canada", 4),
    Source("NPR Business", "https://feeds.npr.org/1017/rss.xml", "Economics", "US", 4),
    Source("BBC Sport", "https://feeds.bbci.co.uk/sport/rss.xml", "Sports", "UK", 4),
    Source("BBC Rugby Union", "https://feeds.bbci.co.uk/sport/rugby-union/rss.xml", "Sports", "England", 5),
    Source("Saracens", "https://saracens.com/feed/", "Sports", "England", 5, focus="Saracens"),
    Source("Toronto Blue Jays", "https://www.mlb.com/bluejays/feeds/news/rss.xml", "Sports", "Canada", 5, focus="Blue Jays"),
    Source("Sportsnet Maple Leafs", "https://www.sportsnet.ca/hockey/nhl/feed/", "Sports", "Canada", 5, ("maple leafs", "leafs"), "Maple Leafs"),
    Source("Sky Sports", "https://www.skysports.com/rss/12040", "Sports", "UK", 3),
    Source("CBC Sports", "https://www.cbc.ca/cmlink/rss-sports", "Sports", "Canada", 4),
    Source("The Conversation — Africa", "https://theconversation.com/africa/articles.atom", "Editorial", "Africa", 5, source_type="editorial"),
    Source("The Conversation — UK", "https://theconversation.com/uk/articles.atom", "Editorial", "UK", 5, source_type="editorial"),
    Source("ProPublica", "https://www.propublica.org/feeds/propublica/main", "Editorial", "US", 5, source_type="editorial"),
    Source("Noema", "https://www.noemamag.com/feed/", "Editorial", "World", 4, source_type="editorial"),
    Source("Undark", "https://undark.org/feed/", "Editorial", "World", 4, source_type="editorial"),
    Source("Foreign Policy in Focus", "https://fpif.org/feed/", "Editorial", "World", 4, source_type="editorial"),
    Source("Yale Environment 360", "https://e360.yale.edu/feed.xml", "Editorial", "World", 4, source_type="editorial"),
)

TAG_RE = re.compile(r"<[^>]*>")
SCRIPT_RE = re.compile(r"<(script|style|iframe|object|embed)[^>]*>.*?</\1\s*>", re.I | re.S)
SPACE_RE = re.compile(r"\s+")
TOKEN_RE = re.compile(r"[a-z0-9]+")
WORD_RE = re.compile(r"\b[\w’'-]+\b", re.UNICODE)
TRACKING_QUERY_RE = re.compile(r"([?&])(utm_[^=&]+|cmpid|at_medium|at_campaign)=[^&]*", re.I)

REGION_RULES = {
    "Canada": ("canada", "canadian", "ottawa", "toronto", "blue jays", "maple leafs", "trudeau", "carney"),
    "US": ("united states", "u.s.", "washington", "white house", "congress", "trump", "american"),
    "China": ("china", "chinese", "beijing", "xi jinping"),
    "UK": ("united kingdom", "britain", "british", "england", "westminster", "downing street", "starmer"),
    "Africa": ("africa", "african", "kenya", "nigeria", "south africa", "ethiopia", "ghana"),
    "Middle East": ("middle east", "iran", "israel", "gaza", "lebanon", "syria", "yemen"),
    "Latin America": ("latin america", "brazil", "mexico", "argentina", "colombia", "chile"),
}
SPORT_RULES = ("rugby", "saracens", "blue jays", "baseball", "maple leafs", "nhl", "mlb", "premiership")
TECH_RULES = ("technology", "tech", "software", "ai ", "artificial intelligence", "cyber", "apple", "google", "microsoft", "robot", "chip")
TEAM_RULES = {
    "Saracens": ("saracens",),
    "Blue Jays": ("blue jays",),
    "Maple Leafs": ("maple leafs", "leafs"),
    "England Rugby": ("england rugby", "red roses", "six nations"),
}

PUBLISHER_PREFIXES = (
    ("The Guardian", "The Guardian"),
    ("BBC", "BBC"),
    ("CBC", "CBC News"),
    ("NPR", "NPR"),
    ("Sky Sports", "Sky Sports"),
    ("The Conversation", "The Conversation"),
    ("Toronto Blue Jays", "MLB"),
)


def normalize_publisher(source_name: str) -> str:
    """Return a stable publisher family shared by all of its feed editions."""
    cleaned = sanitize(source_name)
    for prefix, publisher in PUBLISHER_PREFIXES:
        if cleaned == prefix or cleaned.startswith(prefix + " "):
            return publisher
    return cleaned


def text_of(node: ET.Element | None) -> str:
    return "" if node is None else "".join(node.itertext()).strip()


def child_text(item: ET.Element, names: Iterable[str]) -> str:
    wanted = set(names)
    for child in list(item):
        local = child.tag.rsplit("}", 1)[-1].lower()
        if local in wanted:
            value = text_of(child)
            if value:
                return value
    return ""


def sanitize(value: str) -> str:
    """Convert externally supplied markup to inert plain text."""
    value = SCRIPT_RE.sub(" ", value or "")
    value = TAG_RE.sub(" ", value)
    value = html.unescape(value)
    value = "".join(ch for ch in value if ch in "\n\t" or ord(ch) >= 32)
    return SPACE_RE.sub(" ", value).strip()


def safe_url(value: str) -> str:
    value = html.unescape((value or "").strip())
    try:
        parsed = urlparse(value)
        port = parsed.port
    except ValueError:
        return ""
    expected_port = 443 if parsed.scheme == "https" else 80 if parsed.scheme == "http" else None
    if (expected_port is None or not parsed.hostname or parsed.username or parsed.password
            or port not in (None, expected_port) or any(ord(character) < 32 for character in value)):
        return ""
    cleaned = TRACKING_QUERY_RE.sub(r"\1", value).replace("?&", "?").rstrip("?&")
    return cleaned


def reading_metrics(text: str) -> tuple[int, int, bool]:
    """Return honest available-word count, 220-wpm reading time and short flag."""
    words = len(WORD_RE.findall(sanitize(text)))
    return words, max(1, (words + 219) // 220), words < 180


def sanitize_body(text: str) -> str:
    """Sanitize prose while preserving publisher paragraph boundaries."""
    paragraphs = [sanitize(paragraph) for paragraph in re.split(r"\n\s*\n", text or "")]
    return "\n\n".join(paragraph for paragraph in paragraphs if paragraph)


def breaking_title(title: str) -> bool:
    lowered = title.lower()
    return any(term in lowered for term in ("breaking:", "live:", "declares emergency", "major earthquake", "evacuation ordered"))


EDITORIAL_MIN_WORDS = 900


def qualify_editorial(story: dict, extracted_body: str) -> dict | None:
    """Qualify source-declared editorial only when readable text is substantial."""
    if story.get("sourceType") != "editorial":
        return None
    body = sanitize_body(extracted_body)
    words, minutes, _ = reading_metrics(body)
    if words < EDITORIAL_MIN_WORDS:
        return None
    story.update(body=body, wordCount=words, readingMinutes=minutes, isShort=False,
                 category="Editorial",
                 contentStatus="Freely readable article text extracted from publisher page")
    labels = ["Editorial", story.get("region", "World")]
    story["labels"] = list(dict.fromkeys(labels + story.get("labels", [])))
    return story


def safe_image_url(value: str) -> str:
    """Allow only ordinary credential-free HTTPS publisher image URLs."""
    value = html.unescape((value or "").strip())
    if not value or any(ord(character) < 32 for character in value):
        return ""
    try:
        parsed = urlparse(value)
        port = parsed.port
    except ValueError:
        return ""
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or port not in (None, 443)):
        return ""
    return value


def _positive_int(value: object) -> int:
    try:
        result = int(str(value))
        return result if result > 0 else 0
    except (TypeError, ValueError):
        return 0


class _ReadableBodyParser(HTMLParser):
    """Conservatively retain prose elements nested inside an article element."""
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.article_depth = 0
        self.blocked_depth = 0
        self.capture_tag = ""
        self.capture_depth = 0
        self.buffer: list[str] = []
        self.paragraphs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "article":
            self.article_depth += 1
        elif self.article_depth and tag in ("script", "style", "nav", "aside", "footer", "form"):
            self.blocked_depth += 1
        if self.article_depth and not self.blocked_depth and not self.capture_tag and tag in ("p", "h2", "h3", "blockquote", "li"):
            self.capture_tag, self.capture_depth, self.buffer = tag, 1, []
        elif self.capture_tag:
            self.capture_depth += 1

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.capture_tag:
            self.capture_depth -= 1
            if self.capture_depth == 0:
                text = sanitize(" ".join(self.buffer))
                if text:
                    self.paragraphs.append(text)
                self.capture_tag, self.buffer = "", []
        if self.blocked_depth and tag in ("script", "style", "nav", "aside", "footer", "form"):
            self.blocked_depth -= 1
        elif tag == "article" and self.article_depth:
            self.article_depth -= 1

    def handle_data(self, data: str) -> None:
        if self.capture_tag and not self.blocked_depth:
            self.buffer.append(data)


def extract_readable_body(payload: bytes) -> str:
    parser = _ReadableBodyParser()
    try:
        parser.feed(payload.decode("utf-8", "replace"))
    except Exception:
        return ""
    return "\n\n".join(parser.paragraphs)


class _ImageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.images: list[dict] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "img":
            return
        values = {name.lower(): value or "" for name, value in attrs}
        candidate = safe_image_url(values.get("src", ""))
        if candidate:
            self.images.append({"url": candidate, "width": _positive_int(values.get("width")),
                                "height": _positive_int(values.get("height")),
                                "alt": sanitize(values.get("alt", ""))[:300], "kind": "feed"})


def extract_image_candidates(item: ET.Element) -> list[dict]:
    """Collect safe publisher feed candidates, retaining declared dimensions."""
    candidates, markup_candidates = [], []
    for child in list(item):
        local = child.tag.rsplit("}", 1)[-1].lower()
        attributes = {key.rsplit("}", 1)[-1].lower(): value for key, value in child.attrib.items()}
        candidate = ""
        if local in ("thumbnail", "content"):
            medium = attributes.get("medium", "").lower()
            mime = attributes.get("type", "").lower()
            if local == "thumbnail" or medium == "image" or mime.startswith("image/") or not mime:
                candidate = safe_image_url(attributes.get("url", ""))
        elif local == "enclosure" and attributes.get("type", "").lower().startswith("image/"):
            candidate = safe_image_url(attributes.get("url", ""))
        if candidate:
            candidates.append({"url": candidate, "width": _positive_int(attributes.get("width")),
                               "height": _positive_int(attributes.get("height")),
                               "alt": sanitize(attributes.get("alt", attributes.get("description", "")))[:300],
                               "kind": "feed"})
        if local in ("description", "summary", "content", "encoded"):
            markup_candidates.append(text_of(child))
    for markup in markup_candidates:
        parser = _ImageParser()
        try:
            parser.feed(markup)
        except Exception:
            continue
        candidates.extend(parser.images)
    unique = {}
    for candidate in candidates:
        unique.setdefault(candidate["url"], candidate)
    return sorted(unique.values(), key=lambda item: (item["width"] * item["height"], item["width"], item["height"]), reverse=True)


def extract_image(item: ET.Element) -> tuple[str, str]:
    """Find publisher-supplied image metadata without rendering publisher HTML."""
    candidates = extract_image_candidates(item)
    if not candidates:
        return "", ""
    return candidates[0]["url"], candidates[0]["alt"]


class _SocialImageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.candidates: list[dict] = []
        self._latest: dict[str, dict] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "meta":
            return
        values = {name.lower(): value or "" for name, value in attrs}
        key = (values.get("property") or values.get("name", "")).strip().lower()
        content = values.get("content", "").strip()
        family = "og" if key.startswith("og:image") else "twitter" if key.startswith("twitter:image") else ""
        if not family:
            return
        if key in ("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"):
            url = safe_image_url(content)
            if url:
                candidate = {"url": url, "width": 0, "height": 0, "kind": "social"}
                self.candidates.append(candidate)
                self._latest[family] = candidate
        elif key.endswith(":width") and family in self._latest:
            self._latest[family]["width"] = _positive_int(content)
        elif key.endswith(":height") and family in self._latest:
            self._latest[family]["height"] = _positive_int(content)


def extract_social_images(payload: bytes) -> list[dict]:
    parser = _SocialImageParser()
    try:
        parser.feed(payload.decode("utf-8", "replace"))
    except Exception:
        return []
    unique = {}
    for candidate in parser.candidates:
        unique.setdefault(candidate["url"], candidate)
    return list(unique.values())


def image_dimensions(payload: bytes) -> tuple[int, int]:
    """Parse complete JPEG/PNG/GIF/WebP bytes without platform image tools."""
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        if len(payload) < 45 or payload[12:16] != b"IHDR" or payload[-8:-4] != b"IEND":
            raise ValueError("malformed or truncated PNG")
        width, height = struct.unpack(">II", payload[16:24])
    elif payload[:6] in (b"GIF87a", b"GIF89a"):
        if len(payload) < 14 or payload[-1:] != b";":
            raise ValueError("malformed or truncated GIF")
        width, height = struct.unpack("<HH", payload[6:10])
    elif payload.startswith(b"\xff\xd8"):
        if len(payload) < 12 or not payload.endswith(b"\xff\xd9"):
            raise ValueError("malformed or truncated JPEG")
        offset, width, height = 2, 0, 0
        while offset + 4 <= len(payload) - 2:
            if payload[offset] != 0xff:
                raise ValueError("malformed JPEG marker")
            while offset < len(payload) and payload[offset] == 0xff:
                offset += 1
            marker = payload[offset]; offset += 1
            if marker in (0xd8, 0xd9) or 0xd0 <= marker <= 0xd7:
                continue
            if offset + 2 > len(payload):
                raise ValueError("truncated JPEG segment")
            length = struct.unpack(">H", payload[offset:offset + 2])[0]
            if length < 2 or offset + length > len(payload):
                raise ValueError("truncated JPEG segment")
            if marker in tuple(range(0xc0, 0xc4)) + tuple(range(0xc5, 0xc8)) + tuple(range(0xc9, 0xcc)) + tuple(range(0xcd, 0xd0)):
                if length < 7:
                    raise ValueError("malformed JPEG frame")
                height, width = struct.unpack(">HH", payload[offset + 3:offset + 7])
                break
            offset += length
        if not width or not height:
            raise ValueError("JPEG dimensions unavailable")
    elif payload.startswith(b"RIFF") and payload[8:12] == b"WEBP":
        if len(payload) < 30 or struct.unpack("<I", payload[4:8])[0] != len(payload) - 8:
            raise ValueError("malformed or truncated WebP")
        kind, size = payload[12:16], struct.unpack("<I", payload[16:20])[0]
        data = payload[20:20 + size]
        if len(data) != size:
            raise ValueError("truncated WebP chunk")
        if kind == b"VP8X" and size >= 10:
            width = int.from_bytes(data[4:7], "little") + 1
            height = int.from_bytes(data[7:10], "little") + 1
        elif kind == b"VP8 " and size >= 10 and data[3:6] == b"\x9d\x01\x2a":
            width = struct.unpack("<H", data[6:8])[0] & 0x3fff
            height = struct.unpack("<H", data[8:10])[0] & 0x3fff
        elif kind == b"VP8L" and size >= 5 and data[0] == 0x2f:
            bits = int.from_bytes(data[1:5], "little")
            width, height = (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1
        else:
            raise ValueError("unsupported WebP layout")
    else:
        raise ValueError("unsupported image format")
    if width <= 0 or height <= 0:
        raise ValueError("invalid image dimensions")
    return width, height


def meets_image_floor(width: object, height: object) -> bool:
    return _positive_int(width) >= MIN_IMAGE_WIDTH and _positive_int(height) >= MIN_IMAGE_HEIGHT


def parse_date(value: str) -> datetime:
    if not value:
        return datetime(1970, 1, 1, tzinfo=timezone.utc)
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return datetime(1970, 1, 1, tzinfo=timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def categorize(title: str, summary: str, source: Source) -> tuple[str, str, list[str]]:
    haystack = f"{title} {summary}".lower()
    category = source.category
    # Dedicated feeds are already editorially classified. Only broad feeds need
    # keyword reclassification; a passing tech reference must not move politics.
    if source.name in ("BBC News", "CBC World"):
        if any(term in haystack for term in SPORT_RULES):
            category = "Sports"
        elif any(term in haystack for term in TECH_RULES):
            category = "Tech"
    regions = [name for name, terms in REGION_RULES.items() if any(term in haystack for term in terms)]
    region = regions[0] if regions else source.region
    labels = [category, region]
    if "rugby" in haystack or "saracens" in haystack:
        labels.append("Rugby")
    if "blue jays" in haystack or "baseball" in haystack:
        labels.append("Baseball")
    if "maple leafs" in haystack or "nhl" in haystack:
        labels.append("Hockey")
    focus_labels = [name for name, terms in TEAM_RULES.items() if any(term in haystack for term in terms)]
    if source.focus:
        focus_labels.insert(0, source.focus)
    labels.extend(focus_labels)
    return category, region, list(dict.fromkeys(labels))


def parse_feed(payload: bytes, source: Source) -> list[dict]:
    root = ET.fromstring(payload)
    items = [node for node in root.iter() if node.tag.rsplit("}", 1)[-1].lower() in ("item", "entry")]
    stories = []
    for item in items:
        title = sanitize(child_text(item, ("title",)))
        summary = sanitize(child_text(item, ("description", "summary", "content", "encoded")))
        link = child_text(item, ("link",))
        if not link:
            for child in list(item):
                if child.tag.rsplit("}", 1)[-1].lower() == "link":
                    link = child.attrib.get("href", "")
                    if link:
                        break
        link = safe_url(link)
        published = parse_date(child_text(item, ("pubdate", "published", "updated", "date")))
        if not title or not link:
            continue
        if source.required_terms and not any(term in f"{title} {summary}".lower() for term in source.required_terms):
            continue
        if len(summary) > 2400:
            summary = summary[:2399].rsplit(" ", 1)[0] + "…"
        category, region, labels = categorize(title, summary, source)
        word_count, reading_minutes, is_short = reading_metrics(summary)
        image_candidates = extract_image_candidates(item)
        image_url = image_candidates[0]["url"] if image_candidates else ""
        image_alt = image_candidates[0]["alt"] if image_candidates else ""
        identity = hashlib.sha256(f"{title.lower()}|{link}".encode()).hexdigest()[:16]
        story = {
            "id": identity, "title": title, "summary": summary or "This feed supplied a headline but no article summary.",
            "contentStatus": "Source-provided feed summary" if summary else "Headline only — no summary supplied",
            "url": link, "source": source.name, "publisher": normalize_publisher(source.name),
            "published": published.isoformat().replace("+00:00", "Z"),
            "category": category, "region": region, "labels": labels, "sourceWeight": source.weight,
            "focus": source.focus, "sourceType": source.source_type,
            "wordCount": word_count, "readingMinutes": reading_minutes,
            "isShort": is_short, "isBreaking": breaking_title(title),
        }
        if image_url:
            story["imageUrl"] = image_url
        if image_alt:
            story["imageAlt"] = image_alt
        if image_candidates:
            story["_imageCandidates"] = image_candidates
        stories.append(story)
    return stories


def title_tokens(title: str) -> set[str]:
    stop = {"the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "as", "at", "from", "is", "are", "after"}
    return {token for token in TOKEN_RE.findall(title.lower()) if len(token) > 2 and token not in stop}


def similar(a: dict, b: dict) -> bool:
    left, right = title_tokens(a["title"]), title_tokens(b["title"])
    if not left or not right:
        return False
    return len(left & right) / min(len(left), len(right)) >= 0.62


def dedupe(stories: list[dict]) -> list[dict]:
    kept = []
    for story in sorted(stories, key=lambda x: (x["published"], x["sourceWeight"]), reverse=True):
        if any(story["url"].split("?", 1)[0] == old["url"].split("?", 1)[0] or similar(story, old) for old in kept):
            continue
        kept.append(story)
    return kept


def rank(stories: list[dict], now: datetime) -> list[dict]:
    def score(story: dict) -> float:
        age_hours = max(0, (now - parse_date(story["published"])).total_seconds() / 3600)
        specificity = 2 if story["region"] in ("UK", "Canada", "US", "China", "England") else 0
        focus = 2 if story.get("focus") or any(label in TEAM_RULES for label in story.get("labels", [])) else 0
        summary = min(len(story["summary"]) / 500, 2)
        return story["sourceWeight"] * 3 + specificity + focus + summary - age_hours / 18
    return sorted(stories, key=lambda story: (score(story), story["published"]), reverse=True)


def select_top(stories: list[dict], count: int = 7) -> list[dict]:
    """Select an image-complete, sport-free and category-diverse Top 7."""
    stories = [story for story in stories
               if story.get("category") not in ("Sports", "Editorial")
               and (not story.get("isShort") or story.get("isBreaking"))
               and bool(story.get("imageUrl"))
               and safe_image_url(story.get("imageUrl", "")) == story.get("imageUrl")
               and meets_image_floor(story.get("imageWidth"), story.get("imageHeight"))]
    if len(stories) < count:
        raise ValueError(f"Need at least {count} image-bearing non-Sports stories verified at 960x540, got {len(stories)}")
    selected, publisher_counts, category_counts, focus_counts = [], {}, {}, {}

    def publisher(story: dict) -> str:
        return story.get("publisher") or normalize_publisher(story.get("source", ""))

    def add(story: dict) -> None:
        selected.append(story)
        family = publisher(story)
        publisher_counts[family] = publisher_counts.get(family, 0) + 1
        category_counts[story["category"]] = category_counts.get(story["category"], 0) + 1
        if story.get("focus"):
            focus_counts[story["focus"]] = focus_counts.get(story["focus"], 0) + 1

    # Avoid an edition accidentally omitting an entire requested section. Prefer
    # a different publisher for each seed story when the ranked pool permits it.
    required_categories = ("Politics", "Tech", "Economics")
    for category in required_categories:
        story = next((item for item in stories
                      if item["category"] == category and not publisher_counts.get(publisher(item))), None)
        if story is None:
            story = next((item for item in stories if item["category"] == category), None)
        if story:
            add(story)
    for story in stories:
        if story in selected:
            continue
        if (publisher_counts.get(publisher(story), 0) >= 2
                or category_counts.get(story["category"], 0) >= 3
                or (story.get("focus") and focus_counts.get(story["focus"], 0) >= 1)):
            continue
        add(story)
        if len(selected) == count:
            break
    # Feed failures must reduce diversity, not the edition. Relax the caps only
    # after exhausting every candidate that meets them.
    for story in stories:
        if len(selected) == count:
            break
        if story not in selected and (not story.get("focus") or not focus_counts.get(story["focus"])):
            add(story)
    if len(selected) != count or not set(required_categories) <= {story["category"] for story in selected}:
        raise ValueError("Could not assemble a diverse verified Top 7")
    return selected


def select_section(stories: list[dict], count: int = 12, publisher_cap: int = 2) -> list[dict]:
    """Select a concise substantial and publisher-diverse view, relaxing when needed."""
    substantial = [story for story in stories if not story.get("isShort") or story.get("isBreaking")]
    candidates = substantial or stories
    selected, counts = [], {}
    for story in candidates:
        family = story.get("publisher") or normalize_publisher(story.get("source", ""))
        if counts.get(family, 0) >= publisher_cap:
            continue
        selected.append(story)
        counts[family] = counts.get(family, 0) + 1
        if len(selected) == count:
            return selected
    # Two or more healthy publisher families are a useful concise section;
    # do not dilute it merely to hit the display ceiling.
    if len(counts) >= 2:
        return selected
    for story in stories:
        if story not in selected:
            selected.append(story)
            if len(selected) == count:
                break
    return selected


def order_for_output(top: list[dict], ranked: list[dict], limit: int = 200) -> list[dict]:
    """Keep explicit editorial coverage visible before filling by rank."""
    ordered = list(top)
    requirements = [
        lambda story, region=region: story["category"] == "Politics" and story["region"] == region
        for region in ("UK", "Canada", "US", "China")
    ] + [
        lambda story, focus=focus: story.get("focus") == focus
        for focus in ("Saracens", "Blue Jays", "Maple Leafs")
    ] + [
        lambda story: "England Rugby" in story.get("labels", []),
    ]
    for requirement in requirements:
        story = next((item for item in ranked if requirement(item)), None)
        if story and story not in ordered:
            ordered.append(story)
    ordered.extend(story for story in ranked if story not in ordered)
    return ordered[:limit]


def _validated_public_url(value: str) -> str:
    """Validate a credential-free public HTTPS URL and all current DNS answers."""
    value = safe_image_url(value)
    if not value:
        raise ValueError("unsafe public URL")
    parsed = urlparse(value)
    try:
        answers = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError("public hostname did not resolve") from exc
    if not answers:
        raise ValueError("public hostname did not resolve")
    for answer in answers:
        address = ipaddress.ip_address(str(answer[4][0]).split("%", 1)[0])
        if not address.is_global:
            raise ValueError("private or non-global destination rejected")
    return value


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _validated_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _fetch_bounded(url: str, accepted_types: tuple[str, ...], limit: int, timeout: int) -> tuple[bytes, str, int]:
    url = _validated_public_url(url)
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; HerbyProjectsNews/2.0; +https://herbyprojects.com/news/)",
        "Accept": ", ".join(accepted_types),
    })
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _SafeRedirectHandler())
    with opener.open(request, timeout=timeout) as response:
        final_url = _validated_public_url(response.geturl())
        if final_url != response.geturl():
            raise ValueError("redirect URL normalization rejected")
        status = response.getcode()
        if status not in (200, 206):
            raise ValueError(f"unexpected HTTP status {status}")
        content_type = response.headers.get_content_type().lower()
        if not any(content_type == accepted or content_type.startswith(accepted) for accepted in accepted_types):
            raise ValueError(f"unexpected content type {content_type}")
        declared = _positive_int(response.headers.get("Content-Length"))
        if declared > limit:
            raise ValueError("response exceeds byte limit")
        payload = response.read(limit + 1)
        if len(payload) > limit:
            raise ValueError("response exceeds byte limit")
        if declared and len(payload) != declared:
            raise ValueError("truncated response")
        return payload, content_type, status


def fetch_article(url: str, timeout: int = 8) -> bytes:
    return _fetch_bounded(url, ("text/html", "application/xhtml+xml"), MAX_HTML_BYTES, timeout)[0]


def fetch_image(url: str, timeout: int = 10) -> tuple[bytes, str, int]:
    return _fetch_bounded(url, ("image/",), MAX_IMAGE_BYTES, timeout)


def _call_article_fetch(fetcher, url: str) -> bytes:
    result = fetcher(url)
    return result[0] if isinstance(result, tuple) else result


def _call_image_fetch(fetcher, url: str) -> tuple[bytes, str, int]:
    result = fetcher(url)
    if isinstance(result, bytes):
        return result, "image/unknown", 200
    return result


def enrich_verified(stories: list[dict], article_fetch=fetch_article, image_fetch=fetch_image,
                    max_stories: int = MAX_ENRICH_STORIES) -> list[dict]:
    """Probe ranked stories until a selectable Top 7 exists, with strict request caps."""
    qualified, article_cache, probe_cache = [], {}, {}
    attempts = 0
    for story in stories:
        if story.get("category") in ("Sports", "Editorial"):
            continue
        attempts += 1
        if attempts > max_stories:
            break
        story.pop("imageWidth", None)
        story.pop("imageHeight", None)
        candidates = list(story.get("_imageCandidates", []))
        if story.get("imageUrl") and not any(item.get("url") == story["imageUrl"] for item in candidates):
            candidates.append({"url": story["imageUrl"], "width": 0, "height": 0,
                               "alt": story.get("imageAlt", ""), "kind": "feed"})
        try:
            if story["url"] not in article_cache:
                payload = _call_article_fetch(article_fetch, story["url"])
                article_cache[story["url"]] = (extract_social_images(payload), extract_readable_body(payload))
            social_images, body = article_cache[story["url"]]
            candidates = social_images + candidates
            words, minutes, is_short = reading_metrics(body)
            if body and words > story.get("wordCount", 0):
                story.update(body=sanitize_body(body), wordCount=words, readingMinutes=minutes, isShort=is_short,
                             contentStatus="Freely readable article text extracted from publisher page")
        except Exception:
            article_cache[story["url"]] = ([], "")
        unique = {}
        for candidate in candidates:
            url = safe_image_url(candidate.get("url", ""))
            if url:
                unique.setdefault(url, dict(candidate, url=url))
        candidates = sorted(unique.values(),
                            key=lambda item: (item.get("width", 0) * item.get("height", 0),
                                              item.get("kind") == "social"), reverse=True)[:MAX_CANDIDATES_PER_STORY]
        verified = []
        for candidate in candidates:
            url = candidate["url"]
            if url not in probe_cache:
                try:
                    payload, content_type, status = _call_image_fetch(image_fetch, url)
                    if status not in (200, 206) or not content_type.lower().startswith("image/"):
                        raise ValueError("image response was not successful")
                    probe_cache[url] = image_dimensions(payload)
                except Exception:
                    probe_cache[url] = None
            dimensions = probe_cache[url]
            if dimensions and meets_image_floor(*dimensions):
                verified.append((dimensions[0] * dimensions[1], candidate.get("kind") == "social",
                                 dimensions, candidate))
        if verified:
            _, _, (width, height), best = max(verified, key=lambda item: (item[0], item[1]))
            story["imageUrl"], story["imageWidth"], story["imageHeight"] = best["url"], width, height
            if best.get("alt"):
                story["imageAlt"] = best["alt"]
            qualified.append(story)
            try:
                candidate_top = select_top(qualified)
                families = [item.get("publisher") or normalize_publisher(item.get("source", ""))
                            for item in candidate_top]
                if max(families.count(family) for family in set(families)) <= 2:
                    break
            except ValueError:
                pass
    return qualified


def enrich_editorials(stories: list[dict], article_fetch=fetch_article,
                      max_probes: int = MAX_EDITORIAL_PROBES) -> tuple[list[dict], list[dict]]:
    """Extract and deterministically qualify free long reads across publishers."""
    qualified, probes, status, publisher_probes, source_probes = [], 0, {}, {}, {}
    for story in stories:
        if story.get("sourceType") != "editorial" or probes >= max_probes:
            continue
        publisher = story.get("publisher") or normalize_publisher(story.get("source", ""))
        source = story["source"]
        if publisher_probes.get(publisher, 0) >= 6 or source_probes.get(source, 0) >= 3:
            continue
        entry = status.setdefault(source, {"source": source, "succeeded": 0, "failed": 0, "skipped": 0})
        probes += 1
        publisher_probes[publisher] = publisher_probes.get(publisher, 0) + 1
        source_probes[source] = source_probes.get(source, 0) + 1
        try:
            body = extract_readable_body(_call_article_fetch(article_fetch, story["url"]))
            item = qualify_editorial(story, body)
            if item:
                qualified.append(item)
                entry["succeeded"] += 1
            else:
                entry["skipped"] += 1
        except Exception:
            entry["failed"] += 1
    for story in stories:
        if story.get("sourceType") == "editorial" and story["source"] not in status:
            status[story["source"]] = {"source": story["source"], "succeeded": 0, "failed": 0, "skipped": 1}
    return qualified, list(status.values())


def valid_fallback_stories(previous: dict) -> list[dict]:
    """Only a previously verified Top 7 may enter a fallback probe pool."""
    by_id = {story.get("id"): story for story in previous.get("stories", [])}
    result = []
    for identifier in previous.get("topStoryIds", []):
        story = by_id.get(identifier)
        if (story and story.get("category") != "Sports"
                and safe_image_url(story.get("imageUrl", "")) == story.get("imageUrl")
                and meets_image_floor(story.get("imageWidth"), story.get("imageHeight"))):
            result.append(story)
    return result


def valid_fallback_editorials(previous: dict) -> list[dict]:
    """Reuse only checked-in Editorial items that still satisfy every invariant."""
    by_id = {story.get("id"): story for story in previous.get("stories", [])}
    result = []
    for identifier in previous.get("sectionStoryIds", {}).get("Editorial", []):
        story = by_id.get(identifier)
        if not story or story.get("category") != "Editorial" or story.get("sourceType") != "editorial":
            continue
        body = sanitize_body(story.get("body", ""))
        words, minutes, _ = reading_metrics(body)
        if safe_url(story.get("url", "")) != story.get("url") or words < EDITORIAL_MIN_WORDS:
            continue
        result.append(dict(story, body=body, wordCount=words, readingMinutes=minutes, isShort=False))
    return result


def fetch(source: Source, timeout: int = 15) -> bytes:
    request = urllib.request.Request(source.url, headers={"User-Agent": "HerbyProjectsNews/1.0 (+https://herbyprojects.com/news/)"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(3_000_000)


def render_snapshot(top: list[dict]) -> str:
    cards = []
    for i, story in enumerate(top, 1):
        labels = " · ".join(story["labels"])
        cards.append(
            f'<article class="snapshot-card"><div class="story-image-frame">'
            f'<img class="story-image" src="{html.escape(story["imageUrl"], quote=True)}" alt="" width="{story["imageWidth"]}" height="{story["imageHeight"]}" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
            f'</div><p class="snapshot-number">{i:02d}</p>'
            f'<p class="story-meta">{html.escape(story.get("publisher", story["source"]))} · <time datetime="{story["published"]}">{story["published"][:10]}</time> · {story.get("readingMinutes", 1)} min · {story.get("wordCount", 0)} words available</p>'
            f'<h3>{html.escape(story["title"])}</h3><p>{html.escape(story["summary"])}</p>'
            f'<p class="labels">{html.escape(labels)}</p><a href="{html.escape(story["url"], quote=True)}" rel="noopener noreferrer">Read at source</a></article>'
        )
    return "\n".join(cards) + "\n"


def embed_snapshot(fragment: str) -> None:
    """Put source-attributed fallback HTML into the app for no-JS reading."""
    index_path = ROOT / "news" / "index.html"
    if not index_path.exists():
        return
    start, end = "<!-- SNAPSHOT:START -->", "<!-- SNAPSHOT:END -->"
    document = index_path.read_text(encoding="utf-8")
    if document.count(start) != 1 or document.count(end) != 1:
        raise ValueError("news/index.html snapshot markers are missing or ambiguous")
    before, remainder = document.split(start, 1)
    _, after = remainder.split(end, 1)
    index_path.write_text(f"{before}{start}\n{fragment}{end}{after}", encoding="utf-8")


def build(allow_fallback: bool = False) -> dict:
    now = datetime.now(timezone.utc)
    all_stories, statuses = [], []
    for source in SOURCES:
        try:
            stories = parse_feed(fetch(source), source)
            if not stories:
                raise ValueError("feed contained no usable stories")
            all_stories.extend(stories)
            statuses.append({"source": source.name, "ok": True, "items": len(stories)})
        except Exception as exc:  # one broken publisher must not stop refresh
            statuses.append({"source": source.name, "ok": False, "error": sanitize(str(exc))[:180]})
    ranked_all = rank(dedupe(all_stories), now)
    editorial_ranked = [story for story in ranked_all if story.get("sourceType") == "editorial"]
    ranked = [story for story in ranked_all if story.get("sourceType") != "editorial"]
    editorials, editorial_status = enrich_editorials(editorial_ranked)
    previous = json.loads(DATA_PATH.read_text(encoding="utf-8")) if allow_fallback and DATA_PATH.exists() else None
    if len({story.get("publisher") for story in editorials}) < 3 and previous:
        editorials = rank(dedupe(editorials + valid_fallback_editorials(previous)), now)
    qualified = enrich_verified(ranked)
    try:
        top = select_top(qualified)
    except ValueError:
        if not allow_fallback or not DATA_PATH.exists():
            raise
        previous = previous or json.loads(DATA_PATH.read_text(encoding="utf-8"))
        fallback = valid_fallback_stories(previous)
        ranked = rank(dedupe(ranked + fallback), now)
        qualified = enrich_verified(ranked)
        top = select_top(qualified)
    section_story_ids = {}
    selected_sections = []
    for category in ("Politics", "Tech", "Economics", "Sports"):
        selected = select_section([story for story in ranked if story["category"] == category],
                                  publisher_cap=3 if category == "Sports" else 2)
        section_story_ids[category] = [story["id"] for story in selected]
        selected_sections.extend(selected)
    selected_editorials = select_section(editorials, 12, publisher_cap=2)
    section_story_ids["Editorial"] = [story["id"] for story in selected_editorials]
    ordered = list(top)
    for story in selected_sections + selected_editorials + order_for_output(top, ranked) + editorials:
        if story not in ordered:
            ordered.append(story)
    ordered = ordered[:200]
    ordered = [{key: value for key, value in story.items() if not key.startswith("_")} for story in ordered]
    output = {
        "schemaVersion": 2, "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "topStoryIds": [story["id"] for story in top], "sectionStoryIds": section_story_ids,
        "stories": ordered, "sourceStatus": statuses, "editorialStatus": editorial_status,
        "policies": {"topPublisherCap": 2, "sectionPublisherCap": 2,
                     "shortWordThreshold": 180, "editorialMinWords": EDITORIAL_MIN_WORDS,
                     "readingWordsPerMinute": 220},
    }
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    DATA_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    fragment = render_snapshot(top)
    SNAPSHOT_PATH.write_text(fragment, encoding="utf-8")
    embed_snapshot(fragment)
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--allow-fallback", action="store_true", help="Reuse checked-in stories only if live feeds provide fewer than seven")
    parser.add_argument("--status", action="store_true", help="Print non-secret source refresh status")
    args = parser.parse_args()
    output = build(args.allow_fallback)
    if args.status:
        for status in output["sourceStatus"]:
            print(f"{'OK' if status['ok'] else 'FAIL'} {status['source']}: {status.get('items', status.get('error'))}")
        print(f"WROTE {len(output['stories'])} stories; top={len(output['topStoryIds'])}")
        by_id = {story["id"]: story for story in output["stories"]}
        print("SOURCE | CATEGORY | DIMENSIONS")
        for identifier in output["topStoryIds"]:
            story = by_id[identifier]
            print(f"{story['source']} | {story['category']} | {story['imageWidth']}x{story['imageHeight']}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
