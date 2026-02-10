import express, { Request, Response } from 'express';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import turnstile from './lib/ends/turnstile';
import iuam from './lib/ends/iuam';

const app = express();
const port = process.env.PORT || 8742;
const authToken = process.env.authToken || null;

// ক্যাশ এবং গ্লোবাল লিমিট Vercel-এ সাময়িকভাবে কাজ করবে (প্রতি ইনভোকেশনে রিসেট হবে)
(global as any).browserLimit = Number(process.env.browserLimit) || 20;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Vercel-এর জন্য ব্রাউজার লঞ্চার ফাংশন
async function getBrowser() {
    return await puppeteer.launch({
        args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
    });
}

app.post('/cloudflare', async (req: Request, res: Response): Promise<any> => {
    const startTime = Date.now();
    const data = req.body;
    let browser = null;
    let page = null;

    // ভ্যালিডেশন
    if (!data || typeof data.mode !== 'string') {
        return res.status(400).json({ message: 'Bad Request: missing or invalid mode' });
    }
    if (authToken && data.authToken !== authToken) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    try {
        // ব্রাউজার ওপেন করা
        browser = await getBrowser();
        page = await browser.newPage();

        // স্পিড বাড়ানোর জন্য ইমেজ/মিডিয়া ব্লক
        await page.setRequestInterception(true);
        page.on('request', (req: any) => {
            if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        let result: any;
        switch (data.mode) {
            case "turnstile":
                result = await turnstile(data as any, page)
                    .then(token => ({ code: 200, token }))
                    .catch(err => ({ code: 500, message: err.message }));
                break;

            case "iuam":
                // IUAM এর জন্য ডোমেইন ভিজিট করা জরুরি
                if (data.domain) {
                    await page.goto(data.domain, { waitUntil: 'domcontentloaded', timeout: 30000 });
                }
                result = await iuam(data as any, page)
                    .then(r => ({ code: 200, ...r }))
                    .catch(err => ({ code: 500, message: err.message }));
                break;

            default:
                result = { code: 400, message: 'Invalid mode' };
        }

        result.elapsed = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
        return res.status(result.code || 200).json(result);

    } catch (err: any) {
        return res.status(500).json({ code: 500, message: err.message });
    } finally {
        // ব্রাউজার ক্লোজ করা বাধ্যতামূলক নতুবা Vercel 504 Error দেবে
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
});

app.use((req: Request, res: Response) => {
    res.status(404).json({ message: 'Not Found' });
});

export default app;
