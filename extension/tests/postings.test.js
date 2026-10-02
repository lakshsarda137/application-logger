import assert from "node:assert/strict";
import { test } from "node:test";

import { postingIdentity, postingUrlKey, samePosting, urlContinues } from "../lib/postings.js";

test("postingUrlKey keeps host, path and job-id parameters only", () => {
  assert.equal(postingUrlKey("https://Jobs.Lever.co/acme/123/?utm_source=x#top"), "jobs.lever.co/acme/123");
  assert.equal(
    postingUrlKey("https://www.linkedin.com/jobs/search/?keywords=swe&currentJobId=42"),
    "www.linkedin.com/jobs/search?currentjobid=42",
  );
  assert.equal(postingUrlKey("not a url"), "");
});

test("urlContinues: later steps of the same posting, not siblings", () => {
  assert.ok(urlContinues("jobs.lever.co/acme/123", "jobs.lever.co/acme/123/apply"));
  assert.ok(urlContinues("jobs.lever.co/acme/123/apply", "jobs.lever.co/acme/123"));
  assert.ok(!urlContinues("jobs.lever.co/acme/123", "jobs.lever.co/acme/1234"));
  assert.ok(!urlContinues("jobs.lever.co/acme/1", "jobs.lever.co/acme/2"));
  assert.ok(!urlContinues("careers.acme.com/jobs?gh_jid=1", "careers.acme.com/jobs?gh_jid=2"));
  assert.ok(!urlContinues("acme.com", "acme.com/jobs/1"), "a bare host isn't a posting");
  assert.ok(!urlContinues("", "acme.com/jobs/1"));
});

const id = (url, title = "", jsonld = null) => postingIdentity({ url, title, jsonld });

test("samePosting: job IDs decide when both pages have one", () => {
  const a = id("https://acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_R1", "", { title: "SWE", identifier: { value: "R1" }, hiringOrganization: { name: "Acme" } });
  const b = id("https://acme.wd5.myworkdayjobs.com/External/job/SF/SWE_R2", "", { title: "SWE", identifier: "R2", hiringOrganization: "Acme" });
  const c = id("https://globex.example.com/jobs/R1", "", { title: "SWE", identifier: "R1", hiringOrganization: "Globex" });
  assert.ok(samePosting(a, a));
  assert.ok(!samePosting(a, b), "same title, different job");
  assert.ok(!samePosting(a, c), "same ID at another company");
});

test("samePosting: the same job on the careers page and on its ATS", () => {
  const careers = id("https://careers.acme.com/jobs/swe", "", { title: "Software Engineer", hiringOrganization: "Acme" });
  const ats = id("https://boards.greenhouse.io/acme/jobs/55", "", { title: "Software Engineer", hiringOrganization: { name: "Acme" } });
  const other = id("https://boards.greenhouse.io/acme/jobs/56", "", { title: "Data Scientist", hiringOrganization: "Acme" });
  assert.ok(samePosting(careers, ats));
  assert.ok(!samePosting(ats, other));
  assert.ok(!samePosting(null, ats));
});

test("samePosting: unknown company and title count as different jobs", () => {
  assert.ok(!samePosting(id("https://a.example.com/jobs/1", "Careers"), id("https://b.example.com/jobs/1", "Careers")));
});
