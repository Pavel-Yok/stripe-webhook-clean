console.log("🔍 Test webhook secret begins with:", (process.env.STRIPE_TEST_WEBHOOK_SECRET_ENV || "").slice(0, 7));

import express from "express";
import Stripe from "stripe";
import { google } from "googleapis";
import bodyParser from "body-parser";

const app = express();

/* ======================
   Stripe Setup
====================== */
const stripeSecretKey =
  process.env.STRIPE_MODE === "live"
    ? process.env.STRIPE_LIVE_SECRET_KEY_ENV
    : process.env.STRIPE_TEST_SECRET_KEY_ENV;

const webhookSecret = process.env.STRIPE_TEST_OVERRIDE ||
  (process.env.STRIPE_MODE === "live"
    ? process.env.STRIPE_LIVE_WEBHOOK_SECRET_ENV
    : process.env.STRIPE_TEST_WEBHOOK_SECRET_ENV);

if (!stripeSecretKey || !webhookSecret) {
  console.error("❌ Stripe secrets not found. Check your Cloud Run secret mappings.");
  process.exit(1);
}

console.log("🔑 Stripe mode:", process.env.STRIPE_MODE);
console.log("🔑 Stripe key loaded:", stripeSecretKey ? "Yes" : "No");
console.log("🔑 Webhook secret loaded:", webhookSecret ? "Yes" : "No");

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
function paymentReceivedTemplate(amount, currency) {
  return `
  <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
    <div style="text-align:center; margin-bottom:20px;">
      <img src="https://yokweb.com/yokweb-logo.png" alt="Yokweb Logo" width="120" style="border-radius: 8px;" />
    </div>
    <h2 style="color:#2e7d32;">Payment Confirmation</h2>
    <p>Hi,</p>
    <p>We’ve received your payment of <strong>${amount} ${currency}</strong>.</p>
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
    <p>Unfortunately, your recent payment attempt was not successful.</p>
    <p>Please update your payment information to continue enjoying our services.</p>
    <div style="margin-top:30px; text-align:center;">
      <a href="${updateUrl}" style="background:#c62828; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">Update Payment Info</a>
    </div>
  </div>`;
}

function renewalReminderTemplate(amount, currency, date) {
  return `
  <div style="font-family: Arial, sans-serif; color: #333; padding: 20px;">
    <div style="text-align:center; margin-bottom:20px;">
      <img src="https://yokweb.com/yokweb-logo.png" alt="Yokweb Logo" width="120" style="border-radius: 8px;" />
    </div>
    <h2 style="color:#1565c0;">Upcoming Renewal</h2>
    <p>Hi,</p>
    <p>This is a reminder that your subscription will renew on <strong>${date}</strong> for <strong>${amount} ${currency}</strong>.</p>
    <p>No action is required if your payment details are up to date.</p>
    <div style="margin-top:30px; text-align:center;">
      <a href="https://yokweb.com/account" style="background:#1565c0; color:#fff; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">Manage Account</a>
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
    <p>Your trial will end on <strong>${date}</strong>. Don’t miss out — continue with a paid plan today.</p>
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

  const rawMessage = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}`
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  try {
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: rawMessage },
    });
    console.log(`📧 Email sent to ${to} for event: "${subject}"`);
  } catch (err) {
    console.error("❌ Failed to send Gmail notification:", err);
  }
}

/* ======================
   Stripe Webhook Handler
====================== */
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    console.log("✅ Webhook event verified:", event.type);
  } catch (err) {
    console.error("⚠️ Webhook signature verification failed.", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    let customerEmail = event.data.object.customer_email;
    if (!customerEmail && event.data.object.customer) {
      const customer = await stripe.customers.retrieve(event.data.object.customer);
      customerEmail = customer.email;
    }

    switch (event.type) {
      case "invoice.paid": {
        const amount = (event.data.object.amount_paid / 100).toFixed(2);
        const currency = event.data.object.currency.toUpperCase();
        await sendMail({
          to: customerEmail,
          subject: "Payment Received",
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
          subject: "Payment Failed — Update Your Card",
          body: paymentFailedTemplate(session.url),
        });
        break;
      }
      case "invoice.upcoming": {
        const amount = (event.data.object.amount_due / 100).toFixed(2);
        const currency = event.data.object.currency.toUpperCase();
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
    console.error("❌ Error handling event:", err);
  }

  res.json({ received: true });
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
