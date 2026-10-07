import assert from "node:assert/strict";
import { test } from "node:test";

import { attachFile, CAPTURE_FILES, COPY_CASES, loadScripts, makePage, plain } from "./helpers.js";

function load(html, opts) {
  const dom = makePage(html, opts);
  const AL = loadScripts(dom.window, CAPTURE_FILES);
  return { dom, AL, doc: dom.window.document };
}

async function snapshot(html, opts = {}) {
  const { AL, dom } = load(html, opts);
  if (opts.setup) opts.setup(dom.window);
  return plain(await AL.capture.snapshot({ files: opts.files ?? true }));
}

const answer = (snap, label) => snap.answers.find((a) => a.field_label === label)?.value;

test("captures url, title, text, html and JSON-LD JobPosting from @graph", async () => {
  const snap = await snapshot(`<!doctype html><html><head><title>SWE at Acme</title>
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"Organization","name":"Acme"},
      {"@type":"JobPosting","title":"SWE","hiringOrganization":{"name":"Acme"}}]}</script>
    <script type="application/ld+json">{not json}</script>
    </head><body><h1>Software Engineer</h1><p>Responsibilities</p></body></html>`);
  assert.equal(snap.url, "https://boards.greenhouse.io/acme/jobs/1");
  assert.equal(snap.title, "SWE at Acme");
  assert.equal(snap.isTop, true);
  assert.match(snap.text, /Software Engineer/);
  assert.match(snap.html, /<h1>Software Engineer<\/h1>/);
  assert.equal(snap.jsonld.title, "SWE");
  assert.deepEqual(snap.signals, { ats: true, jsonld: true, keywords: false, form: false, fillable: false });
});

test("captures text inputs, textareas and selects with their labels", async () => {
  const snap = await snapshot(`<body>
    <label for="fn">First Name *</label><input id="fn" name="first_name" value="Ada">
    <label>Why Acme? <textarea name="why">Rockets</textarea></label>
    <input name="linkedin" aria-label="LinkedIn Profile" value="https://linkedin.com/in/ada">
    <span id="lbl">Start date</span><input aria-labelledby="lbl" value="June">
    <label for="s">Location</label>
    <select id="s"><option value="">Select…</option><option value="nyc" selected>New York</option></select>
    <label for="empty">Empty</label><input id="empty" value="">
    <label for="blank-select">Blank select</label>
    <select id="blank-select"><option value="" selected>Select…</option></select>
  </body>`);
  assert.equal(answer(snap, "First Name"), "Ada");
  assert.equal(snap.answers.find((a) => a.field_name === "why").value, "Rockets");
  assert.equal(answer(snap, "LinkedIn Profile"), "https://linkedin.com/in/ada");
  assert.equal(answer(snap, "Start date"), "June");
  assert.equal(answer(snap, "Location"), "New York");
  assert.equal(answer(snap, "Empty"), undefined);
  assert.equal(answer(snap, "Blank select"), undefined);
  assert.ok(snap.answers.every((a) => a.page_url === "https://boards.greenhouse.io/acme/jobs/1"));
  assert.equal(snap.answers.find((a) => a.field_name === "first_name").field_key, "boards.greenhouse.io/acme/jobs/1#first_name");
});

test("groups radios and checkboxes under their question", async () => {
  const snap = await snapshot(`<body>
    <fieldset><legend>Are you authorized to work in the US?</legend>
      <label><input type="radio" name="auth" value="1" checked> Yes</label>
      <label><input type="radio" name="auth" value="0"> No</label>
    </fieldset>
    <fieldset><legend>Which offices?</legend>
      <label><input type="checkbox" name="office" checked> NYC</label>
      <label><input type="checkbox" name="office"> SF</label>
      <label><input type="checkbox" name="office" checked> London</label>
    </fieldset>
    <fieldset><legend>Unanswered</legend>
      <label><input type="radio" name="u"> A</label>
      <label><input type="radio" name="u"> B</label>
    </fieldset>
    <label><input type="checkbox" name="consent" checked> I agree to the privacy policy</label>
  </body>`);
  assert.equal(answer(snap, "Are you authorized to work in the US?"), "Yes");
  assert.equal(answer(snap, "Which offices?"), "NYC, London");
  assert.equal(answer(snap, "Unanswered"), undefined);
  assert.equal(answer(snap, "I agree to the privacy policy"), "Yes");
  assert.equal(snap.answers.filter((a) => a.field_label === "Which offices?").length, 1);
});

test("never captures passwords, hidden fields or sensitive questions", async () => {
  const snap = await snapshot(`<body>
    <label for="pw">Password</label><input id="pw" type="password" value="hunter2">
    <input type="hidden" name="csrf" value="tok">
    <label for="ssn">Social Security Number</label><input id="ssn" value="123-45-6789">
    <label for="dob">Date of Birth</label><input id="dob" value="2007-01-01">
    <input name="date_of_birth" value="2007-01-01">
    <input data-automation-id="dateOfBirth" aria-label="When" value="2007-01-01">
    <input autocomplete="bday" aria-label="When" value="2007-01-01">
    <input autocomplete="cc-number" aria-label="Number" value="4111111111111111">
    <label for="g">Gender</label><select id="g"><option selected>Female</option></select>
    <fieldset><legend>Are you a protected veteran?</legend>
      <label><input type="radio" name="vet" checked> No</label>
      <label><input type="radio" name="vet"> Yes</label>
    </fieldset>
    <div id="eeoc_fields"><label for="r">Please choose</label><select id="r"><option selected>Option A</option></select></div>
    <div class="demographic-questions"><label for="x">Anything</label><input id="x" value="secret"></div>
    <fieldset><legend>Voluntary Self-Identification</legend>
      <label for="y">Question</label><input id="y" value="secret2">
    </fieldset>
    <label for="ok">Phone</label><input id="ok" value="555-0100">
  </body>`);
  assert.deepEqual(snap.answers.map((a) => a.field_label), ["Phone"], JSON.stringify(snap.answers));
});

