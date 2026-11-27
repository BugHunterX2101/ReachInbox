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
        inventory=(FEED,adapters.APPROVED_FEEDS[6],adapters.APPROVED_FEEDS[2])
        html="<html><body>Graduate Software Engineer 2027 London, UK Full time September 2027 graduate start.</body></html>"
        def fake_json(url):
            return envelope([row()]) if url==first else envelope([])
        with patch.object(server,"SOURCE_INVENTORY",inventory),patch.object(server,"get_json",side_effect=fake_json),patch.object(server,"get_html",return_value=html),patch.object(server,"ollama_ready",return_value=False):
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
        with patch.object(server,"SOURCE_INVENTORY",(FEED,adapters.APPROVED_FEEDS[6])),patch.object(server,"get_json",side_effect=lambda url:envelope(rows) if url==FEED[3] else envelope([])):
            result=server.collect(2)
        self.assertEqual(len(result["items"]),3)
        self.assertTrue(all(i["status"]=="HOLD" for i in result["items"]))
        self.assertEqual(result["state"]["sources"],2)


class AccessPolicyTests(unittest.TestCase):
    def test_missing_robots_only_for_documented_api(self):
        from urllib.error import HTTPError
        with patch.object(server,"_get_public",side_effect=HTTPError("https://example.com/robots.txt",404,"not found",None,None)):
            server.robots_check(FEED[3])
            with self.assertRaisesRegex(PermissionError,"ROBOTS_HTTP_404"):
                server.robots_check(server.DIAGNOSTIC_ORIGIN[1])

    def test_access_denial_rate_limit_and_server_error_fail_closed(self):
        from urllib.error import HTTPError
        for code in (401,403,429,500,503):
            with patch.object(server,"_get_public",side_effect=HTTPError("https://example.com/robots.txt",code,"error",None,None)):
                with self.assertRaisesRegex(PermissionError,"ROBOTS_HTTP_"+str(code)):
                    server.robots_check(FEED[3])

    def test_explicit_robots_disallow_preserved(self):
        with patch.object(server,"_get_public",return_value=(b"User-agent: *\nDisallow: /posting-api/\n","text/plain")):
            with self.assertRaisesRegex(PermissionError,"ROBOTS_DISALLOWED"):
                server.robots_check(FEED[3])

    def test_robot_challenge_not_permission(self):
        with patch.object(server,"_get_public",return_value=(b"<html>Access denied</html>","text/html")):
            with self.assertRaisesRegex(PermissionError,"ROBOTS_CONTENT_TYPE"):
                server.robots_check(FEED[3])

    def test_probe_target_is_diagnostic_only_and_origin_grounded(self):
        company,url,expected=server.DIAGNOSTIC_ORIGIN
        self.assertNotIn(url,[s[3] for s in server.SOURCE_INVENTORY])
        html="<html><body><h1>"+expected["title"]+"</h1><p>"+expected["location"]+"</p></body></html>"
        jobs=server.detail_evidence(html,url,company,expected)
        self.assertEqual(len(jobs),1)
        self.assertEqual(jobs[0]["extraction"],"scrapling:origin_visible_text")
        self.assertFalse(server.detail_evidence("<html><body>No vacancy</body></html>",url,company,expected))

    def test_local_model_configuration_fails_closed(self):
        with patch.dict(os.environ,{"ENABLE_LOCAL_SCRAPEGRAPHAI":"false"}):
            self.assertEqual(server.ollama_status(),"LOCAL_MODEL_FLAG_OFF")
        with patch.dict(os.environ,{"ENABLE_LOCAL_SCRAPEGRAPHAI":"true","OLLAMA_BASE_URL":"https://external.example","OLLAMA_MODEL":"model"}):
            self.assertEqual(server.ollama_status(),"LOCAL_MODEL_CONFIG_INVALID")


