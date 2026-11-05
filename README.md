# InkSign — v1.1

Sign-shop RIP & cut program for The Ink Stop: vinyl cutting (Graphtec CE6000-60 Plus, US Cutter Titan 3),
print & cut, HP Latex 335 / 115 jobs through Flexi 22, and Xerox 7845 imposition — working from InkFlow orders.

## Install
Run **InkSign-Setup-1.1.0.exe** on each shop PC (Windows may say it protected your PC: **More info → Run anyway**).
It adds InkSign to the desktop and Start menu. Installing a newer version over an old one keeps all devices, jobs and settings
(stored in `%APPDATA%\InkSign`).

## Pages
| Page | What it does |
|---|---|
| **Orders** | InkFlow orders in production. Pick the tool for each item and press **Open** — the artwork loads, sized from the order. When the job finishes, the item is marked printed / cut on the InkFlow order. |
| **Cut Studio** | Vinyl: import SVG / PDF / AI / DXF, trace PNG/JPG logos, text in any installed font (straight or on an arc), shapes, outline/offset, colors cut as separate jobs, copies, nesting, weed border & lines, tiling, materials with force/speed, price estimate, save/open `.inksign` jobs. Zoom with the scroll wheel. |
| **Print & Cut** | PNG/JPG stickers: contour (or shape) cut lines, fills the sheet or roll. *InkSign marks*: print on the Xerox **or an HP**, cut on your cutter — long HP rolls get a fresh set of 4 marks every few feet (segments). *HP through Flexi*: the PDF carries a **CutContour** spot color for Flexi's own print & cut. Built-in **alignment test** per cutter. |
| **Wide Format (HP)** | Banners/signs/canvas: nests on the roll, tiles oversize jobs, hems + grommet marks, canvas wrap, per-media Flexi hot folders, media/ink/cost before printing. |
| **Press (Xerox)** | Step & repeat cards/postcards (front + back), N-up, saddle-stitch booklets, crop marks & bleed, quantity → sheets, paper from the paper catalog, staple / booklet fold / punch, B&W — sent to the Xerox Server. |
| **Xerox Server** | Fiery-style print server for the Xerox 7845 (see below): Printing / Held / Printed queues, job properties, paper catalog, mixed media, imposition, color, finisher. |
| **Devices** | Your machines, status, test cut / test print, settings, **Maintenance** (blade changes, cleanings… due by days, meters cut or sq ft printed). **+ Add device** for new cutters and printers. |
| **Job queue** | Everything sent, with retry and release for held jobs. |
| **History** | Every job ever sent, who sent it, and **Reprint** (to the same or another machine) while the file is kept. |
| **Rolls & stock** | Your InkFlow sign rolls and feet left; low rolls flagged for reorder. |
| **Usage** | Media and ink per job, by printer and media, plus labor timers; CSV export. |
| **Settings** | InkFlow link, watch folders, people & PINs, phone view, shared setup between PCs, updates. |

## Xerox Server — Fiery-style print server for the WorkCentre 7845 (new in 1.1)
Works like Fiery Command WorkStation. One PC (the one by the Xerox) **is** the server; InkSign on every other shop PC connects to it and sees the same jobs.

**Exact Xerox commands.** InkSign carries Xerox's own 7845 printer description (PPD 5.482, from Xerox's driver download).
Every job is turned into PostScript (Ghostscript, built in — nothing to install) and gets the same commands Xerox's driver sends:
trays 1–6 (5 = bypass), 35 paper sizes + custom (3.46–13" × 3.86–19.2"), 32 paper types, 22 paper colors, 2-sided (long/short edge),
collate, staple (1 portrait / 1 landscape / 2 / 4), booklet fold, booklet fold + staple, 2/3/4-hole punch, print quality, banner sheet,
and the PJL job header (job name, owner, B&W billing). The driver's 1,110 rules (which papers can duplex, staple, fold, go in which tray…)
are checked before anything prints — a job that breaks one stays Held with the reason.

