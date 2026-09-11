/**
 * Cloud E2E minus SMTP delivery — verifies every surface of the DEPLOYED API
 * that does not depend on reaching an SMTP server: session auth against Neon
 * sessions, CSV/attachment upload, async scheduling, queue processing,
 * PG-fallback read paths, Slack graceful path, Bull Board gate, logout.
 *
 * Use this when the SMTP path is degraded by an upstream/provider outage —
 * as of 2026-09-11, Render free instances cannot reach any Ethereal port
 * (25/465/587 platform-blocked; 2525 accepts TCP but never banners) even
 * though the same harness delivered real mail on 2026-09-09.
 *
 * Usage: E2E_CLOUD_API=… DATABASE_URL=… SESSION_SECRET=… node scripts/e2e-cloud-nosmtp.mjs
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const API = process.env.E2E_CLOUD_API;
const DATABASE_URL = process.env.DATABASE_URL, SESSION_SECRET = process.env.SESSION_SECRET;
const QUERY_HELPER = `import pg from "pg";const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();const r=await c.query(process.env.QUERY_SQL);for(const row of r.rows)console.log(Object.values(row)[0]);await c.end();`;
function psql(sql){return execFileSync("node",["--input-type=module","--eval",QUERY_HELPER],{encoding:"utf8",cwd:"packages/db-schema",timeout:60000,env:{...process.env,QUERY_SQL:sql},stdio:["ignore","pipe","ignore"]}).trim();}
const results=[];const assert=(c,n,d="")=>results.push([c,n,d])&&console.log(`  ${c?"PASS":"FAIL"}  ${n}${d?" — "+d:""}`);
async function api(p,{method="GET",cookie,body,form}={}){const h={};if(cookie)h.cookie=cookie;let payload;if(form)payload=form;else if(body!==undefined){h["content-type"]="application/json";payload=JSON.stringify(body);}const r=await fetch(`${API}${p}`,{method,headers:h,body:payload,redirect:"manual"});const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}return{status:r.status,json:j,text:t};}
// session
await api("/api/auth/google");
const userId=psql(`SELECT id FROM users WHERE google_id='e2e-cloud-user'`);
const sid=crypto.randomUUID().replace(/-/g,"").repeat(2).slice(0,32);
psql(`INSERT INTO session (sid, sess, expire) VALUES ('${sid}', '{"cookie":{"originalMaxAge":604800000},"userId":"${userId}"}', now() + interval '7 days')`);
const sig=crypto.createHmac("sha256",SESSION_SECRET).update(sid).digest("base64").replace(/=+$/,"");
const cookie=`reachinbox.sid=s%3A${sid}.${encodeURIComponent(sig)}`;
const me=await api("/api/me",{cookie});
assert(me.status===200,"authenticated /api/me (Neon session)",`status=${me.status}`);
assert((await api("/api/me")).status===401,"unauthenticated rejected");
const senders=await api("/api/emails/senders",{cookie});
assert(senders.status===200&&senders.json?.items?.length>=2,"sender dropdown (FR-14)",`${senders.json?.items?.length} senders`);
assert((await api("/admin/queues")).status===401,"Bull Board gated (FR-26)");
const slack=await api("/api/integrations/slack",{cookie});
assert(slack.status===200&&slack.json?.connected===false,"Slack unconfigured graceful (FR-22–25)");
const up=new FormData();up.append("file",new Blob(["a@example.com\nbad-at-example.com\nb@example.com"],{type:"text/csv"}),"r.csv");
const u=await api("/api/emails/upload-recipients",{method:"POST",cookie,form:up});
assert(u.status===201&&u.json?.validCount===2,"CSV upload parse (FR-30)",JSON.stringify({v:u.json?.validCount,i:u.json?.invalidCount}));
const att=new FormData();att.append("file",new Blob(["attachment "+Date.now()]),"a.txt");
const a=await api("/api/attachments",{method:"POST",cookie,form:att});
assert(a.status===201&&a.json?.storageUrl,"attachment upload (signed URL)");
const res=await api("/api/emails/schedule",{method:"POST",cookie,body:{senderId:senders.json.items[0].id,subject:"outage-probe "+Date.now(),body:"<p>probe</p>",recipients:["p1@probe.test","p2@probe.test"],startTime:new Date(Date.now()+1000).toISOString(),delayBetweenSendsMs:1000}});
assert(res.status===202&&res.json?.requestedCount===2,"schedule accepted 202 async (FR-4–6)");
await new Promise(r=>setTimeout(r,20000));
const sent=await api("/api/emails/sent?pageSize=50",{cookie});
assert(sent.status===200&&Array.isArray(sent.json?.items),"sent list (PG fallback read path)",`total=${sent.json?.total}`);
const sched=await api("/api/emails/scheduled?pageSize=50",{cookie});
assert(sched.status===200&&sched.json?.items?.length>=1,"scheduled list shows deferred rows",`items=${sched.json?.items?.length}`);
const nav=await api("/api/emails/nav-counts",{cookie});
assert(nav.status===200&&typeof nav.json?.sent==="number","nav-counts (FR-31/32)",JSON.stringify(nav.json));
const qs=await api("/api/emails/queue-stats",{cookie});
assert(qs.status===200&&qs.json?.queue,"queue-stats BullMQ counts",JSON.stringify(qs.json?.queue));
const one=(sent.json?.items??[])[0]??(sched.json?.items??[])[0];
if(one){const d=await api(`/api/emails/${one.id}`,{cookie});assert(d.status===200&&d.json?.body,"detail view returns body");}
const out=await api("/api/auth/logout",{cookie});
assert((out.status===302||out.status===200)&&((await api("/api/me",{cookie})).status===401),"logout invalidates session (FR-3)");
const p=results.filter(r=>r[0]).length;console.log(`\n==== PARTIAL CLOUD E2E: ${p}/${results.length} checks passed ====`);
if(p!==results.length)process.exitCode=1;