class SourceRotationTests(unittest.TestCase):
    def test_distinct_hosts(self):
        work,cursor=server.choose_work(server.SOURCE_INVENTORY,0,[],set(),2)
        from urllib.parse import urlsplit
        self.assertEqual(len(work),2)
        self.assertNotEqual(urlsplit(work[0][0][3]).hostname,urlsplit(work[1][0][3]).hostname)

    def test_skip_blocked_sources(self):
        blocked={s[3] for s in server.SOURCE_INVENTORY[:4]}
        work,cursor=server.choose_work(server.SOURCE_INVENTORY,0,[],blocked,2)
        self.assertTrue(all(s[3] not in blocked for s,_ in work))

    def test_all_blocked_no_attempt(self):
        blocked={s[3] for s in server.SOURCE_INVENTORY}
        self.assertEqual(server.choose_work(server.SOURCE_INVENTORY,0,[],blocked,2)[0],[])

    def test_timeout_stage(self):
        with patch.object(server.OPENER,"open",side_effect=TimeoutError()):
            with self.assertRaisesRegex(TimeoutError,"ROBOTS_CONNECT_TIMEOUT"):
                server._get_public("https://example.com/robots.txt","text/plain")
            with self.assertRaisesRegex(TimeoutError,"ORIGIN_CONNECT_TIMEOUT"):
                server._get_public("https://example.com/jobs","text/html")

    def test_cooldown_persisted(self):
        with tempfile.TemporaryDirectory() as d,patch.object(server,"DB_PATH",Path(d)/"test.sqlite"):
            server.init_db()
            with patch.object(server,"safe_scan",return_value=("BLOCKED",[])):
                first=server.collect(2)
                second=server.collect(2)
            self.assertTrue({s["source"] for s in first["scans"]}.isdisjoint({s["source"] for s in second["scans"]}))

class ModelEvidenceTests(unittest.TestCase):
    def test_visible_diagnostic_pair_can_differ_from_jsonld_location(self):
        company,url,expected=server.DIAGNOSTIC_ORIGIN
        html="<html><body><nav>India France Canada</nav><main><h1>Tech Intern</h1><p>India - Remote</p></main></body></html>"
        job={"title":"Tech Intern","location":"Remote, India"}
        data=server.build_model_evidence(html,url,job,expected,True)
        self.assertEqual(data["expected_location"],"India - Remote")
        self.assertIn("Tech Intern India - Remote",data["text"])

    def test_never_invents_missing_visible_fields(self):
        company,url,expected=server.DIAGNOSTIC_ORIGIN
        with self.assertRaisesRegex(ValueError,"ORIGIN_VISIBLE_EVIDENCE_MISSING"):
            server.build_model_evidence("<html><body>Careers</body></html>",url,{"title":"Tech Intern","location":"Remote, India"},expected,True)

    def test_production_model_requires_actual_job_fields(self):
        company,url,expected=server.DIAGNOSTIC_ORIGIN
        html="<html><body>Tech Intern India - Remote</body></html>"
        with self.assertRaisesRegex(ValueError,"ORIGIN_VISIBLE_EVIDENCE_MISSING"):
            server.build_model_evidence(html,url,{"title":"Other Role","location":"London"},expected,False)

class StructuredModelEvidenceTests(unittest.TestCase):
    def test_real_structured_fields_for_diagnostic_only(self):
        company,url,expected=server.DIAGNOSTIC_ORIGIN
        source={"@type":"JobPosting","url":url,"title":"Tech Intern","jobLocation":{"address":{"addressCountry":"India"}},"description":"A published vacancy"}
        html='<html><head><script type="application/ld+json">'+json.dumps(source)+'</script></head><body>Careers</body></html>'
        job={"title":"Tech Intern","location":"India"}
        data=server.build_model_evidence(html,url,job,expected,True)
        self.assertEqual(data["source_kind"],"jsonld_projection")
        self.assertEqual(data["expected_title"],"Tech Intern")
        self.assertEqual(data["expected_location"],"India")
        with self.assertRaisesRegex(ValueError,"ORIGIN_VISIBLE_EVIDENCE_MISSING"):
            server.build_model_evidence(html,url,job,expected,False)

    def test_remote_country_from_explicit_applicant_location(self):
        company,url,expected=server.DIAGNOSTIC_ORIGIN
        source={"@type":"JobPosting","url":url,"title":"Tech Intern","jobLocationType":"TELECOMMUTE","applicantLocationRequirements":{"@type":"Country","name":"India"}}
        html='<script type="application/ld+json">'+json.dumps(source)+'</script>'
        data=server.structured_model_evidence(html,url,{"title":"Tech Intern"})
        self.assertEqual(data["expected_location"],"India")
        del source["applicantLocationRequirements"]
        html='<script type="application/ld+json">'+json.dumps(source)+'</script>'
        self.assertIsNone(server.structured_model_evidence(html,url,{"title":"Tech Intern"}))

    def test_reject_unrelated_posting(self):
        company,url,expected=server.DIAGNOSTIC_ORIGIN
        source={"@type":"JobPosting","url":"https://www.ubisar.com/unrelated","title":"Tech Intern","jobLocation":"India"}
        html='<script type="application/ld+json">'+json.dumps(source)+'</script>'
        self.assertIsNone(server.structured_model_evidence(html,url,{"title":"Tech Intern"}))

if __name__ == "__main__":
    unittest.main()
