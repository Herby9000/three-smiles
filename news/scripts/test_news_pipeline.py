import json
import os
import struct
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse
from unittest.mock import patch
from xml.etree import ElementTree

import news_pipeline as pipeline

RSS = b'''<?xml version="1.0"?><rss><channel><item>
<title>UK &amp; Canada discuss technology partnership</title>
<link>https://example.com/story?utm_source=test</link>
<description><![CDATA[<p>A <strong>detailed</strong> update.</p><script>alert(1)</script>]]></description>
<pubDate>Sat, 15 Aug 2026 12:00:00 GMT</pubDate>
</item></channel></rss>'''

IMAGE_RSS = b'''<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<item><title>Thumbnail</title><link>https://example.com/1</link><media:thumbnail url="https://images.example.com/thumb.jpg" /></item>
<item><title>Media content</title><link>https://example.com/2</link><media:content url="https://images.example.com/content.webp" medium="image" /></item>
<item><title>Enclosure</title><link>https://example.com/3</link><enclosure url="https://images.example.com/enclosed.png" type="image/png" /></item>
<item><title>Description</title><link>https://example.com/4</link><description><![CDATA[<p>Words</p><img src="https://images.example.com/description.jpg" alt="A supplied caption">]]></description></item>
</channel></rss>'''

class ImageCollector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.images = []

    def handle_starttag(self, tag, attrs):
        if tag == 'img':
            self.images.append(dict(attrs))

