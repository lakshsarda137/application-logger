# Application Logger

A personal tool that logs internship/job applications. You choose one right-click option, **"Log entire application,"** and it saves the job posting, the resume and cover letter you uploaded, and your answers to the portal's questions. A local website lets you search everything later.

Everything runs locally on your Mac. No data leaves your machine, and no personal data is ever committed to this repo.

---

## 1. Goals

- Save the **resume** and **cover letter** you applied with to a local folder (e.g. `~/Desktop/Professional/Sophomore/October/google_swe/`) **and** to SQLite.
- Save **everything else** (posting text, snapshot, metadata, portal answers) to SQLite only. It is shown in the dashboard and not written to the Professional folder.
- Capture uploads and postings **defensively** as you browse, so multi-page portals (Workday etc.) don't lose data before you log.
- A **dashboard website** with fuzzy full-text search (no LLMs). Each result shows the posting and the resume used together.
- Warn when you revisit a posting you already applied to: **"You applied here on {date}"** (top right).
- Delete an application from both disk and SQLite.

## 2. Architecture

```
┌──────────────────────────┐        HTTP (127.0.0.1)        ┌──────────────────────────────┐
│   Chrome Extension (MV3) │  ───────────────────────────▶  │   Local Server (FastAPI)      │
│                          │                                │                               │
│  content script          │   POST /applications           │  • SQLite + FTS5              │
│   (all pages, all frames)│   GET  /applications/check     │  • writes resume/cover letter │
│  background worker       │   POST /files/classify         │    to Desktop folder          │
│   (24h capture cache)    │   GET  /settings/month-folder  │  • serves dashboard website   │
│  log dialog (ext. page)  │                                │                               │
│  "applied here" toast    │                                │  http://127.0.0.1:8765        │
└──────────────────────────┘                                └──────────────────────────────┘
```

**Stack**
- Extension: Chrome Manifest V3, vanilla JS/TypeScript. Uses IndexedDB for the capture cache, with the `unlimitedStorage` permission.
- Server: Python 3.12, FastAPI, Uvicorn, SQLite (built-in, with FTS5), `rapidfuzz`, `pypdf` / `pdfplumber` (PDF text), `python-docx` (DOCX text).
- Dashboard: plain HTML/CSS/JS served by FastAPI (no build step).

## 3. Repo layout

```
application-logger/
├── extension/
│   ├── manifest.json
│   ├── background.js          # context menu, capture cache, session merging, expiry
│   ├── content.js             # page snapshots, upload capture, form answers, toast
│   ├── log-dialog.html/.js    # the "name this folder" dialog
│   ├── lib/                   # small helpers (url normalization, JSON-LD parsing)
│   └── icons/
├── server/
│   ├── main.py                # FastAPI app + routes
│   ├── db.py                  # schema, migrations, FTS5 triggers
│   ├── storage.py             # folder creation, collisions, month folders, deletion
│   ├── classify.py            # resume vs cover letter
│   ├── search.py              # FTS5 + rapidfuzz ranking
│   ├── config.py              # loads config.local.json
│   └── static/                # dashboard (index.html, app.html, settings.html, css, js)
├── scripts/
│   ├── start.sh
│   └── com.applicationlogger.plist.example   # optional launchd auto-start
├── config.example.json
├── requirements.txt
├── .gitignore
└── README.md
```

## 4. How capture works (defensive caching)

### 4.1 Capture sessions
- The background worker keeps a **capture session per tab**. It holds page snapshots, uploaded files, and form answers.
- If a tab opens a new tab (e.g. "Apply" on a company site opens Workday), the new tab **joins the opener's session** (`openerTabId`). This keeps the posting and the application together.
- Navigating across domains within the same tab stays in the same session.
- **One session per job posting.** When a tab (or a tab opened from it) lands on a posting for a *different* job, it starts a new session instead, so browsing several postings in one tab, or opening several from a search page, never mixes them. The old session keeps its data, and returning to that posting resumes it. Two postings count as the same job if they share a job ID (and company), if one URL is a later step of the other (`/jobs/1` → `/jobs/1/apply`), or if the company and job title match (the careers page and its ATS). Anything else counts as a different job (`extension/lib/postings.js`).
- Sessions expire **24 hours** after their last activity and are then deleted.
- Cached data is **not** considered "applied." Only logged applications count.
- Cached data lives only in the extension's IndexedDB. Nothing is sent to the server until you log.

