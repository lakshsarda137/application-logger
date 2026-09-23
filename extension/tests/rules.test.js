// README §4.2: which pages get captured.
import assert from "node:assert/strict";
import { test } from "node:test";

import { CAPTURE_FILES, loadScripts, makePage } from "./helpers.js";

const AL = loadScripts(makePage("<body></body>").window, CAPTURE_FILES);

function signalsFor(html, url = "https://careers.acme.com/jobs/1") {
  const dom = makePage(html, { url });
  const al = loadScripts(dom.window, CAPTURE_FILES);
  return { ...al.capture.signals() };
}

test("rule 1: job-application platforms, including subdomains", () => {
  const yes = [
    ["acme.wd5.myworkdayjobs.com", "/External/job/x"],
    ["boards.greenhouse.io", "/acme/jobs/1"],
    ["job-boards.greenhouse.io", "/embed/job_app"],
    ["jobs.lever.co", "/acme/1"],
    ["jobs.ashbyhq.com", "/acme"],
    ["careers-acme.icims.com", "/jobs/1"],
    ["ats.rippling.com", "/acme/jobs/1"],
    ["acme.fa.us2.oraclecloud.com", "/hcmUI/CandidateExperience/en/sites/x/job/1"],
    ["acme.bamboohr.com", "/careers/12"],
    ["apply.workable.com", "/acme/j/1"],
    ["www.linkedin.com", "/jobs/view/123"],
    ["www.indeed.com", "/viewjob"],
    ["app.joinhandshake.com", "/stu/jobs/1"],
    ["BOARDS.GREENHOUSE.IO.", "/"],
  ];
  const no = [
    ["www.linkedin.com", "/feed/"],
    ["www.linkedin.com", "/in/me/"],
    ["www.workday.com", "/en-us/products.html"], // marketing site
    ["wd5.myworkday.com", "/acme/d/home.htmld"], // employee portal
    ["app.rippling.com", "/dashboard"], // the HR app, not the job site
    ["acme.fa.us2.oraclecloud.com", "/fscmUI/faces/FuseWelcome"], // Oracle ERP
    ["acme.bamboohr.com", "/home"],
    ["www.workable.com", "/pricing"],
    ["app.joinhandshake.com", "/stu/messages"],
    ["notgreenhouse.io", "/"],
    ["greenhouse.io.evil.com", "/"],
    ["acme.com", "/careers"],
  ];
  for (const [h, p] of yes) assert.equal(AL.isAtsPage(h, p), true, `${h}${p}`);
  for (const [h, p] of no) assert.equal(AL.isAtsPage(h, p), false, `${h}${p}`);
});

test("rule 2: posting wording alone isn't enough; it needs a way to apply", () => {
  const posting = "About the role. Minimum qualifications: 2 years. Requirements: Python.";
  assert.equal(AL.matchesPostingKeywords(posting), false, "no apply signal");
  assert.equal(AL.matchesPostingKeywords(posting, { hasApplyControl: true }), true, "apply button");
  assert.equal(AL.matchesPostingKeywords(`${posting} Apply for this job`), true, "apply phrase");
  assert.equal(AL.matchesPostingKeywords("Requirements for the new build. Apply now!"), false, "no qualifications group");
  assert.equal(
    AL.matchesPostingKeywords("WHAT YOU’LL DO: ship.\nWhat you’ll need: grit\nSubmit   your application"),
    true,
    "curly apostrophes, case, whitespace",
  );
});

test("rule 2: whole words only", () => {
  assert.equal(AL.matchesPostingKeywords("skillset unrequired apply now", { hasApplyControl: true }), false);
  assert.equal(AL.matchesPostingKeywords("skills. required.", { hasApplyControl: true }), true);
});

