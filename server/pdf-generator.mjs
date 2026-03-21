/**
 * pdf-generator.mjs
 * Server-side PDF generation using Puppeteer (headless Chromium) + Handlebars templates.
 * Produces C-Suite executive-grade documents with Montserrat font and Executive Blue palette.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(__dirname, "templates");

// Lazy-loaded singletons to avoid startup overhead
let _handlebars = null;
let _puppeteerBrowser = null;
let _browserCloseTimer = null;
const BROWSER_IDLE_TIMEOUT_MS = 60_000; // close browser after 60s of inactivity

async function getHandlebars() {
    if (!_handlebars) {
        const { default: Handlebars } = await import("handlebars");
        // Register helpers
        Handlebars.registerHelper("gte", (a, b) => a >= b);
        Handlebars.registerHelper("inc", (i) => i + 1);
        _handlebars = Handlebars;
    }
    return _handlebars;
}

async function getBrowser() {
    // Reset idle timer
    if (_browserCloseTimer) {
        clearTimeout(_browserCloseTimer);
        _browserCloseTimer = null;
    }

    if (!_puppeteerBrowser || !_puppeteerBrowser.connected) {
        const { default: puppeteer } = await import("puppeteer");
        _puppeteerBrowser = await puppeteer.launch({
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--font-render-hinting=none"
            ]
        });
    }

    // Schedule idle close
    _browserCloseTimer = setTimeout(async () => {
        if (_puppeteerBrowser?.connected) {
            await _puppeteerBrowser.close().catch(() => {});
        }
        _puppeteerBrowser = null;
        _browserCloseTimer = null;
    }, BROWSER_IDLE_TIMEOUT_MS);

    return _puppeteerBrowser;
}

async function renderHtml(templateName, data) {
    const Handlebars = await getHandlebars();
    const templatePath = path.join(templatesDir, `${templateName}.hbs`);
    const source = await fsp.readFile(templatePath, "utf8");
    const template = Handlebars.compile(source);
    return template(data);
}

async function htmlToPdf(html) {
    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
        await page.setContent(html, { waitUntil: "networkidle0", timeout: 30_000 });

        const pdfBuffer = await page.pdf({
            format: "A4",
            printBackground: true,
            margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
            preferCSSPageSize: false
        });

        return Buffer.from(pdfBuffer);
    } finally {
        await page.close().catch(() => {});
    }
}

function buildReferenceId(applicantName) {
    const hash = crypto.createHash("sha256").update(applicantName + Date.now()).digest("hex");
    return `AGS-${hash.slice(0, 4).toUpperCase()}-${hash.slice(4, 8).toUpperCase()}-${Date.now().toString(36).toUpperCase().slice(-4)}`;
}

function formatDate(date = new Date()) {
    return date.toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Generate Referee Briefing PDF.
 * @param {object} state  APP_STATE from the client
 * @param {number} refereeIndex  Index into state.referees array
 * @returns {Buffer} PDF bytes
 */
export async function generateRefereePdf(state, refereeIndex = 0) {
    const applicantName = state?.personal?.fullName || "Applicant";
    const referee = (state?.referees || [])[refereeIndex] || {
        name: "[Referee Name]",
        role: "Supervisor",
        employer: "Organisation",
        email: "",
        phone: ""
    };

    const data = {
        applicantName,
        applicantEmail: state?.personal?.email || "",
        applicantPhone: state?.personal?.phone || "",
        refereeName: referee.name || "[Referee Name]",
        refereeRole: referee.role || "Supervisor",
        refereeEmployer: referee.employer || "Organisation",
        refereeEmail: referee.email || "",
        refereePhone: referee.phone || "",
        issuedDate: formatDate(),
        referenceId: buildReferenceId(applicantName + String(refereeIndex))
    };

    const html = await renderHtml("referee-briefing", data);
    return htmlToPdf(html);
}

/**
 * Generate Application Summary PDF.
 * @param {object} state  APP_STATE from the client
 * @returns {Buffer} PDF bytes
 */
export async function generateApplicationPdf(state) {
    const applicantName = state?.personal?.fullName || "Applicant";

    const PROGRESS_KEYS = ["personal", "employment", "address", "documents", "referees", "disclosure"];
    const progressItems = PROGRESS_KEYS.map((key) => {
        const value = Number.parseInt(String(state?.progress?.[key] || 0), 10) || 0;
        const fillClass = value >= 80 ? "fill-high" : value >= 40 ? "fill-mid" : "fill-low";
        return { key, label: key.charAt(0).toUpperCase() + key.slice(1), value, fillClass };
    });

    const totalProgress = progressItems.length
        ? Math.round(progressItems.reduce((s, p) => s + p.value, 0) / progressItems.length)
        : 0;

    const documents = (state?.documents || []).map((doc) => ({
        ...doc,
        typeLabel: (String(doc.type || "").split("/")[1] || "file").toUpperCase(),
        status: doc.status || "uploaded"
    }));

    const referees = state?.referees || [];
    const disclosureText = state?.disclosure?.statement || state?.formData?.["disclosure-editor"] || "";

    const data = {
        applicantName,
        personal: state?.personal || {},
        progressItems,
        overallProgress: totalProgress,
        referees,
        refereeCount: referees.length,
        documents,
        documentCount: documents.length,
        disclosureText,
        generatedDate: formatDate(),
        referenceId: buildReferenceId(applicantName)
    };

    const html = await renderHtml("application-summary", data);
    return htmlToPdf(html);
}

/**
 * Gracefully close the shared browser on server shutdown.
 */
export async function closeBrowser() {
    if (_browserCloseTimer) {
        clearTimeout(_browserCloseTimer);
        _browserCloseTimer = null;
    }
    if (_puppeteerBrowser?.connected) {
        await _puppeteerBrowser.close().catch(() => {});
    }
    _puppeteerBrowser = null;
}