### 4.2 What gets cached
- **Job posting pages:** on load (after the DOM settles), the extension saves the URL, title, visible text (`innerText`), full HTML, and structured data from any `schema.org/JobPosting` JSON-LD (title, company, location, employment type, salary, date posted, job ID).

  A page is cached if **any** of these rules match (and it isn't on a personal site, see below):

  1. **Job-application platform.** The hostname ends with one of the candidate-facing hosts in `extension/lib/ats-domains.js`: Workday job sites (`myworkdayjobs.com`, `myworkdaysite.com`), `greenhouse.io`, `lever.co`, `ashbyhq.com`, SmartRecruiters, iCIMS, Jobvite, Workable (`apply.`), BambooHR (`/careers`, `/jobs`), Taleo, SuccessFactors (`/career`), Oracle (`/hcmUI/CandidateExperience`), Eightfold, Rippling (`ats.`), Breezy, Recruitee, JazzHR, Teamtailor, Personio, Dover, Wellfound/Handshake/LinkedIn/Indeed job paths. Multi-purpose sites are narrowed to their job pages, so Workday's or Rippling's HR apps and your LinkedIn profile don't count.

  2. **Job posting wording plus a way to apply.** The visible text has a phrase from both groups below, **and** the page has an "Apply" button or link (or an apply phrase such as "Apply for this job" or "Submit application"). Wording alone used to match blog posts and inboxes.

     | Group | Phrases (any one counts) |
     |---|---|
     | **A: Qualifications / role** | qualifications, preferred/minimum/basic qualifications, nice to have, bonus points, who you are, skills, responsibilities, what you'll do, about the role, job description |
     | **B: Requirements** | requirements, required, what you'll need, what we're looking for, must have, you have, you bring |

  3. **Job-posting metadata.** The page contains `schema.org/JobPosting` JSON-LD. Only job postings have it.

  4. **An application form.** The page mentions a resume/CV, offers an upload, and asks for your name or email. Contact forms (no resume) and newsletter boxes (no upload) don't count.

  5. **A later step of the same application.** The tab (or the tab that opened it) already has a capture session, the page is on the **same site** as a page that matched rules 1–4, and it has a form to fill in (two or more fields). This keeps pages P2…Pn of a custom-domain portal. It does not follow you to other sites, and LinkedIn/Indeed/Google never extend a session to the rest of their site.

  **Never captured:** Gmail, Google Docs/Drive/Calendar/Meet/Chat, Outlook, Slack, WhatsApp, Instagram, Facebook, X, Reddit, YouTube, Claude, ChatGPT, Notion. Empty embedded frames (ads, trackers, captchas) are skipped. Uploads are still cached everywhere (see below).

  The phrase lists live in `extension/lib/posting-keywords.js`.
- **Uploads:** a capture-phase listener catches `change` on `input[type=file]` and `drop` events. The file bytes, filename, MIME type, and nearby field label are stored. Uploading a new file into the same field replaces the old one.
- **Portal answers:** field label + value are recorded on `change`/`blur`, grouped by page URL. The following are **never** captured: password fields, hidden fields, and fields matching sensitive patterns (SSN, date of birth, EEO/demographic questions).
- **Iframes:** the content script runs with `all_frames: true` and `match_about_blank: true`, so embedded forms (e.g. Greenhouse inside a company site) are captured too. Every frame reports to the background worker under its tab's session.

## 5. Logging flow

1. Right-click → **"Log entire application."**
2. The background worker collects the session and opens the **log dialog**, prefilled with:
   - **Company** and **position**, guessed from JSON-LD, then page title, then ATS URL patterns.
   - **Folder name:** `{company}_{position}` (lowercase, snake_case, e.g. `google_swe`). Editable.
   - **Save path:** the current month folder (see §6), shown for confirmation.
   - **Captured files**, each auto-labelled *Resume* / *Cover letter* / *Other*, which you can relabel or remove.
   - **Fallback:** "Add file from disk" in case a file wasn't captured.
   - A summary of the captured posting pages and form answers.
3. **Save** sends everything to `POST /applications`.
4. The server:
   - writes the resume and cover letter into the folder;
   - stores everything (including the file bytes and extracted text) in SQLite and updates the FTS index.
5. The extension clears the session. If the server is down, the session is **kept** and the dialog shows "Server not running," so nothing is lost.

### 5.1 Resume vs cover letter (`classify.py`)
Text is extracted from each PDF/DOCX. Rules are applied in this order:
1. Filename contains `resume` or `cv` → **Resume**.
2. Filename contains `cover` → **Cover letter**.
3. The file contains **all three** of "Education", "Experience", "Projects" **and** has a higher word count than the other uploaded file → **Resume**.
4. Otherwise → **Cover letter**.

If only one file was uploaded, rule 3 skips the word-count comparison. The user can always override the label in the dialog.

## 6. Save path and folders

- Settings store a **base path** (default `~/Desktop/Professional/Sophomore`). It can be changed from the dashboard's Settings page.
- The month folder is chosen automatically from today's date, using the full month name (`October`).
  - If `base/October` exists, files are saved there.
  - If it doesn't, the log dialog asks: *"There's no October folder. Create it?"* **Yes** creates it and saves there. **No** lets you choose a different folder.
- **Name collisions:** if `google_swe` already exists, the date is appended: `google_swe_2026-10-03`. If that also exists, the time is appended: `google_swe_2026-10-03_1432`.
- The dashboard does **not** sync with Finder. Changes made in Finder are not reflected in the DB.

## 7. "You applied here" detection

- On each page load, the content script calls `GET /applications/check?url=…`.
- Matching uses the **normalized URL**: lowercase host, `www.` and tracking params (`utm_*`, `gh_src`, `source`, etc.) removed, trailing slash stripped. It is compared against the posting URL and every captured page URL of **logged** applications. When available, the ATS job ID is matched as well.
- Matching is not done by domain alone, because platforms like Workday host thousands of companies on the same domain.
- On a match, a small toast appears top-right: **"You applied here on {date}."** Clicking it opens that application in the dashboard.

## 8. Database schema (SQLite)

```sql
applications (
  id INTEGER PRIMARY KEY,
  company TEXT, position TEXT,
  folder_name TEXT, folder_path TEXT,
  applied_at TEXT,                 -- ISO timestamp
  posting_url TEXT, posting_url_normalized TEXT,
  posting_title TEXT, posting_text TEXT, posting_html BLOB,
  location TEXT, employment_type TEXT, salary TEXT,
  date_posted TEXT, job_id TEXT, ats_platform TEXT,
  jsonld TEXT                      -- raw JobPosting JSON if present
)

application_pages (                -- every page captured in the flow (P1..Pn)
  id INTEGER PRIMARY KEY, application_id INTEGER REFERENCES applications ON DELETE CASCADE,
  url TEXT, url_normalized TEXT, title TEXT, text TEXT, captured_at TEXT
)

documents (
  id INTEGER PRIMARY KEY, application_id INTEGER REFERENCES applications ON DELETE CASCADE,
  kind TEXT CHECK(kind IN ('resume','cover_letter','other')),
  filename TEXT, file_path TEXT, mime TEXT, sha256 TEXT,
  content BLOB, text_content TEXT
)

form_answers (
  id INTEGER PRIMARY KEY, application_id INTEGER REFERENCES applications ON DELETE CASCADE,
  page_url TEXT, field_label TEXT, field_name TEXT, value TEXT
)

settings (key TEXT PRIMARY KEY, value TEXT)

-- Full-text index (external content, kept in sync by triggers)
applications_fts USING fts5(company, position, posting_title, posting_text,
                            posting_url, document_text, form_text)
```

## 9. Search (no LLMs)

- **FTS5** with BM25 ranking over company, position, posting text, URL, resume/cover letter text, and answers. Queries also run as prefix matches (`goo*`).
- **rapidfuzz** scores company and position names for typo tolerance (`gogle` still finds Google).
- The final score is a weighted blend, with company/position matches weighted highest.
- Each result card shows **the posting and the resume used**, with the application date. Two roles at the same company appear as two clearly labelled cards.

## 10. Dashboard (http://127.0.0.1:8765)

- **Home / Search:** a search bar, then results (or the most recent applications when the search is empty).
- **Application page:**
  - metadata (company, role, date, location, salary, URL);
  - full posting text;
  - the archived snapshot, rendered in a sandboxed iframe;
  - resume and cover letter preview and download;
  - portal answers grouped by page;
  - captured pages;
  - **Delete** (see §11).
- **Settings:** base save path, current month folder, folder creation behavior.

## 11. Deleting an application

`DELETE /applications/{id}`, triggered from the dashboard after a confirmation prompt, removes:
- all DB rows (via cascade) and the application's FTS entries;
- the local folder. For safety, the folder is deleted **only if** it resolves to a path inside the configured base path.

## 12. API

| Method | Path | Purpose |
|---|---|---|
| POST | `/applications` | Create from log dialog (multipart: JSON + files) |
| GET | `/applications?q=` | Search / list |
| GET | `/applications/{id}` | Detail |
| DELETE | `/applications/{id}` | Delete (DB + folder) |
| GET | `/applications/check?url=` | "Applied here?" check |
| POST | `/files/classify` | Resume vs cover letter labels |
| GET | `/documents/{id}` | Download/preview a file |
| GET/PUT | `/settings` | Base path etc. |
| GET | `/settings/month-folder` | Does this month's folder exist? |
| POST | `/settings/month-folder` | Create it |

## 13. Security and privacy (public repo)

- The server binds to **127.0.0.1 only**.
- CORS allows only the extension's origin and the dashboard itself.
- A random API token is generated on first run and stored in `config.local.json`. The extension sends it in a header, so random websites can't call the local server.
- The SQLite DB lives **outside the repo** by default: `~/Library/Application Support/ApplicationLogger/app.db`.
- `.gitignore` must exist **before the first commit** and include:
  ```
  config.local.json
  *.db
  *.db-journal
  *.sqlite*
  data/
  .env
  __pycache__/
  .venv/
  node_modules/
  *.pdf
  *.docx
  .DS_Store
  ```
- Only `config.example.json`, with placeholder values, is committed. Never commit real names, emails, phone numbers, or paths.

## 14. Setup (target)

```bash
git clone <repo> && cd application-logger
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp config.example.json config.local.json   # edit base path
./scripts/start.sh                         # starts server on 127.0.0.1:8765
```
Then open Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`. Paste the API token from `config.local.json` into the extension's options page.

Optional: install `scripts/com.applicationlogger.plist.example` as a launchd agent so the server starts automatically at login.

## 15. Build phases

**Phase 1: Core logging (one-page portals)**
- FastAPI server, SQLite schema, settings, token auth.
- Context menu "Log entire application," log dialog, save to folder + DB.
- Month folder logic and collision handling.
- `.gitignore` and `config.example.json` from the very first commit.

**Phase 2: Defensive caching (multi-page portals)**
- Capture sessions in IndexedDB with 24h expiry and opener-tab linking.
- Posting snapshots and JSON-LD extraction.
- Upload capture (including iframes and drag-and-drop) and portal answers.
- Resume/cover letter classifier, plus the dialog's relabel and "add from disk" controls.

**Phase 3: Dashboard and search**
- FTS5 + rapidfuzz search, results page, application page, settings page, delete.

**Phase 4: "Applied here" toast**
- URL normalization, check endpoint, toast UI.

**Phase 5: Nice-to-haves**
- Autofill of name, email, phone, location, LinkedIn, GitHub, and website from a local profile (stored in `config.local.json`, never committed).
- Application status tracking (applied / interview / rejected / offer).

Each phase should be working and manually tested on a real portal (one Greenhouse or Lever, one Workday) before starting the next.

## 16. Status and development

| Phase | Status |
|---|---|
| 1. Core logging | Implemented, automated tests pass |
| 2. Defensive caching | Implemented, automated tests pass |
| 3. Dashboard and search | Implemented, automated tests pass; checked in Chrome against scratch data |
| 4. "Applied here" toast | Implemented, automated tests pass |
| 5. Nice-to-haves | Skipped for now |

None of this has been manually tested on a real portal yet (see the checklist below).

**Implementation notes that go beyond §1–§12**
- **Uploads are cached on every site**, not only on job pages, so a file is never lost. An upload alone doesn't make a tab start capturing pages; only rules 1–3 (or logging) do.
- **Detached file inputs.** Some widgets pick files through an `<input type=file>` that is never added to the page. `lib/main-world-hook.js` (a MAIN-world content script) catches those too.
- **"Other recent uploads".** The log dialog also lists files uploaded in *other* tabs in the last 24h (e.g. if the Workday tab was closed), so they can be added.
- **Posting page choice.** The dialog picks the page you logged from if it's a posting, else the latest posting page (JSON-LD or keyword match), else the first page. A posting page without JSON-LD gives way to the same posting's JSON-LD page (an earlier step of its URL, or an embedded frame). An older posting never wins over a newer one. Each captured page has a radio button to change this and a checkbox to leave it out.
- **The log dialog opens as a tab** next to the page, in the same window. It closes after saving (or Cancel/Discard) and switches back to the page.
- **Classifier fallback.** Rule 4 of §5.1 labels only the first unmatched file as a cover letter. Any further unmatched files become "Other".
- **Dashboard auth.** Dashboard pages set an HttpOnly, SameSite=Strict cookie (derived from the token, not the token itself). Mutating calls also need `X-Requested-With: dashboard`.
- **Capture is deliberately narrow** (§4.2): job platforms, posting wording plus an Apply button, JobPosting metadata, application forms, and later form steps on the same site. Personal sites are never captured. The "applied here" check only matches captured pages from the posting's site, a job platform, or the company's own domain.
- **Copy numbers are stripped from resume/cover letter names.** `Resume(75).pdf`, `Resume (2).pdf`, `Resume copy 3.pdf` and the site-mangled `Resume_tex__18_ (6).pdf` become `Resume.pdf`, both in what a job site receives and in the saved copy. **With `"resume_name": "Ada_Lovelace_Resume"` in `config.local.json`, every resume is renamed to `Ada_Lovelace_Resume.pdf` instead**, whatever it's called on disk (a resume by filename or by a resume/CV field label, never a file or field that says cover letter). The service worker reads it from `GET /settings` on install, browser start and every 30 minutes, or when you click **Test connection**. The file on your disk is never touched. Only browser/macOS copy markers are removed (not `-1` or ` 2026`), and only for files that look like a resume or cover letter by filename or field label. The browser-side rename runs on job pages and covers normal and hidden upload fields; drag-and-drop uploads aren't renamed in the browser, but the saved copy is still clean.
- **Clicking the extension icon** opens the dashboard. Options are under right-click → Options.

**Tests**
```bash
pip install -r requirements-dev.txt && pytest          # server (Python 3.12)
npm install && npm test                                 # extension (Node 20+, jsdom + fake-indexeddb)
```

**Manual test checklist**
1. Run `./scripts/start.sh`. In the extension's Options, paste the token from `config.local.json` and click **Test connection**.
2. **Greenhouse/Lever (one page):** open a posting, fill the form, attach a resume and cover letter, then right-click → **Log entire application**. Check the prefilled details, the file labels (the server classifier relabels them after a moment), the answers and the pages. Save, then confirm `{base}/{Month}/{folder}` contains only the resume and cover letter.
3. **Workday (multi-page):** open a posting, click Apply, and upload your resume on the upload step. Continue a few steps, then log from the last page. The resume and the posting page should both appear even though they're no longer on screen.
4. **New tab:** on a company careers page whose "Apply" opens the ATS in a new tab, apply there and log. The posting from the first tab should be included (if the ATS page shows the posting again, it is included only when its company and title match).
4b. **Several postings:** in one tab, open posting X, then posting Y (different job), and log from Y. Only Y's pages should appear. Do the same with two postings opened from a LinkedIn search tab.
5. **Closed tab:** upload a file in some tab, close it, then log from another tab. The file should be under **Other recent uploads**.
6. **Server down:** stop the server and log. The dialog should say "Server not running", and after restarting the server, **Retry** should save with nothing lost.
7. **Toast:** revisit a logged posting (also try it with `?utm_source=x` added). "You applied here on {date}" should appear top-right, and clicking it opens the dashboard.
8. **Dashboard** (click the extension icon): search by company, with a typo (`gogle`), and by resume text. Open an application, preview the resume and the archived page, then delete it and confirm its folder is gone.
9. **Sensitive fields:** fill in EEO/demographic questions and date of birth, log, and confirm none of them appear in the dialog's answers.
