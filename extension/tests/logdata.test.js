import assert from "node:assert/strict";
import { test } from "node:test";

import { buildLogData, choosePosting, dedupeFiles } from "../lib/logdata.js";

const at = (min) => new Date(Date.UTC(2026, 9, 3, 12, min)).toISOString();

test("posting: the latest posting wins, even over an older one with JSON-LD", () => {
  const pages = [
    { id: 1, url: "a", capturedAt: at(0), jsonld: { title: "Old" }, isTop: true },
    { id: 2, url: "b", capturedAt: at(5), jsonld: { title: "New" }, isTop: true },
    { id: 3, url: "c", capturedAt: at(9), isPosting: true, isTop: true },
  ];
  assert.equal(choosePosting(pages).id, 3);
  assert.equal(choosePosting(pages.slice(0, 2)).id, 2);
});

test("posting: the page being logged wins when it is a posting", () => {
  const pages = [
    { id: 1, url: "https://boards.greenhouse.io/acme/jobs/1", capturedAt: at(0), jsonld: { title: "X" }, isPosting: true, isTop: true },
    { id: 2, url: "https://ats.rippling.com/globex/jobs/2", capturedAt: at(5), isPosting: true, isTop: true },
    { id: 3, url: "https://boards.greenhouse.io/acme/jobs/3", capturedAt: at(9), jsonld: { title: "Z" }, isPosting: true, isTop: true },
  ];
  assert.equal(choosePosting(pages, "https://ats.rippling.com/globex/jobs/2").id, 2);
  // Logged from a page that isn't a posting (a form step): the latest posting.
  assert.equal(choosePosting(pages, "https://ats.rippling.com/globex/apply").id, 3);
});

test("posting: a keyword-only page gives way to the same posting's JSON-LD page", () => {
  const earlier = { id: 1, url: "https://jobs.lever.co/acme/123", capturedAt: at(0), jsonld: { title: "SWE" }, isPosting: true, isTop: true };
  const apply = { id: 2, url: "https://jobs.lever.co/acme/123/apply", capturedAt: at(5), isPosting: true, isTop: true };
  assert.equal(choosePosting([earlier, apply], apply.url).id, 1);
  // A frame snapshotted with it (Greenhouse embedded in a careers page).
  const top = { id: 3, url: "https://careers.acme.com/jobs?gh_jid=7", capturedAt: "2026-10-03T13:00:00.000Z", isPosting: true, isTop: true };
  const frame = { id: 4, url: "https://boards.greenhouse.io/embed/job_app?token=7", capturedAt: "2026-10-03T13:00:01.000Z", jsonld: { title: "SWE" } };
  assert.equal(choosePosting([top, frame], top.url).id, 4);
  // An unrelated older posting with JSON-LD doesn't.
  const other = { id: 5, url: "https://jobs.lever.co/acme/999", capturedAt: at(0), jsonld: { title: "Old" }, isPosting: true, isTop: true };
  assert.equal(choosePosting([other, apply], apply.url).id, 2);
});

test("posting: else latest keyword match, else first top-frame page", () => {
  assert.equal(
    choosePosting([
      { id: 1, capturedAt: at(0), isTop: true },
      { id: 2, capturedAt: at(1), isPosting: true },
      { id: 3, capturedAt: at(2), isPosting: true },
      { id: 4, capturedAt: at(3), isTop: true },
    ]).id,
    3,
  );
  assert.equal(
    choosePosting([
      { id: 1, capturedAt: at(2), isTop: false },
      { id: 2, capturedAt: at(1), isTop: true },
      { id: 3, capturedAt: at(0), isTop: false },
    ]).id,
    2,
  );
  assert.equal(choosePosting([{ id: 7, capturedAt: at(0) }]).id, 7);
  assert.equal(choosePosting([]), null);
});

test("Workday-style flow: the posting page is chosen over later form pages", () => {
  const pages = [
    { id: 1, url: "wd/job/SWE_R1", capturedAt: at(0), jsonld: { title: "SWE" }, isPosting: true, isTop: true },
    { id: 2, url: "wd/job/SWE_R1/apply", capturedAt: at(2), isTop: true },
    { id: 3, url: "wd/job/SWE_R1/apply/step2", capturedAt: at(5), isTop: true },
  ];
  const data = buildLogData({ pages });
  assert.equal(data.posting.id, 1);
  assert.deepEqual(data.pages.map((p) => p.id), [1, 2, 3]);
});

test("files: same file captured twice keeps one (the newest)", () => {
  const files = dedupeFiles([
    { id: 1, filename: "cv.pdf", size: 10, lastModified: 5, capturedAt: 1 },
    { id: 2, filename: "cover.pdf", size: 20, lastModified: 5, capturedAt: 2 },
    { id: 3, filename: "cv.pdf", size: 10, lastModified: 5, capturedAt: 3 },
    { id: 4, filename: "cv.pdf", size: 11, lastModified: 5, capturedAt: 4 },
  ]);
  assert.deepEqual(files.map((f) => f.id), [2, 3, 4]);
});

test("answers: drops empty values, oldest first", () => {
  const data = buildLogData({
    answers: [
      { key: "b", value: "2", updatedAt: 2 },
      { key: "a", value: "1", updatedAt: 1 },
      { key: "c", value: " ", updatedAt: 3 },
    ],
  });
  assert.deepEqual(data.answers.map((a) => a.key), ["a", "b"]);
  assert.equal(data.posting, null);
});
