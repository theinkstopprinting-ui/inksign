# Titan 3 mark sensor — what VinylMaster's Barcode Controller sends

Worked out by reading `AutoARMS_Detector.exe` ("Automark Cutting Module V2.61", the Barcode
Controller that ships with VinylMaster DSR) with Ghidra, and by reading its own log files and
`.ArmsData` job files. Nothing here has been sent to a real cutter from InkSign yet.

## The short version

The Titan does **not** find the barcode by itself. The PC drives the head around with ordinary
HP-GL moves, asks the cutter for the light level under the sensor many times a second, and does
all of the maths itself: it finds the edges of the black bars, reads the job number out of the bar
widths, finds the corner marks, works out a skew / scale correction and only then sends the cut
data. That is why this cannot be copied safely without the cutter in front of us: a wrong move
drives the carriage, and the edge-finding thresholds have to be tuned against real readings.

## How it talks to the cutter

- The cutter is opened by its Windows USB device path
  (`\\?\usb#vid_0483&pid_5750#…#{28d78fad-5a12-11d1-ae5b-0000f803a8c2}`), the USB printing-class
  interface. Each command is: open the path for writing, `WriteFile`, close.
- Replies come back on a separate read path. The program looks for `BUSY;`, `FREE;` and
  `CMD:100,OK;` in what it receives.

## Commands seen

| Sent | What it does | How sure |
| --- | --- | --- |
| `CMD:3;` | Sent first when the link is not yet up (hello / enter command mode) | fairly |
| `CMD:2;` (also `CMD:3;CMD:2;`) | Ask for the current speed | fairly |
| `MS;CMD:10;` (also `MS;CMD:100;`) | "Tell me when the move is finished"; waits for `FREE;` / `CMD:100,OK;` (long timeout) | sure |
| `CMD:13,<n>;` | Sensor light level, 33–100 seen. 50 is the start; it goes to 100 when the mark reads too faint, and down to 33 when it reads "too light / too close" | sure |
| `CMD:4;` | Read the sensor (one light reading). Polled about 10 times after changing the level, and continuously while the head sweeps over an edge | sure of the meaning, **reply format not decoded** |
| `CMD:7;`, `CMD:11,<n>;`, `CMD:12,<a>,<b>;` | Unknown | not decoded |
| `PU x,y;` `PD x,y;` | Ordinary moves, 40 units per mm, used to sweep the sensor | sure |
| `SP2;` | Tool select before cutting | sure |
| `MK0,0,<dx>,<dy>;IN;` … | Start of the stored cut data in every `.ArmsData` job (mark distances in units) | sure |

Settings that matter (from the program's Cutter Settings page on this PC): laser / sensor offset
X 22.469 mm, Y −4.729 mm from the knife; blade compensation 0.25; overcut 2.00.

## The steps it goes through (from its log)

1. `CMD:13,50;` then a "pre-scan" at the start point: read the sensor, and raise or lower the level
   until white vinyl and black ink are far enough apart ("ADC Range … = 15–43").
2. Sweep in +Y and −Y over the first mark edge and take the middle of the two crossings (this
   cancels the sensor's lag: "Est YLag −0.23"). Same in X ("Est Xlag −0.27").
3. Sweep along the barcode strip, collect the X positions of every black/white edge, and decode
   the job number from the bar widths ("BarCode Detected 17062").
4. Load `Jobs/<number>.ArmsData`: its `[PARAMS]` (page size, mark spacing, copies, offsets) and
   `[PLTDATA]` (the cut path).
5. Find the extender mark after the barcode, estimate scale and angle, then visit each mark
   ("BeginScanMark at …") and find its X and Y edge. If a mark is not found it retries with a
   different sensor level.
6. Fit the four corners ("Quad"), build the transform (origin, width vector, height vector, skew),
   run the cut path through it, and send it.

## What InkSign does today, and what is still to do

- Today (1.9.0 on): InkSign prints the job number and barcode, saves the cut job under that
  number, and you type or scan the number at the cutter page. The marks themselves are then found
  by the Titan's own `MK` routine (the same command VinylMaster's cut data starts with). This
  does not need any of the above, but it has not been tried on the real cutter yet either.
- Still to do, with the cutter connected and someone at the machine:
  1. A read-only sensor check: set the level, read `CMD:4;` with the head parked over white and
     then over black, and record exactly what comes back. This pins down the reply format.
  2. One slow sweep over a single printed bar to confirm lag and units.
  3. Only then the barcode read, and last the full mark scan.
