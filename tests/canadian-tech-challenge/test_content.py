#!/usr/bin/env python3
import json
import struct
import unittest
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2] / "public-projects" / "canadian-tech-challenge"
QUESTIONS = ROOT / "data" / "questions.json"
CATEGORIES = {
    "AI & Data", "Fintech & Crypto", "SaaS & Enterprise", "Consumer & Commerce",
    "Deep Tech & Climate", "Builders & Breakthroughs", "Frontier & Defence",
}
EXPECTED_COUNTS = {
    "AI & Data": 61, "Fintech & Crypto": 56, "SaaS & Enterprise": 12,
    "Consumer & Commerce": 12, "Deep Tech & Climate": 12,
    "Builders & Breakthroughs": 12, "Frontier & Defence": 46,
}
EXPANSION_COMPANIES = {
    "Maneva", "Voiceflow", "ODAIA", "Botpress", "Viggle AI", "ThinkLabs AI", "Looki", "Gandeeva Therapeutics", "Shakudo", "Zuva", "Borderless AI", "Reliant AI", "Augmenta", "Intrepid Labs", "Private AI (now Limina)", "Ranovus", "Basetwo AI", "Spellbook", "Arteria AI", "Boosted.ai", "Xaba", "Miovision", "Nanoprecise Sci Corp", "Spare", "Unblocked", "Acerta Analytics", "Durable", "Scispot", "Astrus", "Artificial Agency", "Altis Labs", "Cadstrom", "Bench IQ", "Tempo Labs", "Variational AI", "Forma.ai", "Inverted AI", "Mercator AI", "Moonvalley", "Ideogram", "Ventus Therapeutics", "Taalas", "Deep Genomics", "Super Whisper", "Veeda AI", "Invision AI", "Turbopuffer", "Fellow", "Ribbon",
    "Saris", "Brim Financial", "OneVest", "Helcim", "FISPAN", "Venn", "Float Financial", "Relay Financial", "Zum Rails", "ZayZoon", "nesto", "Bull Bitcoin", "Stablecorp", "Informal Systems", "Quandri", "Fiscal.ai", "Zapper", "Buckzy Payments", "Inference Labs", "Vessel", "PayTic", "PayShepherd", "Beacon", "Finofo", "Nmbr", "LayerZero Labs", "Blockstream", "Plooto", "Tetra Digital Group", "Keep", "Trolley", "Conquest Planning", "Newton", "Figment", "Axelar", "Ledn", "ChainSafe", "Horizon (Sequence)", "Noble", "Pine", "Balance", "Helika", "FundThrough", "CapIntel",
    "Field Effect", "Novarc Technologies", "Ideon Technologies", "Prevu3D", "AON3D", "ZeroKey", "Cellula Robotics", "NordSpace", "Wolf Advanced Technology", "Ecopia AI", "Roshel", "Canada Rocket Company", "Juno Industries", "Haply Robotics", "Brilliant Matters", "Sanctuary AI", "Avidbots", "Kinova Robotics", "Robotiq", "Kepler Communications", "Reaction Dynamics", "Tailscale", "SkyWatch", "Promise Robotics", "Dominion Dynamics", "Wyvern", "Arcane Aerospace", "Canadian Strategic Missions Corporation (CSMC)", "Sentinel R&D", "Maritime Launch", "Clearpath Robotics", "ProteinQure", "Quantum Bridge Technologies", "Crypto4A Technologies", "Quantropi", "1QBit", "High Q Technologies", "InfinityQ Technology", "Photonic Inc.", "Nord Quantique", "Anyon Systems", "Space", "evolutionQ", "ISARA", "Starpath Robotics", "Avidrone Aerospace",
}
KNOWN_DEAD_SOURCE_URLS = {
    "https://generalfusion.com/technology/",
    "https://ingeniumcanada.org/channel/innovation/nortel-the-rise-and-fall-of-a-canadian-technology-giant",
    "https://pointclickcare.com/company/",
    "https://www.opentext.com/about",
    "https://www.clio.com/about/",
}


class LocalReferenceParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.references = []
        self.ids = set()
        self.anchors = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.add(attrs["id"])
        for key in ("src", "href"):
            value = attrs.get(key, "")
            if not isinstance(value, str):
                continue
            if value.startswith("#"):
                self.anchors.append(value[1:])
            elif value and not value.startswith(("http://", "https://", "mailto:", "data:")):
                self.references.append(value.split("?")[0].split("#")[0])


class QuestionDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.questions = json.loads(QUESTIONS.read_text())

    def test_exact_total_and_category_counts(self):
        self.assertEqual(len(self.questions), 211)
        counts = Counter(q["category"] for q in self.questions)
        self.assertEqual(set(counts), CATEGORIES)
        self.assertEqual(dict(counts), EXPECTED_COUNTS)

    def test_every_expected_expansion_company_appears_once_and_helius_is_absent(self):
        expansion = [q for q in self.questions if "-exp-" in q["id"]]
        self.assertEqual(len(expansion), 139)
        counts = Counter(q["company"] for q in expansion)
        self.assertEqual(set(counts), EXPANSION_COMPANIES)
        self.assertTrue(all(count == 1 for count in counts.values()))
        self.assertNotIn("helius", " ".join(q["company"] for q in expansion).casefold())

    def test_schema_and_values(self):
        required = {"id", "category", "difficulty", "company", "question", "options", "answer", "explanation", "sourceUrl", "sourceLabel", "asOf"}
        for q in self.questions:
            with self.subTest(q=q.get("id")):
                self.assertEqual(set(q), required)
                self.assertTrue(all(isinstance(q[key], str) and q[key].strip() for key in required - {"difficulty", "options", "answer"}))
                self.assertIn(q["category"], CATEGORIES)
                self.assertIn(q["difficulty"], (1, 2, 3))
                self.assertEqual(len(q["options"]), 4)
                self.assertEqual(len(set(q["options"])), 4)
                self.assertTrue(all(isinstance(option, str) and option.strip() for option in q["options"]))
                self.assertIsInstance(q["answer"], int)
                self.assertIn(q["answer"], range(4))
                self.assertRegex(q["asOf"], r"^\d{4}-\d{2}-\d{2}$")

    def test_no_duplicate_ids_or_question_text(self):
        ids = [q["id"] for q in self.questions]
        texts = [q["question"].casefold().strip() for q in self.questions]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(texts), len(set(texts)))

    def test_source_urls_are_public_https(self):
        for q in self.questions:
            with self.subTest(q=q["id"]):
                parsed = urlparse(q["sourceUrl"])
                self.assertEqual(parsed.scheme, "https")
                self.assertTrue(parsed.netloc)
                self.assertNotIn(parsed.hostname, {"localhost", "127.0.0.1"})
                self.assertFalse(parsed.username or parsed.password)

    def test_known_dead_source_urls_are_not_reintroduced(self):
        source_urls = {q["sourceUrl"] for q in self.questions}
        self.assertFalse(source_urls & KNOWN_DEAD_SOURCE_URLS)


class SiteIntegrityTests(unittest.TestCase):
    def test_expanded_bank_is_excluded_from_github_pages(self):
        repository_root = ROOT.parents[1]
        pages_config = (repository_root / "_config.yml").read_text()
        self.assertIn("- public-projects", pages_config)
        self.assertFalse((repository_root / ".nojekyll").exists())

    def test_html_local_assets_and_anchors_exist(self):
        parser = LocalReferenceParser()
        parser.feed((ROOT / "index.html").read_text())
        for reference in parser.references:
            with self.subTest(reference=reference):
                self.assertTrue((ROOT / reference).exists(), reference)
        for anchor in parser.anchors:
            self.assertIn(anchor, parser.ids)

    def test_nested_path_manifest_contract(self):
        manifest = json.loads((ROOT / "manifest.webmanifest").read_text())
        self.assertEqual(manifest["start_url"], "./")
        self.assertEqual(manifest["scope"], "./")
        html = (ROOT / "index.html").read_text()
        self.assertNotIn('href="/projects/canadian-tech-challenge', html)
        self.assertIn('href="manifest.webmanifest"', html)
        self.assertIn('fetch("data/questions.json")', (ROOT / "assets" / "app.js").read_text())

    def test_png_signatures_and_dimensions(self):
        for size in (180, 192, 512):
            path = ROOT / "assets" / f"icon-{size}.png"
            raw = path.read_bytes()
            self.assertEqual(raw[:8], b"\x89PNG\r\n\x1a\n")
            width, height = struct.unpack(">II", raw[16:24])
            self.assertEqual((width, height), (size, size))

    def test_progressive_fallback_and_accessibility_hooks(self):
        html = (ROOT / "index.html").read_text()
        self.assertIn("<noscript>", html)
        self.assertIn("Answer: Xanadu", html)
        self.assertIn('aria-live="polite"', html)
        self.assertIn("prefers-reduced-motion", (ROOT / "assets" / "styles.css").read_text())
        self.assertNotIn("analytics", html.casefold())


if __name__ == "__main__":
    unittest.main()
