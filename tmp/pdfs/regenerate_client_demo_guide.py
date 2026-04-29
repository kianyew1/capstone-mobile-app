from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, ListFlowable, ListItem, PageBreak
from reportlab.pdfbase.pdfmetrics import stringWidth
from datetime import datetime
from pathlib import Path

OUT = Path(r"C:\src\capstone-ecgapp\output\PulseSense_Client_Demo_Guide_2026-04-29.pdf")
OUT.parent.mkdir(parents=True, exist_ok=True)

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="GuideTitle",
    parent=styles["Title"],
    fontName="Helvetica-Bold",
    fontSize=22,
    leading=26,
    textColor=colors.HexColor("#0f172a"),
    spaceAfter=8,
))
styles.add(ParagraphStyle(
    name="GuideSubtitle",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=10.5,
    leading=14,
    textColor=colors.HexColor("#334155"),
    spaceAfter=14,
))
styles.add(ParagraphStyle(
    name="MetaLabel",
    parent=styles["BodyText"],
    fontName="Helvetica-Bold",
    fontSize=9.5,
    leading=12,
    textColor=colors.HexColor("#0f172a"),
))
styles.add(ParagraphStyle(
    name="MetaValue",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=9.5,
    leading=12,
    textColor=colors.HexColor("#334155"),
))
styles.add(ParagraphStyle(
    name="SectionHeading",
    parent=styles["Heading2"],
    fontName="Helvetica-Bold",
    fontSize=13,
    leading=16,
    textColor=colors.HexColor("#0f172a"),
    spaceBefore=12,
    spaceAfter=6,
))
styles.add(ParagraphStyle(
    name="Body",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=10,
    leading=14,
    textColor=colors.HexColor("#1e293b"),
    spaceAfter=4,
))
styles.add(ParagraphStyle(
    name="Callout",
    parent=styles["BodyText"],
    fontName="Helvetica-Bold",
    fontSize=10,
    leading=14,
    textColor=colors.HexColor("#7c2d12"),
    backColor=colors.HexColor("#fff7ed"),
    borderPadding=8,
    borderColor=colors.HexColor("#fdba74"),
    borderWidth=0.5,
    borderRadius=4,
    spaceAfter=10,
))
styles.add(ParagraphStyle(
    name="Footer",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=8,
    leading=10,
    textColor=colors.HexColor("#475569"),
    alignment=TA_CENTER,
))


def bullet_list(items):
    return ListFlowable(
        [ListItem(Paragraph(item, styles["Body"])) for item in items],
        bulletType="bullet",
        leftIndent=14,
        bulletFontName="Helvetica",
        bulletFontSize=9,
        bulletOffsetY=2,
    )


def ordered_list(items):
    return ListFlowable(
        [ListItem(Paragraph(item, styles["Body"])) for item in items],
        bulletType="1",
        start="1",
        leftIndent=14,
    )


def meta_pair(label, value):
    return Paragraph(f"<b>{label}</b><br/>{value}", styles["Body"])


def draw_header_footer(canvas, doc):
    canvas.saveState()
    width, height = A4
    canvas.setStrokeColor(colors.HexColor("#cbd5e1"))
    canvas.setLineWidth(0.5)
    canvas.line(doc.leftMargin, height - 18 * mm, width - doc.rightMargin, height - 18 * mm)
    canvas.setFont("Helvetica-Bold", 8.5)
    canvas.setFillColor(colors.HexColor("#334155"))
    canvas.drawString(doc.leftMargin, height - 14 * mm, "PulseSense hosted-demo handover guide")
    page_label = f"Page {canvas.getPageNumber()}"
    canvas.drawRightString(width - doc.rightMargin, 12 * mm, page_label)
    canvas.restoreState()


doc = SimpleDocTemplate(
    str(OUT),
    pagesize=A4,
    leftMargin=18 * mm,
    rightMargin=18 * mm,
    topMargin=24 * mm,
    bottomMargin=18 * mm,
)

story = []

story.append(Paragraph("PulseSense Client Demo Guide", styles["GuideTitle"]))
story.append(Paragraph(
    "Hosted-backend demo package for Android phone installation, ecg-review-web startup, and first-run validation.",
    styles["GuideSubtitle"],
))

