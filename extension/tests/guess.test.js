import assert from "node:assert/strict";
import { test } from "node:test";

import {
  companyFromUrl,
  defaultKind,
  folderName,
  guessCompanyAndPosition,
  parseTitle,
  shortPosition,
} from "../lib/guess.js";

test("companyFromUrl knows common ATS URL shapes", () => {
  const cases = {
    "https://boards.greenhouse.io/acmecorp/jobs/123": "Acmecorp",
    "https://job-boards.greenhouse.io/acme-robotics/jobs/123": "Acme Robotics",
    "https://boards.greenhouse.io/embed/job_app?for=acme&token=1": "Acme",
    "https://jobs.lever.co/acme/1234-abcd": "Acme",
    "https://jobs.ashbyhq.com/acme/abc": "Acme",
    "https://acme.wd5.myworkdayjobs.com/en-US/External/job/X": "Acme",
    "https://acme.bamboohr.com/careers/12": "Acme",
    "https://apply.workable.com/acme/j/ABC/": "Acme",
    "https://jobs.smartrecruiters.com/AcmeInc/123": "AcmeInc",
    "https://wellfound.com/company/acme/jobs/1": "Acme",
    "https://careers.acme.com/jobs/1": "",
    "not a url": "",
  };
  for (const [url, expected] of Object.entries(cases)) {
    assert.equal(companyFromUrl(url), expected, url);
  }
});

test("parseTitle handles common title shapes", () => {
  assert.deepEqual(parseTitle("Job Application for Software Engineer at Acme"), {
    position: "Software Engineer",
    company: "Acme",
  });
  assert.deepEqual(parseTitle("Software Engineer Intern at Acme | Greenhouse"), {
    position: "Software Engineer Intern",
    company: "Acme",
  });
  assert.deepEqual(parseTitle("Data Scientist @ Globex"), { position: "Data Scientist", company: "Globex" });
  assert.deepEqual(parseTitle("Acme - Backend Engineer", { host: "jobs.lever.co" }), {
    company: "Acme",
    position: "Backend Engineer",
  });
  assert.deepEqual(parseTitle("Backend Engineer - Acme"), { position: "Backend Engineer", company: "Acme" });
  assert.deepEqual(parseTitle("Backend Engineer | Careers"), { position: "Backend Engineer" });
  assert.deepEqual(parseTitle("   "), {});
});

test("guessCompanyAndPosition prefers JSON-LD, then title, then URL", () => {
  assert.deepEqual(
    guessCompanyAndPosition({
      url: "https://boards.greenhouse.io/acme/jobs/1",
      title: "Job Application for Wrong at Wrong",
      jsonld: { title: "SWE Intern", hiringOrganization: { name: "Acme, Inc." } },
    }),
    { company: "Acme, Inc.", position: "SWE Intern" },
  );
  assert.deepEqual(
    guessCompanyAndPosition({
      url: "https://boards.greenhouse.io/acme/jobs/1",
      title: "Job Application for Platform Engineer at Acme",
    }),
    { company: "Acme", position: "Platform Engineer" },
  );
  // Lever-style title on a custom domain, URL has nothing: title order used.
  assert.deepEqual(
    guessCompanyAndPosition({ url: "https://acme.com/careers/1", title: "Platform Engineer - Acme" }),
    { company: "Acme", position: "Platform Engineer" },
  );
  // Title is "Company - Position" but the URL tells us which side is the company.
  assert.deepEqual(
    guessCompanyAndPosition({ url: "https://jobs.ashbyhq.com/acme/1", title: "Acme - Platform Engineer" }),
    { company: "Acme", position: "Platform Engineer" },
  );
  assert.deepEqual(guessCompanyAndPosition({}), { company: "", position: "" });
});

test("folderName builds snake_case names with common abbreviations", () => {
  assert.equal(folderName("Google", "Software Engineer"), "google_swe");
  assert.equal(folderName("Google", "Software Engineering Intern (Summer 2027)"), "google_swe_intern");
  assert.equal(folderName("Amazon", "Software Development Engineer Internship"), "amazon_sde_intern");
  assert.equal(folderName("Acme, Inc.", "Machine Learning Engineer"), "acme_ml_engineer");
  assert.equal(folderName("Café Déjà", "Product Manager"), "cafe_deja_pm");
  assert.equal(folderName("", ""), "application");
  assert.ok(folderName("A".repeat(50), "B".repeat(50)).length <= 60);
  assert.equal(shortPosition("Data Scientist, New Grad"), "ds_new_grad");
});

test("defaultKind: filename, then field label, then fill resume/cover letter", () => {
  assert.equal(defaultKind("Ada_Resume_2026.pdf"), "resume");
  assert.equal(defaultKind("résumé.pdf"), "resume");
  assert.equal(defaultKind("ada-cv.pdf"), "resume");
  assert.equal(defaultKind("cvs-receipt.pdf", "", ["resume"]), "cover_letter");
  assert.equal(defaultKind("Cover Letter - Acme.docx"), "cover_letter");
  assert.equal(defaultKind("cover_letter.pdf", "Resume/CV"), "cover_letter");
  assert.equal(defaultKind("ada.pdf", "Resume/CV"), "resume");
  assert.equal(defaultKind("ada.pdf", "", []), "resume");
  assert.equal(defaultKind("ada.pdf", "", ["resume"]), "cover_letter");
  assert.equal(defaultKind("ada.pdf", "", ["resume", "cover_letter"]), "other");
});
