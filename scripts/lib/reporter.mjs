/**
 * ONE owner of the E2E results reporter: PASS/FAIL lines, summary, exit code.
 * Consumers: cloudHarness.mjs (re-exports), e2e-oauth.mjs, future harnesses.
 */
const results = [];

function pass(name, detail = "") {
  results.push({ ok: true, name });
  console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
}
function fail(name, detail = "") {
  results.push({ ok: false, name });
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
}
export function assert(cond, name, detail = "") {
  (cond ? pass : fail)(name, detail);
  return Boolean(cond);
}
export function summary(label = "E2E") {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n==== ${label} SUMMARY: ${results.length - failed.length}/${results.length} checks passed ====`);
  if (failed.length) {
    console.log("Failed checks:");
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exitCode = 1;
  }
}
