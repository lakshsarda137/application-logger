import assert from "node:assert/strict";
import { test } from "node:test";

import { siteOf } from "../lib/sites.js";

test("siteOf returns the registrable domain", () => {
  const cases = {
    "https://careers.acme.com/jobs/1": "acme.com",
    "https://acme.com": "acme.com",
    "https://www.linkedin.com/in/x": "linkedin.com",
    "https://jobs.acme.co.uk/1": "acme.co.uk",
    "https://acme.wd5.myworkdayjobs.com/x": "myworkdayjobs.com",
    "https://127.0.0.1:8765/": "127.0.0.1",
    "not a url": "",
    "": "",
  };
  for (const [url, site] of Object.entries(cases)) assert.equal(siteOf(url), site, url);
});
