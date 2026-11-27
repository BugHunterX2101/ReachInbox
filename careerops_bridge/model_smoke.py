"""Actual local inference build gate. Synthetic evidence, never a live discovery."""
import json
import os
import subprocess
import sys

fixtures=(
    {"text":"JobPosting title: Backend Engineer\nJobPosting location: Dublin\nDepartment: Engineering","expected_title":"Backend Engineer","expected_location":"Dublin"},
    {"text":"Department: Technology\nJobPosting location: Toronto\nJobPosting title: Graduate Developer","expected_title":"Graduate Developer","expected_location":"Toronto"},
)
env={k:v for k,v in os.environ.items() if k in {"PATH","HOME","LANG","LC_ALL","OLLAMA_BASE_URL","OLLAMA_MODEL","OLLAMA_HOST"}}
for i,fixture in enumerate(fixtures,1):
    child=subprocess.run([sys.executable,"/app/model_probe.py"],input=json.dumps(fixture),text=True,capture_output=True,env=env,timeout=110)
    try: proof=json.loads(child.stdout.strip().splitlines()[-1])
    except (ValueError,IndexError): proof={"status":"INVALID_OUTPUT"}
    passed=child.returncode==0 and proof.get("status")=="PASSED" and proof.get("verified_title") is True and proof.get("verified_location") is True
    print(json.dumps({"event":"synthetic_model_smoke","case":i,"passed":passed,"status":proof.get("status"),"code":proof.get("code") or proof.get("error_type"),"verified_title":proof.get("verified_title",False),"verified_location":proof.get("verified_location",False)}),flush=True)
    if not passed: raise SystemExit(1)
print("LOCAL_MODEL_SMOKE_PASSED_2_OF_2",flush=True)
