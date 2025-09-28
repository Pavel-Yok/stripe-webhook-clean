// server.js

// Using 'import' syntax requires "type": "module" in your package.json
import express from "express";
import Stripe from "stripe";
import { google } from "googleapis";
import bodyParser from "body-parser";

const app = express();

/* ======================
   Configuration
====================== */
const SENDER_EMAIL = 'pavel@yokweb.com'; // 🟢 FINAL SENDER EMAIL

const stripeSecretKey =
  process.env.STRIPE_MODE === "test"
    ? process.env.STRIPE_LIVE_SECRET_KEY_ENV
    : process.env.STRIPE_TEST_SECRET_KEY_ENV;

const webhookSecret = process.env.STRIPE_MODE === "test"
  ? process.env.STRIPE_LIVE_WEBHOOK_SECRET_ENV
  : process.env.STRIPE_TEST_WEBHOOK_SECRET_ENV;

if (!stripeSecretKey || !webhookSecret) {
  console.error("❌ Stripe secrets not found. Check your Cloud Run secret mappings.");
  // NOTE: On Cloud Run, this will crash the instance on startup if variables are missing, which is a desirable failure mode for security.
  process.exit(1);
}

console.log("🔑 Stripe mode:", process.env.STRIPE_MODE);
console.log("🔑 Webhook secret begins with:", webhookSecret.slice(0, 7));

const stripe = new Stripe(stripeSecretKey);

/* ======================
   Gmail OAuth2 Setup
====================== */
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID_ENV,
  process.env.GOOGLE_CLIENT_SECRET_ENV,
  process.env.GOOGLE_REDIRECT_URI_ENV
);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN_ENV });
const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

/* ======================
   HTML Email Templates
====================== */

