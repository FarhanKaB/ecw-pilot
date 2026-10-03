# ECW Pilot

A coding assistant panel for eClinicalWorks. Everyone installs **one** Tampermonkey script (the loader); it loads the right files for each practice from this repository.

*Not affiliated with eClinicalWorks.*

## What's in this repository

```
loader/ECW_Pilot.user.js        the ONE script people install (rarely changes)
manifest.json                   clients, their eCW addresses, file versions, update notes
shared/history.js               patient history (every client)
shared/sort.js                  Sort (every client)            ← replace the placeholder
shared/claim-link.js            Claim Link (every client)      ← replace the placeholder
clients/highland/coding.js      HighLand's coding rules + screening pills
clients/highland/link.js        HighLand's Link                ← replace the placeholder
```

## One-time setup

1. Create a **public** repository named `ecw-pilot` and upload these files, keeping the folders.
2. The loader already points to `FarhanKaB/ecw-pilot`. If the repository is ever renamed or moved, update the `REPO_ROOT` line, `@updateURL` and `@downloadURL` in `loader/ECW_Pilot.user.js`.
3. Replace the three placeholder files (Sort, Claim Link, Link) with your scripts. You can paste an existing Tampermonkey script as-is.
4. Turn on two-factor authentication for your GitHub account, and only add collaborators who may change billing rules. Whatever is in this repository runs inside the EMR.

## Install (for each coder)

1. Install Tampermonkey.
2. Open this link and click **Install**:
   `https://raw.githubusercontent.com/FarhanKaB/ecw-pilot/main/loader/ECW_Pilot.user.js`
3. **Remove** the old scripts (SmartCoder, HighLand Smart Coder, HighLand Beta, and the separate Link, Claim Link or Sort scripts) so nothing runs twice.

## Releasing a change

1. Edit or replace the file on GitHub.
2. In `manifest.json`, **raise that file's `version`** and write a short line in its `notes`.
3. Commit.

Coders get it on their next page refresh. Pages that are already open show **"A new version of ECW Pilot is available — refresh to update"** within about 20 minutes. After refreshing, the panel shows a one-time **"ECW Pilot was updated"** message with your notes. The panel footer always shows `ECW Pilot · <client> · v<version>`.

If you don't raise the version, nobody gets the change: files are cached by version.

## Adding a client

1. Copy `clients/highland/` to `clients/<new-id>/` and change its rules and screening pills (`SCREENING_PILLS` at the top of `coding.js`).
2. Add the client to `manifest.json`:
   ```json
   "newid": {
     "name": "New Practice",
     "hosts": ["theirsite.ecwcloud.com"],
     "files": {
       "coding": { "label": "Coding", "path": "clients/newid/coding.js", "version": "1.0", "notes": [] },
       "link":   { "label": "Link",   "path": "clients/newid/link.js",   "version": "1.0", "notes": [] }
     },
     "defaults": { "sort": true, "link": true, "claimLink": true }
   }
   ```
   `hosts` is the part of the eCW address before `/mobiledoc`, e.g. `nyhmcnapp.ecwcloud.com` for HighLand.

Nobody needs to reinstall anything.

## Settings (per coder)

The gear button in the panel opens **Settings**: turn **Sort**, **Link** and **Claim Link** on or off, and move the panel to the left or right. Each coder's choices are saved in their browser. `defaults` in `manifest.json` decides what's on for coders who haven't changed anything. Turning a module on takes effect immediately; turning it off takes effect after a page refresh.

## Testing before release

Keep a `beta` branch. A tester runs this once in the browser console on eCW and refreshes:

```js
localStorage.setItem('ecwpilot:branch', 'beta')
```

To go back: `localStorage.removeItem('ecwpilot:branch')`.

## Troubleshooting (browser console, F12)

| Message | Meaning |
|---|---|
| `… is not set up for any client in manifest.json` | That eCW address isn't in any client's `hosts` |
| `GitHub not reachable — using the last saved manifest` | Offline or blocked; the last good copy is running |
| `… failed to start` | That file has an error; the others still run |
| `smcDiagnose()` | Shows which eCW billing functions are available |
