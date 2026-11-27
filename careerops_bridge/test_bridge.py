"""Offline deployment gate: no live requests, credentials or provider spending."""
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import bridge_adapters as adapters
import server

FEED = adapters.APPROVED_FEEDS[0]
URL = "https://jobs.ashbyhq.com/Abound/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

def row(title="Graduate Software Engineer 2027", location="London, UK", url=URL):
    return {"title":title,"location":location,"jobUrl":url,"descriptionPlain":"Full time September 2027 graduate start."}

def envelope(rows):
    return {"jobs":rows}

class AdaptersTests(unittest.TestCase):
    def test_board_url_and_region_filters(self):
        data = envelope([row(), row("Software Engineer Intern 2027"),row(location="Singapore"),row(url="https://jobs.ashbyhq.com/unreviewed/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),row(location="London, UK / India"),row(url=URL+"?utm_source=example")])
        results = adapters.parse_feed(data,*FEED)
        self.assertEqual(len(results),1)
        self.assertEqual(results[0]["url"],URL)

    def test_bad_feed_and_unsafe_urls(self):
        with self.assertRaises(ValueError):
            adapters.parse_feed({},*FEED)
        with self.assertRaises(ValueError):
            adapters.parse_feed(envelope([row()]),"Other",*FEED[1:])
        for url in ("http://127.0.0.1","https://jobs.ashbyhq.com.evil.example/Abound/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","https://user@jobs.ashbyhq.com/Abound/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"):
            self.assertIsNone(adapters.posting_url(url,"ASHBY","Abound"))

    def test_grad_and_india_hints(self):
        self.assertTrue(adapters.eligible_hint("Junior Backend Engineer","Bengaluru, India"))
        self.assertFalse(adapters.eligible_hint("Backend Engineer","London, UK"))
        self.assertFalse(adapters.eligible_hint("Senior Software Engineer 2027","Toronto, Canada","graduate"))
        self.assertFalse(adapters.eligible_hint("AI Engineer Internship 2027","Toronto, Canada","graduate"))
        self.assertTrue(adapters.eligible_hint("Graduate Data Engineer","Paris, France","September 2027 start"))
    
    def test_agent_reach_requires_matching_origin(self):
        declared = {"channels":[{"name":"web","actions":[{"name":"read","backends":["jina"]}]}]}
        returned = {"ok":True,"items":[{"url":URL,"text":"Graduate Software Engineer 2027. London, UK. Apply for the advertised full-time role."}]}
        def runner(args,**kwargs):
            payload=declared if args[1]=="channels" else returned
            return SimpleNamespace(returncode=0,stdout=json.dumps(payload))
        result=adapters.agent_read_verified(URL,"Graduate Software Engineer 2027",runner=runner)
        self.assertEqual(result["status"],"OK")
        returned["items"][0]["url"]="https://example.com/unrelated"
        self.assertNotEqual(adapters.agent_read_verified(URL,"Graduate Software Engineer 2027",runner=runner)["status"],"OK")

    def test_model_grounding(self):
        self.assertTrue(adapters.model_fields_grounded("Graduate Software Engineer 2027","London, UK",URL,URL,"Graduate Software Engineer 2027 London, UK",[]))
        self.assertFalse(adapters.model_fields_grounded("Invented job","London, UK",URL,URL,"Graduate Software Engineer 2027 London, UK",[]))

    def test_scrapling_real_parser_fixture(self):
        company,url=server.PAGES[0]
        data={"@type":"JobPosting","title":"AI Engineer Intern","url":url,"jobLocation":{"address":{"addressLocality":"Bengaluru","addressCountry":"India"}},"description":"Entry level engineering internship"}
        html='<html><head><script type="application/ld+json">'+json.dumps(data)+'</script></head><body>AI Engineer Intern Bengaluru, India</body></html>'
        items=server.parse_jobposting(html,url,company)
        self.assertEqual(len(items),1)
        self.assertEqual(items[0]["extraction"],"scrapling:jsonld")
        self.assertTrue(server.eligible_hint(items[0]))
        self.assertIn("Bengaluru",server.visible_text(html,url))

class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.db=patch.object(server,"DB_PATH",Path(self.temp.name)/"test.sqlite")
        self.db.start()
        server.init_db()
    def tearDown(self):
        self.db.stop()
        self.temp.cleanup()
    def test_feed_to_detail_hold_only(self):
        first=FEED[3]
        html="<html><body>Graduate Software Engineer 2027 London, UK Full time September 2027 graduate start.</body></html>"
        def fake_json(url):
            return envelope([row()]) if url==first else envelope([])
        with patch.object(server,"get_json",side_effect=fake_json),patch.object(server,"get_html",return_value=html),patch.object(server,"ollama_ready",return_value=False):
            a=server.collect(2)
            self.assertEqual(len(a["scans"]),2)
            self.assertEqual(len(a["items"]),1)
            self.assertEqual(a["items"][0]["status"],"HOLD")
            self.assertEqual(a["items"][0]["extraction"],"official-ats:ashby")
            b=server.collect(2)
            self.assertEqual(len(b["scans"]),2)
            detail=next(x for x in b["items"] if x["url"]==URL)
            self.assertEqual(detail["source_url"],URL)
            self.assertEqual(detail["extraction"],"scrapling:origin_visible_text")
            self.assertEqual(detail["status"],"HOLD")
            self.assertEqual(sum(x["new"] for x in b["scans"]),0)

    def test_blocked_origin_never_switches_provider(self):
        with patch.object(server,"get_html",side_effect=PermissionError("ROBOTS_DISALLOWED")),patch.object(server,"scrapegraph_fallback") as model:
            company,url=server.PAGES[0]
            code,items=server.safe_scan((company,"HTML","",url))
            self.assertEqual((code,items),("BLOCKED",[]))
            model.assert_not_called()
    
    def test_bound_and_status(self):
        for invalid in (0,3,True,2.0):
            with self.assertRaises(ValueError):
                server.collect(invalid)
        rows=[row(url="https://jobs.ashbyhq.com/Abound/aaaaaaaa-bbbb-cccc-dddd-"+str(i).zfill(12)) for i in range(8)]
        with patch.object(server,"get_json",side_effect=lambda url:envelope(rows) if url==FEED[3] else envelope([])):
            result=server.collect(2)
        self.assertLessEqual(len(result["items"]),3)
        self.assertTrue(all(i["status"]=="HOLD" for i in result["items"]))
        self.assertEqual(result["state"]["sources"],len(adapters.APPROVED_FEEDS)+len(server.PAGES))

if __name__ == "__main__":
    unittest.main()