test("sensitive-word matching is whole-word", async () => {
  const snap = await snapshot(`<body>
    <label for="a">How do you embrace change?</label><input id="a" value="Gladly">
    <label for="b">Describe a race condition you fixed</label><input id="b" value="Mutex">
  </body>`);
  assert.equal(answer(snap, "How do you embrace change?"), "Gladly");
  // Known, accepted false positive: erring toward not capturing is the safe side.
  assert.equal(answer(snap, "Describe a race condition you fixed"), undefined);
});

test("answerFor reports cleared fields with an empty value", () => {
  const { AL, doc } = load(`<body><label for="a">City</label><input id="a" value="">
    <label><input type="checkbox" name="c"> Subscribe</label></body>`);
  assert.deepEqual(plain(AL.capture.answerFor(doc.getElementById("a"))), {
    page_url: "https://boards.greenhouse.io/acme/jobs/1",
    field_key: "boards.greenhouse.io/acme/jobs/1#a",
    field_label: "City",
    field_name: "a",
    value: "",
  });
  assert.equal(AL.capture.answerFor(doc.querySelector("[name=c]")).value, "");
  assert.equal(AL.capture.answerFor(doc.body), null);
});

test("reads files still held in file inputs, grouped by field", async () => {
  const snap = await snapshot(
    `<body><label for="resume">Resume/CV</label><input type="file" id="resume" name="resume">
     <label for="cl">Cover letter</label><input type="file" id="cl" name="cover"></body>`,
    {
      setup(window) {
        attachFile(window, window.document.getElementById("resume"), "Ada Resume.pdf", "%PDF-1.4 hello");
      },
    },
  );
  assert.equal(snap.files.length, 1);
  const group = snap.files[0];
  assert.equal(group.fieldKey, "boards.greenhouse.io/acme/jobs/1#resume");
  assert.equal(group.fieldLabel, "Resume/CV");
  const f = group.files[0];
  assert.equal(f.filename, "Ada Resume.pdf");
  assert.equal(f.mime, "application/pdf");
  assert.equal(f.lastModified, 1700000000000);
  assert.equal(Buffer.from(f.base64, "base64").toString(), "%PDF-1.4 hello");
  assert.equal(snap.answers.length, 0, "file inputs are not answers");
});

test("snapshot({files:false}) skips reading files", async () => {
  const snap = await snapshot(`<body><input type="file" id="f"></body>`, {
    files: false,
    setup(window) {
      attachFile(window, window.document.getElementById("f"), "a.pdf", "x");
    },
  });
  assert.deepEqual(snap.files, []);
});

test("dropTarget finds the nearby file input, else a labelled drop zone", () => {
  const { AL, doc } = load(`<body>
    <div id="zone1"><p id="t1">Drop here</p><input type="file" name="resume" aria-label="Resume"></div>
    <div aria-label="Attach cover letter"><span id="t2">drop</span></div>
    <span id="t3">loose</span></body>`);
  assert.deepEqual(plain(AL.capture.dropTarget(doc.getElementById("t1"))), {
    fieldKey: "boards.greenhouse.io/acme/jobs/1#resume",
    fieldLabel: "Resume",
  });
  assert.deepEqual(plain(AL.capture.dropTarget(doc.getElementById("t2"))), {
    fieldKey: "boards.greenhouse.io/acme/jobs/1#drop:Attach cover letter",
    fieldLabel: "Attach cover letter",
  });
  assert.equal(AL.capture.dropTarget(doc.getElementById("t3")).fieldKey, "boards.greenhouse.io/acme/jobs/1#drop");
});

test("loading the scripts twice is harmless", () => {
  const { dom } = load("<body></body>");
  const AL = loadScripts(dom.window, CAPTURE_FILES);
  assert.equal(typeof AL.capture.snapshot, "function");
});

test("capture.cleanFilename matches the shared table; isResumeOrCover checks name or label", () => {
  const { AL } = load("<body></body>");
  for (const [raw, expected] of COPY_CASES) assert.equal(AL.capture.cleanFilename(raw), expected, raw);
  assert.equal(AL.capture.isResumeOrCover("Ada_Resume(2).pdf", ""), true);
  assert.equal(AL.capture.isResumeOrCover("Ada CV (2).pdf", ""), true);
  assert.equal(AL.capture.isResumeOrCover("Cover Letter (2).pdf", ""), true);
  assert.equal(AL.capture.isResumeOrCover("Ada (2).pdf", "Resume/CV"), true);
  assert.equal(AL.capture.isResumeOrCover("photo (2).png", "Profile photo"), false);
  assert.equal(AL.capture.isResumeOrCover("cvs-receipt (2).pdf", ""), false);
  const n = "Ada_Lovelace_Resume";
  assert.equal(AL.capture.uploadName("Ada_Lovelace_Resume_General_tex_18_ (49).pdf", "", n), "Ada_Lovelace_Resume.pdf");
  assert.equal(AL.capture.uploadName("draft.docx", "Resume/CV", n), "Ada_Lovelace_Resume.docx");
  assert.equal(AL.capture.uploadName("Cover Letter (2).pdf", "Resume/CV", n), "Cover Letter.pdf");
  assert.equal(AL.capture.uploadName("draft.pdf", "Resume or cover letter", n), "draft.pdf");
  assert.equal(AL.capture.uploadName("photo (2).png", "Profile photo", n), "photo (2).png");
  assert.equal(AL.capture.uploadName("Ada_Resume (2).pdf", "", ""), "Ada_Resume.pdf");
});