test("rule 2 on real-ish pages: a posting with an Apply button vs. a blog post", () => {
  // (Newlines between blocks: jsdom has no innerText, so tags would otherwise glue words together.)
  const posting = signalsFor(`<body><h1>SWE Intern</h1>
    <p>Responsibilities: build. Requirements: Go.</p>
    <a href="/apply">Apply now →</a></body>`);
  assert.equal(posting.keywords, true);
  const blog = signalsFor(`<body><h1>How we hire</h1><p>Our requirements and the skills we value.
    You can apply through our site whenever you like.</p><a href="/blog">Read more</a></body>`, "https://blog.acme.com/hiring");
  assert.equal(blog.keywords, false);
});

test("hasApplyControl: short Apply buttons/links, not the word inside a sentence", () => {
  const yes = [
    `<button>Apply</button>`,
    `<a href="#">Apply now</a>`,
    `<a href="#"> Easy Apply </a>`,
    `<input type="submit" value="Apply for this job">`,
    `<div role="button" aria-label="Apply for this position">→</div>`,
  ];
  const no = [
    `<a href="#">Terms apply to all offers in this section of the site</a>`,
    `<p>Apply</p>`,
    `<button>Applications</button>`,
  ];
  for (const html of yes) {
    const al = loadScripts(makePage(`<body>${html}</body>`).window, CAPTURE_FILES);
    assert.equal(al.capture.hasApplyControl(), true, html);
  }
  for (const html of no) {
    const al = loadScripts(makePage(`<body>${html}</body>`).window, CAPTURE_FILES);
    assert.equal(al.capture.hasApplyControl(), false, html);
  }
});

test("rule 3: JSON-LD signal via capture.signals", () => {
  const s = signalsFor(`<head><script type="application/ld+json">{"@type":["JobPosting"],"title":"x"}</script></head><body>hi</body>`);
  assert.deepEqual(s, { ats: false, jsonld: true, keywords: false, form: false, fillable: false });
});

test("application form: resume + upload + name/email", () => {
  const form = signalsFor(`<body><form>
    <label for="fn">First name</label><input id="fn">
    <label for="em">Email</label><input id="em" type="email">
    <label for="cv">Resume/CV</label><input id="cv" type="file">
  </form></body>`);
  assert.equal(form.form, true);
  assert.equal(form.fillable, true);

  // Custom upload widget: no <input type=file> visible, but the text says to upload a resume.
  const widget = signalsFor(`<body><p>Upload your resume (PDF)</p>
    <input name="applicant_email" placeholder="you@example.com"><input name="legalName_firstName"></body>`);
  assert.equal(widget.form, true);
});

test("not an application form: contact forms, plain uploads, newsletter boxes", () => {
  const contact = signalsFor(`<body><form><label for="n">Full name</label><input id="n">
    <label for="e">Email</label><input id="e" type="email"><textarea name="message"></textarea></form></body>`);
  assert.equal(contact.form, false, "no resume");
  const upload = signalsFor(`<body><p>Upload your resume to our resume builder</p><input type="file"></body>`);
  assert.equal(upload.form, false, "no name or email");
  const newsletter = signalsFor(`<body><p>Get our resume tips</p><input type="email" placeholder="Email"></body>`);
  assert.equal(newsletter.form, false, "no upload");
});

test("fillable form (rule 4): two or more fields; a search box alone doesn't count", () => {
  assert.equal(signalsFor(`<body><input type="search"><input name="q" aria-label="Search"></body>`).fillable, false);
  assert.equal(signalsFor(`<body><input name="school"><select name="degree"><option>BS</option></select></body>`).fillable, true);
  assert.equal(signalsFor(`<body><input name="school" disabled><input name="x" readonly></body>`).fillable, false);
});

test("never-capture hosts: personal and productivity sites", () => {
  for (const h of ["mail.google.com", "docs.google.com", "www.instagram.com", "claude.ai", "acme.slack.com", "x.com"]) {
    assert.equal(AL.isNeverCapture(h), true, h);
  }
  for (const h of ["careers.google.com", "www.google.com", "boards.greenhouse.io", "www.linkedin.com", "box.com"]) {
    assert.equal(AL.isNeverCapture(h), false, h);
  }
});