**Queues & actions.** *Printing* (waiting / processing / printing), *Held*, *Printed* (kept 30 days for reprints), *All*.
Print, Hold, **Process & hold** (ready to go, prints instantly later), **Print next** (rush), **Proof** (1 copy, stays held), Properties,
Preview (every sheet, front/back, with the paper it's on), Duplicate, Rename, Save PDF, Cancel, Remove, Pause printing. Search by job, person, paper or order.

**Job properties.** Job info (name, copies, collate, notes) · Media (paper catalog or by hand; sides; fit / fill / 100%, auto-rotate, rotate 180°) ·
Layout (normal, N-up, step & repeat, booklet — bleed, gutter, crop marks) · Color & image (color / grayscale; optional InkSign color management
with RGB/CMYK source, output profile per paper, rendering intent, pure-black text, overprint simulation; print quality) ·
Finishing (staple, booklet fold, punch, collate, banner) · Mixed media (front/back covers on other stock, page ranges on other paper,
blank inserts / slip sheets, chapter starts — 2-sided jobs get blank backs so each change starts a new sheet).

**Paper catalog.** Every stock with its size, Xerox paper type, color, weight, coated, tray, ICC profile and cost per sheet; plus what's
loaded in each tray (jobs on "Automatic" go to the tray holding that paper). Printed jobs add sheets × cost to Usage and the InkFlow order.

**Getting jobs in.** Press page · Import (PDF / PostScript) · InkFlow orders (Press) · **Windows printers**: Xerox Server → Setup →
*Add the InkSign printers* adds "InkSign 7845 - Hold" and "InkSign 7845 - Print" (with Xerox's 7845 PS3 driver, included) to any PC —
print from Word, Acrobat, Illustrator; the driver's tray/paper/staple choices come through. Untouched Windows jobs print byte-for-byte as the driver made them.

**Other shop PCs.** Install InkSign → Xerox Server → Setup → *Use the server on another PC* → server address + key (shown on the server PC).
PCs that follow the shared setup connect automatically. On the server PC press *Allow through Windows Firewall* once (ports 8631, 9101, 9102).

**Self-test.** `InkSign.exe --smoke-test=C:\temp\inksign-test.json` runs the whole server against a fake printer in a throw-away
folder (never touches your setup or the real Xerox) and writes the results.

## Shop tools (new in 1.0)
- **People & PINs** (Settings): add each person as Owner or Staff with a PIN, tick *Ask who's using InkSign*. Staff can run jobs; only owners change settings, devices, calibration, pricing and color profiles. Every job, timer and maintenance entry records who did it.
- **Labor timer** (left sidebar): start on an order (Weeding, Application, Install…), stop when done — minutes × your labor rate are added to that order's costs in InkFlow.
- **Real costs to InkFlow**: each finished cut job adds its vinyl cost to the order; wide-format jobs add media + ink.
- **Roll stock**: pick the InkFlow roll in Cut Studio (one per vinyl color) or Wide Format — the feet used come off the roll when the job finishes, with a reorder warning.
- **Quotes from InkSign**: *Create InkFlow quote…* in Cut Studio and Wide Format makes a quote for a customer (or adds the lines to an open order) at InkSign's suggested price, with the proof attached.
- **History & reprint**, **maintenance reminders** (a toast at start-up when something's due).
- **Phone view**: Settings → Phone view → turn on. Open the address shown on a phone on the shop Wi-Fi, sign in with your PIN: see the queue, release held jobs, retry, cancel. Allow InkSign through the Windows firewall (private networks) when asked.
- **Shared setup**: point every PC at one shared folder (network share or Nextcloud). The main PC *publishes*; the others *follow* every 5 minutes — materials, pricing, colors, media, ICC profiles, clip-art library and machine settings stay the same everywhere, while each PC keeps its own USB/COM cutter connection.
- Job files older than 90 days (Settings → Job files) are cleaned up; history rows stay.

## Cutting tools (new in 0.8)
- **Cutter controls** (Cut Studio → Cutter control, or Devices → Controls): jog the blade, send it to the origin,
  **Start next job here**, pause the queue, cancel waiting jobs (also clears the cutter's Windows print queue).
  A cut already running is stopped with PAUSE on the cutter itself.
- **Save vinyl on the roll**: tick *Next job starts after the last one* — InkSign remembers where the last job ended and
  starts the next one ½" after it. *New roll / reset* when you load a fresh roll.
- **Cut by color, one at a time**: with *Wait for me to load each color*, the second color onward waits in the Job queue
  ("Load Red vinyl, then press Release").
- **Weed box around each piece** (Weeding), on top of the weed border and weed lines.
- **HTV mirrors itself**: materials have a *Mirror* tick (on for Heat transfer vinyl).
- **Stencil bridges** (Edit): keeps the middles of O, A, B, D, R… attached for paint/sandblast stencils.
- **Knockout (reverse)** (Edit): a solid block with the design cut out.
- **Rhinestones** (Edit): stone template holes along the outline and/or honeycomb fill, SS6–SS30.

## Design tools (new in 0.9)
- **Shift+click** to pick several pieces → **Combine**: *Weld* (overlaps become one outline — script fonts, logo + backer),
  *Trim* (cut the others out of the first), *Overlap*, *Group*.
- **Undo**: Ctrl+Z.
- **Nodes** (Edit): *Reduce nodes* smooths traced logos; *Edit nodes* — drag a node, double-click to delete it.
- **Text effects** (Edit): arch, bulge, pinch, wave, flag, perspective, taper, slant; **drop shadow** as its own color layer.
  Outlined text = Outline / offset.
- **Library tab**: templates (USDOT door numbers, boat registration numbers with USCG spacing, 24×18 yard sign,
  vehicle door lettering, store hours) and your own clip-art — select pieces → *Save to library*, click a thumbnail to insert.
- **Mockup page**: load a photo of the truck/window/wall, click both ends of something you measured and type its length,
  then add the Cut Studio design (or a printed graphic) at real size. Drag, set width, turn; *Save mockup (PNG)* for the proof.

## Printing tools (new in 0.10)
- **Color page**: add ICC profiles (get the Xerox 7845's output profile for each paper from Xerox), pick one per printer.
  Press and Print & Cut then convert photos/PNG/JPG to the Xerox's CMYK before sending (PDFs go as they are; the HPs are
  color-managed by Flexi). **Soft proof** shows how a picture will print and marks colors the printer can't reach.
  **Match a color** gives the CMYK recipe for a brand color on that printer and the closest vinyl in your color library (ΔE).
- **Preflight** (Wide Format, Press, Print & Cut): resolution at the printed size, fonts not embedded, RGB/CMYK/spot colors,
  stretched artwork, missing bleed.
- **Send proof to InkFlow** (every tool + Mockup): attaches the print PDF or a PNG proof to the order's files, ready to
  send for approval in InkFlow. Unlinked jobs pick the order from a list.
- **White ink** (Print & Cut: under the art's shape or a box; Wide Format: box) as a spot color for printers with white —
  set the spot name your RIP expects. (The HP Latex 335/115 have no white.)
- **Variable data** (Press): numbered tickets (From / To / Digits) or a list (paste or open CSV — names, badges); text
  fields like `No. {Number}` or `{Name}` placed on each piece in any installed font (embedded), then laid out N-up.
  Cut Studio → Text: **Each line as its own piece** for name decals.
- **Printing straight to the HPs without Flexi** isn't possible: the Latex 335/115 only accept jobs from HP-certified RIPs
  (Flexi, ONYX, Caldera…) — there's no driver or open job format. InkSign keeps sending them through Flexi's hot folders.

## Hook up each machine (Devices → Settings)
**Graphtec CE6000-60 Plus / Titan 3 (USB)** — *Connected by: USB (Windows printer)* → pick the cutter's printer → Save →
load scrap vinyl → **Test cut** (a 1" square with a triangle). Wrong size: change *HP-GL units per mm*.
Flipped/sideways: change *Rotate* / *Mirror*. Graphtec panel COMMAND = AUTO or HP-GL. Close Flexi's cutter server while testing.

**HP Latex 335 / 115 (Flexi 22)** — in Flexi Production Manager make a hot folder per printer (and per media if you like),
then in InkSign browse to it. **Test print** drops a color-bar PDF and waits for Flexi to take it.

**Xerox 7845** — IP address, port 9100 → **Test print**. Check that the first tray/duplex job comes out as chosen.

## Print & cut with InkSign marks
1. **First time on each cutter — alignment test** (Print & Cut → bottom right): *Print test sheet* → load it → scan the marks →
   *Cut test sheet*. Look at square **C**: if the cut sits off the printed square, type how far it landed right/up (mm) → **Save correction**.
   If the squares cut sideways or upside down, change *Rotate the cut*. Cut the test again until it sits on the print.
2. Normal jobs: **1. Print** → load in the cutter, bottom-left mark toward the cutter's origin → scan the marks → **2. Cut**.
3. **HP roll jobs**: pick the HP and *Roll*, set *Marks every* (12–60"). Each segment has its own 4 marks. Segment 1 cuts right away;
   segments 2, 3… wait in the Job queue — feed to the segment, scan its marks, press **Release**.
   The Flexi hot folder used must print at 100% size with **no** Flexi marks (the marks are already in the file).
4. Until the mark-reading commands are set up (below), start the mark scan from the cutter's panel; the *How to run it* box shows the exact
   mark size and distances to enter.

### Capturing Flexi's mark-reading commands (so the cutter finds the marks by itself)
1. Windows → Printers & scanners → the cutter → *Printer properties* → **Ports** → tick **FILE:** → OK.
2. In Flexi, send one small contour-cut job (with marks) to that cutter. Windows asks for a file name — save it (e.g. `graphtec-capture.plt`).
3. Set the port back to the cutter's USB port.
4. Send the capture files for the Graphtec and the Titan 3. The commands go into Devices → cutter → *Mark-reading commands*
   (placeholders `{DX_MM} {DY_MM} {DX} {DY}` for the mark distances, `{CUT}` for the cut, `<ETX>` for GP-GL).

## Connect InkFlow (one time)
1. Railway → InkFlow → Variables → add **INKSIGN_SHARED_SECRET** = any long random string (32+ characters) → redeploy.
2. Put the **InkFlow-InkSign-link** update into InkFlow (extract over the project folder, `npm run build`, commit, push).
   No database migration needed.
3. InkSign → **Settings → InkFlow**: InkFlow address + the same secret → **Test connection**.

Then: InkFlow orders get an **Open in InkSign** button, InkSign's Orders page fills up, and finished items show
"Cut" / "Printed" on the InkFlow order, on its timeline, with wide-format media + ink cost added to the order's costs.

## Watch folders (Settings)
Pick a folder and a machine. Files dropped in are sent automatically and moved to `Done` (or `Errors`).
Xerox watch folders can be 1- or 2-sided, and held for release; HP watch folders can pick the media hot folder.

## Updates
Post a new installer on InkFlow → **Shop apps → InkSign**. Every InkSign checks InkFlow every few hours (or Settings → Check now)
and shows a green "new version" note — click it to download, run it, done.
Optional: Settings → Updates → *Fully automatic* takes a web folder with `latest.yml` + installer and updates silently.

## Things to confirm on the first real job
- First cut on each cutter (size and direction).
- The alignment test on each cutter before the first real print & cut job (Graphtec and Titan 3).
- The Titan 3 reads InkSign's marks only if its own sensor can be started from its panel; otherwise it needs the captured Flexi commands.
- Xerox tray / paper type / duplex commands — check the first job comes from the right tray.

## Build from source
`npm install` · `npm start` (run) · `npm test` (75 tests) · `npm run dist` (Windows installer; on Linux needs Wine).
Ghostscript is `@jspawn/ghostscript-wasm` (Ghostscript 9.56, AGPL). Xerox PPD driver files: `electron/printers/xerox-7845-ppd-driver/`.
New cutter/printer models: one line in `electron/drivers/presets.js`; new kinds of machine: a driver in `electron/drivers/`.
