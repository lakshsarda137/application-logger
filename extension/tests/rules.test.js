// README §4.2 rules 1–3.
import assert from "node:assert/strict";
import { test } from "node:test";

import { CAPTURE_FILES, loadScripts, makePage } from "./helpers.js";

const AL = loadScripts(makePage("<body></body>").window, CAPTURE_FILES);

test("rule 1: known ATS hosts, including subdomains", () => {
  const yes = [
    ["acme.wd5.myworkdayjobs.com", "/External/job/x"],
    ["boards.greenhouse.io", "/acme/jobs/1"],
    ["job-boards.greenhouse.io", "/acme"],
    ["jobs.lever.co", "/acme/1"],
    ["jobs.ashbyhq.com", "/acme"],
    ["careers-acme.icims.com", "/jobs/1"],
    ["acme.fa.us2.oraclecloud.com", "/hcmUI/"],
    ["www.linkedin.com", "/jobs/view/123"],
    ["www.linkedin.com", "/jobs"],
    ["www.indeed.com", "/viewjob"],
    ["app.joinhandshake.com", "/jobs/1"],
    ["BOARDS.GREENHOUSE.IO.", "/"],
  ];
  const no = [
    ["www.linkedin.com", "/feed/"],
    ["www.linkedin.com", "/jobsearch-blog"],
    ["notgreenhouse.io", "/"],
    ["greenhouse.io.evil.com", "/"],
    ["acme.com", "/careers"],
  ];
  for (const [h, p] of yes) assert.equal(AL.isAtsPage(h, p), true, `${h}${p}`);
  for (const [h, p] of no) assert.equal(AL.isAtsPage(h, p), false, `${h}${p}`);
});

test("rule 2: needs a phrase from every group", () => {
  const posting = "About the role. Minimum qualifications: 2 years. Requirements: Python.";
  assert.equal(AL.matchesPostingKeywords(posting), true);
  assert.equal(AL.matchesPostingKeywords("Our requirements for the new build"), false);
  assert.equal(AL.matchesPostingKeywords("Skills and requirements"), false, "no role group");
  assert.equal(
    AL.matchesPostingKeywords("WHAT YOU’LL DO\nship things\nWhat you’ll need: grit\nNice to have: Go"),
    true,
    "curly apostrophes and case",
  );
  assert.equal(AL.matchesPostingKeywords("what   you'll\n do; you bring; bonus points"), true, "flexible whitespace");
});

test("rule 2: whole words only", () => {
  // "skillset", "unrequired", "therole" must not count.
  assert.equal(AL.matchesPostingKeywords("skillset unrequired therole"), false);
  assert.equal(AL.matchesPostingKeywords("skills. required. the role."), true);
});

test("rule 3: JSON-LD signal via capture.signals", () => {
  const dom = makePage(
    `<head><script type="application/ld+json">{"@type":["JobPosting"],"title":"x"}</script></head><body>hi</body>`,
    { url: "https://careers.acme.com/jobs/1" },
  );
  const al = loadScripts(dom.window, CAPTURE_FILES);
  assert.deepEqual({ ...al.capture.signals() }, { ats: false, jsonld: true, keywords: false });
});