class PipelineTests(unittest.TestCase):
    def verified_story(self, identifier, category, source=None, width=960, height=540):
        return {'id': identifier, 'title': f'Unique {identifier}', 'summary': 'x',
                'url': f'https://publisher.test/{identifier}', 'published': '2026-08-15T12:00:00Z',
                'sourceWeight': 3, 'source': source or f'Source {identifier}', 'category': category,
                'region': 'World', 'labels': [category], 'imageUrl': f'https://images.test/{identifier}.jpg',
                'imageWidth': width, 'imageHeight': height}

    def test_topic_navigation_is_nonshrinking_nonwrapping_and_scrollable(self):
        css = (Path(__file__).parents[1] / 'assets' / 'news.css').read_text(encoding='utf-8')

        def declarations(selector):
            start = css.index(selector + '{') + len(selector) + 1
            return css[start:css.index('}', start)]

        topics = declarations('.topics')
        topic = declarations('.topic')
        self.assertIn('display:flex', topics)
        self.assertIn('overflow-x:auto', topics)
        self.assertIn('flex:0 0 auto', topic)
        self.assertIn('white-space:nowrap', topic)
        self.assertIn('min-height:44px', topic)

    def test_sports_subfilters_have_320px_mobile_contract(self):
        css = (Path(__file__).parents[1] / 'assets' / 'news.css').read_text(encoding='utf-8')

        def declarations(selector):
            start = css.index(selector + '{') + len(selector) + 1
            return css[start:css.index('}', start)]

        row = declarations('.sports-filters')
        pill = declarations('.sports-filter')
        self.assertIn('display:flex', row)
        self.assertIn('overflow-x:auto', row)
        self.assertIn('flex-wrap:nowrap', row)
        self.assertIn('flex:0 0 auto', pill)
        self.assertIn('white-space:nowrap', pill)
        self.assertIn('min-height:44px', pill)

    def test_checked_in_edition_has_every_named_sports_filter(self):
        data = json.loads((Path(__file__).parents[1] / 'data' / 'news.json').read_text(encoding='utf-8'))
        sports = [story for story in data['stories'] if story['category'] == 'Sports']

        def exact(story, focus, label, source):
            return story.get('focus') == focus or label in story.get('labels', []) or story.get('source') == source

        saracens = [story for story in sports if exact(story, 'Saracens', 'Saracens', 'Saracens')]
        counts = {
            'Rugby': sum((('Rugby' in story.get('labels', []) or 'England Rugby' in story.get('labels', []) or
                           story.get('source') == 'BBC Rugby Union') and story not in saracens) for story in sports),
            'Saracens': len(saracens),
            'Blue Jays': sum(exact(story, 'Blue Jays', 'Blue Jays', 'Toronto Blue Jays') for story in sports),
            'Leafs': sum(exact(story, 'Maple Leafs', 'Maple Leafs', 'Sportsnet Maple Leafs') for story in sports),
        }
        self.assertTrue(all(count > 0 for count in counts.values()), counts)

    def test_editorial_is_first_class_navigation_with_empty_state_and_length_metadata(self):
        html = (Path(__file__).parents[1] / 'index.html').read_text(encoding='utf-8')
        script = (Path(__file__).parents[1] / 'assets' / 'news.js').read_text(encoding='utf-8')
        self.assertIn('data-filter="Editorial"', html)
        self.assertIn('Editorial feeds are temporarily unavailable', script)
        self.assertIn('readingMinutes', script)
        self.assertIn("story.body", script)

    def test_daily_seven_manifest_is_nested_path_safe(self):
        news_root = Path(__file__).parents[1]
        manifest = json.loads((news_root / 'manifest.webmanifest').read_text(encoding='utf-8'))
        deployed_manifest_url = 'https://herby9000.github.io/herbyprojects/news/manifest.webmanifest'
        expected_app_url = 'https://herby9000.github.io/herbyprojects/news/'
        for field in ('id', 'start_url', 'scope'):
            self.assertEqual(urljoin(deployed_manifest_url, manifest[field]), expected_app_url)
        self.assertEqual({icon['sizes'] for icon in manifest['icons']}, {'192x192', '512x512'})
        for icon in manifest['icons']:
            resolved = urljoin(deployed_manifest_url, icon['src'])
            self.assertEqual(urlparse(resolved).path, f'/herbyprojects/news/assets/icons/daily-seven-{icon["sizes"].split("x")[0]}.png')
            self.assertEqual(icon['type'], 'image/png')

    def test_daily_seven_png_icons_have_signatures_and_exact_dimensions(self):
        icon_root = Path(__file__).parents[1] / 'assets' / 'icons'
        for size in (180, 192, 512):
            payload = (icon_root / f'daily-seven-{size}.png').read_bytes()
            self.assertEqual(payload[:8], b'\x89PNG\r\n\x1a\n')
            self.assertEqual(payload[12:16], b'IHDR')
            self.assertEqual(struct.unpack('>II', payload[16:24]), (size, size))

    def test_daily_seven_html_has_complete_app_icon_metadata(self):
        html = (Path(__file__).parents[1] / 'index.html').read_text(encoding='utf-8')
        self.assertIn('<meta name="theme-color" content="#f4efe6">', html)
        self.assertIn('<meta name="application-name" content="Daily Seven">', html)
        self.assertIn('<meta name="apple-mobile-web-app-title" content="Daily Seven">', html)
        self.assertIn('<link rel="manifest" href="manifest.webmanifest?v=2">', html)
        self.assertIn('<link rel="icon" href="assets/icons/daily-seven.svg?v=1" type="image/svg+xml">', html)
        self.assertIn('<link rel="icon" href="assets/icons/daily-seven-192.png?v=1" type="image/png" sizes="192x192">', html)
        self.assertIn('<link rel="apple-touch-icon" href="assets/icons/daily-seven-180.png?v=1" sizes="180x180">', html)
        self.assertNotIn('../assets/favicon', html)

    def test_daily_seven_icon_is_original_editorial_art_not_a_generic_letter(self):
        icon_path = Path(__file__).parents[1] / 'assets' / 'icons' / 'daily-seven.svg'
        source = icon_path.read_text(encoding='utf-8')
        root = ElementTree.fromstring(source)
        self.assertEqual(root.attrib.get('viewBox'), '0 0 512 512')
        self.assertIn('Daily Seven morning briefing icon', source)
        self.assertEqual(len(root.findall(".//*[@class='editorial-rule']")), 7)
        self.assertEqual(len(root.findall(".//*[@class='rising-sun']")), 1)
        self.assertNotIn('>H<', source)

    def test_browser_javascript_initializes_and_starts_loading(self):
        script = Path(__file__).with_name('test_news_runtime.js')
        result = subprocess.run(['node', str(script)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_checked_in_refreshed_data_passes_production_dom_behavior(self):
        script = Path(__file__).with_name('test_news_runtime.js')
        data = Path(__file__).parents[1] / 'data' / 'news.json'
        result = subprocess.run(['node', str(script)], capture_output=True, text=True,
                                env={**os.environ, 'NEWS_DATA_PATH': str(data)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_publisher_normalization_collapses_feed_editions(self):
        self.assertEqual(pipeline.normalize_publisher('The Guardian China'), 'The Guardian')
        self.assertEqual(pipeline.normalize_publisher('BBC Technology'), 'BBC')
        self.assertEqual(pipeline.normalize_publisher('CBC Canada'), 'CBC News')
        self.assertEqual(pipeline.normalize_publisher('Ars Technica'), 'Ars Technica')

    def test_sanitization_strips_active_markup_and_decodes_entities(self):
        self.assertEqual(pipeline.sanitize('<style>x</style><p>A &amp; B</p><iframe>x</iframe>'), 'A & B')
        self.assertEqual(pipeline.safe_url('javascript:alert(1)'), '')

    def test_story_links_reject_credentials_and_nonstandard_ports(self):
        self.assertEqual(pipeline.safe_url('https://user:secret@example.com/story'), '')
        self.assertEqual(pipeline.safe_url('https://example.com:8443/story'), '')
        self.assertEqual(pipeline.safe_url('https://example.com/story'), 'https://example.com/story')

    def test_article_body_extraction_is_sanitized_and_article_scoped(self):
        markup = b'''<html><body><nav>Menu poison</nav><article><h2>Context &amp; evidence</h2>
        <p>First paragraph with useful detail.</p><script>alert(1)</script>
        <p>Second paragraph <a href="javascript:bad()">with a link</a>.</p></article>
        <footer>Footer poison</footer></body></html>'''
        body = pipeline.extract_readable_body(markup)
        self.assertIn('Context & evidence', body)
        self.assertIn('First paragraph with useful detail.', body)
        self.assertNotIn('alert', body)
        self.assertNotIn('poison', body)
        self.assertNotIn('<', body)

    def test_image_extraction_covers_media_enclosure_and_description(self):
        source = pipeline.Source('Test', 'https://example.com/feed', 'Politics', 'World')
        stories = pipeline.parse_feed(IMAGE_RSS, source)
        self.assertEqual([story['imageUrl'] for story in stories], [
            'https://images.example.com/thumb.jpg',
            'https://images.example.com/content.webp',
            'https://images.example.com/enclosed.png',
            'https://images.example.com/description.jpg',
        ])
        self.assertEqual(stories[-1].get('imageAlt'), 'A supplied caption')

    def test_multiple_media_candidates_choose_largest_not_first(self):
        payload = b'''<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item>
        <title>Variants</title><link>https://example.com/variants</link>
        <media:content url="https://images.example.com/140.jpg" width="140" height="112" />
        <media:content url="https://images.example.com/700.jpg" width="700" height="560" />
        <media:content url="https://images.example.com/460.jpg" width="460" height="368" />
        </item></channel></rss>'''
        story = pipeline.parse_feed(payload, pipeline.Source('Test', 'https://example.com/feed', 'Politics', 'World'))[0]
        self.assertEqual(story['imageUrl'], 'https://images.example.com/700.jpg')

    def test_social_image_metadata_handles_order_entities_and_rejects_unsafe_values(self):
        markup = b'''<html><head>
        <meta content="https://images.example.com/lead.jpg?a=1&amp;b=2" property="og:image">
        <meta content="630" property="og:image:height"><meta property="og:image:width" content="1200">
        <meta name="twitter:image" content="http://images.example.com/unsafe.jpg">
        <meta property="og:image" content="javascript:alert(1)">
        </head><body><script><meta property="og:image" content="https://evil.test/x.jpg"></script></body></html>'''
        candidates = pipeline.extract_social_images(markup)
        self.assertEqual(candidates, [{'url': 'https://images.example.com/lead.jpg?a=1&b=2',
                                       'width': 1200, 'height': 630, 'kind': 'social'}])

    def test_intrinsic_dimensions_for_jpeg_png_gif_webp_and_truncation(self):
        png = (b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 13) + b'IHDR' +
               struct.pack('>II', 960, 540) + b'\x08\x02\x00\x00\x00' + b'\x00\x00\x00\x00' +
               struct.pack('>I', 0) + b'IEND' + b'\x00\x00\x00\x00')
        gif = b'GIF89a' + struct.pack('<HH', 960, 540) + b'\x00\x00\x00;'
        jpeg = (b'\xff\xd8\xff\xc0\x00\x11\x08' + struct.pack('>HH', 540, 960) +
                b'\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00\xff\xd9')
        webp_payload = b'VP8X' + struct.pack('<I', 10) + b'\x00\x00\x00\x00' + (959).to_bytes(3, 'little') + (539).to_bytes(3, 'little')
        webp = b'RIFF' + struct.pack('<I', len(webp_payload) + 4) + b'WEBP' + webp_payload
        for payload in (jpeg, png, gif, webp):
            self.assertEqual(pipeline.image_dimensions(payload), (960, 540))
            with self.assertRaises(ValueError):
                pipeline.image_dimensions(payload[:-1])

    def test_publication_floor_boundaries(self):
        self.assertFalse(pipeline.meets_image_floor(959, 540))
        self.assertFalse(pipeline.meets_image_floor(960, 539))
        self.assertTrue(pipeline.meets_image_floor(960, 540))

    def test_image_urls_are_https_credential_free_and_use_normal_ports(self):
        accepted = 'https://images.example.com/photo.jpg?x=1&amp;y=2'
        self.assertEqual(pipeline.safe_image_url(accepted), 'https://images.example.com/photo.jpg?x=1&y=2')
        for unsafe in ('http://example.com/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,x',
                       'file:///tmp/a.jpg', 'https://user:pass@example.com/a.jpg',
                       'https://example.com:8443/a.jpg', '//example.com/a.jpg', 'not a url'):
            self.assertEqual(pipeline.safe_image_url(unsafe), '', unsafe)

    def test_network_destination_validation_rejects_private_dns_answers(self):
        public_answer = [(2, 1, 6, '', ('93.184.216.34', 443))]
        private_answer = [(2, 1, 6, '', ('127.0.0.1', 443))]
        with patch('news_pipeline.socket.getaddrinfo', return_value=public_answer):
            self.assertEqual(pipeline._validated_public_url('https://example.com/a'), 'https://example.com/a')
        with patch('news_pipeline.socket.getaddrinfo', return_value=private_answer):
            with self.assertRaisesRegex(ValueError, 'private or non-global'):
                pipeline._validated_public_url('https://example.com/a')

    def test_economics_sources_exist_and_dedicated_category_is_stable(self):
        economics = [source for source in pipeline.SOURCES if source.category == 'Economics']
        self.assertGreaterEqual(len(economics), 3)
        self.assertIn('https://feeds.bbci.co.uk/news/business/rss.xml', {source.url for source in economics})
        self.assertIn('https://www.theguardian.com/business/economics/rss', {source.url for source in economics})
        self.assertIn('https://www.theguardian.com/business/rss', {source.url for source in economics})
        category, _, labels = pipeline.categorize('AI firms influence central bank policy', '', economics[0])
        self.assertEqual(category, 'Economics')
        self.assertIn('Economics', labels)

    def test_feed_normalization_is_timezone_safe_and_tagged(self):
        source = pipeline.Source('BBC News', 'https://example.com/feed', 'Politics', 'World', 3)
        story = pipeline.parse_feed(RSS, source)[0]
        self.assertEqual(story['published'], '2026-08-15T12:00:00Z')
        self.assertEqual(story['url'], 'https://example.com/story')
        self.assertEqual(story['category'], 'Tech')
        self.assertIn(story['region'], ('UK', 'Canada'))
        self.assertNotIn('<', story['summary'])
        self.assertNotIn('alert', story['summary'])

    def test_reading_time_and_short_content_are_derived_from_available_text(self):
        self.assertEqual(pipeline.reading_metrics('word ' * 1), (1, 1, True))
        self.assertEqual(pipeline.reading_metrics('word ' * 440), (440, 2, False))
        self.assertEqual(pipeline.reading_metrics('word ' * 441), (441, 3, False))

    def test_editorial_requires_editorial_source_and_extracted_long_body(self):
        base = self.verified_story('essay', 'Editorial', source='Essay Journal')
        base.update(sourceType='editorial', summary='A feed excerpt.', region='Africa')
        self.assertIsNone(pipeline.qualify_editorial(dict(base), 'word ' * 899))
        qualified = pipeline.qualify_editorial(dict(base), 'word ' * 900)
        self.assertEqual((qualified['wordCount'], qualified['readingMinutes']), (900, 5))
        self.assertEqual(qualified['contentStatus'], 'Freely readable article text extracted from publisher page')
        ordinary = dict(base, sourceType='news')
        self.assertIsNone(pipeline.qualify_editorial(ordinary, 'word ' * 1200))

    def test_dedupe_collapses_same_event_and_keeps_newer(self):
        base = {'summary': 'x', 'sourceWeight': 3, 'source': 'A', 'category': 'Politics', 'region': 'UK', 'labels': []}
        old = dict(base, id='1', title='Prime minister announces major new housing plan', url='https://a.test/1', published='2026-08-15T10:00:00Z')
        new = dict(base, id='2', title='Major new housing plan announced by prime minister', url='https://b.test/2', published='2026-08-15T11:00:00Z')
        self.assertEqual([x['id'] for x in pipeline.dedupe([old, new])], ['2'])

    def test_ranking_favors_recency_and_relevance(self):
        now = datetime(2026, 8, 15, 12, tzinfo=timezone.utc)
        basic = {'summary': 'A useful summary ' * 10, 'source': 'A', 'category': 'Politics', 'labels': [], 'url': 'https://x.test'}
        relevant = dict(basic, id='r', title='Relevant', published='2026-08-15T11:00:00Z', sourceWeight=5, region='UK')
        stale = dict(basic, id='s', title='Stale', published='2026-08-10T11:00:00Z', sourceWeight=1, region='World')
        self.assertEqual(pipeline.rank([stale, relevant], now)[0]['id'], 'r')

    def test_category_rules_cover_requested_sports(self):
        source = pipeline.Source('BBC News', 'https://example.com', 'Politics', 'World')
        category, region, labels = pipeline.categorize('Saracens rugby prepare for England fixture', '', source)
        self.assertEqual(category, 'Sports')
        self.assertEqual(region, 'UK')
        self.assertIn('Rugby', labels)
        category, region, labels = pipeline.categorize('Toronto Blue Jays baseball update', '', source)
        self.assertEqual((category, region), ('Sports', 'Canada'))
        self.assertIn('Baseball', labels)
        category, region, labels = pipeline.categorize('Toronto Maple Leafs prepare for season', '', source)
        self.assertEqual((category, region), ('Sports', 'Canada'))
        self.assertIn('Maple Leafs', labels)

    def test_england_region_word_does_not_turn_non_sport_into_sport(self):
        source = pipeline.Source('Test', 'https://example.com', 'Politics', 'UK')
        category, _, _ = pipeline.categorize('Hospitals in England publish safety data', '', source)
        self.assertEqual(category, 'Politics')

    def test_dedicated_politics_feed_is_not_reclassified_by_tech_reference(self):
        source = pipeline.Source('The Guardian China', 'https://example.com', 'Politics', 'China')
        category, region, _ = pipeline.categorize('China publishes AI policy', '', source)
        self.assertEqual((category, region), ('Politics', 'China'))

    def test_explicit_source_filter_and_focus_label(self):
        source = pipeline.Source('Leafs', 'https://example.com', 'Sports', 'Canada', 5, ('maple leafs',), 'Maple Leafs')
        payload = RSS.replace(b'UK &amp; Canada discuss technology partnership', b'Unrelated hockey report')
        self.assertEqual(pipeline.parse_feed(payload, source), [])
        payload = RSS.replace(b'UK &amp; Canada discuss technology partnership', b'Maple Leafs publish roster update')
        story = pipeline.parse_feed(payload, source)[0]
        self.assertEqual(story['focus'], 'Maple Leafs')
        self.assertIn('Maple Leafs', story['labels'])

    def test_top_is_exactly_seven_image_bearing_sport_free_and_diverse(self):
        stories = []
        categories = ('Politics', 'Tech', 'Economics', 'Sports')
        for i in range(16):
            stories.append({'id': str(i), 'title': f'Unique story number {i}', 'summary': 'x', 'url': f'https://e.test/{i}',
                'published': f'2026-08-15T{12-i:02d}:00:00Z', 'sourceWeight': 3, 'source': f'Source {i % 5}',
                'category': categories[i % 4], 'region': 'World', 'labels': [],
                'imageUrl': f'https://images.e.test/{i}.jpg', 'imageWidth': 1200, 'imageHeight': 675})
        top = pipeline.select_top(stories)
        self.assertEqual(len(top), 7)
        self.assertTrue(all(story['imageUrl'].startswith('https://') for story in top))
        self.assertNotIn('Sports', {story['category'] for story in top})
        self.assertTrue({'Politics', 'Tech', 'Economics'} <= {story['category'] for story in top})
        self.assertLessEqual(max(sum(s['source'] == name for s in top) for name in {s['source'] for s in top}), 2)
        self.assertLessEqual(max((sum(s.get('focus') == focus for s in top)
                                  for focus in {s.get('focus') for s in top if s.get('focus')}), default=0), 1)

    def test_top_cap_uses_normalized_publisher_not_feed_name(self):
        categories = ['Politics', 'Tech', 'Economics', 'Politics', 'Tech', 'Economics', 'Politics', 'Tech', 'Economics', 'Politics', 'Tech']
        stories = [self.verified_story(str(i), category, source=(f'The Guardian Feed {i}' if i < 6 else f'Independent {i}'))
                   for i, category in enumerate(categories)]
        for story in stories:
            story['publisher'] = 'The Guardian' if story['source'].startswith('The Guardian') else story['source']
        top = pipeline.select_top(stories)
        self.assertEqual(len(top), 7)
        self.assertLessEqual(sum(story['publisher'] == 'The Guardian' for story in top), 2)

    def test_section_selection_is_diverse_and_degrades_when_alternatives_fail(self):
        stories = []
        for i in range(10):
            story = self.verified_story(str(i), 'Tech', source='Dominant feed' if i < 6 else f'Alternative {i}')
            story['publisher'] = 'Dominant' if i < 6 else story['source']
            stories.append(story)
        selected = pipeline.select_section(stories, 6)
        self.assertLessEqual(sum(story['publisher'] == 'Dominant' for story in selected), 2)
        self.assertEqual(len({story['publisher'] for story in selected}), 5)
        self.assertEqual(len(pipeline.select_section(stories[:4], 6)), 4)

    def test_short_stories_are_excluded_from_default_view_until_needed(self):
        stories = []
        for i in range(5):
            story = self.verified_story(str(i), 'Politics')
            story.update(publisher=f'Publisher {i}', isShort=i < 2, wordCount=40 if i < 2 else 300)
            stories.append(story)
        selected = pipeline.select_section(stories, 3)
        self.assertEqual([story['id'] for story in selected], ['2', '3', '4'])
        self.assertEqual(len(pipeline.select_section(stories[:2], 3)), 2)

    def test_selection_skips_low_resolution_ranked_candidate(self):
        categories = ['Politics', 'Tech', 'Economics', 'Politics', 'Tech', 'Economics', 'Politics', 'Tech']
        stories = [self.verified_story(str(i), category) for i, category in enumerate(categories)]
        stories[0]['imageWidth'] = 959
        top = pipeline.select_top(stories)
        self.assertEqual(len(top), 7)
        self.assertNotIn('0', {story['id'] for story in top})
        self.assertIn('7', {story['id'] for story in top})
        self.assertEqual({story['category'] for story in top}, {'Politics', 'Tech', 'Economics'})
        self.assertNotIn('Sports', {story['category'] for story in top})

    def test_fallback_rejects_unverified_and_low_resolution_top_stories(self):
        previous = {'topStoryIds': ['good', 'low', 'unknown'], 'stories': [
            self.verified_story('good', 'Politics'), self.verified_story('low', 'Tech', width=959),
            {key: value for key, value in self.verified_story('unknown', 'Economics').items()
             if key not in ('imageWidth', 'imageHeight')} ]}
        self.assertEqual([story['id'] for story in pipeline.valid_fallback_stories(previous)], ['good'])

    def test_fallback_image_is_reprobed_and_cannot_retain_stale_dimensions(self):
        story = self.verified_story('previous', 'Politics', width=2000, height=1000)
        malformed_fetch = lambda _url: (b'not an image', 'image/jpeg', 200)
        qualified = pipeline.enrich_verified([story], article_fetch=lambda _url: b'<html></html>',
                                             image_fetch=malformed_fetch, max_stories=1)
        self.assertEqual(qualified, [])
        self.assertNotIn('imageWidth', story)
        self.assertNotIn('imageHeight', story)

    def test_top_fails_honestly_when_safe_image_pool_is_short(self):
        stories = []
        for i in range(10):
            stories.append({'id': str(i), 'title': str(i), 'source': f'S{i}',
                            'category': 'Sports' if i == 8 else 'Politics',
                            'imageUrl': f'https://images.test/{i}.jpg' if i < 6 or i == 8 else ''})
        with self.assertRaisesRegex(ValueError, 'image-bearing non-Sports'):
            pipeline.select_top(stories)

    def test_output_retains_explicit_coverage_ahead_of_ranked_fill(self):
        def story(identifier, category='Politics', region='World', focus='', labels=None):
            return {'id': identifier, 'title': identifier, 'summary': 'x', 'url': f'https://e.test/{identifier}',
                    'published': '2026-08-15T12:00:00Z', 'sourceWeight': 3, 'source': identifier,
                    'category': category, 'region': region, 'labels': labels or [], 'focus': focus}
        top = [story(f'top-{i}', ('Politics', 'Tech', 'Sports')[i % 3]) for i in range(7)]
        required = [story(f'politics-{region}', region=region) for region in ('UK', 'Canada', 'US', 'China')]
        required += [story(focus, 'Sports', 'Canada', focus) for focus in ('Saracens', 'Blue Jays', 'Maple Leafs')]
        required += [story('england', 'Sports', 'UK', labels=['England Rugby'])]
        filler = [story(f'filler-{i}') for i in range(25)]
        output = pipeline.order_for_output(top, filler + required, limit=15)
        self.assertEqual(len(output), 15)
        self.assertTrue(all(item in output for item in required))

    def test_checked_in_fallback_shape(self):
        data_path = Path(__file__).parents[1] / 'data' / 'news.json'
        if not data_path.exists():
            self.skipTest('snapshot generated after first live refresh')
        data = json.loads(data_path.read_text(encoding='utf-8'))
        self.assertEqual(data['schemaVersion'], 2)
        self.assertEqual(len(data['topStoryIds']), 7)
        self.assertTrue(all(set(('id', 'title', 'summary', 'url', 'published', 'category', 'source')) <= set(s) for s in data['stories']))
        by_id = {story['id']: story for story in data['stories']}
        top = [by_id[identifier] for identifier in data['topStoryIds']]
        self.assertTrue(all(story['category'] != 'Sports' for story in top))
        self.assertTrue(all(pipeline.safe_image_url(story.get('imageUrl', '')) == story.get('imageUrl') for story in top))
        self.assertTrue(all(pipeline.meets_image_floor(story.get('imageWidth'), story.get('imageHeight')) for story in top))

    def test_checked_in_fallback_has_diverse_substantial_editorial_and_length_metadata(self):
        data = json.loads((Path(__file__).parents[1] / 'data' / 'news.json').read_text(encoding='utf-8'))
        self.assertIn('Editorial', data['sectionStoryIds'])
        by_id = {story['id']: story for story in data['stories']}
        editorial = [by_id[identifier] for identifier in data['sectionStoryIds']['Editorial']]
        self.assertGreaterEqual(len(editorial), 4)
        self.assertGreaterEqual(len({story['publisher'] for story in editorial}), 3)
        self.assertTrue(all(story['category'] == 'Editorial' and story['wordCount'] >= 900 and
                            story['readingMinutes'] >= 5 and story.get('body') for story in editorial))
        self.assertTrue(all('readingMinutes' in story and 'wordCount' in story for story in data['stories']))

    def test_editorial_fallback_reuses_only_previously_qualified_safe_long_reads(self):
        good = self.verified_story('good-editorial', 'Editorial', source='Essay source')
        good.update(sourceType='editorial', publisher='Essay source', body='word ' * 900,
                    wordCount=900, readingMinutes=5, isShort=False)
        short = dict(good, id='short-editorial', body='word ' * 899, wordCount=899)
        unsafe = dict(good, id='unsafe-editorial', url='javascript:alert(1)')
        previous = {'sectionStoryIds': {'Editorial': [good['id'], short['id'], unsafe['id']]},
                    'stories': [good, short, unsafe]}
        self.assertEqual([story['id'] for story in pipeline.valid_fallback_editorials(previous)], ['good-editorial'])

    def test_no_js_snapshot_has_seven_safe_story_images(self):
        snapshot = (Path(__file__).parents[1] / 'snapshot.html').read_text(encoding='utf-8')
        parser = ImageCollector()
        parser.feed(snapshot)
        self.assertEqual(len(parser.images), 7)
        for image in parser.images:
            self.assertEqual(pipeline.safe_image_url(image['src']), image['src'])
            self.assertEqual(image.get('referrerpolicy'), 'no-referrer')
            self.assertGreaterEqual(int(image['width']), 960)
            self.assertGreaterEqual(int(image['height']), 540)

if __name__ == '__main__':
    unittest.main()