// Helper to wrap amount and currency formatting
function formatAmount(amount, currency) {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

// 🟢 NEW: Template for the Finalized Invoice (The Core Requirement)
function finalizedInvoiceTemplate(invoiceUrl, invoiceNumber, amount, currency) {
  const formattedAmount = formatAmount(amount, currency);
  return `
  <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
    <div style="text-align:center; margin-bottom:20px;">
      <img src="https://yokweb.com/yokweb-logo.png" alt="Yokweb Logo" width="120" style="border-radius: 8px;" />
    </div>
    <h2 style="color:#1565c0;">Invoice #${invoiceNumber} is Ready</h2>
    <p>Hi,</p>
    <p>Your invoice **#${invoiceNumber}** for **${formattedAmount}** has been finalized and is due for payment.</p>
    <p>Please click the button below to view and pay your invoice securely online.</p>
    <div style="margin-top:30px; text-align:center;">
      <a href="${invoiceUrl}" style="background:#1565c0; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">View & Pay Invoice</a>
    </div>
    <p style="margin-top:20px; font-size: 12px; color: #777;">
      You can also download a PDF copy directly from the hosted page.
    </p>
    <p style="margin-top:20px;">Thank you for your business!</p>
  </div>`;
}

function paymentReceivedTemplate(amount, currency) {
  const formattedAmount = formatAmount(amount, currency);
  return `
  <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
    <div style="text-align:center; margin-bottom:20px;">
      <img src="https://yokweb.com/yokweb-logo.png" alt="Yokweb Logo" width="120" style="border-radius: 8px;" />
    </div>
    <h2 style="color:#2e7d32;">Payment Confirmation</h2>
    <p>Hi,</p>
    <p>We’ve received your payment of **${formattedAmount}**.</p>
    <p>Thank you for your trust in our services!</p>
    <div style="margin-top:30px; text-align:center;">
      <a href="https://yokweb.com/account" style="background:#2e7d32; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">Visit Your Account</a>
    </div>
  </div>`;
}

function paymentFailedTemplate(updateUrl) {
  return `
  <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
    <div style="text-align:center; margin-bottom:20px;">
      <img src="https://yokweb.com/yokweb-logo.png" alt="Yokweb Logo" width="120" style="border-radius: 8px;" />
    </div>
    <h2 style="color:#c62828;">Payment Failed</h2>
    <p>Hi,</p>
    <p>Unfortunately, your recent payment attempt was not successful. Your subscription may be interrupted.</p>
    <p>Please update your payment information to continue enjoying our services.</p>
    <div style="margin-top:30px; text-align:center;">
      <a href="${updateUrl}" style="background:#c62828; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">Update Payment Info</a>
    </div>
  </div>`;
}

function renewalReminderTemplate(amount, currency, date) {
  const formattedAmount = formatAmount(amount, currency);
  return `
  <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
    <div style="text-align:center; margin-bottom:20px;">
      <img src="https://yokweb.com/yokweb-logo.png" alt="Yokweb Logo" width="120" style="border-radius: 8px;" />
    </div>
    <h2 style="color:#f9a825;">Upcoming Renewal Reminder</h2>
    <p>Hi,</p>
    <p>This is a reminder that your subscription will renew on **${date}** for **${formattedAmount}**.</p>
    <p>No action is required if your payment details are up to date.</p>
    <div style="margin-top:30px; text-align:center;">
      <a href="https://yokweb.com/account" style="background:#f9a825; color:#000; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">Manage Account</a>
    </div>
  </div>`;
}

function trialEndingTemplate(date) {
  return `
  <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
    <div style="text-align:center; margin-bottom:20px;">
      <img src="https://yokweb.com/yokweb-logo.png" alt="Yokweb Logo" width="120" style="border-radius: 8px;" />
    </div>
    <h2 style="color:#f9a825;">Your Trial is Ending Soon</h2>
    <p>Hi,</p>
    <p>Your trial will end on **${date}**. Don’t miss out — continue with a paid plan today.</p>
    <div style="margin-top:30px; text-align:center;">
      <a href="https://yokweb.com/pricing" style="background:#f9a825; color:#000; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">Upgrade Now</a>
    </div>
  </div>`;
}

/* ======================
   Gmail Send Function
====================== */
async function sendMail({ to, subject, body }) {
  if (!to) {
    console.error("⚠️ No customer email available, skipping.");
    return;
  }

  // CRITICAL: Construct the raw message string with the From header
  const rawMessage = Buffer.from(
    `To: ${to}\r\nFrom: ${SENDER_EMAIL}\r\nSubject: ${subject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}`
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  try {
    await gmail.users.messages.send({
      userId: SENDER_EMAIL, // Use the explicit sender email (pavel@yokweb.com) for authorization
      requestBody: { raw: rawMessage },
    });
    console.log(`📧 Email sent to ${to} for event: "${subject}" from ${SENDER_EMAIL}`);
  } catch (err) {
    console.error("❌ Failed to send Gmail notification:", err);
  }
}

/* ======================
   Stripe Webhook Handler
====================== */
// CRITICAL: Use bodyParser.raw() ONLY for this endpoint
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  // 1. Signature Verification
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    console.log("✅ Webhook event verified:", event.type);
  } catch (err) {
    console.error("⚠️ Webhook signature verification failed.", err.message);
    // CRITICAL FIX: The next likely failure point—ensure no whitespace in webhookSecret value!
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Return 200 immediately to prevent Stripe retries
  res.json({ received: true });

  // 2. Event Processing (should happen asynchronously after response)
  try {
    let customerEmail = event.data.object.customer_email;
    if (!customerEmail && event.data.object.customer) {
      const customer = await stripe.customers.retrieve(event.data.object.customer);
      customerEmail = customer.email;
    }

    switch (event.type) {
      
      // 🟢 NEW CORE LOGIC: Send the Actual Invoice
      case "invoice.finalized": {
        const invoiceObject = event.data.object;
        const invoiceUrl = invoiceObject.hosted_invoice_url;
        const invoiceNumber = invoiceObject.number; 
        const amount = invoiceObject.amount_due;
        const currency = invoiceObject.currency;

        if (!invoiceUrl || !invoiceNumber) {
            console.error("⚠️ Finalized invoice missing hosted URL or number. Skipping email.");
            break; 
        }

        await sendMail({
            to: customerEmail,
            subject: `Invoice ${invoiceNumber} from Yokweb is Due`,
            body: finalizedInvoiceTemplate(invoiceUrl, invoiceNumber, amount, currency),
        });
        break;
      }

      case "invoice.paid": {
        const amount = event.data.object.amount_paid;
        const currency = event.data.object.currency;
        await sendMail({
          to: customerEmail,
          subject: "Payment Received - Thank You",
          body: paymentReceivedTemplate(amount, currency),
        });
        break;
      }

      case "invoice.payment_failed": {
        const session = await stripe.billingPortal.sessions.create({
          customer: event.data.object.customer,
          return_url: "https://yokweb.com/account",
        });
        await sendMail({
          to: customerEmail,
          subject: "Action Required: Payment Failed",
          body: paymentFailedTemplate(session.url),
        });
        break;
      }
      
      case "invoice.upcoming": {
        const amount = event.data.object.amount_due;
        const currency = event.data.object.currency;
        const date = new Date(event.data.object.next_payment_attempt * 1000).toLocaleDateString();
        await sendMail({
          to: customerEmail,
          subject: "Upcoming Renewal Reminder",
          body: renewalReminderTemplate(amount, currency, date),
        });
        break;
      }

      case "customer.subscription.trial_will_end": {
        const date = new Date(event.data.object.trial_end * 1000).toLocaleDateString();
        await sendMail({
          to: customerEmail,
          subject: "Trial Ending Soon",
          body: trialEndingTemplate(date),
        });
        break;
      }

      default:
        console.log("ℹ️ Unhandled event type:", event.type);
    }
  } catch (err) {
    console.error("❌ Error handling event logic:", err);
  }
});

/* ======================
   Health Check
====================== */
app.get("/", (req, res) => {
  res.send("✅ Stripe Webhook service is running");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Webhook server running on port ${PORT}`);
});