meta_rows = [
    ("Prepared on", "29 Apr 2026"),
    ("GitHub repository", "https://github.com/kianyew1/capstone-mobile-app"),
    ("APK filename", "PulseSense_Demo_Hosted_2026-04-29.apk"),
    ("Review-web launcher", "start_review_web_demo.ps1"),
    ("Backend mode", "Hosted backend already baked into the current build settings"),
]
for label, value in meta_rows:
    story.append(meta_pair(label, value))

story.append(Spacer(1, 4))
story.append(Paragraph(
    "Important: This demo does not require the client to run a local backend. The APK talks to the hosted backend, and the supplied PowerShell script starts the local ecg-review-web against that hosted backend.",
    styles["Callout"],
))

sections = [
    ("1. What the client receives", [
        bullet_list([
            "The Android APK file: <b>PulseSense_Demo_Hosted_2026-04-29.apk</b>",
            "The PowerShell review-web launcher: <b>start_review_web_demo.ps1</b>",
            "A GitHub repository link for the source code and project documentation.",
            "Project documentation files inside the cloned repository, including <b>README.md</b> and <b>DATABASE-README.md</b>.",
            "The ECG hardware device used for Bluetooth pairing and signal capture.",
        ])
    ]),
    ("2. What the client needs before starting", [
        bullet_list([
            "A Windows laptop with PowerShell, Node.js, and npm installed for the review web launcher.",
            "An Android phone with Bluetooth enabled.",
            "Working internet access on the phone and laptop so both can reach the hosted backend.",
            "The ECG hardware powered on and ready for pairing.",
            "Git installed on the laptop if the client wants to clone the repository locally.",
        ])
    ]),
    ("3. Clone the repository", [
        Paragraph("Cloning the repository is not required to run the phone demo itself, but it is part of the handover so the client has the codebase and documentation locally.", styles["Body"]),
        ordered_list([
            "Open a terminal or Git Bash on the laptop.",
            "Choose the local folder where the project should be stored.",
            "Run: <b>git clone https://github.com/kianyew1/capstone-mobile-app.git</b>",
            "Open the cloned folder: <b>capstone-mobile-app</b>.",
            "Inside that folder, review these files first: <b>README.md</b>, <b>QUICK_START.md</b>, and <b>DATABASE-README.md</b>.",
        ])
    ]),
    ("4. Start ecg-review-web", [
        Paragraph("Use the supplied PowerShell launcher to start the review UI locally while still talking to the hosted backend.", styles["Body"]),
        ordered_list([
            "From the repository root, open PowerShell.",
            "Run: <b>powershell -ExecutionPolicy Bypass -File .\\start_review_web_demo.ps1</b>",
            "Wait for the Vite server to finish starting.",
            "Open <b>http://127.0.0.1:5173</b> in the browser.",
        ]),
        Paragraph("What the script does automatically:", styles["Body"]),
        bullet_list([
            "Checks that Node.js and npm are available.",
            "Runs <b>npm install</b> in <b>ecg-review-web</b> if dependencies are missing.",
            "Starts the review web on port 5173.",
            "Routes all <b>/api</b> requests to the hosted backend used for the demo.",
        ]),
        Paragraph("Keep that PowerShell window open while using the review web. Press <b>Ctrl+C</b> in that window when you want to stop the local review server.", styles["Body"]),
    ]),
    ("5. Install the APK on the Android phone", [
        ordered_list([
            "Transfer <b>PulseSense_Demo_Hosted_2026-04-29.apk</b> to the phone.",
            "On the phone, open the APK file from the Downloads folder or file manager.",
            "If Android blocks the install, allow installation from this source when prompted.",
            "Continue the install until the app appears on the home screen or app list.",
        ]),
        Paragraph("Note: this APK is intended for direct sideload installation for the demo. It is not a Play Store distribution package.", styles["Body"]),
    ]),
    ("6. First app launch", [
        ordered_list([
            "Open the installed app on the Android phone.",
            "Proceed through any onboarding steps shown by the app.",
            "Grant Bluetooth and location permissions when Android asks for them. These are required for BLE device scanning.",
            "Keep the ECG hardware powered on and close to the phone.",
        ])
    ]),
    ("7. Pair the ECG hardware", [
        ordered_list([
            "Navigate to the Bluetooth pairing screen inside the app.",
            "Wait for the ECG device to appear in the discovered device list.",
            "Select the ECG device and wait for the app to show a connected state.",
            "If the hardware is not found, confirm the device is powered on and advertising before trying again.",
        ])
    ]),
    ("8. Run a calibration", [
        ordered_list([
            "Start the calibration flow from within the app.",
            "Maintain electrode contact for the full calibration capture period.",
            "Wait for the app to finish uploading and processing the calibration.",
            "Confirm that the calibration completes successfully before starting a session.",
        ])
    ]),
    ("9. Run a demo session", [
        ordered_list([
            "Start a new session in the app.",
            "Keep the Bluetooth connection stable during the run.",
            "Allow the session to collect data normally.",
            "End the session from the app when enough demo data has been captured.",
            "Wait for the app to finish the final upload step.",
        ])
    ]),
    ("10. Use ecg-review-web after a session", [
        ordered_list([
            "Keep the local review web open at <b>http://127.0.0.1:5173</b>.",
            "If a specific record ID is available, paste that <b>ecg_recordings.id</b> into the review page input.",
            "If anything fails, or if there is uncertainty about which record to inspect, use this fallback record ID and click <b>Load</b>: <b>4acc06b3-2b31-49d0-bc43-d691a4cb008a</b>.",
            "Click <b>Generate</b> only if the static review manifest has not been created yet.",
            "Browse the generated window images once processing is complete.",
        ]),
        Paragraph("The static review page now attempts to load the latest record automatically, but the fallback record ID above gives the client a known-good manual option.", styles["Body"]),
    ]),
    ("11. What success looks like", [
        bullet_list([
            "The review web launcher starts successfully and opens on the laptop.",
            "The app installs successfully on the Android phone.",
            "The ECG hardware pairs successfully over Bluetooth.",
            "Calibration completes without an upload error.",
            "A session can be started and ended successfully.",
            "The app does not require the client to run a local backend for this demo path.",
        ])
    ]),
    ("12. Troubleshooting", [
        Paragraph("The review-web script fails immediately", styles["Body"]),
        bullet_list([
            "Confirm Node.js and npm are installed on the laptop.",
            "Run the script from the repository root so it can find the <b>ecg-review-web</b> folder.",
            "If PowerShell blocks the script, use the exact command shown in this guide with <b>-ExecutionPolicy Bypass</b>.",
        ]),
        Paragraph("APK does not install", styles["Body"]),
        bullet_list([
            "Confirm the phone allows installation from the chosen source.",
            "Retry after deleting any older copy of the app if Android reports a package conflict.",
        ]),
        Paragraph("The ECG device does not appear in the app", styles["Body"]),
        bullet_list([
            "Confirm Bluetooth is enabled on the phone.",
            "Confirm the hardware is powered on and in advertising mode.",
            "Move the phone closer to the hardware and rescan.",
        ]),
        Paragraph("Calibration or session upload fails", styles["Body"]),
        bullet_list([
            "Confirm the phone has working internet access.",
            "Retry the flow with the same hosted backend setup once the network is stable.",
            "If the problem persists, the issue is likely on the hosted backend or Supabase side rather than on the client phone.",
        ]),
    ]),
    ("13. Client acceptance checklist", [
        ordered_list([
            "Repository cloned successfully from GitHub.",
            "PowerShell launcher <b>start_review_web_demo.ps1</b> starts ecg-review-web successfully.",
            "APK file <b>PulseSense_Demo_Hosted_2026-04-29.apk</b> installed successfully.",
            "App launches without immediate configuration work on the client side.",
            "Bluetooth pairing succeeds with the ECG hardware.",
            "Calibration succeeds.",
            "A session can be started, run, and ended.",
        ])
    ]),
    ("14. Handover notes", [
        bullet_list([
            "This guide is for the hosted-backend demo path only.",
            "The source repository contains broader setup documentation for backend, database, review web, and offline signal-processing workflows.",
            "The provided APK is suitable for direct demo installation. It is not a Play Store release build.",
        ])
    ]),
]

for title, blocks in sections:
    story.append(Paragraph(title, styles["SectionHeading"]))
    for block in blocks:
        story.append(block)
        story.append(Spacer(1, 3))


doc.build(story, onFirstPage=draw_header_footer, onLaterPages=draw_header_footer)
print(f"Wrote {OUT}")
